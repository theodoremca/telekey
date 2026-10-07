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

#[cfg(target_os = "windows")]
mod imp {
    use anyhow::{Context, Result};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };

    fn hwnd(window: &tauri::WebviewWindow) -> Result<HWND> {
        let handle = window.hwnd().context("could not reach the native window handle")?;
        Ok(handle.0 as HWND)
    }

    /// The Windows counterpart of the non-activating `NSPanel`.
    ///
    /// `WS_EX_NOACTIVATE` is the load-bearing bit: without it, showing the
    /// overlay takes focus from whatever the user was typing in, and the
    /// synthetic Ctrl+V lands in the wrong place — the same failure the macOS
    /// side had. `WS_EX_TOOLWINDOW` additionally keeps it out of Alt-Tab, which
    /// a transient HUD has no business appearing in.
    pub fn make_nonactivating(window: &tauri::WebviewWindow) -> Result<()> {
        let handle = hwnd(window)?;

        unsafe {
            let current = GetWindowLongPtrW(handle, GWL_EXSTYLE);
            let wanted = current
                | WS_EX_NOACTIVATE as isize
                | WS_EX_TOOLWINDOW as isize
                | WS_EX_TOPMOST as isize;
            SetWindowLongPtrW(handle, GWL_EXSTYLE, wanted);
        }

        Ok(())
    }

    /// Show without stealing focus.
    ///
    /// `SetWindowPos` with `SWP_NOACTIVATE` rather than Tauri's `show()`, which
    /// activates the window.
    pub fn show_without_focus(window: &tauri::WebviewWindow) -> Result<()> {
        let handle = hwnd(window)?;

        unsafe {
            SetWindowPos(
                handle,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }

        Ok(())
    }

    /// Whether the window would take focus if shown.
    pub fn can_become_key(window: &tauri::WebviewWindow) -> Result<bool> {
        let handle = hwnd(window)?;
        let style = unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) };
        Ok(style & WS_EX_NOACTIVATE as isize == 0)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
///
/// Taller than the capsule needs: the window now also holds the dictation pill
/// and stays on screen between dictations, click-through except over the pill,
/// so the extra height costs nothing and gives a two-line failure room to grow
/// upward from the same bottom edge as the pill.
pub const OVERLAY_WIDTH: f64 = 296.0;
pub const OVERLAY_HEIGHT: f64 = 88.0;

/// Distance from the bottom of the work area to the bottom of the window. The
/// work area already excludes the Dock and the taskbar on every screen, so
/// this only has to keep the pill off the very edge. The webview adds its own
/// inset below the capsule and the pill (`overlay.css`, `--rest`).
pub const OVERLAY_BOTTOM_MARGIN: f64 = 6.0;

/// A rectangle on the desktop. `y` grows downward, as Tauri reports positions.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }

    /// Squared distance from the point to the nearest edge; zero inside.
    fn distance_squared(&self, x: f64, y: f64) -> f64 {
        let dx = (self.x - x).max(x - (self.x + self.width)).max(0.0);
        let dy = (self.y - y).max(y - (self.y + self.height)).max(0.0);
        dx * dx + dy * dy
    }
}

/// One display, measured in the same units as the pointer.
///
/// The units differ by OS, and mixing them is the bug this replaces. macOS
/// measures the desktop in points, one space across every screen whatever its
/// scaling, so `units_per_point` is 1. Windows (and X11) measure it in pixels,
/// so a window that is 296 points wide covers 296 × the screen's scale factor
/// of them, and `units_per_point` is that scale factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    pub bounds: Rect,
    /// The part not covered by the Dock, the menu bar or the taskbar.
    pub work_area: Rect,
    pub units_per_point: f64,
}

/// Where the overlay window sits, in desktop units, and how big a point is
/// there. Kept so the pointer can be tested against the pill without asking
/// the window where it is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    pub units_per_point: f64,
}

/// The screen the pointer is on, or the nearest one when it is in a gap
/// between screens of different sizes (or the OS reported it a pixel out).
pub fn screen_at(screens: &[Screen], x: f64, y: f64) -> Option<&Screen> {
    screens
        .iter()
        .find(|screen| screen.bounds.contains(x, y))
        .or_else(|| {
            screens.iter().min_by(|a, b| {
                a.bounds
                    .distance_squared(x, y)
                    .total_cmp(&b.bounds.distance_squared(x, y))
            })
        })
}

