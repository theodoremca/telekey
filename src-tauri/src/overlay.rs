//! The recording overlay window, and the dictation pill that lives in it.
//!
//! Created once at startup — building it on demand would cost a webview launch
//! at the exact moment the user is already waiting. Between dictations it
//! either hides, or stays on screen as the resting pill: transparent and
//! click-through except over the pill itself, which the pointer watcher below
//! turns on and off as the pointer comes and goes.
//!
//! Both follow the pointer to whichever screen it is on (`panel.rs` does the
//! geometry). The webview is told about hover from here rather than finding
//! out for itself, because a page in a window of an app that is never active
//! cannot rely on seeing the pointer move.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::panel::{self, PillZone, Placement, Rect, Screen};
use crate::pipeline::Status;

pub const OVERLAY_LABEL: &str = "overlay";

/// The pill's state, for the webview: whether it is showing at all, and
/// whether the pointer is over it.
pub const PILL_EVENT: &str = "telekey://pill";

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PillState {
    shown: bool,
    hover: bool,
}

/// How long a success confirmation lingers. Long enough to read the echoed
/// text, short enough not to sit in the way of the next sentence.
const SUCCESS_LINGER: Duration = Duration::from_millis(1_600);

/// Failures stay longer — they carry something the user has to act on.
const FAILURE_LINGER: Duration = Duration::from_millis(4_500);

/// A cancel is just confirmation that nothing happened — keep it brief.
const CANCEL_LINGER: Duration = Duration::from_millis(700);

/// A notice is a glance: "Microphone: AirPods Pro" needs no longer than this.
const NOTICE_LINGER: Duration = Duration::from_millis(2_600);

/// How often the pointer is checked while the pill is showing. Often when it
/// is within reach of the pill, so hovering feels immediate; a few times a
/// second otherwise, which is only to follow it to another screen.
const POINTER_NEAR: Duration = Duration::from_millis(50);
const POINTER_FAR: Duration = Duration::from_millis(250);
/// With the pill off there is nothing to watch; this only notices it coming on.
const PILL_OFF: Duration = Duration::from_millis(500);

/// Screens change only when a display is plugged in or rearranged, so they are
/// re-read this often, or sooner when the pointer is on none of them.
const SCREENS_TTL: Duration = Duration::from_secs(2);

pub struct Overlay {
    app: AppHandle,
    window: WebviewWindow,
    /// Bumped on every visibility change so a scheduled hide belonging to an
    /// earlier dictation cannot close the overlay for the current one.
    generation: AtomicU64,
    /// Whether something is on screen right now, from `show` until the hide
    /// that ends it. A notice only takes the capsule when nothing else has it:
    /// "recording" is false while transcribing and while a result lingers,
    /// which is exactly when a notice would otherwise replace an error.
    busy: AtomicBool,
    /// The latest notice that arrived while the capsule was busy, shown once
    /// it is free. Only the latest: two notices in a row are one fact.
    pending_notice: Mutex<Option<String>>,
    /// "Show the dictation pill", where this OS can have it.
    pill: AtomicBool,
    /// The pointer is over the pill, so the window takes clicks there.
    hovered: AtomicBool,
    /// The pointer was within reach of the pill at the last check.
    near: AtomicBool,
    /// A pointer check is queued on the main thread, so a stalled main thread
    /// does not collect a backlog of them.
    tracking: AtomicBool,
    desk: Mutex<Desk>,
}

/// The screens as last read, and where the window was put on them.
#[derive(Default)]
struct Desk {
    screens: Vec<Screen>,
    /// Divides Tauri's pointer position into desktop units (see [`read_desk`]).
    pointer_scale: f64,
    read_at: Option<Instant>,
    placed: Option<Placement>,
}

impl Overlay {
    pub fn create(app: &AppHandle, show_pill: bool) -> Result<Arc<Self>> {
        let window = match app.get_webview_window(OVERLAY_LABEL) {
            Some(existing) => existing,
            None => build_window(app)?,
        };

        panel::make_nonactivating(&window)
            .context("could not make the overlay non-activating")?;

        // Click-through until a dictation is live and the cancel control
        // exists, or the pointer is over the pill.
        if let Err(err) = window.set_ignore_cursor_events(true) {
            tracing::warn!("could not make the overlay click-through: {err}");
        }

        let overlay = Arc::new(Self {
            app: app.clone(),
            window,
            generation: AtomicU64::new(0),
            busy: AtomicBool::new(false),
            pending_notice: Mutex::new(None),
            pill: AtomicBool::new(show_pill && crate::settings::pill_supported()),
            hovered: AtomicBool::new(false),
            near: AtomicBool::new(false),
            tracking: AtomicBool::new(false),
            desk: Mutex::new(Desk::default()),
        });

        // Startup runs on the main thread, where placing is allowed.
        overlay.place(&overlay.window, true)?;

        Ok(overlay)
    }

