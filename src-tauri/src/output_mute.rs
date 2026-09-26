//! Silencing system audio output while a dictation is running.
//!
//! On speakers, whatever is playing bleeds into the microphone and lands in the
//! transcript. With `mute_while_recording` on, the pipeline silences the default
//! output device for exactly as long as the key is held.
//!
//! What was muted is remembered, so the restore puts back the device that was
//! actually changed rather than whichever one is default when the key comes up.
//! Changing output mid-dictation therefore cannot strand the wrong device.
//!
//! Nothing here may fail a dictation. Callers log and carry on, the same rule
//! history and usage follow: the transcript is what matters.

use anyhow::Result;

/// The system's audio output, as far as this app needs it.
///
/// A trait at the boundary so the pipeline is testable without a sound card.
pub trait OutputMute: Send + Sync {
    /// Silence the default output device, remembering what to put back.
    /// Muting twice without a restore in between changes nothing.
    fn mute(&self) -> Result<()>;

    /// Put the output back exactly as it was. A no-op when nothing is muted.
    fn restore(&self) -> Result<()>;

    /// False where this platform has no implementation yet, so the settings
    /// window can hide the toggle instead of offering one that does nothing.
    fn supported(&self) -> bool;
}

/// Honest no-op for platforms without an implementation.
///
/// **Windows is missing**: the equivalent is `IAudioEndpointVolume::SetMute` on
/// the default render endpoint, reached through `IMMDeviceEnumerator`, which
/// needs the `Win32_Media_Audio` feature and raw COM calls. Until that is
/// written, `supported()` is false and the toggle does not appear.
pub struct Unsupported;

impl OutputMute for Unsupported {
    fn mute(&self) -> Result<()> {
        Ok(())
    }

    fn restore(&self) -> Result<()> {
        Ok(())
    }

    fn supported(&self) -> bool {
        false
    }
}

