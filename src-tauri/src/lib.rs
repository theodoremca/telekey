//! TeleKey — push-to-talk dictation for macOS.
//!
//! Hold the shortcut anywhere, speak, release, and polished text lands at the
//! cursor. The Rust side owns the whole pipeline; the webview is only ever a
//! view onto it.

pub mod audio;
pub mod cli;
pub mod commands;
pub mod escape;
pub mod fn_key;
pub mod frontmost;
pub mod history;
pub mod hosted;
pub mod inject;
pub mod input_device;
pub mod output_mute;
pub mod overlay;
pub mod panel;
pub mod permissions;
pub mod pipeline;
pub mod polish;
pub mod settings;
pub mod setup;
pub mod session;
pub mod signing;
pub mod transcribe;
pub mod usage;
pub mod trigger;

use std::sync::{mpsc, Arc};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use pipeline::{Pipeline, Status, StatusSink};
use settings::Settings;

/// Event names the overlay listens on.
pub const STATUS_EVENT: &str = "telekey://status";
pub const LEVEL_EVENT: &str = "telekey://level";
pub const SESSION_EVENT: &str = "telekey://session";
/// Settings were saved, by any window. Carries the saved `Settings`.
pub const SETTINGS_EVENT: &str = "telekey://settings";
/// The default microphone changed, or a device came or went. Carries the
/// current default as an `Option<InputDevice>`.
pub const INPUT_DEVICE_EVENT: &str = "telekey://input-device";

/// How often the input level is pushed to the overlay while recording.
/// 30 Hz is smooth to the eye and cheap over IPC.
const LEVEL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(33);

/// Publishes pipeline status onto the Tauri event bus and drives the overlay's
/// visibility from it.
struct TauriSink {
    app: AppHandle,
    overlay: Arc<overlay::Overlay>,
}

impl StatusSink for TauriSink {
    fn publish(&self, status: Status) {
        // The overlay has to be visible before it can render the state, so show
        // first and emit second.
        match &status {
            Status::Recording => {
                self.overlay.set_clickable(true);
                self.overlay.show();
            }
            Status::Transcribing => self.overlay.set_clickable(true),
            Status::Inserted { .. } => {
                self.overlay.set_clickable(false);
                self.overlay.linger_after_success();
            }
            Status::Failed { message } => {
                let lower = message.to_ascii_lowercase();
                let buy = lower.contains("credit");
                self.overlay.set_clickable(buy);
                self.overlay.linger_after_failure();
                if buy {
                    if let Err(err) = open_main_window(&self.app, "usage") {
                        tracing::warn!("could not open credits: {err}");
                    }
                }
                // The key was held before the microphone was allowed. The
                // message says "in Setup", so Setup had better be on screen.
                if lower.contains("microphone") {
                    let app = self.app.clone();
                    let queued = self.app.run_on_main_thread(move || {
                        if let Err(err) = open_setup_window(&app) {
                            tracing::warn!("could not open setup: {err}");
                        }
                    });
                    if let Err(err) = queued {
                        tracing::warn!("could not reach the main thread for setup: {err}");
                    }
                }
            }
            Status::Cancelled => {
                self.overlay.set_clickable(false);
                self.overlay.linger_after_cancel();
            }
            Status::Idle => {
                self.overlay.set_clickable(false);
                self.overlay.hide();
            }
            // The overlay decides when a notice may take the capsule, and
            // emits it itself at that moment — so not here, where it would
            // land on top of whatever the capsule is showing.
            Status::Notice { text } => {
                self.overlay.notice(text.clone());
                return;
            }
        }

        if let Err(err) = self.app.emit(STATUS_EVENT, &status) {
            tracing::warn!("could not emit status: {err}");
        }
    }
}

