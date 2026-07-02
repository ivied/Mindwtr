use crate::*;

fn strip_file_scheme(raw: &str) -> Result<String, String> {
    if !raw.to_ascii_lowercase().starts_with("file://") {
        return Ok(raw.to_string());
    }

    let without_scheme = &raw[7..];
    if without_scheme.starts_with('/') {
        #[cfg(target_os = "windows")]
        {
            let without_leading_slash = without_scheme.trim_start_matches('/');
            if without_leading_slash.as_bytes().get(1) == Some(&b':') {
                return Ok(without_leading_slash.to_string());
            }
        }
        return Ok(without_scheme.to_string());
    }

    Err("Only local file paths can be opened.".to_string())
}

fn canonical_existing_dir(path: PathBuf) -> Option<PathBuf> {
    path.canonicalize()
        .ok()
        .filter(|candidate| candidate.is_dir())
}

fn configured_obsidian_vault_path(config: &AppConfigToml) -> Option<PathBuf> {
    #[derive(Deserialize, Default)]
    struct VaultPathOnly {
        vault_path: Option<String>,
    }

    let raw = config.obsidian_config.as_ref()?;
    let parsed = serde_json::from_str::<VaultPathOnly>(raw).ok()?;
    let vault_path = parsed.vault_path?.trim().to_string();
    if vault_path.is_empty() {
        return None;
    }
    canonical_existing_dir(PathBuf::from(vault_path))
}

fn allowed_open_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let config = read_config(app);
    let mut roots = vec![
        get_data_dir(app),
        get_data_dir(app).join("attachments"),
        get_data_dir(app).join("audio-captures"),
    ];

    if let Some(sync_path) = config
        .sync_path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        roots.push(PathBuf::from(sync_path).join("attachments"));
    }

    if let Some(vault_path) = configured_obsidian_vault_path(&config) {
        roots.push(vault_path);
    }

    #[cfg(target_os = "linux")]
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        roots.push(PathBuf::from(runtime_dir).join("doc"));
    }

    roots.into_iter().filter_map(canonical_existing_dir).fold(
        Vec::<PathBuf>::new(),
        |mut unique_roots, root| {
            if !unique_roots.iter().any(|existing| existing == &root) {
                unique_roots.push(root);
            }
            unique_roots
        },
    )
}

fn normalize_open_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Path is empty".to_string());
    }
    let without_file_scheme = strip_file_scheme(trimmed)?;
    let candidate = PathBuf::from(without_file_scheme);
    if !candidate.is_absolute() {
        return Err("Only absolute local file paths can be opened.".to_string());
    }
    candidate
        .canonicalize()
        .map_err(|_| "File does not exist or cannot be accessed.".to_string())
}

fn path_is_under_allowed_root(path: &Path, allowed_roots: &[PathBuf]) -> bool {
    allowed_roots
        .iter()
        .any(|root| path == root || path.starts_with(root))
}

fn path_is_openable(path: &Path, allowed_roots: &[PathBuf]) -> bool {
    path_is_under_allowed_root(path, allowed_roots) || path.is_file()
}

#[cfg(target_os = "macos")]
fn parse_macos_eventkit_json(raw: *mut c_char) -> Result<Value, String> {
    if raw.is_null() {
        return Err("EventKit bridge returned null output".to_string());
    }
    // SAFETY: We have verified `raw` is non-null. The Objective-C bridge allocates
    // via `strdup()` so the pointer is valid until we free it. We copy the string
    // immediately and then free the original to avoid use-after-free.
    let text = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    unsafe { mindwtr_macos_calendar_free_string(raw) };
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Failed to parse EventKit bridge output: {error}"))
}

#[tauri::command]
pub(crate) fn get_macos_calendar_permission_status() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let value =
            parse_macos_eventkit_json(unsafe { mindwtr_macos_calendar_permission_status_json() })?;
        let status = value
            .get("status")
            .and_then(|item| item.as_str())
            .unwrap_or("denied");
        return Ok(status.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("unsupported".to_string())
    }
}

