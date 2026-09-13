//! A desktop registers only against its verified local service. No registration
//! is created for remote connections or desktop-owned sidecars.
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
struct Registration {
    version: u8,
    enabled: bool,
    executable: PathBuf,
    pid: u32,
    birth: String,
    #[serde(default, rename = "pausedForService", skip_serializing_if = "Option::is_none")]
    paused_for_service: Option<String>,
}

#[derive(Default)]
pub(crate) struct DesktopCompanion {
    registration: Mutex<Option<(PathBuf, Registration)>>,
    paused: AtomicBool,
}

pub(crate) struct BackgroundTray(pub AtomicBool);

pub(crate) fn background_arguments(args: &[String]) -> bool {
    args.iter().skip(1).any(|argument| argument == "--tray-only")
}

pub(crate) fn background(app: &AppHandle) -> bool {
    app.try_state::<BackgroundTray>().is_some_and(|state| state.0.load(Ordering::SeqCst))
}

pub(crate) fn activate(app: &AppHandle) {
    if let Some(state) = app.try_state::<BackgroundTray>() {
        state.0.store(false, Ordering::SeqCst);
    }
}

fn write(home: &Path, registration: &Registration) -> Result<(), String> {
    // Reuse the existing same-user service boundary; never loosen its directory
    // permissions or create a companion inside an untrusted/symlinked runtime.
    let directory = home.join("runtime");
    let path = directory.join("desktop-companion.json");
    if path.exists() {
        crate::service_state::read_owner_only_file(&path, "desktop companion")
            .map_err(|error| error.to_string())?;
    } else {
        crate::service_state::read_owner_only_file(&home.join("runtime/local-grant.secret"), "local service authorization")
            .map_err(|error| error.to_string())?;
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
    let temporary = directory.join(format!(".desktop-companion-{}-{stamp}", std::process::id()));
    let result = (|| -> Result<(), String> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|error| error.to_string())?;
        crate::windows_path_trust::ensure(&[(crate::windows_path_trust::TrustKind::File, &temporary)])?;
        file.write_all(&serde_json::to_vec(registration).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
        crate::sync_profile_store_directory(&directory)?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(temporary); }
    result
}

fn service_birth(app: &AppHandle, home: &Path) -> Result<Option<String>, String> {
    let resource = crate::simplified_sidecar_resource_dir(&app.path().resource_dir().map_err(|error| error.to_string())?);
    let entries = crate::read_registry_bridge(&resource, home).map_err(|_| "Cannot read service ownership")?;
    let services = entries.iter().filter(|entry| entry.instance_type == "service" && entry.pid.is_some()).collect::<Vec<_>>();
    match services.as_slice() {
        [] => Ok(None),
        [entry] if entry.pid_alive == Some(true) => crate::native_profile_lock_birth(app, entry.pid.unwrap())?.map(Some).ok_or_else(|| "Cannot prove service process identity".into()),
        _ => Err("Service ownership is unavailable or ambiguous".into()),
    }
}

pub(crate) fn register(app: &AppHandle, service: Option<&crate::service_state::ResolvedLocalService>) {
    let Some(service) = service else { return; };
    let state = app.state::<DesktopCompanion>();
    if state.paused.load(Ordering::SeqCst) { return; }
    let mut saved = state.registration.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.paused.load(Ordering::SeqCst) { return; }
    if saved.as_ref().is_some_and(|(home, _)| home == &service.base_dir) { return; }
    let result = (|| -> Result<Registration, String> {
        if background(app) {
            if let Ok(raw) = crate::service_state::read_owner_only_file(&service.base_dir.join("runtime/desktop-companion.json"), "desktop companion") {
                if let Ok(entry) = serde_json::from_str::<Registration>(&raw) {
                    if !entry.enabled {
                        let current = service_birth(app, &service.base_dir)?;
                        if entry.paused_for_service.is_none() || current.is_none() || entry.paused_for_service == current {
                            return Err("Tray background startup was disabled for this service run".into());
                        }
                    }
                }
            }
        }
        let registration = Registration {
            version: 1,
            enabled: true,
            executable: std::fs::canonicalize(std::env::current_exe().map_err(|error| error.to_string())?).map_err(|error| error.to_string())?,
            pid: std::process::id(),
            birth: crate::native_profile_lock_birth(app, std::process::id())?.ok_or("Cannot prove desktop process identity")?,
            paused_for_service: None,
        };
        write(&service.base_dir, &registration)?;
        Ok(registration)
    })();
    match result {
        Ok(registration) => { *saved = Some((service.base_dir.clone(), registration)); }
        Err(error) => log::warn!("Could not register the desktop companion: {error}"),
    }
}

pub(crate) const QUIT_MENU_ID: &str = "station-desktop-quit";

/// Preserve the platform's standard menu, replacing only its native Quit
/// action: on macOS terminate: can bypass Tauri's ExitRequested callback.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn desktop_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
    fn replace<R: tauri::Runtime>(app: &tauri::AppHandle<R>, menu: &Submenu<R>, quit_text: &str) -> tauri::Result<()> {
        for (position, item) in menu.items()?.into_iter().enumerate() {
            match item {
                MenuItemKind::Submenu(submenu) => replace(app, &submenu, quit_text)?,
                MenuItemKind::Predefined(item) if item.text()? == quit_text => {
                    let quit = MenuItem::with_id(app, QUIT_MENU_ID, quit_text, true, Some("CmdOrCtrl+Q"))?;
                    menu.remove(&item)?;
                    menu.insert(&quit, position)?;
                }
                _ => {}
            }
        }
        Ok(())
    }
    let menu = Menu::default(app)?;
    let quit_text = PredefinedMenuItem::quit(app, None)?.text()?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item { replace(app, &submenu, &quit_text)?; }
    }
    Ok(menu)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn desktop_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    tauri::menu::Menu::default(app)
}