/// Push the input level to the overlay while a dictation is running.
fn spawn_level_ticker(app: AppHandle, pipeline: Arc<Pipeline>) {
    std::thread::Builder::new()
        .name("telekey-level".into())
        .spawn(move || loop {
            std::thread::sleep(LEVEL_INTERVAL);
            if pipeline.is_recording() {
                let _ = app.emit(LEVEL_EVENT, pipeline.level());
            }
        })
        .expect("failed to spawn the level ticker");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    session::hydrate_env();

    let config_dir = settings::config_dir().unwrap_or_else(|err| {
        tracing::error!("could not locate the config directory: {err:#}");
        std::path::PathBuf::from(".")
    });
    let loaded = load_settings();
    let (trigger_tx, trigger_rx) = mpsc::channel();
    let trigger_bus = trigger::Bus::new(trigger_tx);
    // The Fn tap feeds the same channel as the accelerator, so both triggers
    // are live at once and losing one does not cost the other.
    let fn_bus = trigger_bus.clone();
    let escape_bus = trigger_bus.clone();

    tauri::Builder::default()
        .plugin(trigger::plugin(trigger_bus.clone()))
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            commands::load_settings,
            commands::save_settings,
            commands::set_fn_trigger,
            commands::validate_shortcut,
            commands::can_mute_output,
            commands::api_key_status,
            commands::set_api_key,
            commands::clear_api_key,
            commands::permissions_status,
            commands::open_permission_settings,
            commands::input_device,
            commands::input_devices,
            commands::history_entries,
            commands::delete_history_entry,
            commands::clear_history,
            commands::copy_to_clipboard,
            commands::open_apps,
            commands::signing_status,
            commands::usage_summary,
            commands::usage_daily,
            commands::clear_usage,
            commands::request_input_monitoring,
            commands::setup_state,
            commands::prompt_for_microphone,
            commands::restart_app,
            commands::cancel_dictation,
            commands::session_status,
            commands::set_session,
            commands::clear_session,
            commands::open_hosted_login,
            commands::open_hosted_account,
            commands::hosted_account,
            commands::create_checkout,
            commands::open_credits,
        ])
        .setup(move |app| {
            // A menubar app, not a dock app.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Snapshot the permissions before anything can change them. This is
            // the only chance: once granted mid-session, a permission reads as
            // trusted while the process still behaves as though it is not, and
            // the setup window needs to know the difference to ask for the one
            // restart that fixes it.
            let permissions_at_launch = permissions::current();
            app.manage(commands::LaunchPermissions(permissions_at_launch));

            let overlay = overlay::Overlay::create(app.handle())?;
            match panel::can_become_key(overlay.window()) {
                Ok(false) => tracing::info!("overlay is non-activating"),
                Ok(true) => tracing::error!(
                    "overlay can still become key — pasting will land in the wrong app"
                ),
                Err(err) => tracing::warn!("could not verify overlay focus behaviour: {err:#}"),
            }

            let sink = Arc::new(TauriSink {
                app: app.handle().clone(),
                overlay: Arc::clone(&overlay),
            });
            let history = Arc::new(history::History::load(&config_dir));
            let usage = Arc::new(usage::Usage::load(&config_dir));
            let pipeline = Arc::new(Pipeline::new(loaded.clone(), sink, history, usage));

            // Open the microphone once now, so the first real dictation is not
            // truncated waiting for CoreAudio to initialise — unless macOS has
            // never asked about the microphone. Opening it is what makes macOS
            // ask, and on a first run that dialog would land before the setup
            // window could explain it. The setup window's "Allow…" opens the
            // device instead, and `setup_state` warms up once it is granted.
            // Denied and Unknown (every other OS) still warm up as before.
            if permissions_at_launch.microphone == permissions::Permission::NotAsked {
                tracing::info!("microphone never asked for; warmup waits for the setup window");
            } else {
                pipeline.warmup();
            }

            spawn_level_ticker(app.handle().clone(), Arc::clone(&pipeline));

            // Follow the system's choice of microphone, and say so when it
            // changes: the settings window updates its Microphone row, and a
            // notice names the new device — unless the user pinned one, in
            // which case the default changing is not their concern. A device
            // that merely appeared only refreshes the picker.
            {
                let app = app.handle().clone();
                let overlay = Arc::clone(&overlay);
                let watched = Arc::clone(&pipeline);
                input_device::watch(move |change| match change {
                    input_device::Change::Default(device) => {
                        if let Err(err) = app.emit(INPUT_DEVICE_EVENT, &device) {
                            tracing::warn!("could not announce the microphone change: {err}");
                        }
                        let pinned = watched.settings().input_device.is_some();
                        if let (Some(device), false) = (device, pinned) {
                            tracing::info!(microphone = %device.name, "default input device changed");
                            overlay.notice(format!("Microphone: {}", device.name));
                        }
                    }
                    input_device::Change::List => {
                        if let Err(err) = app.emit(INPUT_DEVICE_EVENT, input_device::current()) {
                            tracing::warn!("could not announce the device list change: {err}");
                        }
                    }
                });
            }

            tracing::info!(
                api = session::api_base().as_deref(),
                site = session::site_url().as_deref(),
                shortcut = %loaded.shortcut,
                fn_trigger = loaded.fn_trigger,
                "hosted endpoints"
            );

            if let Err(err) = trigger::rebind(app.handle(), &loaded.shortcut) {
                tracing::error!("could not bind the push-to-talk shortcut: {err:#}");
            }

            // No permission is requested from here. Every system dialog is
            // triggered by a button in the setup window, in the order the user
            // reads them, once the window has said what each one is for. Three
            // unexplained dialogs stacked on top of each other before that
            // window existed is what a first launch used to look like.
            if loaded.fn_trigger {
                // Failing here is not fatal: the shortcut above still works, so
                // the user loses the nicer gesture rather than dictation. On a
                // first run this is expected — the tap starts after the restart
                // the setup window asks for.
                if let Err(err) = fn_key::spawn(fn_bus) {
                    tracing::warn!(
                        "hold-Fn is enabled but could not start ({err:#}); \
                         the keyboard shortcut still works"
                    );
                }
            }

            if !inject::accessibility_granted() {
                tracing::warn!(
                    "Accessibility permission not granted — pasting will silently fail \
                     until it is granted from the setup window"
                );
            }

            // A build that cannot hold a permission is worth saying out loud —
            // otherwise the symptom is just "dictation stopped pasting".
            if let Some(advice) = signing::current().advice() {
                tracing::warn!("{advice}");
            }

            build_tray(app.handle())?;

            // First run, or something revoked since the last one: put the work
            // in front of the user. Without this the app looks installed and
            // simply does nothing when the shortcut is held, which is the worst
            // failure this app has — silent, and indistinguishable from a bug.
            //
            // On a worker thread, because deciding means reading the key, and
            // reading the key can touch the Keychain — which is entitled to put
            // an authorisation dialog on screen, and did: doing this inline
            // stalled startup for as long as the dialog went unanswered. Only
            // the window itself goes back to the main thread, where AppKit
            // requires it (see rule 1 in CLAUDE.md).
            let handle = app.handle().clone();
            let fn_trigger = loaded.fn_trigger;
            // A restart the setup window asked for: it should come back up and
            // say the job is done, or the user is left staring at nothing.
            let after_restart = std::env::var_os(commands::SETUP_AFTER_RESTART).is_some();
            if after_restart {
                // SAFETY: still single-threaded startup; nothing else reads the
                // environment yet.
                unsafe { std::env::remove_var(commands::SETUP_AFTER_RESTART) };
            }
            std::thread::spawn(move || {
                let outstanding = setup::evaluate(
                    permissions_at_launch,
                    permissions::current(),
                    commands::credentials_ready(),
                    fn_trigger,
                );
                // Worth a line either way: "the setup window did not appear" and
                // "the setup window appeared when it should not have" are both
                // bug reports, and neither is diagnosable from silence.
                let missing = outstanding
                    .requirements
                    .iter()
                    .filter(|row| !row.is_done())
                    .count();
                if outstanding.complete && !after_restart {
                    tracing::info!("setup is complete, nothing to prompt for");
                    return;
                }
                tracing::info!(missing, after_restart, "opening the setup window");

                let opener = handle.clone();
                let queued = handle.run_on_main_thread(move || {
                    if let Err(err) = open_setup_window(&opener) {
                        tracing::warn!("could not open the setup window: {err:#}");
                    }
                });
                if let Err(err) = queued {
                    tracing::warn!("could not reach the main thread for setup: {err:#}");
                }
            });

            let worker = Arc::clone(&pipeline);
            if let Err(err) = escape::spawn(escape_bus, pipeline.escape_arm()) {
                tracing::warn!("Escape-to-cancel is unavailable ({err:#}); the overlay button still works");
            }

            std::thread::Builder::new()
                .name("telekey-pipeline".into())
                .spawn(move || worker.run(trigger_rx))?;

            app.manage(trigger_bus);
            app.manage(Arc::clone(&pipeline));
            listen_for_hosted_session(app.handle(), Arc::clone(&pipeline));

            tracing::info!(
                shortcut = %loaded.shortcut,
                fn_trigger = loaded.fn_trigger,
                "telekey ready"
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running telekey")
        .run(|app, event| {
            // Quitting mid-dictation must never leave the machine silent. This
            // covers a clean exit; a force-kill cannot be caught, which is why
            // the muting uses the device's own mute flag where it has one —
            // that is one click to undo from the menu bar.
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                if let Some(pipeline) = app.try_state::<Arc<Pipeline>>() {
                    pipeline.restore_output();
                }
            }
        });
}

pub const SETTINGS_LABEL: &str = "settings";

/// Event telling the window which tab to show.
pub const TAB_EVENT: &str = "telekey://tab";

/// Open the main window on `tab`, or bring it forward if it already exists.
///
/// Settings and History are tabs of one window rather than two windows: for a
/// utility this small, a second window is more to manage than it is worth.
pub fn open_main_window(app: &AppHandle, tab: &str) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(SETTINGS_LABEL) {
        existing.show()?;
        existing.set_focus()?;
        existing.emit(TAB_EVENT, tab)?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        tauri::WebviewUrl::App(format!("index.html?tab={tab}").into()),
    )
    .title("TeleKey")
    .inner_size(540.0, 680.0)
    .min_inner_size(460.0, 520.0)
    .resizable(true)
    .build()?;

    // Unlike the overlay, this window is meant to be interacted with.
    window.set_focus()?;
    Ok(())
}

