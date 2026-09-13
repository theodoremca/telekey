//! TeleKey — push-to-talk dictation for macOS.
//!
//! Hold the shortcut anywhere, speak, release, and polished text lands at the
//! cursor. The Rust side owns the whole pipeline; the webview is only ever a
//! view onto it.

pub mod audio;
pub mod cli;
pub mod commands;
pub mod fn_key;
pub mod frontmost;
pub mod history;
pub mod inject;
pub mod overlay;
pub mod panel;
pub mod permissions;
pub mod pipeline;
pub mod polish;
pub mod settings;
pub mod setup;
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
            Status::Recording => self.overlay.show(),
            Status::Transcribing => {}
            Status::Inserted { .. } => self.overlay.linger_after_success(),
            Status::Failed { .. } => self.overlay.linger_after_failure(),
            Status::Idle => self.overlay.hide(),
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

    let config_dir = settings::config_dir().unwrap_or_else(|err| {
        tracing::error!("could not locate the config directory: {err:#}");
        std::path::PathBuf::from(".")
    });
    let loaded = load_settings();
    let (trigger_tx, trigger_rx) = mpsc::channel();
    // The Fn tap feeds the same channel as the accelerator, so both triggers
    // are live at once and losing one does not cost the other.
    let fn_tx = trigger_tx.clone();

    tauri::Builder::default()
        .plugin(trigger::plugin(trigger_tx))
        .invoke_handler(tauri::generate_handler![
            commands::load_settings,
            commands::save_settings,
            commands::validate_shortcut,
            commands::api_key_status,
            commands::set_api_key,
            commands::clear_api_key,
            commands::permissions_status,
            commands::open_permission_settings,
            commands::input_device,
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
            // truncated waiting for CoreAudio to initialise.
            pipeline.warmup();

            spawn_level_ticker(app.handle().clone(), Arc::clone(&pipeline));

            if let Err(err) = trigger::rebind(app.handle(), &loaded.shortcut) {
                tracing::error!("could not bind the push-to-talk shortcut: {err:#}");
            }

            if loaded.fn_trigger {
                // Failing here is not fatal: the shortcut above still works, so
                // the user loses the nicer gesture rather than dictation.
                if let Err(err) = fn_key::spawn(fn_tx) {
                    tracing::warn!(
                        "hold-Fn is enabled but could not start ({err:#}); \
                         the keyboard shortcut still works"
                    );
                }
            }

            if !inject::accessibility_granted() {
                tracing::warn!(
                    "Accessibility permission not granted — pasting will silently fail. \
                     Prompting for it now."
                );
                // Registers TeleKey in the Accessibility list and offers the
                // user a direct route there. Shown at most once per launch.
                permissions::prompt_for_accessibility();
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
            let outstanding = setup::evaluate(
                permissions_at_launch,
                permissions::current(),
                commands::ApiKeyStatus::read().is_set,
                loaded.fn_trigger,
            );
            if !outstanding.complete {
                if let Err(err) = open_setup_window(app.handle()) {
                    tracing::warn!("could not open the setup window: {err:#}");
                }
            }

            let worker = Arc::clone(&pipeline);
            std::thread::Builder::new()
                .name("telekey-pipeline".into())
                .spawn(move || worker.run(trigger_rx))?;

            app.manage(pipeline);

            tracing::info!(shortcut = %loaded.shortcut, "telekey ready");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running telekey");
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

/// Open the setup window, or bring it forward if it is already up.
///
/// A window of its own rather than a tab of Settings: it is the first thing a
/// new user sees, it has exactly one job — turn every dot green — and a
/// settings window full of vocabulary lists and rate tables would bury it. It
/// is fixed-size for the same reason.
pub fn open_setup_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(SETUP_LABEL) {
        existing.show()?;
        existing.set_focus()?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        SETUP_LABEL,
        tauri::WebviewUrl::App("setup.html".into()),
    )
    .title("TeleKey Setup")
    // Tall enough for the worst case — four rows and the restart banner —
    // because a checklist that scrolls hides the item you have not done yet.
    .inner_size(460.0, 700.0)
    .resizable(false)
    .center()
    .build()?;

    window.set_focus()?;
    Ok(())
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

    if let Some(icon) = app.default_window_icon() {
        // Template rendering makes the icon follow the menubar's light/dark state.
        tray = tray.icon(icon.clone()).icon_as_template(true);
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
