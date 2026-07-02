use crate::storage::{ensure_data_file, load_data_snapshot, persist_data_snapshot_with_retries};
use crate::{get_config_path, get_secrets_path, read_config, write_config_files, AppConfigToml};
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const LOCAL_API_HOST: &str = "127.0.0.1";
pub(crate) const DEFAULT_LOCAL_API_PORT: u16 = 3456;
const MIN_LOCAL_API_PORT: u16 = 1024;
const MAX_LOCAL_API_PORT: u16 = u16::MAX;
const REQUEST_HEADER_LIMIT_BYTES: usize = 16 * 1024;
const REQUEST_BODY_LIMIT_BYTES: usize = 1_000_000;
const LOCAL_API_TOKEN_BYTES: usize = 32;
const LOCAL_API_REV_BY: &str = "desktop-local-api";
const MAX_SYNC_REVISION: i64 = 2_147_483_647;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalApiServerStatus {
    enabled: bool,
    running: bool,
    port: u16,
    url: Option<String>,
    token: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct LocalApiConfig {
    enabled: bool,
    port: u16,
    token: Option<String>,
}

impl Default for LocalApiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_LOCAL_API_PORT,
            token: None,
        }
    }
}

struct LocalApiHandle {
    port: u16,
    shutdown: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct LocalApiRuntime {
    handle: Option<LocalApiHandle>,
    last_error: Option<String>,
}

#[derive(Default)]
pub(crate) struct LocalApiServerState {
    inner: Mutex<LocalApiRuntime>,
    write_lock: Arc<Mutex<()>>,
}

#[derive(Debug)]
struct ApiRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug)]
struct ApiResponse {
    status: u16,
    body: Value,
}

impl ApiResponse {
    fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    fn created(body: Value) -> Self {
        Self { status: 201, body }
    }

