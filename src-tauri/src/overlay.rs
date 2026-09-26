//! The recording overlay window.
//!
//! Created once at startup and shown/hidden per dictation — building it on
//! demand would cost a webview launch at the exact moment the user is already
//! waiting.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::panel;
use crate::pipeline::Status;

pub const OVERLAY_LABEL: &str = "overlay";

/// How long a success confirmation lingers. Long enough to read the echoed
/// text, short enough not to sit in the way of the next sentence.
const SUCCESS_LINGER: Duration = Duration::from_millis(1_600);

/// Failures stay longer — they carry something the user has to act on.
const FAILURE_LINGER: Duration = Duration::from_millis(4_500);

/// A cancel is just confirmation that nothing happened — keep it brief.
const CANCEL_LINGER: Duration = Duration::from_millis(700);

/// A notice is a glance: "Microphone: AirPods Pro" needs no longer than this.
const NOTICE_LINGER: Duration = Duration::from_millis(2_600);

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
}

impl Overlay {
    pub fn create(app: &AppHandle) -> Result<Arc<Self>> {
        let window = match app.get_webview_window(OVERLAY_LABEL) {
            Some(existing) => existing,
            None => build_window(app)?,
        };

        panel::make_nonactivating(&window)
            .context("could not make the overlay non-activating")?;

        // Click-through until a dictation is live and the cancel control exists.
        if let Err(err) = window.set_ignore_cursor_events(true) {
            tracing::warn!("could not make the overlay click-through: {err}");
        }

        position(&window)?;

        Ok(Arc::new(Self {
            app: app.clone(),
            window,
            generation: AtomicU64::new(0),
            busy: AtomicBool::new(false),
            pending_notice: Mutex::new(None),
        }))
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

    /// Show without taking focus. Position is refreshed first so the overlay
    /// follows the user's current display.
    pub fn show(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.busy.store(true, Ordering::SeqCst);

        self.on_main(|window| {
            if let Err(err) = position(window) {
                tracing::warn!("could not position the overlay: {err:#}");
            }
            if let Err(err) = panel::show_without_focus(window) {
                tracing::warn!("could not show the overlay: {err:#}");
            }
        });
    }

    pub fn hide(self: &Arc<Self>) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.on_main(|window| {
            if let Err(err) = window.hide() {
                tracing::warn!("could not hide the overlay: {err:#}");
            }
        });
        self.release();
    }

    /// Hide after `delay`, unless another dictation starts in the meantime.
    pub fn hide_after(self: &Arc<Self>, delay: Duration) {
        let expected = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let overlay = Arc::clone(self);

        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if overlay.generation.load(Ordering::SeqCst) == expected {
                overlay.on_main(|window| {
                    if let Err(err) = window.hide() {
                        tracing::warn!("could not hide the overlay: {err:#}");
                    }
                });
                overlay.release();
            }
        });
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
        self.hide_after(NOTICE_LINGER);
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
        self.hide_after(SUCCESS_LINGER);
    }

    pub fn linger_after_failure(self: &Arc<Self>) {
        self.hide_after(FAILURE_LINGER);
    }

    pub fn linger_after_cancel(self: &Arc<Self>) {
        self.hide_after(CANCEL_LINGER);
    }

    /// The overlay is click-through except while a dictation can be cancelled.
    pub fn set_clickable(&self, clickable: bool) {
        self.on_main(move |window| {
            if let Err(err) = window.set_ignore_cursor_events(!clickable) {
                tracing::warn!("could not update overlay click-through: {err}");
            }
        });
    }

    pub fn window(&self) -> &WebviewWindow {
        &self.window
    }
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
    // Never focused, never visible until a dictation starts.
    .focused(false)
    .visible(false)
    .build()
    .context("could not create the overlay window")
}

/// Centre horizontally near the bottom of the display the pointer is on.
fn position(window: &WebviewWindow) -> Result<()> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .context("could not find a monitor to place the overlay on")?;

    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let origin = monitor.position().to_logical::<f64>(scale);

    let (x, y) = panel::overlay_position(size.width, size.height);

    window
        .set_position(tauri::LogicalPosition::new(origin.x + x, origin.y + y))
        .context("could not move the overlay")?;

    Ok(())
}