/// The platform's implementation, or [`Unsupported`] where there is none.
pub fn for_this_platform() -> std::sync::Arc<dyn OutputMute> {
    #[cfg(target_os = "macos")]
    {
        std::sync::Arc::new(macos::CoreAudioOutput::default())
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::sync::Arc::new(Unsupported)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use anyhow::{anyhow, Result};
    use objc2_core_audio::{
        kAudioDevicePropertyMute, kAudioDevicePropertyVolumeScalar,
        kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyElementMain,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeOutput, kAudioObjectSystemObject,
        AudioObjectGetPropertyData,
        AudioObjectID, AudioObjectPropertyAddress, AudioObjectSetPropertyData,
    };
    use parking_lot::Mutex;

    use super::OutputMute;

    /// How to undo what we did.
    ///
    /// The device's own mute flag is preferred: it is one switch, it is exactly
    /// what the menu bar shows, and a user who is left muted by a crash can undo
    /// it in a click. Not every device has one — several USB interfaces and some
    /// Bluetooth headsets do not — so volume is the fallback, and then the old
    /// level has to be restored precisely.
    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Restore {
        Mute(u32),
        Volume(f32),
    }

    #[derive(Debug, Clone, Copy)]
    struct Muted {
        device: AudioObjectID,
        restore: Restore,
    }

    #[derive(Default)]
    pub struct CoreAudioOutput {
        muted: Mutex<Option<Muted>>,
    }

    fn address(selector: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    /// Read a property into a `T`. `T` must be the type CoreAudio documents for
    /// this selector, which is why every call site below is a single known pair.
    unsafe fn get<T: Copy>(device: AudioObjectID, selector: u32) -> Result<T> {
        let mut addr = address(selector);
        let mut value = std::mem::MaybeUninit::<T>::uninit();
        let mut size = std::mem::size_of::<T>() as u32;

        let status = unsafe {
            AudioObjectGetPropertyData(
                device,
                NonNull::from(&mut addr),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::new(value.as_mut_ptr().cast::<c_void>())
                    .ok_or_else(|| anyhow!("null property buffer"))?,
            )
        };
        if status != 0 {
            return Err(anyhow!("CoreAudio read failed with status {status}"));
        }
        Ok(unsafe { value.assume_init() })
    }

    unsafe fn set<T: Copy>(device: AudioObjectID, selector: u32, value: T) -> Result<()> {
        let mut addr = address(selector);
        let mut value = value;
        let status = unsafe {
            AudioObjectSetPropertyData(
                device,
                NonNull::from(&mut addr),
                0,
                std::ptr::null(),
                std::mem::size_of::<T>() as u32,
                NonNull::from(&mut value).cast::<c_void>(),
            )
        };
        if status != 0 {
            return Err(anyhow!("CoreAudio write failed with status {status}"));
        }
        Ok(())
    }

    fn default_output() -> Result<AudioObjectID> {
        // Global scope, not output: this property hangs off the system object,
        // and the output scope is rejected there.
        let mut addr = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut device: AudioObjectID = 0;
        let mut size = std::mem::size_of::<AudioObjectID>() as u32;

        let status = unsafe {
            AudioObjectGetPropertyData(
                kAudioObjectSystemObject as AudioObjectID,
                NonNull::from(&mut addr),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut device).cast::<c_void>(),
            )
        };
        if status != 0 {
            return Err(anyhow!("no default output device (status {status})"));
        }
        if device == 0 {
            return Err(anyhow!("no default output device"));
        }
        Ok(device)
    }

    impl OutputMute for CoreAudioOutput {
        fn mute(&self) -> Result<()> {
            let mut held = self.muted.lock();
            if held.is_some() {
                return Ok(());
            }

            let device = default_output()?;

            // Preferred path: the device's own mute flag.
            if let Ok(was) = unsafe { get::<u32>(device, kAudioDevicePropertyMute) } {
                if unsafe { set::<u32>(device, kAudioDevicePropertyMute, 1) }.is_ok() {
                    // `was`, not zero: someone who was already muted before they
                    // spoke stays muted when they let go.
                    *held = Some(Muted {
                        device,
                        restore: Restore::Mute(was),
                    });
                    return Ok(());
                }
            }

            // Fallback for devices with no mute flag: drop the level to zero and
            // remember it precisely.
            let was = unsafe { get::<f32>(device, kAudioDevicePropertyVolumeScalar) }
                .map_err(|err| anyhow!("this output device has no mute or volume control: {err}"))?;
            unsafe { set::<f32>(device, kAudioDevicePropertyVolumeScalar, 0.0) }?;
            *held = Some(Muted {
                device,
                restore: Restore::Volume(was),
            });
            Ok(())
        }

        fn restore(&self) -> Result<()> {
            let Some(muted) = self.muted.lock().take() else {
                return Ok(());
            };
            match muted.restore {
                Restore::Mute(was) => unsafe {
                    set::<u32>(muted.device, kAudioDevicePropertyMute, was)
                },
                Restore::Volume(was) => unsafe {
                    set::<f32>(muted.device, kAudioDevicePropertyVolumeScalar, was)
                },
            }
        }

        fn supported(&self) -> bool {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unsupported_platform_says_so_and_does_nothing() {
        let output = Unsupported;
        assert!(!output.supported());
        assert!(output.mute().is_ok());
        assert!(output.restore().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reports_itself_supported() {
        assert!(for_this_platform().supported());
    }

    /// The real thing, against the real default output device.
    ///
    /// Ignored by default because it briefly silences the machine it runs on,
    /// and because a CI runner may have no output device at all. Run it on a
    /// Mac with `cargo test --lib -- --ignored real_hardware`.
    ///
    /// It checks the effect, not just the absence of an error: `osascript`
    /// reports what the rest of the system can see. Every observation is taken
    /// before anything is asserted, so a failure still leaves the audio
    /// restored rather than stranding the machine muted.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "changes the machine's volume; run explicitly"]
    fn real_hardware_mutes_and_restores() {
        /// What the rest of the system sees, rather than what we believe.
        fn system_says_muted() -> String {
            let out = std::process::Command::new("osascript")
                .args(["-e", "output muted of (get volume settings)"])
                .output()
                .expect("osascript should be present on macOS");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        let output = for_this_platform();

        let before = system_says_muted();
        let muted = output.mute();
        let during = system_says_muted();
        let restored = output.restore();
        let after = system_says_muted();

        muted.expect("could not mute the default output device");
        restored.expect("could not restore the default output device");
        assert_eq!(during, "true", "the system was not actually silenced");
        assert_eq!(after, before, "the volume was not put back as it was");
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn platforms_without_an_implementation_hide_the_toggle() {
        assert!(!for_this_platform().supported());
    }
}