    fn error(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            body: json!({ "error": message.into() }),
        }
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn generate_uuid_v4() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

fn generate_local_api_token() -> String {
    let mut bytes = [0_u8; LOCAL_API_TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn normalize_local_api_port(port: Option<u16>) -> Result<u16, String> {
    let port = port.unwrap_or(DEFAULT_LOCAL_API_PORT);
    if !(MIN_LOCAL_API_PORT..=MAX_LOCAL_API_PORT).contains(&port) {
        return Err(format!(
            "Local API port must be between {} and {}.",
            MIN_LOCAL_API_PORT, MAX_LOCAL_API_PORT
        ));
    }
    Ok(port)
}

fn parse_bool_setting(value: Option<&String>) -> bool {
    value
        .map(|raw| raw.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn normalize_local_api_token(value: Option<&String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

fn read_local_api_config(app: &tauri::AppHandle) -> LocalApiConfig {
    let config = read_config(app);
    let port = config
        .local_api_port
        .as_deref()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .and_then(|value| normalize_local_api_port(Some(value)).ok())
        .unwrap_or(DEFAULT_LOCAL_API_PORT);
    LocalApiConfig {
        enabled: parse_bool_setting(config.local_api_enabled.as_ref()),
        port,
        token: normalize_local_api_token(config.local_api_token.as_ref()),
    }
}

fn write_local_api_config(app: &tauri::AppHandle, next: LocalApiConfig) -> Result<(), String> {
    let mut config: AppConfigToml = read_config(app);
    config.local_api_enabled = Some(if next.enabled { "true" } else { "false" }.to_string());
    config.local_api_port = Some(next.port.to_string());
    config.local_api_token = next.token;
    write_config_files(&get_config_path(app), &get_secrets_path(app), &config)
}

fn ensure_local_api_token(
    app: &tauri::AppHandle,
    mut config: LocalApiConfig,
    required: bool,
) -> Result<LocalApiConfig, String> {
    if required && config.token.is_none() {
        config.token = Some(generate_local_api_token());
        write_local_api_config(app, config.clone())?;
    }
    Ok(config)
}

fn status_from_runtime(config: LocalApiConfig, runtime: &LocalApiRuntime) -> LocalApiServerStatus {
    let running_port = runtime.handle.as_ref().map(|handle| handle.port);
    let port = running_port.unwrap_or(config.port);
    LocalApiServerStatus {
        enabled: config.enabled,
        running: running_port.is_some(),
        port,
        url: running_port.map(|value| format!("http://{}:{}", LOCAL_API_HOST, value)),
        token: config.enabled.then(|| config.token.clone()).flatten(),
        error: runtime.last_error.clone(),
    }
}

fn stop_runtime(runtime: &mut LocalApiRuntime) {
    let Some(mut handle) = runtime.handle.take() else {
        return;
    };
    handle.shutdown.store(true, Ordering::SeqCst);
    let _ = TcpStream::connect((LOCAL_API_HOST, handle.port));
    if let Some(join) = handle.join.take() {
        let _ = join.join();
    }
}

fn start_runtime(
    app: tauri::AppHandle,
    port: u16,
    token: String,
    write_lock: Arc<Mutex<()>>,
) -> Result<LocalApiHandle, String> {
    ensure_data_file(&app)?;
    let listener = TcpListener::bind((LOCAL_API_HOST, port))
        .map_err(|error| format!("Failed to start local API server on port {port}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Failed to configure local API server: {error}"))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = shutdown.clone();
    let join = thread::spawn(move || {
        while !thread_shutdown.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let app = app.clone();
                    let token = token.clone();
                    let write_lock = write_lock.clone();
                    thread::spawn(move || handle_connection(app, token, write_lock, stream));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(error) => {
                    log::warn!("Local API accept failed: {error}");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });

    Ok(LocalApiHandle {
        port,
        shutdown,
        join: Some(join),
    })
}

pub(crate) fn start_configured_local_api_server(
    app: &tauri::AppHandle,
    state: &LocalApiServerState,
) {
    let config = read_local_api_config(app);
    if !config.enabled {
        return;
    }
    let config = match ensure_local_api_token(app, config, true) {
        Ok(config) => config,
        Err(error) => {
            log::warn!("Failed to prepare local API token: {error}");
            return;
        }
    };

    let mut runtime = state
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if runtime.handle.is_some() {
        return;
    }
    let Some(token) = config.token.clone() else {
        runtime.last_error = Some("Local API token is not configured".to_string());
        return;
    };
    match start_runtime(app.clone(), config.port, token, state.write_lock.clone()) {
        Ok(handle) => {
            runtime.handle = Some(handle);
            runtime.last_error = None;
        }
        Err(error) => {
            log::warn!("{error}");
            runtime.last_error = Some(error);
        }
    }
}

#[tauri::command]
pub(crate) fn get_local_api_server_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalApiServerState>,
) -> Result<LocalApiServerStatus, String> {
    let config = read_local_api_config(&app);
    let config = ensure_local_api_token(&app, config.clone(), config.enabled)?;
    let runtime = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(status_from_runtime(config, &runtime))
}

#[tauri::command]
pub(crate) fn set_local_api_server_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalApiServerState>,
    enabled: bool,
    port: Option<u16>,
) -> Result<LocalApiServerStatus, String> {
    let port = normalize_local_api_port(port)?;
    let current_config = ensure_local_api_token(&app, read_local_api_config(&app), enabled)?;
    let token = current_config.token.clone();
    let mut runtime = state.inner.lock().map_err(|e| e.to_string())?;

    if enabled {
        let token_for_runtime = token
            .clone()
            .ok_or_else(|| "Local API token is not configured".to_string())?;
        if runtime.handle.as_ref().map(|handle| handle.port) != Some(port) {
            stop_runtime(&mut runtime);
            match start_runtime(
                app.clone(),
                port,
                token_for_runtime.clone(),
                state.write_lock.clone(),
            ) {
                Ok(handle) => {
                    runtime.handle = Some(handle);
                    runtime.last_error = None;
                }
                Err(error) => {
                    runtime.last_error = Some(error.clone());
                    let _ = write_local_api_config(
                        &app,
                        LocalApiConfig {
                            enabled: false,
                            port,
                            token: token.clone(),
                        },
                    );
                    return Ok(status_from_runtime(
                        LocalApiConfig {
                            enabled: false,
                            port,
                            token,
                        },
                        &runtime,
                    ));
                }
            }
        }
    } else {
        stop_runtime(&mut runtime);
        runtime.last_error = None;
    }

    let config = LocalApiConfig {
        enabled,
        port,
        token,
    };
    write_local_api_config(&app, config.clone())?;
    Ok(status_from_runtime(config, &runtime))
}

fn handle_connection(
    app: tauri::AppHandle,
    token: String,
    write_lock: Arc<Mutex<()>>,
    mut stream: TcpStream,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let response = match read_request(&mut stream) {
        Ok(Some(request)) => handle_api_request(&app, &token, &write_lock, request),
        Ok(None) => return,
        Err(error) => ApiResponse::error(400, error),
    };
    let _ = write_response(&mut stream, response);
}

fn read_request(stream: &mut TcpStream) -> Result<Option<ApiRequest>, String> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut temp = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if read == 0 {
            if buffer.is_empty() {
                return Ok(None);
            }
            return Err("Incomplete HTTP request".to_string());
        }
        buffer.extend_from_slice(&temp[..read]);
        if buffer.len() > REQUEST_HEADER_LIMIT_BYTES + REQUEST_BODY_LIMIT_BYTES {
            return Err("Request too large".to_string());
        }
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > REQUEST_HEADER_LIMIT_BYTES {
            return Err("Request headers too large".to_string());
        }
    };

    let header_bytes = &buffer[..header_end];
    let header_text = std::str::from_utf8(header_bytes)
        .map_err(|_| "Invalid HTTP header encoding".to_string())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing HTTP request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP method".to_string())?
        .to_ascii_uppercase();
    let target = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP target".to_string())?;
    let (path, query) = parse_request_target(target);

    let mut content_length = 0_usize;
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let header_name = name.trim().to_ascii_lowercase();
        let header_value = value.trim().to_string();
        if header_name == "content-length" {
            content_length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| "Invalid Content-Length".to_string())?;
        }
        headers.insert(header_name, header_value);
    }
    if content_length > REQUEST_BODY_LIMIT_BYTES {
        return Err("Request body too large".to_string());
    }

    let body_start = header_end + 4;
    while buffer.len().saturating_sub(body_start) < content_length {
        let read = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("Incomplete HTTP request body".to_string());
        }
        buffer.extend_from_slice(&temp[..read]);
    }
    let body = buffer[body_start..body_start + content_length].to_vec();

    Ok(Some(ApiRequest {
        method,
        path,
        query,
        headers,
        body,
    }))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_request_target(target: &str) -> (String, HashMap<String, String>) {
    let (path_raw, query_raw) = target.split_once('?').unwrap_or((target, ""));
    let path = percent_decode(path_raw).unwrap_or_else(|| path_raw.to_string());
    let mut query = HashMap::new();
    for pair in query_raw.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode(key).unwrap_or_else(|| key.to_string());
        let value = percent_decode(value).unwrap_or_else(|| value.to_string());
        query.insert(key, value);
    }
    (path, query)
}

fn write_response(stream: &mut TcpStream, response: ApiResponse) -> Result<(), String> {
    let raw = http_response(&response);
    stream.write_all(raw.as_bytes()).map_err(|e| e.to_string())
}

fn http_response(response: &ApiResponse) -> String {
    let status_text = match response.status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let body = serde_json::to_string_pretty(&response.body).unwrap_or_else(|_| "{}".to_string());
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response.status,
        status_text,
        body.len(),
        body,
    )
}