pub const SETUP_LABEL: &str = "setup";

/// The setup window's size. The height was measured in the browser preview
/// with the fullest state on screen — four rows, the credentials form open,
/// the "use the shortcut instead" action — at 754 px, and rounded up to leave
/// room for an error line. The page keeps its footer stuck to the bottom, so
/// even on a display too short for this the Done button stays in view.
const SETUP_WIDTH: f64 = 460.0;
const SETUP_HEIGHT: f64 = 800.0;
const SETUP_MIN_HEIGHT: f64 = 620.0;
/// Space left for the menubar and Dock when the display is smaller than the
/// window would like to be.
const SETUP_WORK_AREA_MARGIN: f64 = 24.0;

/// Open the setup window, or bring it forward if it is already up.
///
/// A window of its own rather than a tab of Settings: it is the first thing a
/// new user sees, it has exactly one job — turn every dot green — and a
/// settings window full of vocabulary lists and rate tables would bury it.
pub fn open_setup_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(SETUP_LABEL) {
        existing.show()?;
        existing.set_focus()?;
        return Ok(());
    }

    let height = setup_height_for(app);
    let window = tauri::WebviewWindowBuilder::new(
        app,
        SETUP_LABEL,
        tauri::WebviewUrl::App("setup.html".into()),
    )
    .title("TeleKey Setup")
    .inner_size(SETUP_WIDTH, height)
    .min_inner_size(SETUP_WIDTH, SETUP_MIN_HEIGHT.min(height))
    // Resizable so nothing can ever be clipped, but not maximisable: a
    // full-screen checklist is absurd, and the green button would offer it.
    .resizable(true)
    .maximizable(false)
    .center()
    .build()?;

    window.set_focus()?;
    Ok(())
}