#[tauri::command]
pub(crate) async fn request_macos_calendar_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(|| {
            parse_macos_eventkit_json(unsafe { mindwtr_macos_calendar_request_permission_json() })
        })
        .await
        .map_err(|error| format!("EventKit permission request task failed: {error}"))??;
        let status = value
            .get("status")
            .and_then(|item| item.as_str())
            .unwrap_or("denied");
        return Ok(status.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("unsupported".to_string())
    }
}

#[tauri::command]
pub(crate) fn get_macos_calendar_events(
    range_start: String,
    range_end: String,
) -> Result<MacOsCalendarReadResult, String> {
    #[cfg(target_os = "macos")]
    {
        let start = CString::new(range_start.as_str())
            .map_err(|error| format!("Invalid calendar range start: {error}"))?;
        let end = CString::new(range_end.as_str())
            .map_err(|error| format!("Invalid calendar range end: {error}"))?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_calendar_events_json(start.as_ptr(), end.as_ptr())
        })?;
        let parsed = serde_json::from_value::<MacOsCalendarReadResult>(value)
            .map_err(|error| format!("Failed to decode EventKit payload: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = range_start;
        let _ = range_end;
        Ok(MacOsCalendarReadResult {
            permission: "unsupported".to_string(),
            calendars: Vec::new(),
            events: Vec::new(),
        })
    }
}