fn handle_api_request(
    app: &tauri::AppHandle,
    token: &str,
    write_lock: &Arc<Mutex<()>>,
    request: ApiRequest,
) -> ApiResponse {
    if request.method == "OPTIONS" {
        return ApiResponse::ok(json!({ "ok": true }));
    }
    if !is_request_authorized(&request, token) {
        return ApiResponse::error(401, "Unauthorized");
    }

    match route_api_request(app, write_lock, request) {
        Ok(response) => response,
        Err(error) => api_error_response(error),
    }
}

fn is_request_authorized(request: &ApiRequest, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    request
        .headers
        .get("authorization")
        .map(|value| value.trim() == expected)
        .unwrap_or(false)
}

fn api_error_response(error: String) -> ApiResponse {
    if error == "Task not found" {
        return ApiResponse::error(404, error);
    }
    if error.starts_with("Invalid ")
        || error.starts_with("Task title")
        || error.starts_with("Request ")
    {
        return ApiResponse::error(400, error);
    }
    ApiResponse::error(500, error)
}

fn route_api_request(
    app: &tauri::AppHandle,
    write_lock: &Arc<Mutex<()>>,
    request: ApiRequest,
) -> Result<ApiResponse, String> {
    let segments = path_segments(&request.path);

    if request.method == "GET" && request.path == "/health" {
        return Ok(ApiResponse::ok(json!({ "ok": true })));
    }

    if request.method == "GET" && request.path == "/tasks" {
        let data = load_data_snapshot(app)?;
        let tasks = filter_tasks(array_items(&data, "tasks"), &request.query)?;
        return Ok(ApiResponse::ok(json!({ "tasks": tasks })));
    }

    if request.method == "GET" && request.path == "/projects" {
        let data = load_data_snapshot(app)?;
        let projects = array_items(&data, "projects")
            .into_iter()
            .filter(|project| !has_string_field(project, "deletedAt"))
            .collect::<Vec<_>>();
        return Ok(ApiResponse::ok(json!({ "projects": projects })));
    }

    if request.method == "GET" && (request.path == "/areas" || request.path == "/v1/areas") {
        let data = load_data_snapshot(app)?;
        let areas = array_items(&data, "areas")
            .into_iter()
            .filter(|area| !has_string_field(area, "deletedAt"))
            .collect::<Vec<_>>();
        return Ok(ApiResponse::ok(json!({ "areas": areas })));
    }

    if request.method == "GET" && request.path == "/search" {
        let data = load_data_snapshot(app)?;
        let query = request.query.get("query").cloned().unwrap_or_default();
        return Ok(ApiResponse::ok(search_data(&data, &query)));
    }

    if segments.len() == 2 && segments[0] == "tasks" && request.method == "GET" {
        let data = load_data_snapshot(app)?;
        let task = find_task(&data, &segments[1]).ok_or_else(|| "Task not found".to_string())?;
        return Ok(ApiResponse::ok(json!({ "task": task })));
    }

    if request.method == "POST" && request.path == "/tasks" {
        let _guard = write_lock.lock().map_err(|e| e.to_string())?;
        let mut data = load_data_snapshot(app)?;
        let body = parse_body_object(&request.body)?;
        let device_id = device_id_from_data(&data);
        let task = create_task_from_body(&body, &device_id)?;
        ensure_array_mut(&mut data, "tasks")?.push(Value::Object(task.clone()));
        persist_data_snapshot_with_retries(app, &data)?;
        return Ok(ApiResponse::created(json!({ "task": Value::Object(task) })));
    }

    if segments.len() == 2 && segments[0] == "tasks" && request.method == "PATCH" {
        let _guard = write_lock.lock().map_err(|e| e.to_string())?;
        let mut data = load_data_snapshot(app)?;
        let device_id = device_id_from_data(&data);
        let body = parse_body_object(&request.body)?;
        let task = update_task_in_data(&mut data, &segments[1], |task| {
            apply_task_patch(task, &body, &device_id)
        })?;
        persist_data_snapshot_with_retries(app, &data)?;
        return Ok(ApiResponse::ok(json!({ "task": task })));
    }

    if segments.len() == 2 && segments[0] == "tasks" && request.method == "DELETE" {
        let _guard = write_lock.lock().map_err(|e| e.to_string())?;
        let mut data = load_data_snapshot(app)?;
        let device_id = device_id_from_data(&data);
        update_task_in_data(&mut data, &segments[1], |task| {
            let now = now_iso();
            task.insert("deletedAt".to_string(), Value::String(now.clone()));
            task.insert("updatedAt".to_string(), Value::String(now));
            bump_task_revision(task, &device_id);
            Ok(())
        })?;
        persist_data_snapshot_with_retries(app, &data)?;
        return Ok(ApiResponse::ok(json!({ "ok": true })));
    }

    if segments.len() == 3 && segments[0] == "tasks" && request.method == "POST" {
        let action = segments[2].as_str();
        if !matches!(action, "complete" | "archive" | "restore") {
            return Ok(ApiResponse::error(404, "Not found"));
        }
        let _guard = write_lock.lock().map_err(|e| e.to_string())?;
        let mut data = load_data_snapshot(app)?;
        let device_id = device_id_from_data(&data);
        let mut recurring_follow_up: Option<Map<String, Value>> = None;
        let task = update_task_in_data(&mut data, &segments[1], |task| {
            let now = now_iso();
            let previous_task = task.clone();
            let previous_status = task
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or("inbox")
                .to_string();
            if action == "complete" {
                task.insert("status".to_string(), Value::String("done".to_string()));
                task.insert("completedAt".to_string(), Value::String(now.clone()));
                task.insert("isFocusedToday".to_string(), Value::Bool(false));
                if should_create_recurring_follow_up(action, &previous_status) {
                    recurring_follow_up = create_next_recurring_task_for_local_api(
                        &previous_task,
                        &now,
                        &previous_status,
                    );
                }
            } else if action == "archive" {
                task.insert("status".to_string(), Value::String("archived".to_string()));
                task.entry("completedAt".to_string())
                    .or_insert_with(|| Value::String(now.clone()));
                task.insert("isFocusedToday".to_string(), Value::Bool(false));
            } else {
                task.remove("deletedAt");
                task.remove("purgedAt");
            }
            task.insert("updatedAt".to_string(), Value::String(now));
            bump_task_revision(task, &device_id);
            Ok(())
        })?;
        if let Some(next_task) = recurring_follow_up {
            ensure_array_mut(&mut data, "tasks")?.push(Value::Object(next_task));
        }
        persist_data_snapshot_with_retries(app, &data)?;
        return Ok(ApiResponse::ok(json!({ "task": task })));
    }

    Ok(ApiResponse::error(404, "Not found"))
}

