//! Hold-Fn push-to-talk.
//!
//! Fn is not a keypress. It produces no key-down event and cannot be registered
//! as an accelerator — it only ever appears as a modifier-flag change. So it
//! needs a `CGEventTap` watching `FlagsChanged` rather than the global-shortcut
//! plugin the chord trigger uses.
//!
//! This is deliberately *additive*: the accelerator stays bound alongside it.
//! Input Monitoring is a separate permission that can be missing or revoked, and
//! trading a working chord for a trigger that silently does nothing would be a
//! bad bargain. Losing Fn should cost the nicer gesture, not dictation itself.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc;

use anyhow::{bail, Result};

use crate::trigger::{Bus, TriggerEvent};

/// `kCGEventFlagMaskSecondaryFn`. Fn shows up here and nowhere else.
#[cfg(target_os = "macos")]
const FN_FLAG: u64 = 0x0080_0000;

/// Whether macOS will let this process observe keyboard events.
///
/// Input Monitoring is separate from Accessibility, and — like Accessibility —
/// its absence is silent: the tap is simply never created and Fn does nothing.
#[cfg(target_os = "macos")]
pub fn input_monitoring_granted() -> bool {
    objc2_core_graphics::CGPreflightListenEventAccess()
}

#[cfg(not(target_os = "macos"))]
pub fn input_monitoring_granted() -> bool {
    false
}

/// Ask macOS for Input Monitoring, which registers the app in the list.
///
/// The prompt appears at most once per app; afterwards the user must grant it
/// in System Settings, which is why the settings window links there too.
#[cfg(target_os = "macos")]
pub fn request_input_monitoring() -> bool {
    objc2_core_graphics::CGRequestListenEventAccess()
}

#[cfg(not(target_os = "macos"))]
pub fn request_input_monitoring() -> bool {
    false
}

/// Start watching for Fn. Returns once the tap is installed and running.
#[cfg(target_os = "macos")]
pub fn spawn(bus: Bus) -> Result<()> {
    if !input_monitoring_granted() {
        bail!("Input Monitoring permission is not granted");
    }

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    // The tap needs a thread with its own run loop, and that thread owns it for
    // the life of the process.
    std::thread::Builder::new()
        .name("telekey-fn-tap".into())
        .spawn(move || run_tap(bus, ready_tx))
        .map_err(|err| anyhow::anyhow!("could not spawn the Fn watcher: {err}"))?;

    match ready_rx.recv() {
        Ok(Ok(())) => {
            tracing::info!("hold-Fn trigger active");
            Ok(())
        }
        Ok(Err(message)) => bail!("{message}"),
        Err(_) => bail!("the Fn watcher stopped before it started"),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn spawn(_bus: Bus) -> Result<()> {
    bail!("hold-Fn is only available on macOS")
}

/// Shared with the C callback through `user_info`.
#[cfg(target_os = "macos")]
struct TapState {
    bus: Bus,
    /// Whether Fn was down at the previous flag change. `FlagsChanged` fires for
    /// every modifier, so the edge has to be derived rather than assumed.
    fn_was_down: bool,
    /// Kept so the callback can re-enable a tap macOS has switched off.
    tap: Option<objc2_core_foundation::CFRetained<objc2_core_foundation::CFMachPort>>,
}

#[cfg(target_os = "macos")]
fn run_tap(bus: Bus, ready: mpsc::Sender<Result<(), String>>) {
    use objc2_core_foundation::{kCFRunLoopCommonModes, CFMachPort, CFRunLoop};
    use objc2_core_graphics::{CGEvent, CGEventMask, CGEventTapLocation, CGEventTapOptions,
                              CGEventTapPlacement, CGEventType};

    // Leaked on purpose: the callback holds this pointer for the life of the
    // process, and the thread never unwinds in normal operation.
    let state = Box::leak(Box::new(TapState {
        bus,
        fn_was_down: false,
        tap: None,
    }));
    let user_info = state as *mut TapState as *mut c_void;

    let mask: CGEventMask = 1 << CGEventType::FlagsChanged.0;

    let tap = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            // Listen only: never modify or swallow the event. Fn must keep
            // doing whatever else the user has bound it to.
            CGEventTapOptions::ListenOnly,
            mask,
            Some(on_event),
            user_info,
        )
    };

    let Some(tap) = tap else {
        let _ = ready.send(Err(
            "could not create the event tap — check Input Monitoring".to_string()
        ));
        return;
    };

    let source = CFMachPort::new_run_loop_source(None, Some(&tap), 0);
    let Some(source) = source else {
        let _ = ready.send(Err("could not attach the event tap to a run loop".to_string()));
        return;
    };

    let run_loop = CFRunLoop::current().expect("a thread always has a run loop");
    unsafe {
        run_loop.add_source(Some(&source), kCFRunLoopCommonModes);
        CGEvent::tap_enable(&tap, true);
    }

    state.tap = Some(tap);
    let _ = ready.send(Ok(()));

    // Blocks forever, servicing the tap.
    CFRunLoop::run();
}

