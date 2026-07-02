#[cfg(target_os = "linux")]
use crate::install::is_flatpak;
use tauri_plugin_autostart::ManagerExt;

fn autostart_error(error: tauri_plugin_autostart::Error) -> String {
    error.to_string()
}

#[tauri::command]
pub(crate) fn get_launch_at_startup_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(autostart_error)
}

#[tauri::command]
pub(crate) async fn set_launch_at_startup_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    if is_flatpak() {
        return set_flatpak_launch_at_startup_enabled(enabled).await;
    }

    let autostart = app.autolaunch();
    if enabled {
        autostart.enable().map_err(autostart_error)?;
    } else {
        autostart.disable().map_err(autostart_error)?;
    }
    autostart.is_enabled().map_err(autostart_error)
}

#[cfg(target_os = "linux")]
async fn set_flatpak_launch_at_startup_enabled(enabled: bool) -> Result<bool, String> {
    use ashpd::desktop::background::Background;

    let response = Background::request()
        .reason("Keep reminders and sync running when Mindwtr is in the background")
        .auto_start(enabled)
        .dbus_activatable(false)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .response()
        .map_err(|error| error.to_string())?;

    Ok(response.auto_start())
}