#[tauri::command]
pub(crate) fn get_macos_writable_calendars() -> Result<Vec<MacOsCalendarPushTarget>, String> {
    #[cfg(target_os = "macos")]
    {
        let value = parse_macos_eventkit_json(unsafe { mindwtr_macos_writable_calendars_json() })?;
        let parsed = serde_json::from_value::<Vec<MacOsCalendarPushTarget>>(value)
            .map_err(|error| format!("Failed to decode writable EventKit calendars: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub(crate) fn ensure_macos_mindwtr_calendar(
    stored_calendar_id: Option<String>,
) -> Result<Option<MacOsCalendarPushTarget>, String> {
    #[cfg(target_os = "macos")]
    {
        let stored = CString::new(stored_calendar_id.unwrap_or_default())
            .map_err(|error| format!("Invalid stored calendar ID: {error}"))?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_ensure_mindwtr_calendar_json(stored.as_ptr())
        })?;
        if value.is_null() {
            return Ok(None);
        }
        let parsed = serde_json::from_value::<MacOsCalendarPushTarget>(value)
            .map_err(|error| format!("Failed to decode Mindwtr EventKit calendar: {error}"))?;
        return Ok(Some(parsed));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = stored_calendar_id;
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn encode_macos_calendar_event_payload(
    details: &MacOsCalendarEventPayload,
) -> Result<CString, String> {
    let raw = serde_json::to_string(details)
        .map_err(|error| format!("Failed to encode EventKit event payload: {error}"))?;
    CString::new(raw).map_err(|error| format!("Invalid EventKit event payload: {error}"))
}

#[tauri::command]
pub(crate) fn create_macos_calendar_event(
    details: MacOsCalendarEventPayload,
) -> Result<MacOsCalendarEventWriteResult, String> {
    #[cfg(target_os = "macos")]
    {
        let event_json = encode_macos_calendar_event_payload(&details)?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_create_calendar_event_json(event_json.as_ptr())
        })?;
        let parsed = serde_json::from_value::<MacOsCalendarEventWriteResult>(value)
            .map_err(|error| format!("Failed to decode EventKit create result: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = details;
        Ok(MacOsCalendarEventWriteResult {
            ok: false,
            event_id: None,
            error: Some("unsupported".to_string()),
        })
    }
}

#[tauri::command]
pub(crate) fn update_macos_calendar_event(
    event_id: String,
    details: MacOsCalendarEventPayload,
) -> Result<MacOsCalendarEventWriteResult, String> {
    #[cfg(target_os = "macos")]
    {
        let event_id = CString::new(event_id.as_str())
            .map_err(|error| format!("Invalid EventKit event ID: {error}"))?;
        let event_json = encode_macos_calendar_event_payload(&details)?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_update_calendar_event_json(event_id.as_ptr(), event_json.as_ptr())
        })?;
        let parsed = serde_json::from_value::<MacOsCalendarEventWriteResult>(value)
            .map_err(|error| format!("Failed to decode EventKit update result: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = event_id;
        let _ = details;
        Ok(MacOsCalendarEventWriteResult {
            ok: false,
            event_id: None,
            error: Some("unsupported".to_string()),
        })
    }
}

#[tauri::command]
pub(crate) fn delete_macos_calendar_event(
    event_id: String,
) -> Result<MacOsCalendarEventWriteResult, String> {
    #[cfg(target_os = "macos")]
    {
        let event_id = CString::new(event_id.as_str())
            .map_err(|error| format!("Invalid EventKit event ID: {error}"))?;
        let value = parse_macos_eventkit_json(unsafe {
            mindwtr_macos_delete_calendar_event_json(event_id.as_ptr())
        })?;
        let parsed = serde_json::from_value::<MacOsCalendarEventWriteResult>(value)
            .map_err(|error| format!("Failed to decode EventKit delete result: {error}"))?;
        return Ok(parsed);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = event_id;
        Ok(MacOsCalendarEventWriteResult {
            ok: false,
            event_id: None,
            error: Some("unsupported".to_string()),
        })
    }
}

#[cfg(target_os = "macos")]
fn parse_cloudkit_json(raw: *mut c_char) -> Result<Value, String> {
    if raw.is_null() {
        return Err("CloudKit bridge returned null output".to_string());
    }
    let text = unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned();
    unsafe { mindwtr_cloudkit_free_string(raw) };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Failed to parse CloudKit bridge output: {error}"))?;
    if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        return Err(format!("CloudKit error: {err}"));
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn cloudkit_account_status() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(|| {
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_account_status() })
        })
        .await
        .map_err(|error| format!("CloudKit account status task failed: {error}"))??;
        let status = value
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown");
        return Ok(status.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("unsupported".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_ensure_zone() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_ensure_zone() })
        })
        .await
        .map_err(|error| format!("CloudKit ensure zone task failed: {error}"))??;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_ensure_subscription() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_ensure_subscription() })
        })
        .await
        .map_err(|error| format!("CloudKit ensure subscription task failed: {error}"))??;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_fetch_all_records(record_type: String) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_type = CString::new(record_type.as_str())
                .map_err(|e| format!("Invalid record type: {e}"))?;
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_fetch_all_records(c_type.as_ptr()) })
        })
        .await
        .map_err(|error| format!("CloudKit fetch all records task failed: {error}"))??;
        return Ok(value);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = record_type;
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_fetch_changes(change_token: Option<String>) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_token = change_token
                .as_deref()
                .map(|s| CString::new(s).ok())
                .flatten();
            let ptr = c_token.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
            parse_cloudkit_json(unsafe { mindwtr_cloudkit_fetch_changes(ptr) })
        })
        .await
        .map_err(|error| format!("CloudKit fetch changes task failed: {error}"))??;
        return Ok(value);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = change_token;
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_save_records(
    record_type: String,
    records_json: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_type = CString::new(record_type.as_str())
                .map_err(|e| format!("Invalid record type: {e}"))?;
            let c_json = CString::new(records_json.as_str())
                .map_err(|e| format!("Invalid records JSON: {e}"))?;
            parse_cloudkit_json(unsafe {
                mindwtr_cloudkit_save_records(c_type.as_ptr(), c_json.as_ptr())
            })
        })
        .await
        .map_err(|error| format!("CloudKit save records task failed: {error}"))??;
        return Ok(value);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_type, records_json);
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_save_attachment_asset(
    record_name: String,
    file_path: String,
    metadata_json: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_record_name = CString::new(record_name.as_str())
                .map_err(|e| format!("Invalid attachment record name: {e}"))?;
            let c_file_path = CString::new(file_path.as_str())
                .map_err(|e| format!("Invalid attachment file path: {e}"))?;
            let c_metadata = CString::new(metadata_json.as_str())
                .map_err(|e| format!("Invalid attachment metadata JSON: {e}"))?;
            parse_cloudkit_json(unsafe {
                mindwtr_cloudkit_save_attachment_asset(
                    c_record_name.as_ptr(),
                    c_file_path.as_ptr(),
                    c_metadata.as_ptr(),
                )
            })
        })
        .await
        .map_err(|error| format!("CloudKit save attachment task failed: {error}"))??;
        return Ok(value);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_name, file_path, metadata_json);
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_fetch_attachment_asset(
    record_name: String,
    target_path: String,
) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_record_name = CString::new(record_name.as_str())
                .map_err(|e| format!("Invalid attachment record name: {e}"))?;
            let c_target_path = CString::new(target_path.as_str())
                .map_err(|e| format!("Invalid attachment target path: {e}"))?;
            parse_cloudkit_json(unsafe {
                mindwtr_cloudkit_fetch_attachment_asset(
                    c_record_name.as_ptr(),
                    c_target_path.as_ptr(),
                )
            })
        })
        .await
        .map_err(|error| format!("CloudKit fetch attachment task failed: {error}"))??;
        return Ok(value);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_name, target_path);
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) async fn cloudkit_delete_records(
    record_type: String,
    record_ids: Vec<String>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let value = tauri::async_runtime::spawn_blocking(move || {
            let c_type = CString::new(record_type.as_str())
                .map_err(|e| format!("Invalid record type: {e}"))?;
            let ids_json = serde_json::to_string(&record_ids)
                .map_err(|e| format!("Failed to serialize record IDs: {e}"))?;
            let c_ids = CString::new(ids_json.as_str())
                .map_err(|e| format!("Invalid record IDs JSON: {e}"))?;
            parse_cloudkit_json(unsafe {
                mindwtr_cloudkit_delete_records(c_type.as_ptr(), c_ids.as_ptr())
            })
        })
        .await
        .map_err(|error| format!("CloudKit delete records task failed: {error}"))??;
        let _ = value;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (record_type, record_ids);
        Err("CloudKit is not available on this platform".to_string())
    }
}

