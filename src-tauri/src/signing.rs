//! Whether this build can actually hold onto its permissions.
//!
//! macOS attaches an Accessibility grant to the app's code signature. A build
//! signed ad-hoc — or carrying the placeholder signature Rust's linker emits —
//! has no stable identity, so the grant is dropped on the next rebuild, or
//! never applies at all.
//!
//! That fails silently: the checkbox in System Settings looks ticked, and
//! dictation simply stops pasting. Detecting it here turns a baffling bug into
//! one line of explanation, which matters most for someone who has just cloned
//! the repository and built it for the first time.

use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Signing {
    /// Signed with a real certificate: permissions survive rebuilds.
    Stable,
    /// Ad-hoc or linker-signed: permissions reset on every rebuild.
    Unstable,
    /// Could not be determined — a dev binary outside a bundle, say.
    Unknown,
}

impl Signing {
    pub fn is_stable(self) -> bool {
        matches!(self, Signing::Stable)
    }

    /// What to tell the user, when there is anything worth telling them.
    pub fn advice(self) -> Option<&'static str> {
        match self {
            Signing::Stable | Signing::Unknown => None,
            Signing::Unstable => Some(
                "This build is ad-hoc signed, so macOS will forget its Accessibility \
                 permission the next time you rebuild. Run ./scripts/dev-sign.sh with \
                 any code-signing certificate to make it stick.",
            ),
        }
    }
}

/// Inspect our own signature.
///
/// Shells out to `codesign` rather than linking the Security framework: this
/// runs once at startup, and the flags it prints are the same thing a developer
/// would check by hand.
#[cfg(target_os = "macos")]
pub fn current() -> Signing {
    let Ok(exe) = std::env::current_exe() else {
        return Signing::Unknown;
    };

    let output = Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=2"])
        .arg(&exe)
        .output();

    let Ok(output) = output else {
        return Signing::Unknown;
    };

    // codesign reports on stderr.
    let report = String::from_utf8_lossy(&output.stderr);

    if report.is_empty() {
        return Signing::Unknown;
    }
    if report.contains("adhoc") || report.contains("linker-signed") {
        return Signing::Unstable;
    }
    if report.contains("Authority=") {
        return Signing::Stable;
    }

    Signing::Unknown
}

#[cfg(not(target_os = "macos"))]
pub fn current() -> Signing {
    Signing::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_certificate_counts_as_stable() {
        assert!(Signing::Stable.is_stable());
        assert!(!Signing::Unstable.is_stable());
        assert!(!Signing::Unknown.is_stable());
    }

    #[test]
    fn advice_is_offered_only_when_something_is_wrong() {
        assert!(Signing::Unstable.advice().is_some());
        assert!(Signing::Stable.advice().is_none());
        // Unknown covers `cargo run` outside a bundle, where the warning would
        // be noise rather than help.
        assert!(Signing::Unknown.advice().is_none());
    }

    #[test]
    fn state_serialises_for_the_settings_window() {
        assert_eq!(
            serde_json::to_value(Signing::Unstable).unwrap(),
            serde_json::json!("unstable")
        );
    }

    #[test]
    fn inspecting_our_own_signature_does_not_panic() {
        let _ = current();
    }
}