/// Where the overlay goes on `screen`: horizontally centred, at the bottom of
/// the work area.
///
/// Bottom-centre keeps it out of the way of the text being dictated into, which
/// is usually higher on screen, and matches where macOS puts its own transient
/// feedback. A work area smaller than the window pins it to the top-left of the
/// work area rather than pushing it off screen.
pub fn overlay_placement(screen: &Screen) -> Placement {
    let unit = screen.units_per_point;
    let area = screen.work_area;
    let width = OVERLAY_WIDTH * unit;
    let height = OVERLAY_HEIGHT * unit;
    let margin = OVERLAY_BOTTOM_MARGIN * unit;

    let x = area.x + ((area.width - width) / 2.0).max(0.0);
    let y = area.y + (area.height - height - margin).max(0.0);

    Placement {
        x: x.round(),
        y: y.round(),
        units_per_point: unit,
    }
}

/// The part of the overlay window that reacts to the pointer while the pill is
/// showing. Everywhere else stays click-through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PillZone {
    /// Resting: a little more than the thin pill itself, so it is easy to find.
    Idle,
    /// Hovered: the widened pill and its button, so moving onto the button
    /// does not count as leaving.
    Hover,
}

impl PillZone {
    /// Width and height in points, measured up from the window's bottom edge.
    pub fn size(self) -> (f64, f64) {
        match self {
            PillZone::Idle => (96.0, 32.0),
            PillZone::Hover => (OVERLAY_WIDTH, 64.0),
        }
    }
}

/// Whether the pointer is over the pill's zone in a window placed at `at`.
pub fn pill_contains(zone: PillZone, at: Placement, x: f64, y: f64) -> bool {
    let (local_x, local_y) = local_point(at, x, y);
    let (width, height) = zone.size();
    Rect::new(
        (OVERLAY_WIDTH - width) / 2.0,
        OVERLAY_HEIGHT - height,
        width,
        height,
    )
    .contains(local_x, local_y)
}

/// Whether the pointer is close enough to the pill that it is worth watching
/// closely. Far away, checking a few times a second is plenty.
pub fn pointer_is_near(at: Placement, x: f64, y: f64) -> bool {
    const REACH: f64 = 160.0;
    let (local_x, local_y) = local_point(at, x, y);
    Rect::new(
        -REACH,
        -REACH,
        OVERLAY_WIDTH + 2.0 * REACH,
        OVERLAY_HEIGHT + 2.0 * REACH,
    )
    .contains(local_x, local_y)
}

