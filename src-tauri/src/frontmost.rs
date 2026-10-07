//! Which app the user is dictating into.
//!
//! Captured on key-down, *before* any overlay appears, so the transcript can be
//! routed back to the right place and per-app formatting can be chosen. The
//! overlay is non-activating, so this stays correct for the whole dictation.

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TargetApp {
    /// e.g. `com.tinyspeck.slackmacgap`. `None` for apps without a bundle ID.
    pub bundle_id: Option<String>,
    /// e.g. `Slack`. For display and logging only.
    pub name: Option<String>,
    /// The process, for reading where the cursor is (`context.rs`).
    pub pid: Option<i32>,
    /// The focused window's title, where reading it costs nothing (Windows
    /// has the window in hand already). Only ever sent when the user has
    /// switched on "Use what's on screen".
    pub title: Option<String>,
}

impl TargetApp {
    /// A stable key for per-app settings, falling back to the display name and
    /// finally to a sentinel so lookups never silently collide.
    pub fn profile_key(&self) -> &str {
        self.bundle_id
            .as_deref()
            .or(self.name.as_deref())
            .unwrap_or("unknown")
    }
}

#[cfg(target_os = "macos")]
pub fn frontmost_app() -> TargetApp {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    match workspace.frontmostApplication() {
        Some(app) => TargetApp {
            bundle_id: app.bundleIdentifier().map(|id| id.to_string()),
            name: app.localizedName().map(|name| name.to_string()),
            pid: Some(app.processIdentifier()),
            title: None,
        },
        None => TargetApp::default(),
    }
}

/// The app currently in the foreground, via its executable name.
///
/// Windows has no bundle identifier, so the executable's file stem stands in —
/// `slack`, `Code`, `WindowsTerminal`. That is what a formatting profile is
/// keyed on here, and what the History list shows.
#[cfg(target_os = "windows")]
pub fn frontmost_app() -> TargetApp {
    use std::os::windows::ffi::OsStringExt;

    use windows_sys::Win32::Foundation::{CloseHandle, MAX_PATH};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return TargetApp::default();
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(window, &mut pid);
        if pid == 0 {
            return TargetApp::default();
        }

        // Limited information is enough for the image path and, unlike full
        // query access, does not require elevation for most processes.
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return TargetApp::default();
        }

        let mut buffer = [0u16; MAX_PATH as usize];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len);
        CloseHandle(process);

        if ok == 0 || len == 0 {
            return TargetApp::default();
        }

        let path = std::ffi::OsString::from_wide(&buffer[..len as usize]);
        let name = std::path::Path::new(&path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned());

        // The window's own title bar text: no message is sent to the other
        // process for a top-level window, so this cannot hang.
        let mut title = [0u16; 512];
        let copied = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
        let title = (copied > 0)
            .then(|| String::from_utf16_lossy(&title[..copied as usize]))
            .filter(|title| !title.trim().is_empty());

        TargetApp {
            // No bundle identifier on Windows; the name is the stable key.
            bundle_id: None,
            name,
            pid: i32::try_from(pid).ok(),
            title,
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn frontmost_app() -> TargetApp {
    TargetApp::default()
}

/// Apps with a user interface, sorted by name.
///
/// Lets a formatting profile be picked from a list rather than typed as a
/// bundle identifier — nobody knows offhand that Slack is
/// `com.tinyspeck.slackmacgap`.
#[cfg(target_os = "macos")]
pub fn running_apps() -> Vec<TargetApp> {
    use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};

    let workspace = NSWorkspace::sharedWorkspace();
    let mut apps: Vec<TargetApp> = workspace
        .runningApplications()
        .iter()
        // Background daemons and menubar-only helpers are never a paste target.
        .filter(|app| app.activationPolicy() == NSApplicationActivationPolicy::Regular)
        .map(|app| TargetApp {
            bundle_id: app.bundleIdentifier().map(|id| id.to_string()),
            name: app.localizedName().map(|name| name.to_string()),
            ..TargetApp::default()
        })
        .filter(|app| app.name.is_some())
        .collect();

    apps.sort_by(|a, b| {
        a.name
            .as_deref()
            .unwrap_or_default()
            .to_lowercase()
            .cmp(&b.name.as_deref().unwrap_or_default().to_lowercase())
    });
    apps.dedup_by(|a, b| a.profile_key() == b.profile_key());

    apps
}

/// Not enumerated on Windows yet.
///
/// The formatting editor falls back to whatever is already configured; adding a
/// profile there needs `EnumWindows` plus the same process-name lookup as
/// above. Returning empty is honest — the UI shows no candidates rather than
/// wrong ones.
#[cfg(not(target_os = "macos"))]
pub fn running_apps() -> Vec<TargetApp> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_key_prefers_the_bundle_id() {
        let app = TargetApp {
            bundle_id: Some("com.tinyspeck.slackmacgap".into()),
            name: Some("Slack".into()),
            ..TargetApp::default()
        };
        assert_eq!(app.profile_key(), "com.tinyspeck.slackmacgap");
    }

    #[test]
    fn profile_key_falls_back_to_the_name() {
        let app = TargetApp {
            bundle_id: None,
            name: Some("Some Helper".into()),
            ..TargetApp::default()
        };
        assert_eq!(app.profile_key(), "Some Helper");
    }

    #[test]
    fn profile_key_has_a_sentinel_for_unknown_apps() {
        assert_eq!(TargetApp::default().profile_key(), "unknown");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn querying_the_frontmost_app_does_not_panic() {
        // In a headless test runner there may be no frontmost app; the point is
        // that the Objective-C round-trip is sound either way.
        let _ = frontmost_app();
    }
}