/// The preferred height, or as much of it as the display's work area allows.
fn setup_height_for(app: &AppHandle) -> f64 {
    let available = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            monitor.work_area().size.height as f64 / scale - SETUP_WORK_AREA_MARGIN
        });
    match available {
        Some(limit) if limit < SETUP_HEIGHT => limit.max(SETUP_MIN_HEIGHT),
        _ => SETUP_HEIGHT,
    }
}

/// `telekey://auth?…` lands the Firebase session in the Keychain.
fn listen_for_hosted_session(app: &AppHandle, pipeline: Arc<Pipeline>) {
    use tauri_plugin_deep_link::DeepLinkExt;

    let handle = app.clone();
    let pipe = Arc::clone(&pipeline);
    app.deep_link().on_open_url(move |event| {
        apply_auth_urls(&handle, &pipe, event.urls());
    });

    match app.deep_link().get_current() {
        Ok(Some(urls)) => apply_auth_urls(app, &pipeline, urls),
        Ok(None) => {}
        Err(err) => tracing::debug!("no launch URL: {err}"),
    }
}

fn apply_auth_urls(app: &AppHandle, pipeline: &Pipeline, urls: Vec<url::Url>) {
    for url in urls {
        match session::session_from_callback_url(url.as_str()) {
            Ok(next) => {
                if let Err(err) = session::store(&next) {
                    tracing::warn!("could not store the hosted session: {err:#}");
                    continue;
                }
                pipeline.invalidate_transcriber();
                if let Err(err) = app.emit(SESSION_EVENT, session::status()) {
                    tracing::warn!("could not emit session: {err}");
                }
                tracing::info!("hosted session stored");

                // Back to the window the user was in. Mid-setup, that is the
                // setup window, whose rows still need doing; opening Usage on
                // top of it left two windows and no obvious next step. This
                // also covers a cold launch by the link itself, where the URL
                // arrives before the setup window has been created: opening it
                // here is idempotent with the startup check. Credentials are
                // known ready — the session was stored a moment ago — so the
                // Keychain is not read again on this thread.
                let outstanding = app.try_state::<commands::LaunchPermissions>().map(|at_launch| {
                    setup::evaluate(
                        at_launch.0,
                        permissions::current(),
                        true,
                        pipeline.settings().fn_trigger,
                    )
                });
                let opened = match outstanding {
                    Some(state) if !state.complete => open_setup_window(app),
                    _ => open_main_window(app, "usage"),
                };
                if let Err(err) = opened {
                    tracing::warn!("could not open a window after sign-in: {err}");
                }
            }
            Err(err) => tracing::debug!("ignored URL: {err:#}"),
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let history_item = MenuItem::with_id(app, "history", "History…", true, None::<&str>)?;
    let usage_item = MenuItem::with_id(app, "usage", "Usage…", true, None::<&str>)?;
    let settings_item =
        MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    // Reachable after the first run too: permissions can be revoked, and a
    // macOS update has been known to drop them on its own.
    let setup_item = MenuItem::with_id(app, "setup", "Setup…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit TeleKey", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &history_item,
            &usage_item,
            &settings_item,
            &setup_item,
            &quit,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id("telekey")
        .menu(&menu)
        .tooltip("TeleKey — hold to dictate")
        .on_menu_event(|app, event| match event.id().as_ref() {
            id @ ("settings" | "history" | "usage") => {
                if let Err(err) = open_main_window(app, id) {
                    tracing::error!("could not open the {id} window: {err}");
                }
            }
            "setup" => {
                if let Err(err) = open_setup_window(app) {
                    tracing::error!("could not open the setup window: {err}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });

    // The menubar gets its own glyph. A template image is drawn from alpha alone
    // so it can follow the menubar's light/dark state, and the app icon is a
    // filled tile: used here it would be a blank rounded square.
    #[cfg(target_os = "macos")]
    {
        let glyph = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
        tray = tray.icon(glyph).icon_as_template(true);
    }
    // Windows and Linux trays show the icon in colour, so the tile is right there.
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

/// Load settings, falling back to defaults rather than refusing to start.
///
/// A user with a broken config file still gets a working dictation key; the
/// error is logged so it is diagnosable.
fn load_settings() -> Settings {
    let dir = match settings::config_dir() {
        Ok(dir) => dir,
        Err(err) => {
            tracing::error!("could not locate the config directory: {err:#}");
            return Settings::default();
        }
    };

    match Settings::load(&dir) {
        Ok(settings) => settings,
        Err(err) => {
            tracing::error!("could not load settings, using defaults: {err:#}");
            Settings::default()
        }
    }
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_env("TELEKEY_LOG")
        .unwrap_or_else(|_| EnvFilter::new("telekey=info,warn"));

    let _ = fmt().with_env_filter(filter).try_init();
}