fn path_segments(path: &str) -> Vec<String> {
    path.trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| percent_decode(segment).unwrap_or_else(|| segment.to_string()))
        .collect()
}

fn array_items(data: &Value, key: &str) -> Vec<Value> {
    data.get(key)
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
}

fn ensure_array_mut<'a>(data: &'a mut Value, key: &str) -> Result<&'a mut Vec<Value>, String> {
    let object = data
        .as_object_mut()
        .ok_or_else(|| "Local data snapshot is invalid".to_string())?;
    let entry = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !entry.is_array() {
        *entry = Value::Array(Vec::new());
    }
    entry
        .as_array_mut()
        .ok_or_else(|| "Local data snapshot is invalid".to_string())
}

fn has_string_field(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .is_some_and(|field| !field.trim().is_empty())
}

fn filter_tasks(tasks: Vec<Value>, query: &HashMap<String, String>) -> Result<Vec<Value>, String> {
    let include_all = query.get("all").map(|value| value == "1").unwrap_or(false);
    let include_deleted = query
        .get("deleted")
        .map(|value| value == "1")
        .unwrap_or(false);
    let status = query
        .get("status")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    if let Some(status) = status {
        validate_task_status(status)?;
    }
    let text_query = query
        .get("query")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    let filtered = tasks
        .into_iter()
        .filter(|task| include_deleted || !has_string_field(task, "deletedAt"))
        .filter(|task| {
            if include_all {
                return true;
            }
            let status = task
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            status != "done" && status != "archived"
        })
        .filter(|task| {
            status
                .map(|target| task.get("status").and_then(|value| value.as_str()) == Some(target))
                .unwrap_or(true)
        })
        .filter(|task| {
            text_query
                .as_ref()
                .map(|target| value_search_text(task).contains(target))
                .unwrap_or(true)
        })
        .collect();
    Ok(filtered)
}

fn search_data(data: &Value, query: &str) -> Value {
    let target = query.trim().to_ascii_lowercase();
    if target.is_empty() {
        return json!({ "tasks": [], "projects": [] });
    }
    let tasks = array_items(data, "tasks")
        .into_iter()
        .filter(|task| !has_string_field(task, "deletedAt"))
        .filter(|task| value_search_text(task).contains(&target))
        .collect::<Vec<_>>();
    let projects = array_items(data, "projects")
        .into_iter()
        .filter(|project| !has_string_field(project, "deletedAt"))
        .filter(|project| value_search_text(project).contains(&target))
        .collect::<Vec<_>>();
    json!({ "tasks": tasks, "projects": projects })
}

fn value_search_text(value: &Value) -> String {
    [
        "title",
        "description",
        "status",
        "tags",
        "contexts",
        "projectId",
        "areaId",
        "name",
        "supportNotes",
    ]
    .iter()
    .filter_map(|key| value.get(*key))
    .map(|field| {
        field
            .as_str()
            .map(|raw| raw.to_string())
            .unwrap_or_else(|| field.to_string())
    })
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase()
}

fn find_task(data: &Value, task_id: &str) -> Option<Value> {
    data.get("tasks")?
        .as_array()?
        .iter()
        .find(|task| task.get("id").and_then(|value| value.as_str()) == Some(task_id))
        .cloned()
}

fn update_task_in_data<F>(data: &mut Value, task_id: &str, update: F) -> Result<Value, String>
where
    F: FnOnce(&mut Map<String, Value>) -> Result<(), String>,
{
    let tasks = ensure_array_mut(data, "tasks")?;
    let task = tasks
        .iter_mut()
        .find(|task| task.get("id").and_then(|value| value.as_str()) == Some(task_id))
        .ok_or_else(|| "Task not found".to_string())?;
    let task_object = task
        .as_object_mut()
        .ok_or_else(|| "Task is invalid".to_string())?;
    update(task_object)?;
    Ok(Value::Object(task_object.clone()))
}