/// Called by the window server for every modifier change.
///
/// Must return quickly. macOS silently disables a tap whose callback is slow,
/// which is handled below rather than left to fail quietly.
#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn on_event(
    _proxy: objc2_core_graphics::CGEventTapProxy,
    event_type: objc2_core_graphics::CGEventType,
    event: NonNull<objc2_core_graphics::CGEvent>,
    user_info: *mut c_void,
) -> *mut objc2_core_graphics::CGEvent {
    use objc2_core_graphics::{CGEvent, CGEventType};

    let event_ptr = event.as_ptr();

    if user_info.is_null() {
        return event_ptr;
    }
    let state = unsafe { &mut *(user_info as *mut TapState) };

    match event_type {
        // macOS disables a tap that responded too slowly, or after certain user
        // input. Without re-enabling, Fn silently stops working mid-session with
        // nothing in the log — the failure mode this branch exists to prevent.
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
            if let Some(tap) = state.tap.as_ref() {
                tracing::warn!("Fn tap was disabled by the system; re-enabling");
                CGEvent::tap_enable(tap, true);
            }
            return event_ptr;
        }
        CGEventType::FlagsChanged => {}
        _ => return event_ptr,
    }

    let flags = unsafe { CGEvent::flags(Some(event.as_ref())) };
    let fn_down = flags.0 & FN_FLAG != 0;

    // FlagsChanged fires for every modifier, so only act on a Fn edge.
        if fn_down != state.fn_was_down {
            state.fn_was_down = fn_down;
            let trigger = if fn_down {
                TriggerEvent::Start
            } else {
                TriggerEvent::Stop
            };
            state.bus.emit(trigger);
        }

    event_ptr
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fn_flag_matches_the_documented_mask() {
        // kCGEventFlagMaskSecondaryFn, and what objc2-core-graphics reports.
        assert_eq!(FN_FLAG, 0x0080_0000);
        assert_eq!(FN_FLAG, 8_388_608);
        #[cfg(target_os = "macos")]
        assert_eq!(
            FN_FLAG,
            objc2_core_graphics::CGEventFlags::MaskSecondaryFn.0
        );
    }

    #[test]
    fn the_event_mask_selects_only_flag_changes() {
        #[cfg(target_os = "macos")]
        {
            use objc2_core_graphics::CGEventType;
            let mask: u64 = 1 << CGEventType::FlagsChanged.0;
            assert_eq!(mask, 1 << 12);
            // A key-down must not be in the mask; this tap observes modifiers
            // only, and should never see ordinary typing.
            assert_eq!(mask & (1 << CGEventType::KeyDown.0), 0);
        }
    }

    #[test]
    fn spawning_without_permission_fails_rather_than_silently_doing_nothing() {
        // The whole point of the preflight check: a tap that cannot be created
        // must report why, not leave the user pressing a key that does nothing.
        if !input_monitoring_granted() {
            let (tx, _rx) = mpsc::channel();
            let err = spawn(crate::trigger::Bus::new(tx)).unwrap_err();
            assert!(
                err.to_string().contains("Input Monitoring"),
                "unhelpful message: {err}"
            );
        }
    }
}