#[tauri::command]
pub(crate) fn cloudkit_consume_pending_remote_change() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let had_change = unsafe { mindwtr_cloudkit_consume_pending_remote_change() };
        return Ok(had_change != 0);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn cloudkit_register_for_notifications() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        unsafe { mindwtr_cloudkit_register_for_remote_notifications() };
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn open_path(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let normalized = normalize_open_path(&path)?;
    let allowed_roots = allowed_open_roots(&app);
    if !path_is_openable(&normalized, &allowed_roots) {
        return Err("Path is outside Mindwtr-managed locations.".to_string());
    }
    open::that(normalized).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_open_path_rejects_urls_and_relative_paths() {
        assert!(normalize_open_path("https://example.com/file.txt").is_err());
        assert!(normalize_open_path("../notes.txt").is_err());
    }

    #[test]
    fn path_is_under_allowed_root_respects_boundaries() {
        let root = PathBuf::from("/tmp/mindwtr");
        assert!(path_is_under_allowed_root(
            Path::new("/tmp/mindwtr/attachments/a.pdf"),
            &[root.clone()]
        ));
        assert!(!path_is_under_allowed_root(
            Path::new("/tmp/mindwtr-other/a.pdf"),
            &[root]
        ));
    }

    #[test]
    fn path_is_under_allowed_root_allows_flatpak_document_portal_paths() {
        let portal_root = PathBuf::from("/run/user/1000/doc");
        assert!(path_is_under_allowed_root(
            Path::new("/run/user/1000/doc/abc123/notes.pdf"),
            &[portal_root]
        ));
    }

    #[test]
    fn path_is_openable_allows_existing_user_selected_files() {
        let temp = tempfile::tempdir().expect("should create temp dir");
        let attachment_path = temp.path().join("notes.md");
        fs::write(&attachment_path, "notes").expect("should write attachment");

        assert!(path_is_openable(&attachment_path, &[]));
    }

    #[test]
    fn path_is_openable_rejects_unmanaged_directories() {
        let temp = tempfile::tempdir().expect("should create temp dir");

        assert!(!path_is_openable(temp.path(), &[]));
    }
}

#[tauri::command]
pub(crate) fn set_macos_activation_policy(
    app: tauri::AppHandle,
    accessory: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let policy = if accessory {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        app.set_activation_policy(policy)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, accessory);
    }
    Ok(())
}
