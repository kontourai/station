//! Apply before Tauri initializes WebKitGTK; an explicit user setting always wins.
use std::ffi::OsStr;

fn needs_dmabuf_fallback(override_value: Option<&OsStr>, wayland: bool, nvidia: bool) -> bool {
    override_value.is_none() && wayland && nvidia
}

pub(super) fn configure() {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty())
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|session| session == "wayland");
    if needs_dmabuf_fallback(
        std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").as_deref(),
        wayland,
        std::path::Path::new("/sys/module/nvidia").is_dir(),
    ) {
        // run() calls this before constructing the Tauri runtime or its threads.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_fallback_to_unconfigured_nvidia_wayland() {
        for wayland in [false, true] {
            for nvidia in [false, true] {
                assert_eq!(
                    needs_dmabuf_fallback(None, wayland, nvidia),
                    wayland && nvidia
                );
                for value in ["", "0", "1"] {
                    assert!(!needs_dmabuf_fallback(
                        Some(OsStr::new(value)),
                        wayland,
                        nvidia
                    ));
                }
            }
        }
    }
}