fn parse_body_object(body: &[u8]) -> Result<Map<String, Value>, String> {
    if body.is_empty() {
        return Err("Invalid JSON body".to_string());
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid JSON body".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "Invalid JSON body".to_string())
}

fn device_id_from_data(data: &Value) -> String {
    data.get("settings")
        .and_then(|settings| settings.get("deviceId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(LOCAL_API_REV_BY)
        .to_string()
}

fn next_revision(value: Option<&Value>) -> i64 {
    let current = value
        .and_then(|value| value.as_i64())
        .filter(|value| *value >= 0)
        .unwrap_or(0);
    if current >= MAX_SYNC_REVISION {
        MAX_SYNC_REVISION
    } else {
        current + 1
    }
}

fn bump_task_revision(task: &mut Map<String, Value>, device_id: &str) {
    task.insert(
        "rev".to_string(),
        Value::Number(next_revision(task.get("rev")).into()),
    );
    task.insert("revBy".to_string(), Value::String(device_id.to_string()));
}

fn create_next_recurring_task_for_local_api(
    task: &Map<String, Value>,
    completed_at: &str,
    previous_status: &str,
) -> Option<Map<String, Value>> {
    let rule = recurrence_rule(task)?;
    let interval = recurrence_interval(task);
    let strategy = recurrence_strategy(task);
    let completed_occurrences = recurrence_completed_occurrences(task).unwrap_or(0);
    if let Some(count) = recurrence_count(task) {
        if completed_occurrences + 1 >= count {
            return None;
        }
    }

    let strict_anchors = strategy != "fluid";
    let due_anchor_day = strict_anchors
        .then(|| recurrence_anchor_day_for_field(task, "dueAnchorDay", "dueDate"))
        .flatten();
    let start_anchor_day = strict_anchors
        .then(|| recurrence_anchor_day_for_field(task, "startAnchorDay", "startTime"))
        .flatten();
    let review_anchor_day = strict_anchors
        .then(|| recurrence_anchor_day_for_field(task, "reviewAnchorDay", "reviewAt"))
        .flatten();
    let next_due_date = task
        .get("dueDate")
        .and_then(|value| value.as_str())
        .and_then(|value| {
            next_recurring_iso(
                value,
                completed_at,
                rule,
                strategy,
                interval,
                due_anchor_day,
            )
        });
    let mut next_start_time = task
        .get("startTime")
        .and_then(|value| value.as_str())
        .and_then(|value| {
            next_recurring_iso(
                value,
                completed_at,
                rule,
                strategy,
                interval,
                start_anchor_day,
            )
        });
    let next_review_at = task
        .get("reviewAt")
        .and_then(|value| value.as_str())
        .and_then(|value| {
            next_recurring_iso(
                value,
                completed_at,
                rule,
                strategy,
                interval,
                review_anchor_day,
            )
        });

    if next_start_time.is_none() && next_due_date.is_none() && next_review_at.is_none() {
        next_start_time =
            next_recurring_iso(completed_at, completed_at, rule, "fluid", interval, None);
    }

    let next_occurrence_anchor = next_due_date
        .as_deref()
        .or(next_start_time.as_deref())
        .or(next_review_at.as_deref());
    if recurrence_until(task)
        .as_deref()
        .is_some_and(|until| should_stop_at_until(next_occurrence_anchor, until))
    {
        return None;
    }

    let mut next_task = Map::new();
    next_task.insert("id".to_string(), Value::String(generate_uuid_v4()));
    next_task.insert(
        "title".to_string(),
        task.get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("Untitled")
            .to_string()
            .into(),
    );
    let next_status = if previous_status == "done" || previous_status == "archived" {
        "next"
    } else {
        previous_status
    };
    next_task.insert("status".to_string(), Value::String(next_status.to_string()));
    copy_task_fields(
        task,
        &mut next_task,
        &[
            "priority",
            "energyLevel",
            "assignedTo",
            "description",
            "location",
            "projectId",
            "sectionId",
            "areaId",
            "timeEstimate",
        ],
    );
    if let Some(value) = next_start_time {
        next_task.insert("startTime".to_string(), Value::String(value));
    }
    if let Some(value) = next_due_date {
        next_task.insert("dueDate".to_string(), Value::String(value));
    }
    if let Some(value) = next_review_at {
        next_task.insert("reviewAt".to_string(), Value::String(value));
    }
    if let Some(recurrence) = next_recurrence_value(task, completed_occurrences + 1, rule) {
        next_task.insert("recurrence".to_string(), recurrence);
    }
    if task
        .get("showFutureRecurrence")
        .and_then(|value| value.as_bool())
        == Some(true)
    {
        next_task.insert("showFutureRecurrence".to_string(), Value::Bool(true));
    }
    if task
        .get("suppressMindwtrReminders")
        .and_then(|value| value.as_bool())
        == Some(true)
    {
        next_task.insert("suppressMindwtrReminders".to_string(), Value::Bool(true));
    }
    next_task.insert(
        "tags".to_string(),
        task.get("tags")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    next_task.insert(
        "contexts".to_string(),
        task.get("contexts")
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    if let Some(checklist) = reset_checklist_value(task.get("checklist")) {
        next_task.insert("checklist".to_string(), checklist);
    }
    if let Some(attachments) = duplicate_attachment_value(task.get("attachments"), completed_at) {
        next_task.insert("attachments".to_string(), attachments);
    }
    next_task.insert("isFocusedToday".to_string(), Value::Bool(false));
    next_task.insert(
        "createdAt".to_string(),
        Value::String(completed_at.to_string()),
    );
    next_task.insert(
        "updatedAt".to_string(),
        Value::String(completed_at.to_string()),
    );
    Some(next_task)
}

fn should_create_recurring_follow_up(action: &str, previous_status: &str) -> bool {
    action == "complete" && previous_status != "done"
}

fn recurrence_value(task: &Map<String, Value>) -> Option<&Value> {
    task.get("recurrence")
}

fn recurrence_rule(task: &Map<String, Value>) -> Option<&str> {
    match recurrence_value(task)? {
        Value::String(value) if is_recurrence_rule(value) => Some(value.as_str()),
        Value::Object(value) => value
            .get("rule")
            .and_then(|rule| rule.as_str())
            .filter(|rule| is_recurrence_rule(rule)),
        _ => None,
    }
}

fn is_recurrence_rule(value: &str) -> bool {
    matches!(value, "daily" | "weekly" | "monthly" | "yearly")
}

fn recurrence_strategy(task: &Map<String, Value>) -> &str {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("strategy")
            .and_then(|strategy| strategy.as_str())
            .filter(|strategy| *strategy == "fluid")
            .unwrap_or("strict"),
        _ => "strict",
    }
}

fn recurrence_interval(task: &Map<String, Value>) -> i64 {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("interval")
            .and_then(|interval| interval.as_i64())
            .filter(|interval| *interval > 0)
            .unwrap_or(1),
        _ => 1,
    }
}

fn recurrence_count(task: &Map<String, Value>) -> Option<i64> {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("count")
            .and_then(|count| count.as_i64())
            .filter(|count| *count > 0),
        _ => None,
    }
}

fn recurrence_completed_occurrences(task: &Map<String, Value>) -> Option<i64> {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("completedOccurrences")
            .and_then(|count| count.as_i64())
            .filter(|count| *count >= 0),
        _ => None,
    }
}

fn recurrence_until(task: &Map<String, Value>) -> Option<String> {
    match recurrence_value(task) {
        Some(Value::Object(value)) => value
            .get("until")
            .and_then(|until| until.as_str())
            .map(str::to_string),
        _ => None,
    }
}

fn normalized_anchor_day(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(|value| value.as_i64())
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| (1..=31).contains(value))
}