pub(crate) fn request_quit(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    match pause(app) {
        Ok(()) => app.exit(0),
        Err(error) => {
            log::error!("Could not pause desktop companion: {error}");
            app.dialog().message("Station could not save its background preference. Please try quitting again.").title("Could not quit Station").show(|_| {});
        }
    }
}

/// Pause restoration for this service run. A new service process (including
/// after login) may restore the tray again; manual app opening also resumes it.
pub(crate) fn pause(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopCompanion>();
    if state.paused.load(Ordering::SeqCst) { return Ok(()); }
    let saved = state.registration.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((home, registration)) = saved.as_ref() {
        if home.join("runtime/desktop-companion.json").exists() {
            if let Some(birth) = service_birth(app, home)? {
                let mut registration = registration.clone();
                registration.enabled = false;
                registration.paused_for_service = Some(birth);
                write(home, &registration)?;
            }
        }
    }
    state.paused.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn registration_is_private_atomic_and_preserves_explicit_quit() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let runtime = home.path().join("runtime");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
        let secret = runtime.join("local-grant.secret");
        std::fs::write(&secret, "test-only").unwrap();
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o600)).unwrap();
        let mut registration = Registration { version: 1, enabled: true, executable: PathBuf::from("/test/app"), pid: 42, birth: "test-birth".into(), paused_for_service: None };
        write(home.path(), &registration).unwrap();
        let path = runtime.join("desktop-companion.json");
        let raw = crate::service_state::read_owner_only_file(&path, "test companion").unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value, serde_json::json!({"version":1,"enabled":true,"executable":"/test/app","pid":42,"birth":"test-birth"}));
        registration.enabled = false;
        registration.paused_for_service = Some("service-birth".into());
        write(home.path(), &registration).unwrap();
        assert!(!serde_json::from_str::<Registration>(&std::fs::read_to_string(&path).unwrap()).unwrap().enabled);
        std::fs::remove_file(&path).unwrap();
        let other = home.path().join("other"); std::fs::write(&other, "untouched").unwrap();
        std::os::unix::fs::symlink(&other, &path).unwrap();
        assert!(write(home.path(), &registration).is_err());
        assert_eq!(std::fs::read_to_string(other).unwrap(), "untouched");
    }

    #[test]
    fn only_explicit_background_launch_suppresses_activation() {
        assert!(background_arguments(&["station".into(), "--tray-only".into()]));
        assert!(!background_arguments(&["station".into(), "station-stable://pair".into()]));
        assert!(!background_arguments(&["station".into(), "--tray-only=false".into()]));
    }
}
