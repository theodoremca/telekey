//! Turning the overlay into a window that never takes focus.
//!
//! This is the load-bearing piece of the whole app. A normal window becomes key
//! when shown, which deactivates whatever the user was typing in — so the
//! synthetic ⌘V would land somewhere else entirely, or nowhere.
//!
//! macOS only grants "show without stealing focus" to an `NSPanel` carrying the
//! `NonactivatingPanel` style bit. Tauri creates an `NSWindow`, so the window's
//! Objective-C class is swapped in place before the style bit is applied. This
//! is what `tauri-nspanel` does; it is done directly here because that crate is
//! not published to crates.io.

#[cfg(target_os = "macos")]
mod imp {
    use anyhow::{bail, Context, Result};
    use objc2::runtime::AnyObject;
    use objc2::ClassType;
    use objc2_app_kit::{
        NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowLevel, NSWindowStyleMask,
    };

    /// `NSStatusWindowLevel`. High enough to sit above ordinary and floating
    /// windows, so the overlay is visible whatever the user is working in.
    const STATUS_WINDOW_LEVEL: NSWindowLevel = 25;

    /// Refuse to touch AppKit off the main thread.
    ///
    /// AppKit asserts internally and takes the process down with SIGTRAP, which
    /// is a terrible way to learn about a threading mistake — the app simply
    /// vanishes the moment the user first presses the shortcut. Failing with an
    /// error instead keeps the dictation working, minus the overlay.
    fn require_main_thread(what: &str) -> Result<()> {
        if !super::on_main_thread() {
            bail!("{what} must run on the main thread; dispatch it first");
        }
        Ok(())
    }

    /// Swap the window's class to `NSPanel` and mark it non-activating.
    ///
    /// # Safety
    ///
    /// Reclassing a live object is sound here only because `NSPanel` is a direct
    /// subclass of `NSWindow` and adds no instance variables — the memory layout
    /// is unchanged, which is precisely why AppKit tolerates this swap.
    pub fn make_nonactivating(window: &tauri::WebviewWindow) -> Result<()> {
        require_main_thread("make_nonactivating")?;

        let raw = window
            .ns_window()
            .context("could not reach the native window handle")?;

        if raw.is_null() {
            bail!("native window handle was null");
        }

        unsafe {
            objc2::ffi::object_setClass(raw as *mut AnyObject, NSPanel::class());

            let panel = &*(raw as *mut NSWindow);

            panel.setStyleMask(panel.styleMask() | NSWindowStyleMask::NonactivatingPanel);
            panel.setLevel(STATUS_WINDOW_LEVEL);

            // Follow the user across spaces, show over full-screen apps, and do
            // not slide with Exposé.
            panel.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::Stationary,
            );

            // Our app is an accessory and is never "active"; without this the
            // panel would vanish the moment focus sits elsewhere — which is the
            // entire time.
            panel.setHidesOnDeactivate(false);

            if panel.canBecomeKeyWindow() {
                bail!("panel still reports it can become key — focus would be stolen");
            }
        }

        Ok(())
    }

    /// Show the panel without making it key or activating the app.
    ///
    /// Deliberately not Tauri's `show()`, which routes through
    /// `makeKeyAndOrderFront:` and would defeat the point.
    pub fn show_without_focus(window: &tauri::WebviewWindow) -> Result<()> {
        require_main_thread("show_without_focus")?;

        let raw = window
            .ns_window()
            .context("could not reach the native window handle")?;

        if raw.is_null() {
            bail!("native window handle was null");
        }

        unsafe {
            (*(raw as *mut NSWindow)).orderFrontRegardless();
        }

        Ok(())
    }

    /// Whether the window would take focus if shown. Should always be false
    /// after [`make_nonactivating`].
    pub fn can_become_key(window: &tauri::WebviewWindow) -> Result<bool> {
        require_main_thread("can_become_key")?;

        let raw = window
            .ns_window()
            .context("could not reach the native window handle")?;

        if raw.is_null() {
            bail!("native window handle was null");
        }

        Ok(unsafe { (*(raw as *mut NSWindow)).canBecomeKeyWindow() })
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use anyhow::Result;

    pub fn make_nonactivating(_window: &tauri::WebviewWindow) -> Result<()> {
        Ok(())
    }

    pub fn show_without_focus(window: &tauri::WebviewWindow) -> Result<()> {
        window.show()?;
        Ok(())
    }

    pub fn can_become_key(_window: &tauri::WebviewWindow) -> Result<bool> {
        Ok(false)
    }
}

pub use imp::{can_become_key, make_nonactivating, show_without_focus};

/// Whether the caller is on the main thread.
///
/// Every AppKit window call in this module depends on it; the crash it prevents
/// is a SIGTRAP with no Rust backtrace, so it is worth an explicit check.
#[cfg(target_os = "macos")]
pub fn on_main_thread() -> bool {
    objc2::MainThreadMarker::new().is_some()
}

#[cfg(not(target_os = "macos"))]
pub fn on_main_thread() -> bool {
    true
}

/// Overlay geometry, in logical points.
pub const OVERLAY_WIDTH: f64 = 296.0;
pub const OVERLAY_HEIGHT: f64 = 68.0;

/// Distance from the bottom of the work area, clearing the Dock.
pub const OVERLAY_BOTTOM_MARGIN: f64 = 96.0;

/// Where the overlay sits: horizontally centred, near the bottom.
///
/// Bottom-centre keeps it out of the way of the text being dictated into, which
/// is usually higher on screen, and matches where macOS puts its own transient
/// feedback.
pub fn overlay_position(screen_width: f64, screen_height: f64) -> (f64, f64) {
    let x = (screen_width - OVERLAY_WIDTH) / 2.0;
    let y = screen_height - OVERLAY_HEIGHT - OVERLAY_BOTTOM_MARGIN;
    (x.max(0.0), y.max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_is_horizontally_centred() {
        let (x, _) = overlay_position(1920.0, 1080.0);
        assert_eq!(x, (1920.0 - OVERLAY_WIDTH) / 2.0);
    }

    #[test]
    fn overlay_sits_above_the_dock() {
        let (_, y) = overlay_position(1920.0, 1080.0);
        assert_eq!(y, 1080.0 - OVERLAY_HEIGHT - OVERLAY_BOTTOM_MARGIN);
        assert!(y + OVERLAY_HEIGHT < 1080.0, "must stay on screen");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_spawned_thread_is_not_the_main_thread() {
        // Regression: the overlay used to call AppKit straight from the pipeline
        // worker, which killed the process with SIGTRAP the first time anyone
        // pressed the shortcut. Everything touching the window now checks this.
        let off_main = std::thread::spawn(on_main_thread).join().unwrap();
        assert!(!off_main, "a spawned thread must not pass the main-thread check");
    }

    #[test]
    fn overlay_stays_on_screen_on_tiny_displays() {
        // A display shorter than the margin must not push the panel off-screen.
        let (x, y) = overlay_position(200.0, 100.0);
        assert!(x >= 0.0 && y >= 0.0, "got ({x}, {y})");
    }
}