fn recurrence_anchor_day_value(task: &Map<String, Value>, key: &str) -> Option<u32> {
    match recurrence_value(task) {
        Some(Value::Object(value)) => normalized_anchor_day(value.get(key)),
        _ => None,
    }
}

fn iso_day(value: &str) -> Option<u32> {
    parse_iso_prefix(value).map(|(_, _, day, _)| day)
}

fn recurrence_anchor_day_for_field(
    task: &Map<String, Value>,
    field_anchor_key: &str,
    field_key: &str,
) -> Option<u32> {
    recurrence_anchor_day_value(task, field_anchor_key)
        .or_else(|| recurrence_anchor_day_value(task, "anchorDay"))
        .or_else(|| {
            task.get(field_key)
                .and_then(|value| value.as_str())
                .and_then(iso_day)
        })
}

fn next_recurrence_anchor_days(task: &Map<String, Value>, rule: &str) -> Map<String, Value> {
    let mut anchors = Map::new();
    if rule != "monthly" && rule != "yearly" {
        return anchors;
    }

    let start_anchor_day = recurrence_anchor_day_for_field(task, "startAnchorDay", "startTime");
    let due_anchor_day = recurrence_anchor_day_for_field(task, "dueAnchorDay", "dueDate");
    let review_anchor_day = recurrence_anchor_day_for_field(task, "reviewAnchorDay", "reviewAt");
    let anchor_day = recurrence_anchor_day_value(task, "anchorDay")
        .or(due_anchor_day)
        .or(start_anchor_day)
        .or(review_anchor_day);

    if let Some(value) = anchor_day {
        anchors.insert("anchorDay".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = start_anchor_day {
        anchors.insert("startAnchorDay".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = due_anchor_day {
        anchors.insert("dueAnchorDay".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = review_anchor_day {
        anchors.insert("reviewAnchorDay".to_string(), Value::Number(value.into()));
    }
    anchors
}

fn next_recurrence_value(
    task: &Map<String, Value>,
    completed_occurrences: i64,
    rule: &str,
) -> Option<Value> {
    let anchor_days = next_recurrence_anchor_days(task, rule);
    match recurrence_value(task)? {
        Value::Object(value) => {
            let mut next = value.clone();
            for (key, value) in anchor_days {
                next.insert(key, value);
            }
            if value
                .get("count")
                .and_then(|count| count.as_i64())
                .is_some()
            {
                next.insert(
                    "completedOccurrences".to_string(),
                    Value::Number(serde_json::Number::from(completed_occurrences)),
                );
            }
            Some(Value::Object(next))
        }
        Value::String(value) if !anchor_days.is_empty() => {
            let mut next = anchor_days;
            next.insert("rule".to_string(), Value::String(value.clone()));
            Some(Value::Object(next))
        }
        value => Some(value.clone()),
    }
}

fn next_recurring_iso(
    source_iso: &str,
    completed_at: &str,
    rule: &str,
    strategy: &str,
    interval: i64,
    anchor_day: Option<u32>,
) -> Option<String> {
    let base_iso = if strategy == "fluid" {
        completed_at
    } else {
        source_iso
    };
    let (year, month, day, suffix) = parse_iso_prefix(base_iso)?;
    let (next_year, next_month, next_day) = match rule {
        "daily" => add_days(year, month, day, interval),
        "weekly" => add_days(year, month, day, interval.saturating_mul(7)),
        "monthly" => add_months(year, month, anchor_day.unwrap_or(day), interval),
        "yearly" => add_months(
            year,
            month,
            anchor_day.unwrap_or(day),
            interval.saturating_mul(12),
        ),
        _ => return None,
    };
    Some(format!(
        "{next_year:04}-{next_month:02}-{next_day:02}{suffix}"
    ))
}

fn parse_iso_prefix(value: &str) -> Option<(i32, u32, u32, &str)> {
    if value.len() < 10 || &value[4..5] != "-" || &value[7..8] != "-" {
        return None;
    }
    let year = value[0..4].parse::<i32>().ok()?;
    let month = value[5..7].parse::<u32>().ok()?;
    let day = value[8..10].parse::<u32>().ok()?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    Some((year, month, day, &value[10..]))
}

fn add_days(year: i32, month: u32, day: u32, days: i64) -> (i32, u32, u32) {
    civil_from_days(days_from_civil(year, month, day).saturating_add(days))
}

fn add_months(year: i32, month: u32, day: u32, months: i64) -> (i32, u32, u32) {
    let total_months = i64::from(year)
        .saturating_mul(12)
        .saturating_add(i64::from(month) - 1)
        .saturating_add(months);
    let next_year = total_months.div_euclid(12) as i32;
    let next_month = total_months.rem_euclid(12) as u32 + 1;
    let next_day = day.min(days_in_month(next_year, next_month));
    (next_year, next_month, next_day)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 30,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let mut y = i64::from(year);
    let m = i64::from(month);
    let d = i64::from(day);
    y -= if m <= 2 { 1 } else { 0 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let month_adjusted = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * month_adjusted + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn should_stop_at_until(next_iso: Option<&str>, until: &str) -> bool {
    let Some(next_iso) = next_iso else {
        return false;
    };
    if until.len() == 10 {
        return next_iso
            .get(0..10)
            .is_some_and(|next_date| next_date > until);
    }
    next_iso > until
}

fn copy_task_fields(source: &Map<String, Value>, target: &mut Map<String, Value>, keys: &[&str]) {
    for key in keys {
        if let Some(value) = source.get(*key).filter(|value| !value.is_null()) {
            target.insert((*key).to_string(), value.clone());
        }
    }
}

fn reset_checklist_value(value: Option<&Value>) -> Option<Value> {
    let checklist = value?.as_array()?;
    if checklist.is_empty() {
        return None;
    }
    Some(Value::Array(
        checklist
            .iter()
            .filter_map(|item| {
                let mut item = item.as_object()?.clone();
                item.insert("id".to_string(), Value::String(generate_uuid_v4()));
                item.insert("isCompleted".to_string(), Value::Bool(false));
                Some(Value::Object(item))
            })
            .collect(),
    ))
}

fn duplicate_attachment_value(value: Option<&Value>, timestamp: &str) -> Option<Value> {
    let attachments = value?.as_array()?;
    let duplicated = attachments
        .iter()
        .filter_map(|attachment| {
            if has_string_field(attachment, "deletedAt") {
                return None;
            }
            let mut attachment = attachment.as_object()?.clone();
            attachment.insert("id".to_string(), Value::String(generate_uuid_v4()));
            attachment.insert(
                "createdAt".to_string(),
                Value::String(timestamp.to_string()),
            );
            attachment.insert(
                "updatedAt".to_string(),
                Value::String(timestamp.to_string()),
            );
            attachment.remove("deletedAt");
            Some(Value::Object(attachment))
        })
        .collect::<Vec<_>>();
    if duplicated.is_empty() {
        None
    } else {
        Some(Value::Array(duplicated))
    }
}

fn create_task_from_body(
    body: &Map<String, Value>,
    device_id: &str,
) -> Result<Map<String, Value>, String> {
    let input = body
        .get("input")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    let title = body
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    let resolved_title = if title.is_empty() { input } else { title };
    if resolved_title.is_empty() {
        return Err("Task title is required".to_string());
    }

    let mut task = body
        .get("props")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    sanitize_task_patch_map(&mut task)?;
    let now = now_iso();
    task.insert("id".to_string(), Value::String(generate_uuid_v4()));
    task.insert(
        "title".to_string(),
        Value::String(resolved_title.to_string()),
    );
    task.entry("status".to_string())
        .or_insert_with(|| Value::String("inbox".to_string()));
    task.insert("createdAt".to_string(), Value::String(now.clone()));
    task.insert("updatedAt".to_string(), Value::String(now));
    task.insert("rev".to_string(), Value::Number(1.into()));
    task.insert("revBy".to_string(), Value::String(device_id.to_string()));
    Ok(task)
}

fn apply_task_patch(
    task: &mut Map<String, Value>,
    patch: &Map<String, Value>,
    device_id: &str,
) -> Result<(), String> {
    let mut sanitized = patch.clone();
    sanitize_task_patch_map(&mut sanitized)?;
    for (key, value) in sanitized {
        if value.is_null() {
            task.remove(&key);
        } else {
            task.insert(key, value);
        }
    }
    task.insert("updatedAt".to_string(), Value::String(now_iso()));
    bump_task_revision(task, device_id);
    Ok(())
}

fn sanitize_task_patch_map(patch: &mut Map<String, Value>) -> Result<(), String> {
    for key in [
        "id",
        "createdAt",
        "updatedAt",
        "rev",
        "revBy",
        "deletedAt",
        "purgedAt",
    ] {
        patch.remove(key);
    }
    if let Some(status) = patch.get("status").and_then(|value| value.as_str()) {
        validate_task_status(status)?;
    }
    Ok(())
}

fn validate_task_status(status: &str) -> Result<(), String> {
    match status {
        "inbox" | "next" | "waiting" | "someday" | "reference" | "done" | "archived" => Ok(()),
        _ => Err(format!("Invalid status: {status}")),
    }
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hi = bytes.get(index + 1).and_then(|value| hex_value(*value))?;
            let lo = bytes.get(index + 2).and_then(|value| hex_value(*value))?;
            decoded.push((hi << 4) | lo);
            index += 3;
        } else if bytes[index] == b'+' {
            decoded.push(b' ');
            index += 1;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_default_local_api_port() {
        assert_eq!(
            normalize_local_api_port(None).unwrap(),
            DEFAULT_LOCAL_API_PORT
        );
        assert!(normalize_local_api_port(Some(80)).is_err());
    }

    #[test]
    fn parses_request_target_query_values() {
        let (path, query) = parse_request_target("/tasks?query=call+mom&status=next");
        assert_eq!(path, "/tasks");
        assert_eq!(query.get("query").map(String::as_str), Some("call mom"));
        assert_eq!(query.get("status").map(String::as_str), Some("next"));
    }

    #[test]
    fn filters_active_tasks_by_default() {
        let tasks = vec![
            json!({ "id": "1", "title": "A", "status": "next" }),
            json!({ "id": "2", "title": "B", "status": "done" }),
            json!({ "id": "3", "title": "C", "status": "next", "deletedAt": "now" }),
        ];
        let filtered = filter_tasks(tasks, &HashMap::new()).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(
            filtered[0].get("id").and_then(|value| value.as_str()),
            Some("1")
        );
    }

    #[test]
    fn local_api_requires_bearer_token() {
        let mut headers = HashMap::new();
        headers.insert("authorization".to_string(), "Bearer secret".to_string());
        let authorized = ApiRequest {
            method: "GET".to_string(),
            path: "/tasks".to_string(),
            query: HashMap::new(),
            headers,
            body: Vec::new(),
        };
        let unauthorized = ApiRequest {
            method: "GET".to_string(),
            path: "/tasks".to_string(),
            query: HashMap::new(),
            headers: HashMap::new(),
            body: Vec::new(),
        };

        assert!(is_request_authorized(&authorized, "secret"));
        assert!(!is_request_authorized(&unauthorized, "secret"));
    }

    #[test]
    fn local_api_response_does_not_enable_wildcard_cors() {
        let response = ApiResponse::ok(json!({ "ok": true }));
        let raw = http_response(&response);

        assert!(!raw.contains("Access-Control-Allow-Origin"));
        assert!(!raw.contains("Access-Control-Allow-Methods"));
    }

    #[test]
    fn local_api_tasks_include_revision_metadata() {
        let mut body = Map::new();
        body.insert("input".to_string(), Value::String("Call Alice".to_string()));

        let task = create_task_from_body(&body, "device-a").expect("task");

        assert_eq!(task.get("rev").and_then(|value| value.as_i64()), Some(1));
        assert_eq!(
            task.get("revBy").and_then(|value| value.as_str()),
            Some("device-a")
        );
    }

    fn comparable_local_api_recurring_task(task: Option<Map<String, Value>>) -> Value {
        let Some(task) = task else {
            return Value::Null;
        };
        let mut comparable = Map::new();
        for key in ["status", "startTime", "dueDate", "reviewAt", "recurrence"] {
            if let Some(value) = task.get(key) {
                comparable.insert(key.to_string(), value.clone());
            }
        }
        Value::Object(comparable)
    }

    #[test]
    fn local_api_recurring_task_matches_core_golden_fixture() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/recurrence-local-api-parity.fixtures.json"
        ))
        .expect("valid recurrence parity fixture");
        let cases = cases.as_array().expect("fixture array");

        for test_case in cases {
            let name = test_case
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("unnamed recurrence parity case");
            let task = test_case
                .get("task")
                .and_then(|value| value.as_object())
                .unwrap_or_else(|| panic!("missing task object for {name}"));
            let completed_at = test_case
                .get("completedAt")
                .and_then(|value| value.as_str())
                .unwrap_or_else(|| panic!("missing completedAt for {name}"));
            let previous_status = test_case
                .get("previousStatus")
                .and_then(|value| value.as_str())
                .unwrap_or_else(|| panic!("missing previousStatus for {name}"));
            let expected = test_case
                .get("expected")
                .unwrap_or_else(|| panic!("missing expected snapshot for {name}"));

            let actual = comparable_local_api_recurring_task(
                create_next_recurring_task_for_local_api(task, completed_at, previous_status),
            );
            assert_eq!(&actual, expected, "{name}");
        }
    }

    #[test]
    fn local_api_complete_creates_next_recurring_task_payload() {
        let task = json!({
            "id": "task-1",
            "title": "Water plants",
            "status": "next",
            "dueDate": "2026-06-14",
            "recurrence": { "rule": "daily", "count": 3, "completedOccurrences": 0 },
            "tags": ["#home"],
            "contexts": ["@home"],
            "checklist": [
                { "id": "item-1", "title": "Kitchen", "isCompleted": true }
            ],
            "createdAt": "2026-06-01T00:00:00Z",
            "updatedAt": "2026-06-01T00:00:00Z"
        });
        let next = create_next_recurring_task_for_local_api(
            task.as_object().expect("task object"),
            "2026-06-14T12:00:00Z",
            "next",
        )
        .expect("next recurring task");

        assert_ne!(
            next.get("id").and_then(|value| value.as_str()),
            Some("task-1")
        );
        assert_eq!(
            next.get("status").and_then(|value| value.as_str()),
            Some("next")
        );
        assert_eq!(
            next.get("dueDate").and_then(|value| value.as_str()),
            Some("2026-06-15")
        );
        assert_eq!(
            next.get("recurrence")
                .and_then(|value| value.get("completedOccurrences"))
                .and_then(|value| value.as_i64()),
            Some(1)
        );
        let checklist = next
            .get("checklist")
            .and_then(|value| value.as_array())
            .expect("checklist");
        assert_eq!(
            checklist[0]
                .get("isCompleted")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_ne!(
            checklist[0].get("id").and_then(|value| value.as_str()),
            Some("item-1")
        );
    }

    #[test]
    fn local_api_complete_does_not_repeat_done_recurring_tasks() {
        assert!(should_create_recurring_follow_up("complete", "next"));
        assert!(should_create_recurring_follow_up("complete", "archived"));
        assert!(!should_create_recurring_follow_up("complete", "done"));
        assert!(!should_create_recurring_follow_up("archive", "next"));
    }

    #[test]
    fn local_api_recurring_task_stops_when_count_is_exhausted() {
        let task = json!({
            "id": "task-1",
            "title": "Water plants",
            "status": "next",
            "dueDate": "2026-06-14",
            "recurrence": { "rule": "daily", "count": 1, "completedOccurrences": 0 },
            "tags": [],
            "contexts": []
        });

        assert!(create_next_recurring_task_for_local_api(
            task.as_object().expect("task object"),
            "2026-06-14T12:00:00Z",
            "next",
        )
        .is_none());
    }
}
