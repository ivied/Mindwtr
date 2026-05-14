use tauri_plugin_autostart::ManagerExt;

fn autostart_error(error: tauri_plugin_autostart::Error) -> String {
    error.to_string()
}

#[tauri::command]
pub(crate) fn get_launch_at_startup_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(autostart_error)
}

#[tauri::command]
pub(crate) fn set_launch_at_startup_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    let autostart = app.autolaunch();
    if enabled {
        autostart.enable().map_err(autostart_error)?;
    } else {
        autostart.disable().map_err(autostart_error)?;
    }
    autostart.is_enabled().map_err(autostart_error)
}
