//! Which microphone TeleKey opens, and a watch on the system's choice.
//!
//! Opening the device is `audio.rs`'s job. This module names devices for the
//! settings window and notices when the default changes, so the app can say
//! "Microphone: AirPods Pro" the moment a headset takes over rather than
//! leaving the user to find out from a transcript of the wrong room.
//!
//! On macOS the notice comes from a CoreAudio property listener on the system
//! object. cpal has one of its own but keeps it private, so this is the same
//! shape written out: the C callback does nothing but signal a worker thread,
//! and the worker does the CoreAudio-touching work of asking what the default
//! is now. Nothing that could block or panic runs on the HAL's thread.

use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    /// cpal's id, `coreaudio:<device UID>` on macOS. The UID is what macOS
    /// keeps for a device across reconnects, so it is what a pin is stored as.
    pub id: String,
    /// What the user calls it: "MacBook Pro Microphone", "AirPods Pro".
    pub name: String,
}

/// What the watcher reports.
pub enum Change {
    /// The system default input is now this device, or there is none.
    Default(Option<InputDevice>),
    /// A device came or went without the default changing.
    List,
}

fn describe(device: &cpal::Device) -> Option<InputDevice> {
    let id = device.id().ok()?.to_string();
    let name = device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|_| id.clone());
    Some(InputDevice { id, name })
}

/// The system default input device.
pub fn current() -> Option<InputDevice> {
    cpal::default_host()
        .default_input_device()
        .as_ref()
        .and_then(describe)
}

/// Every input device, for the picker. Probes each device, so not for the
/// key-down path.
pub fn list() -> Vec<InputDevice> {
    cpal::default_host()
        .input_devices()
        .map(|devices| devices.filter_map(|device| describe(&device)).collect())
        .unwrap_or_default()
}

/// Whether two answers to "what is the default?" name the same device.
fn same_device(a: &Option<InputDevice>, b: &Option<InputDevice>) -> bool {
    a.as_ref().map(|d| d.id.as_str()) == b.as_ref().map(|d| d.id.as_str())
}

/// Call `on_change` whenever the default input device changes, or the set of
/// devices does. Runs for the life of the process on its own thread.
#[cfg(target_os = "macos")]
pub fn watch(on_change: impl Fn(Change) + Send + 'static) {
    std::thread::Builder::new()
        .name("telekey-input-watch".into())
        .spawn(move || macos::run(on_change))
        .expect("failed to spawn the input device watcher");
}

/// Device-change notices need a platform listener, and only the CoreAudio one
/// is written. Elsewhere the microphone row still shows the right device: it
/// is read afresh each time the settings window opens.
#[cfg(not(target_os = "macos"))]
pub fn watch(_on_change: impl Fn(Change) + Send + 'static) {
    tracing::info!("microphone-change notices are not supported on this platform");
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    use objc2_core_audio::{
        kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDevices,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal,
        kAudioObjectSystemObject, AudioObjectAddPropertyListener, AudioObjectID,
        AudioObjectPropertyAddress,
    };

    use super::{same_device, Change};

    /// CoreAudio fires several notifications for one plug-in (the device list,
    /// then the default, sometimes twice). Let them settle before asking.
    const SETTLE: Duration = Duration::from_millis(250);

    #[derive(Clone, Copy)]
    enum Which {
        Default,
        List,
    }

    /// What the C callback receives as client data: a way to signal the
    /// worker, and which property it is for. Leaked on purpose — the listener
    /// is never removed, so its data must outlive everything.
    struct Signal {
        tx: mpsc::Sender<Which>,
        which: Which,
    }

    /// Runs on CoreAudio's notification thread. It sends and returns; nothing
    /// here may block, take a lock the worker holds, or panic.
    unsafe extern "C-unwind" fn on_property_changed(
        _object: AudioObjectID,
        _count: u32,
        _addresses: NonNull<AudioObjectPropertyAddress>,
        data: *mut c_void,
    ) -> i32 {
        let signal = &*(data as *const Signal);
        let _ = signal.tx.send(signal.which);
        0
    }

    fn listen(which: Which, selector: u32, tx: &mpsc::Sender<Which>) -> Result<(), i32> {
        let address = AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let signal: &'static mut Signal = Box::leak(Box::new(Signal {
            tx: tx.clone(),
            which,
        }));
        // SAFETY: the address only has to live for the call; CoreAudio copies
        // it. The client data is leaked above, so the pointer stays valid for
        // as long as the listener can fire.
        let status = unsafe {
            AudioObjectAddPropertyListener(
                kAudioObjectSystemObject as AudioObjectID,
                NonNull::from(&address),
                Some(on_property_changed),
                signal as *mut Signal as *mut c_void,
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(status)
        }
    }

    pub(super) fn run(on_change: impl Fn(Change)) {
        let (tx, rx) = mpsc::channel();
        for (which, selector) in [
            (Which::Default, kAudioHardwarePropertyDefaultInputDevice),
            (Which::List, kAudioHardwarePropertyDevices),
        ] {
            if let Err(status) = listen(which, selector, &tx) {
                tracing::warn!(
                    status,
                    "could not watch the input device; the microphone row will update when the window reopens"
                );
                return;
            }
        }

        let mut last = super::current();
        tracing::debug!(
            microphone = last.as_ref().map(|device| device.name.as_str()),
            "watching the input device"
        );

        while let Ok(first) = rx.recv() {
            let mut default_may_have_changed = matches!(first, Which::Default);
            std::thread::sleep(SETTLE);
            while let Ok(more) = rx.try_recv() {
                if matches!(more, Which::Default) {
                    default_may_have_changed = true;
                }
            }

            if default_may_have_changed {
                let now = super::current();
                if !same_device(&last, &now) {
                    last = now.clone();
                    on_change(Change::Default(now));
                    continue;
                }
            }
            // The list changed, or the default was re-announced unchanged:
            // either way the picker may be stale, and nobody needs a notice.
            on_change(Change::List);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str) -> Option<InputDevice> {
        Some(InputDevice {
            id: id.into(),
            name: "Some Microphone".into(),
        })
    }

    #[test]
    fn the_same_id_is_the_same_device_whatever_it_is_called() {
        let a = device("coreaudio:AirPods");
        let b = Some(InputDevice {
            id: "coreaudio:AirPods".into(),
            name: "Renamed".into(),
        });
        assert!(same_device(&a, &b));
    }

    #[test]
    fn a_different_id_is_a_change() {
        assert!(!same_device(&device("coreaudio:A"), &device("coreaudio:B")));
        assert!(!same_device(&device("coreaudio:A"), &None));
    }

    #[test]
    fn no_device_twice_is_not_a_change() {
        assert!(same_device(&None, &None));
    }

    #[test]
    fn input_device_serialises_camel_case() {
        let json = serde_json::to_value(InputDevice {
            id: "coreaudio:BuiltInMicrophoneDevice".into(),
            name: "MacBook Pro Microphone".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "coreaudio:BuiltInMicrophoneDevice",
                "name": "MacBook Pro Microphone",
            })
        );
    }

    /// Talks to the real host; only proves nothing panics without a device.
    #[test]
    fn listing_devices_does_not_panic() {
        let _ = list();
        let _ = current();
    }
}