    /// Run a window operation on the main thread.
    ///
    /// Every caller here arrives on the pipeline worker thread, and AppKit
    /// window ordering is main-thread-only — calling it from anywhere else
    /// trips an assertion and takes the whole process down with SIGTRAP. Every
    /// method that touches the window must go through this.
    fn on_main<F>(&self, work: F)
    where
        F: FnOnce(&WebviewWindow) + Send + 'static,
    {
        let window = self.window.clone();
        if let Err(err) = self.app.run_on_main_thread(move || work(&window)) {
            tracing::error!("could not reach the main thread: {err}");
        }
    }

    /// Show without taking focus, on the screen the pointer is on.
    pub fn show(self: &Arc<Self>) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.busy.store(true, Ordering::SeqCst);

        let overlay = Arc::clone(self);
        self.on_main(move |window| {
            if let Err(err) = overlay.place(window, true) {
                tracing::warn!("could not position the overlay: {err:#}");
            }
            if let Err(err) = panel::show_without_focus(window) {
                tracing::warn!("could not show the overlay: {err:#}");
            }
        });
    }

    /// Nothing more to show for a dictation: back to the resting pill, or out
    /// of sight when the pill is off.
    pub fn rest(self: &Arc<Self>) {
        let expected = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.rest_now(expected);
    }

    /// Rest after `delay`, unless another dictation starts in the meantime.
    pub fn rest_after(self: &Arc<Self>, delay: Duration) {
        let expected = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let overlay = Arc::clone(self);

        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if overlay.generation.load(Ordering::SeqCst) == expected {
                overlay.rest_now(expected);
            }
        });
    }

    fn rest_now(self: &Arc<Self>, expected: u64) {
        let overlay = Arc::clone(self);
        self.on_main(move |window| {
            // Checked again here, not only by the caller: a dictation that
            // started while this waited for the main thread owns the window
            // now, and the pill must not be drawn over its recording.
            if overlay.generation.load(Ordering::SeqCst) != expected {
                return;
            }
            let pill = overlay.pill.load(Ordering::SeqCst);
            overlay.hovered.store(false, Ordering::SeqCst);
            if let Err(err) = window.set_ignore_cursor_events(true) {
                tracing::warn!("could not make the overlay click-through: {err}");
            }

            // Pill first, then the status, so the webview already knows which
            // of the two resting looks to draw when it hears "idle".
            overlay.announce_pill(pill, false);
            if let Err(err) = overlay.app.emit(crate::STATUS_EVENT, Status::Idle) {
                tracing::warn!("could not emit status: {err}");
            }

            if pill {
                if let Err(err) = overlay.place(window, false) {
                    tracing::warn!("could not position the pill: {err:#}");
                }
                if let Err(err) = panel::show_without_focus(window) {
                    tracing::warn!("could not show the pill: {err:#}");
                }
                // The pointer may already be on the pill — it was, if the
                // dictation was stopped from there.
                overlay.track(window);
            } else if let Err(err) = window.hide() {
                tracing::warn!("could not hide the overlay: {err:#}");
            }
        });
        self.release();
    }

    /// Show a short note when the capsule is free, or keep it until it is.
    ///
    /// Never in place of a dictation's state: a notice that arrived while a
    /// result was lingering would otherwise replace that result and, with its
    /// own shorter linger, hide it early — an "Out of credits" the user never
    /// saw. During a recording the note waits too; the waveform is the only
    /// thing that belongs there.
    pub fn notice(self: &Arc<Self>, text: String) {
        if self.busy.load(Ordering::SeqCst) {
            *self.pending_notice.lock() = Some(text);
            return;
        }
        self.notice_now(text);
    }

    fn notice_now(self: &Arc<Self>, text: String) {
        self.set_clickable(false);
        self.show();
        if let Err(err) = self.app.emit(crate::STATUS_EVENT, Status::Notice { text }) {
            tracing::warn!("could not emit the notice: {err}");
        }
        self.rest_after(NOTICE_LINGER);
    }

    /// The capsule is free again. If a notice queued up meanwhile, it gets its
    /// turn now — after the result, which is the whole point of the queue.
    fn release(self: &Arc<Self>) {
        self.busy.store(false, Ordering::SeqCst);
        let queued = self.pending_notice.lock().take();
        if let Some(text) = queued {
            self.notice_now(text);
        }
    }

    pub fn linger_after_success(self: &Arc<Self>) {
        self.rest_after(SUCCESS_LINGER);
    }

    pub fn linger_after_failure(self: &Arc<Self>) {
        self.rest_after(FAILURE_LINGER);
    }

    pub fn linger_after_cancel(self: &Arc<Self>) {
        self.rest_after(CANCEL_LINGER);
    }

    /// The overlay is click-through except while a dictation can be cancelled,
    /// or the pointer is over the pill.
    pub fn set_clickable(&self, clickable: bool) {
        self.on_main(move |window| {
            if let Err(err) = window.set_ignore_cursor_events(!clickable) {
                tracing::warn!("could not update overlay click-through: {err}");
            }
        });
    }

    /// Turn the resting pill on or off, from Settings. A dictation on screen
    /// keeps the window; the change shows when it ends.
    pub fn set_pill(self: &Arc<Self>, enabled: bool) {
        let enabled = enabled && crate::settings::pill_supported();
        if self.pill.swap(enabled, Ordering::SeqCst) == enabled {
            return;
        }
        tracing::info!(enabled, "dictation pill");
        if !self.busy.load(Ordering::SeqCst) {
            self.rest();
        }
    }

    /// Follow the pointer for as long as the app runs: move the pill to the
    /// screen it is on, and let the pill take clicks only while it is over it.
    pub fn watch_pointer(self: &Arc<Self>) {
        let overlay = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("telekey-pointer".into())
            .spawn(move || loop {
                let pause = if !overlay.pill_resting() {
                    PILL_OFF
                } else if overlay.near.load(Ordering::Relaxed) {
                    POINTER_NEAR
                } else {
                    POINTER_FAR
                };
                std::thread::sleep(pause);

                if !overlay.pill_resting() || overlay.tracking.swap(true, Ordering::SeqCst) {
                    continue;
                }
                let tracked = Arc::clone(&overlay);
                overlay.on_main(move |window| {
                    tracked.track(window);
                    tracked.tracking.store(false, Ordering::SeqCst);
                });
            });
        if let Err(err) = spawned {
            tracing::warn!("could not watch the pointer; the pill will not respond to it: {err}");
        }
    }

    /// For the webview when it loads, which can be after the pill first went
    /// up and so after the event that said so.
    pub fn pill_state(&self) -> PillState {
        PillState {
            shown: self.pill_resting(),
            hover: self.pill_resting() && self.hovered.load(Ordering::SeqCst),
        }
    }

    /// The capsule is showing a dictation (or a note) and has not rested yet.
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    pub fn window(&self) -> &WebviewWindow {
        &self.window
    }

    /// The pill is on and nothing else has the window.
    fn pill_resting(&self) -> bool {
        self.pill.load(Ordering::SeqCst) && !self.busy.load(Ordering::SeqCst)
    }

    /// Main thread only. Move the pill to the pointer's screen if it changed,
    /// and turn the hover on or off.
    fn track(&self, window: &WebviewWindow) {
        // Re-checked on the main thread: a dictation may have started since
        // this was queued, and its capsule needs every click it gets.
        if !self.pill_resting() {
            return;
        }
        let (at, pointer) = match self.place(window, false) {
            Ok(placed) => placed,
            Err(err) => {
                tracing::debug!("could not follow the pointer: {err:#}");
                return;
            }
        };
        let Some((x, y)) = pointer else {
            return;
        };

        self.near
            .store(panel::pointer_is_near(at, x, y), Ordering::Relaxed);

        let was = self.hovered.load(Ordering::SeqCst);
        let zone = if was { PillZone::Hover } else { PillZone::Idle };
        let over = panel::pill_contains(zone, at, x, y);
        if over == was {
            return;
        }
        self.hovered.store(over, Ordering::SeqCst);
        tracing::debug!(hover = over, "pill");
        if let Err(err) = window.set_ignore_cursor_events(!over) {
            tracing::warn!("could not update overlay click-through: {err}");
        }
        self.announce_pill(true, over);
    }

    fn announce_pill(&self, shown: bool, hover: bool) {
        if let Err(err) = self.app.emit(PILL_EVENT, PillState { shown, hover }) {
            tracing::warn!("could not emit the pill state: {err}");
        }
    }

    /// Main thread only. Put the window at the bottom of the screen the
    /// pointer is on, and return where that is and where the pointer was.
    ///
    /// `fresh` re-reads the screens and moves the window even if the answer
    /// looks unchanged, which is right before showing it for a dictation: a
    /// display can be unplugged between two dictations, and macOS then moves
    /// windows itself.
    fn place(
        &self,
        window: &WebviewWindow,
        fresh: bool,
    ) -> Result<(Placement, Option<(f64, f64)>)> {
        let mut desk = self.desk.lock();

        let raw = self.app.cursor_position().ok();
        let pointer_on = |desk: &Desk| {
            raw.map(|p| (p.x / desk.pointer_scale, p.y / desk.pointer_scale))
        };

        let stale = fresh
            || desk.read_at.is_none_or(|at| at.elapsed() > SCREENS_TTL)
            || pointer_on(&desk)
                .is_some_and(|(x, y)| !desk.screens.iter().any(|s| s.bounds.contains(x, y)));
        if stale {
            let (screens, pointer_scale) = read_desk(&self.app)?;
            // Rare, and the first thing to ask for when the capsule turns up
            // on the wrong screen.
            if screens != desk.screens {
                tracing::info!(?screens, pointer_scale, "screens");
            }
            desk.screens = screens;
            desk.pointer_scale = pointer_scale;
            desk.read_at = Some(Instant::now());
        }

        let pointer = pointer_on(&desk);
        // No pointer (it can fail on Wayland): the primary screen, which every
        // OS here puts at the origin.
        let (x, y) = pointer.unwrap_or((0.0, 0.0));
        let screen = panel::screen_at(&desk.screens, x, y)
            .context("could not find a screen to place the overlay on")?;
        let at = panel::overlay_placement(screen);

        if fresh || desk.placed != Some(at) {
            move_to(window, at)?;
            desk.placed = Some(at);
        }

        Ok((at, pointer))
    }
}

