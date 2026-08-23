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
        },
        None => TargetApp::default(),
    }
}

#[cfg(not(target_os = "macos"))]
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
        };
        assert_eq!(app.profile_key(), "com.tinyspeck.slackmacgap");
    }

    #[test]
    fn profile_key_falls_back_to_the_name() {
        let app = TargetApp {
            bundle_id: None,
            name: Some("Some Helper".into()),
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
