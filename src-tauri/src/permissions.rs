//! Permission state, per platform.
//!
//! Both permissions this app needs fail quietly rather than loudly: a denied
//! microphone yields silence instead of an error, and missing Accessibility
//! swallows the paste keystroke. Surfacing them explicitly is the difference
//! between "TeleKey is broken" and "TeleKey needs one click".
//!
//! Only macOS has all three. Windows has a microphone switch and nothing else
//! this app needs; Linux has none of them. [`Platform`] says which exist, so
//! the setup window and Settings never list a permission that cannot be granted
//! — a row with nothing behind it can never go green, and setup never finishes.

use anyhow::Result;
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

/// Which of TeleKey's permissions exist on this platform at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    /// `"macos"`, `"windows"` or `"linux"`, for wording that names the
    /// system's own settings app.
    pub os: &'static str,
    /// Pasting into another app needs a grant. Only macOS asks: Windows and X11
    /// let any app send keystrokes.
    pub accessibility: bool,
    /// The system has a microphone privacy switch: macOS's per-app grant, or
    /// Windows' privacy settings. Linux has none for a native app.
    pub microphone: bool,
    /// Hold-Fn exists, and with it Input Monitoring. macOS only: elsewhere the
    /// Fn key is handled by the keyboard itself and never reaches the system.
    pub hold_fn: bool,
    /// The dictation pill can take a click without taking focus from the app
    /// being dictated into. Not on Linux yet: the overlay there is an ordinary
    /// window, so a click would move focus and the paste would miss.
    pub pill: bool,
    /// What "Use what's on screen" can read: `"text"` (app, window title and
    /// the text around the cursor; macOS), `"title"` (app and window title;
    /// Windows) or `"none"` (Linux, which hides the setting).
    pub screen_context: &'static str,
}

impl Platform {
    pub const MACOS: Self = Self {
        os: "macos",
        accessibility: true,
        microphone: true,
        hold_fn: true,
        pill: true,
        screen_context: "text",
    };
    pub const WINDOWS: Self = Self {
        os: "windows",
        accessibility: false,
        microphone: true,
        hold_fn: false,
        pill: true,
        screen_context: "title",
    };
    pub const LINUX: Self = Self {
        os: "linux",
        accessibility: false,
        microphone: false,
        hold_fn: false,
        pill: false,
        screen_context: "none",
    };

    pub const fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::MACOS
        }
        #[cfg(target_os = "windows")]
        {
            Self::WINDOWS
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Self::LINUX
        }
    }

    /// Whether a refused microphone is certain to record nothing. macOS's
    /// answer is authoritative. Windows' privacy switch is only a strong hint:
    /// Microsoft says a desktop app may still get through with it off, so a
    /// refusal there is tried, and the device decides.
    pub fn microphone_denial_is_final(self) -> bool {
        self.os == "macos"
    }

    /// Whether hold-Fn is on *and* can work here. A Windows settings file that
    /// says `fnTrigger: true` — the default — asks for nothing.
    pub fn wants_fn(self, fn_trigger: bool) -> bool {
        self.hold_fn && fn_trigger
    }
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
/// registers TeleKey in the Accessibility list itself and offers a direct
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

/// Windows asks nobody: a desktop app may use the microphone unless a switch in
/// Settings › Privacy › Microphone says otherwise, and then it records silence
/// rather than failing. So this reads those switches. There is no "not asked".
#[cfg(target_os = "windows")]
pub fn microphone() -> Permission {
    windows_mic::current()
}

/// Linux has no microphone permission for a native app; the device either
/// opens or reports an error. Nothing to show, nothing to grant —
/// [`Platform::LINUX`] lists no row for it.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn microphone() -> Permission {
    Permission::Unknown
}