/// A desktop point relative to the window's top-left corner, in points.
fn local_point(at: Placement, x: f64, y: f64) -> (f64, f64) {
    let unit = at.units_per_point.max(f64::EPSILON);
    ((x - at.x) / unit, (y - at.y) / unit)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A screen whose work area is the whole of it minus `dock` at the bottom.
    fn screen(x: f64, y: f64, width: f64, height: f64, dock: f64, unit: f64) -> Screen {
        Screen {
            bounds: Rect::new(x, y, width, height),
            work_area: Rect::new(x, y, width, height - dock),
            units_per_point: unit,
        }
    }

    #[test]
    fn overlay_is_centred_at_the_bottom_of_the_work_area() {
        let laptop = screen(0.0, 0.0, 1512.0, 982.0, 70.0, 1.0);
        let at = overlay_placement(&laptop);
        assert_eq!(at.x, ((1512.0 - OVERLAY_WIDTH) / 2.0).round());
        assert_eq!(at.y, 982.0 - 70.0 - OVERLAY_HEIGHT - OVERLAY_BOTTOM_MARGIN);
        assert!(at.y + OVERLAY_HEIGHT <= 982.0 - 70.0, "must clear the Dock");
    }

    #[test]
    fn the_pointer_picks_the_screen_side_by_side() {
        // The bug: with the laptop on the left and a monitor on the right, the
        // capsule stayed on whichever screen it had first appeared on.
        let screens = [
            screen(0.0, 0.0, 1512.0, 982.0, 70.0, 1.0),
            screen(1512.0, 0.0, 2560.0, 1440.0, 0.0, 1.0),
        ];
        let right = screen_at(&screens, 2000.0, 700.0).unwrap();
        assert_eq!(right.bounds.x, 1512.0);
        let at = overlay_placement(right);
        assert!(at.x > 1512.0 && at.x + OVERLAY_WIDTH < 1512.0 + 2560.0);

        let left = screen_at(&screens, 10.0, 10.0).unwrap();
        assert_eq!(left.bounds.x, 0.0);
    }

    #[test]
    fn the_pointer_picks_the_screen_stacked() {
        let screens = [
            screen(0.0, 0.0, 1512.0, 982.0, 70.0, 1.0),
            screen(-524.0, -1440.0, 2560.0, 1440.0, 0.0, 1.0),
        ];
        let above = screen_at(&screens, 100.0, -20.0).unwrap();
        assert_eq!(above.bounds.y, -1440.0);
        let at = overlay_placement(above);
        assert!(at.y < 0.0, "the capsule belongs on the upper screen");
        assert_eq!(at.y, -OVERLAY_HEIGHT - OVERLAY_BOTTOM_MARGIN);
    }

    #[test]
    fn a_screen_left_of_the_primary_has_negative_coordinates() {
        let screens = [
            screen(0.0, 0.0, 1512.0, 982.0, 70.0, 1.0),
            screen(-2560.0, -200.0, 2560.0, 1440.0, 0.0, 1.0),
        ];
        let left = screen_at(&screens, -1.0, 500.0).unwrap();
        let at = overlay_placement(left);
        assert_eq!(at.x, (-2560.0 + (2560.0 - OVERLAY_WIDTH) / 2.0).round());
        assert_eq!(at.y, -200.0 + 1440.0 - OVERLAY_HEIGHT - OVERLAY_BOTTOM_MARGIN);
    }

    #[test]
    fn pixels_scale_the_window_on_a_high_dpi_screen() {
        // Windows measures in pixels: on a 150% screen the 296-point window is
        // 444 pixels wide, and centring must use that.
        let monitor = screen(1920.0, 0.0, 3840.0, 2160.0, 72.0, 1.5);
        let at = overlay_placement(&monitor);
        assert_eq!(at.x, 1920.0 + (3840.0 - OVERLAY_WIDTH * 1.5) / 2.0);
        assert_eq!(
            at.y,
            2160.0 - 72.0 - (OVERLAY_HEIGHT + OVERLAY_BOTTOM_MARGIN) * 1.5
        );
    }

    #[test]
    fn a_pointer_in_a_gap_goes_to_the_nearest_screen() {
        // A short screen beside a tall one leaves an area below it that is on
        // no screen; the pointer cannot be there, but a rounding error can.
        let screens = [
            screen(0.0, 0.0, 1512.0, 982.0, 70.0, 1.0),
            screen(1512.0, 0.0, 2560.0, 1440.0, 0.0, 1.0),
        ];
        let nearest = screen_at(&screens, 1500.0, 1200.0).unwrap();
        assert_eq!(nearest.bounds.x, 1512.0);
        assert!(screen_at(&[], 0.0, 0.0).is_none());
    }

    #[test]
    fn overlay_stays_on_screen_on_tiny_displays() {
        let tiny = screen(0.0, 0.0, 200.0, 60.0, 0.0, 1.0);
        let at = overlay_placement(&tiny);
        assert!(at.x >= 0.0 && at.y >= 0.0, "got ({}, {})", at.x, at.y);
    }

    #[test]
    fn the_pill_zone_is_a_strip_at_the_bottom_centre() {
        let at = Placement { x: 100.0, y: 500.0, units_per_point: 1.0 };
        let centre_x = 100.0 + OVERLAY_WIDTH / 2.0;
        let bottom = 500.0 + OVERLAY_HEIGHT;

        assert!(pill_contains(PillZone::Idle, at, centre_x, bottom - 4.0));
        // Above the resting pill: not yet, or the window would swallow clicks
        // well above where anything is drawn.
        assert!(!pill_contains(PillZone::Idle, at, centre_x, bottom - 40.0));
        // Once hovered, the zone grows to cover the widened pill.
        assert!(pill_contains(PillZone::Hover, at, centre_x, bottom - 40.0));
        assert!(pill_contains(PillZone::Hover, at, 101.0, bottom - 4.0));
        assert!(!pill_contains(PillZone::Idle, at, 101.0, bottom - 4.0));
        // Outside the window entirely.
        assert!(!pill_contains(PillZone::Hover, at, centre_x, bottom + 1.0));
    }

    #[test]
    fn the_pill_zone_scales_with_pixels() {
        let at = Placement { x: 0.0, y: 0.0, units_per_point: 2.0 };
        let centre_x = OVERLAY_WIDTH; // half the width, doubled
        let bottom = OVERLAY_HEIGHT * 2.0;
        assert!(pill_contains(PillZone::Idle, at, centre_x, bottom - 8.0));
        assert!(!pill_contains(PillZone::Idle, at, centre_x, bottom - 80.0));
    }

    #[test]
    fn near_means_within_reach_of_the_window() {
        let at = Placement { x: 1000.0, y: 900.0, units_per_point: 1.0 };
        assert!(pointer_is_near(at, 1100.0, 880.0));
        assert!(!pointer_is_near(at, 200.0, 100.0));
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
}