/// Every screen, in the units the pointer is measured in, and what divides
/// Tauri's pointer position into those units.
///
/// macOS: Tauri multiplies each screen's position and size, which macOS gives
/// in points, by that screen's own scale factor, and the pointer by the
/// primary screen's. With a Retina laptop beside an ordinary monitor those are
/// three different units, so a pointer on the laptop's right half compared
/// against the monitor's numbers. Dividing each back by the factor it was
/// multiplied by recovers points, one space across every screen.
#[cfg(target_os = "macos")]
fn read_desk(app: &AppHandle) -> Result<(Vec<Screen>, f64)> {
    let monitors = app
        .available_monitors()
        .context("could not list the screens")?;
    let pointer_scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|primary| primary.scale_factor())
        .unwrap_or(1.0);

    let screens = monitors
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let position = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            let work = monitor.work_area();
            let work_position = work.position.to_logical::<f64>(scale);
            let work_size = work.size.to_logical::<f64>(scale);
            Screen {
                bounds: Rect::new(position.x, position.y, size.width, size.height),
                work_area: Rect::new(
                    work_position.x,
                    work_position.y,
                    work_size.width,
                    work_size.height,
                ),
                units_per_point: 1.0,
            }
        })
        .collect();

    Ok((screens, pointer_scale))
}