/// Open the system's own setting for a permission.
///
/// Deep-linking straight to the pane saves the user hunting through a settings
/// app that has reorganised itself several times in recent releases.
#[cfg(target_os = "macos")]
pub fn open_settings_pane(pane: SettingsPane) -> Result<()> {
    use anyhow::Context;

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

/// Windows has a page for the microphone only; the other two permissions do
/// not exist here, and [`Platform::WINDOWS`] keeps them off screen.
#[cfg(target_os = "windows")]
pub fn open_settings_pane(pane: SettingsPane) -> Result<()> {
    use anyhow::Context;

    match pane {
        SettingsPane::Microphone => crate::session::open_in_browser("ms-settings:privacy-microphone")
            .context("could not open Windows Settings"),
        SettingsPane::Accessibility | SettingsPane::InputMonitoring => {
            anyhow::bail!("Windows has no such setting, and TeleKey does not need one here")
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn open_settings_pane(_pane: SettingsPane) -> Result<()> {
    anyhow::bail!("Linux has no such setting, and TeleKey does not need one here")
}

/// Windows' microphone switches, read from where Settings › Privacy ›
/// Microphone stores them. Compiled into the tests on every platform so the
/// decision is checked on the Mac that builds releases, not only on Windows.
#[cfg(any(target_os = "windows", test))]
mod windows_mic {
    use super::Permission;

    /// Under HKLM for the device-wide switch, under HKCU for the per-user ones.
    #[cfg(target_os = "windows")]
    const CONSENT: &str =
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    #[cfg(target_os = "windows")]
    const DESKTOP_APPS: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged";

    /// Each switch as stored: `"Allow"`, `"Deny"`, or absent when it has never
    /// been touched.
    #[derive(Debug, Default, Clone, PartialEq, Eq)]
    pub struct Switches {
        /// "Microphone access", for everyone on the device.
        pub device: Option<String>,
        /// "Let apps access your microphone".
        pub apps: Option<String>,
        /// "Let desktop apps access your microphone" — the one that names
        /// TeleKey's kind of app.
        pub desktop_apps: Option<String>,
    }

    /// Only an explicit "Deny" blocks. Absent is Windows' default, which is
    /// allowed, and anything unrecognised is read the same way: refusing to
    /// record for someone whose microphone works is worse than missing a
    /// switch nobody has heard of.
    pub fn decide(switches: &Switches) -> Permission {
        let denies = |value: &Option<String>| {
            value
                .as_deref()
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("deny"))
        };
        if denies(&switches.device) || denies(&switches.apps) || denies(&switches.desktop_apps) {
            Permission::Denied
        } else {
            Permission::Granted
        }
    }

    #[cfg(target_os = "windows")]
    pub fn current() -> Permission {
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

        decide(&Switches {
            device: read(HKEY_LOCAL_MACHINE, CONSENT),
            apps: read(HKEY_CURRENT_USER, CONSENT),
            desktop_apps: read(HKEY_CURRENT_USER, DESKTOP_APPS),
        })
    }

    /// The key's `Value` string, or `None` when the key or value is missing
    /// (or is not a string, which Windows never writes here).
    #[cfg(target_os = "windows")]
    fn read(root: windows_sys::Win32::System::Registry::HKEY, subkey: &str) -> Option<String> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};

        let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let subkey = wide(subkey);
        let name = wide("Value");
        // "Allow" and "Deny" are five and four characters; anything that does
        // not fit is not one of them and is read as allowed.
        let mut buffer = [0u16; 32];
        let mut bytes = std::mem::size_of_val(&buffer) as u32;

        // SAFETY: both names are NUL-terminated, the buffer is as large as
        // `bytes` says, and RRF_RT_REG_SZ makes Windows NUL-terminate the
        // string it writes.
        let status = unsafe {
            RegGetValueW(
                root,
                subkey.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }

        let written = (bytes as usize / 2).min(buffer.len());
        let text = &buffer[..written];
        let end = text.iter().position(|&unit| unit == 0).unwrap_or(text.len());
        Some(String::from_utf16_lossy(&text[..end]))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn switches(device: Option<&str>, apps: Option<&str>, desktop_apps: Option<&str>) -> Switches {
            Switches {
                device: device.map(str::to_owned),
                apps: apps.map(str::to_owned),
                desktop_apps: desktop_apps.map(str::to_owned),
            }
        }

        #[test]
        fn a_windows_that_was_never_touched_allows_the_microphone() {
            assert_eq!(decide(&Switches::default()), Permission::Granted);
        }

        #[test]
        fn everything_allowed_is_granted() {
            let on = switches(Some("Allow"), Some("Allow"), Some("Allow"));
            assert_eq!(decide(&on), Permission::Granted);
        }

        #[test]
        fn any_switch_turned_off_blocks_it() {
            for off in [
                switches(Some("Deny"), Some("Allow"), Some("Allow")),
                switches(Some("Allow"), Some("Deny"), Some("Allow")),
                switches(Some("Allow"), Some("Allow"), Some("Deny")),
                switches(None, None, Some("Deny")),
            ] {
                assert_eq!(decide(&off), Permission::Denied, "{off:?}");
            }
        }

        #[test]
        fn an_unrecognised_value_does_not_stop_dictation() {
            let odd = switches(Some("Prompt"), Some(""), Some("allowed"));
            assert_eq!(decide(&odd), Permission::Granted);
        }
    }
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
    fn only_macos_has_the_last_word_on_the_microphone() {
        assert!(Platform::MACOS.microphone_denial_is_final());
        assert!(
            !Platform::WINDOWS.microphone_denial_is_final(),
            "Windows' switch is a hint; refusing on it alone could stop a working microphone"
        );
    }

    #[test]
    fn hold_fn_is_wanted_only_where_it_exists() {
        assert!(Platform::MACOS.wants_fn(true));
        assert!(!Platform::MACOS.wants_fn(false));
        assert!(!Platform::WINDOWS.wants_fn(true), "fnTrigger defaults to true");
        assert!(!Platform::LINUX.wants_fn(true));
    }

    #[test]
    fn the_pill_is_off_where_a_click_would_take_focus() {
        let pill = [Platform::MACOS.pill, Platform::WINDOWS.pill, Platform::LINUX.pill];
        // Linux last and off: the overlay there is an ordinary window.
        assert_eq!(pill, [true, true, false]);
    }

    #[test]
    fn the_platform_serialises_for_the_ui() {
        let json = serde_json::to_value(Platform::WINDOWS).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "os": "windows",
                "accessibility": false,
                "microphone": true,
                "holdFn": false,
                "pill": true,
                "screenContext": "title",
            })
        );
    }

    #[test]
    fn querying_permissions_does_not_panic() {
        let _ = current();
    }
}
