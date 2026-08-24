//! macOS permission state.
//!
//! Both permissions this app needs fail quietly rather than loudly: a denied
//! microphone yields silence instead of an error, and missing Accessibility
//! swallows the paste keystroke. Surfacing them explicitly is the difference
//! between "Flowtype is broken" and "Flowtype needs one click".

use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    Granted,
    Denied,
    /// Never requested — macOS will prompt on first use.
    NotAsked,
    Unknown,
}

impl Permission {
    pub fn is_granted(self) -> bool {
        matches!(self, Permission::Granted)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub accessibility: Permission,
    pub microphone: Permission,
    /// Needed only for the hold-Fn trigger.
    pub input_monitoring: Permission,
}

pub fn current() -> Permissions {
    Permissions {
        accessibility: accessibility(),
        microphone: microphone(),
        input_monitoring: input_monitoring(),
    }
}

/// Accessibility is binary: the process is either trusted or it is not. There
/// is no "not yet asked" state to distinguish.
pub fn accessibility() -> Permission {
    if crate::inject::accessibility_granted() {
        Permission::Granted
    } else {
        Permission::Denied
    }
}

/// Whether this process may observe keyboard events, which the hold-Fn trigger
/// needs. Distinct from Accessibility, and just as silent when missing.
pub fn input_monitoring() -> Permission {
    if crate::fn_key::input_monitoring_granted() {
        Permission::Granted
    } else {
        Permission::Denied
    }
}

/// Ask macOS to prompt for Accessibility.
///
/// Better than sending the user to System Settings to hunt for the app: this
/// registers Flowtype in the Accessibility list itself and offers a direct
/// button to open the pane. Adding an app by hand with `+` is where people get
/// stuck, and picking the wrong copy of the bundle grants nothing.
///
/// Returns whether the process is already trusted; macOS shows the prompt at
/// most once per app per launch.
#[cfg(target_os = "macos")]
pub fn prompt_for_accessibility() -> bool {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString};

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrustedWithOptions(options: *const AnyObject) -> bool;
        /// `kAXTrustedCheckOptionPrompt`, a `CFStringRef` — toll-free bridged
        /// to `NSString`.
        static kAXTrustedCheckOptionPrompt: &'static NSString;
    }

    unsafe {
        let key: &NSString = kAXTrustedCheckOptionPrompt;
        let yes = NSNumber::numberWithBool(true);
        let options: objc2::rc::Retained<NSDictionary<NSString, NSNumber>> =
            NSDictionary::from_slices(&[key], &[yes.as_ref()]);

        AXIsProcessTrustedWithOptions(
            objc2::rc::Retained::as_ptr(&options) as *const AnyObject
        )
    }
}

#[cfg(not(target_os = "macos"))]
pub fn prompt_for_accessibility() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn microphone() -> Permission {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    let status = unsafe {
        let Some(audio) = AVMediaTypeAudio else {
            return Permission::Unknown;
        };
        AVCaptureDevice::authorizationStatusForMediaType(audio)
    };

    match status {
        AVAuthorizationStatus::Authorized => Permission::Granted,
        AVAuthorizationStatus::Denied | AVAuthorizationStatus::Restricted => Permission::Denied,
        AVAuthorizationStatus::NotDetermined => Permission::NotAsked,
        _ => Permission::Unknown,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn microphone() -> Permission {
    Permission::Unknown
}

/// Open the relevant System Settings pane.
///
/// Deep-linking straight to the pane saves the user hunting through a settings
/// app that has reorganised itself several times in recent macOS releases.
pub fn open_settings_pane(pane: SettingsPane) -> Result<()> {
    let url = match pane {
        SettingsPane::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        SettingsPane::Microphone => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        SettingsPane::InputMonitoring => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        }
    };

    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .with_context(|| format!("could not open {url}"))?;

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsPane {
    Accessibility,
    Microphone,
    InputMonitoring,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn granted_is_the_only_usable_state() {
        assert!(Permission::Granted.is_granted());
        for other in [
            Permission::Denied,
            Permission::NotAsked,
            Permission::Unknown,
        ] {
            assert!(!other.is_granted(), "{other:?} must not count as granted");
        }
    }

    #[test]
    fn permissions_serialise_for_the_ui() {
        let json = serde_json::to_value(Permissions {
            accessibility: Permission::Denied,
            microphone: Permission::NotAsked,
            input_monitoring: Permission::Denied,
        })
        .unwrap();

        assert_eq!(
            json,
            serde_json::json!({
                "accessibility": "denied",
                "microphone": "notAsked",
                "inputMonitoring": "denied",
            })
        );
    }

    #[test]
    fn panes_deserialise_from_the_ui() {
        let pane: SettingsPane = serde_json::from_str("\"accessibility\"").unwrap();
        assert_eq!(pane, SettingsPane::Accessibility);
    }

    #[test]
    fn querying_permissions_does_not_panic() {
        let _ = current();
    }
}