/// Windows and X11: the desktop is one space of pixels, and Tauri reports both
/// the screens and the pointer in it unchanged.
#[cfg(not(target_os = "macos"))]
fn read_desk(app: &AppHandle) -> Result<(Vec<Screen>, f64)> {
    let monitors = app
        .available_monitors()
        .context("could not list the screens")?;

    let screens = monitors
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let work = monitor.work_area();
            Screen {
                bounds: Rect::new(
                    f64::from(position.x),
                    f64::from(position.y),
                    f64::from(size.width),
                    f64::from(size.height),
                ),
                work_area: Rect::new(
                    f64::from(work.position.x),
                    f64::from(work.position.y),
                    f64::from(work.size.width),
                    f64::from(work.size.height),
                ),
                units_per_point: monitor.scale_factor(),
            }
        })
        .collect();

    Ok((screens, 1.0))
}

/// In points on macOS, where Tauri converts a pixel position with the scale of
/// the screen the window is on *now* — the wrong one when moving it to a
/// screen with a different scale. In pixels elsewhere, for the same reason.
fn move_to(window: &WebviewWindow, at: Placement) -> Result<()> {
    #[cfg(target_os = "macos")]
    let moved = window.set_position(tauri::LogicalPosition::new(at.x, at.y));
    #[cfg(not(target_os = "macos"))]
    let moved = window.set_position(tauri::PhysicalPosition::new(at.x as i32, at.y as i32));
    moved.context("could not move the overlay")
}

fn build_window(app: &AppHandle) -> Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("TeleKey")
    .inner_size(panel::OVERLAY_WIDTH, panel::OVERLAY_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    // The pill's button and the capsule's controls are clicked while another
    // app is active, which is all of the time; without this macOS spends the
    // first click on the window instead of the button.
    .accept_first_mouse(true)
    // Never focused, never visible until a dictation starts.
    .focused(false)
    .visible(false)
    .build()
    .context("could not create the overlay window")
}
