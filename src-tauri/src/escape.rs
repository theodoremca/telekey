//! Escape-to-cancel, armed only while a dictation is live.
//!
//! A standing global Escape grab would steal the key from every other app.
//! The tap is installed at launch but the callback is a no-op until
//! [`Arm`] is set, and even then only Escape is swallowed. Anything else
//! passes through untouched.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Result;

use crate::trigger::{Bus, TriggerEvent};

/// Shared with the pipeline: true only during Recording or Transcribing.
pub type Arm = Arc<AtomicBool>;

pub fn new_arm() -> Arm {
    Arc::new(AtomicBool::new(false))
}

/// Start watching for Escape. Safe to call once at launch.
#[cfg(target_os = "macos")]
pub fn spawn(bus: Bus, arm: Arm) -> Result<()> {
    // Swallowing a key requires a modifying tap, which macOS only allows when
    // the process is trusted for Accessibility. Without it the overlay button
    // still cancels; we just cannot intercept Escape.
    if !crate::inject::accessibility_granted() {
        tracing::info!(
            "Escape-to-cancel needs Accessibility; the overlay button still works"
        );
        return Ok(());
    }

    std::thread::Builder::new()
        .name("telekey-escape-tap".into())
        .spawn(move || run_tap(bus, arm))
        .map_err(|err| anyhow::anyhow!("could not spawn the Escape watcher: {err}"))?;

    tracing::info!("Escape-to-cancel armed on demand");
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn spawn(bus: Bus, arm: Arm) -> Result<()> {
    std::thread::Builder::new()
        .name("telekey-escape-hook".into())
        .spawn(move || run_hook(bus, arm))
        .map_err(|err| anyhow::anyhow!("could not spawn the Escape watcher: {err}"))?;
    tracing::info!("Escape-to-cancel armed on demand");
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn spawn(_bus: Bus, _arm: Arm) -> Result<()> {
    tracing::info!(
        "Escape-to-cancel is not wired on this platform; use the overlay button"
    );
    Ok(())
}

/// `kVK_Escape`.
#[cfg(target_os = "macos")]
const ESCAPE_KEYCODE: i64 = 53;

#[cfg(target_os = "macos")]
fn run_tap(bus: Bus, arm: Arm) {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use objc2_core_foundation::{kCFRunLoopCommonModes, CFMachPort, CFRunLoop};
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventMask, CGEventTapLocation, CGEventTapOptions,
        CGEventTapPlacement, CGEventType,
    };

    struct TapState {
        bus: Bus,
        arm: Arm,
        tap: Option<objc2_core_foundation::CFRetained<objc2_core_foundation::CFMachPort>>,
    }

    let state = Box::leak(Box::new(TapState {
        bus,
        arm,
        tap: None,
    }));
    let user_info = state as *mut TapState as *mut c_void;

    let mask: CGEventMask = (1 << CGEventType::KeyDown.0) | (1 << CGEventType::KeyUp.0);

    let tap = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            // Not listen-only: we swallow Escape while armed so it does not
            // also dismiss a dialog in the app the user was dictating into.
            CGEventTapOptions::Default,
            mask,
            Some(on_event),
            user_info,
        )
    };

    let Some(tap) = tap else {
        tracing::warn!("could not create the Escape tap — check Accessibility");
        return;
    };

    let source = CFMachPort::new_run_loop_source(None, Some(&tap), 0);
    let Some(source) = source else {
        tracing::warn!("could not attach the Escape tap to a run loop");
        return;
    };

    let run_loop = CFRunLoop::current().expect("a thread always has a run loop");
    unsafe {
        run_loop.add_source(Some(&source), kCFRunLoopCommonModes);
        CGEvent::tap_enable(&tap, true);
    }

    state.tap = Some(tap);
    CFRunLoop::run();

    unsafe extern "C-unwind" fn on_event(
        _proxy: objc2_core_graphics::CGEventTapProxy,
        event_type: objc2_core_graphics::CGEventType,
        event: NonNull<objc2_core_graphics::CGEvent>,
        user_info: *mut c_void,
    ) -> *mut objc2_core_graphics::CGEvent {
        let event_ptr = event.as_ptr();
        if user_info.is_null() {
            return event_ptr;
        }
        let state = unsafe { &mut *(user_info as *mut TapState) };

        match event_type {
            CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                if let Some(tap) = state.tap.as_ref() {
                    tracing::warn!("Escape tap was disabled by the system; re-enabling");
                    CGEvent::tap_enable(tap, true);
                }
                return event_ptr;
            }
            CGEventType::KeyDown | CGEventType::KeyUp => {}
            _ => return event_ptr,
        }

        if !state.arm.load(Ordering::Relaxed) {
            return event_ptr;
        }

        let keycode = unsafe {
            CGEvent::integer_value_field(Some(event.as_ref()), CGEventField::KeyboardEventKeycode)
        };
        if keycode != ESCAPE_KEYCODE {
            return event_ptr;
        }

        if event_type == CGEventType::KeyDown {
            state.bus.emit(TriggerEvent::Cancel);
        }
        // Swallow down and up so the front app never sees a lone key-up.
        std::ptr::null_mut()
    }
}

#[cfg(target_os = "windows")]
fn run_hook(bus: Bus, arm: Arm) {
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    const VK_ESCAPE: u32 = 0x1B;

    struct HookState {
        bus: Bus,
        arm: Arm,
    }

    static STATE: std::sync::OnceLock<HookState> = std::sync::OnceLock::new();
    if STATE.set(HookState { bus, arm }).is_err() {
        tracing::warn!("Escape hook already running");
        return;
    }

    unsafe {
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), null_mut(), 0);
        if hook.is_null() {
            tracing::warn!("could not install the Escape keyboard hook");
            return;
        }
    }

    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            if let Some(state) = STATE.get() {
                if state.arm.load(Ordering::Relaxed) {
                    let info = &*(lparam as *const KBDLLHOOKSTRUCT);
                    if info.vkCode == VK_ESCAPE {
                        let down =
                            wparam == WM_KEYDOWN as usize || wparam == WM_SYSKEYDOWN as usize;
                        let up = wparam == WM_KEYUP as usize || wparam == WM_SYSKEYUP as usize;
                        if down {
                            state.bus.emit(TriggerEvent::Cancel);
                        }
                        if down || up {
                            return 1;
                        }
                    }
                }
            }
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arm_starts_disarmed() {
        let arm = new_arm();
        assert!(!arm.load(Ordering::Relaxed));
        arm.store(true, Ordering::Relaxed);
        assert!(arm.load(Ordering::Relaxed));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn escape_matches_the_documented_keycode() {
        assert_eq!(ESCAPE_KEYCODE, 53);
    }
}
