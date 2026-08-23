//! Flowtype — push-to-talk dictation for macOS.
//!
//! Hold the shortcut anywhere, speak, release, and polished text lands at the
//! cursor. The Rust side owns the whole pipeline; the webview is only ever a
//! view onto it.

pub mod audio;
pub mod cli;
pub mod commands;
pub mod frontmost;
pub mod history;
pub mod inject;
pub mod overlay;
pub mod panel;
pub mod permissions;
pub mod pipeline;
pub mod polish;
pub mod settings;
pub mod signing;
pub mod transcribe;
pub mod trigger;

use std::sync::{mpsc, Arc};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use pipeline::{Pipeline, Status, StatusSink};
use settings::Settings;

/// Event names the overlay listens on.
pub const STATUS_EVENT: &str = "flowtype://status";
pub const LEVEL_EVENT: &str = "flowtype://level";

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
        .name("flowtype-level".into())
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
        ])
        .setup(move |app| {
            // A menubar app, not a dock app.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

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
            let pipeline = Arc::new(Pipeline::new(loaded.clone(), sink, history));

            // Open the microphone once now, so the first real dictation is not
            // truncated waiting for CoreAudio to initialise.
            pipeline.warmup();

            spawn_level_ticker(app.handle().clone(), Arc::clone(&pipeline));

            if let Err(err) = trigger::rebind(app.handle(), &loaded.shortcut) {
                tracing::error!("could not bind the push-to-talk shortcut: {err:#}");
            }

            if !inject::accessibility_granted() {
                tracing::warn!(
                    "Accessibility permission not granted — pasting will silently fail. \
                     Prompting for it now."
                );
                // Registers Flowtype in the Accessibility list and offers the
                // user a direct route there. Shown at most once per launch.
                permissions::prompt_for_accessibility();
            }

            // A build that cannot hold a permission is worth saying out loud —
            // otherwise the symptom is just "dictation stopped pasting".
            if let Some(advice) = signing::current().advice() {
                tracing::warn!("{advice}");
            }

            build_tray(app.handle())?;

            let worker = Arc::clone(&pipeline);
            std::thread::Builder::new()
                .name("flowtype-pipeline".into())
                .spawn(move || worker.run(trigger_rx))?;

            app.manage(pipeline);

            tracing::info!(shortcut = %loaded.shortcut, "flowtype ready");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running flowtype");
}

pub const SETTINGS_LABEL: &str = "settings";

/// Event telling the window which tab to show.
pub const TAB_EVENT: &str = "flowtype://tab";

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
    .title("Flowtype")
    .inner_size(540.0, 680.0)
    .min_inner_size(460.0, 520.0)
    .resizable(true)
    .build()?;

    // Unlike the overlay, this window is meant to be interacted with.
    window.set_focus()?;
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let history_item = MenuItem::with_id(app, "history", "History…", true, None::<&str>)?;
    let settings_item =
        MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Flowtype", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&history_item, &settings_item, &quit])?;

    let mut tray = TrayIconBuilder::with_id("flowtype")
        .menu(&menu)
        .tooltip("Flowtype — hold to dictate")
        .on_menu_event(|app, event| match event.id().as_ref() {
            id @ ("settings" | "history") => {
                if let Err(err) = open_main_window(app, id) {
                    tracing::error!("could not open the {id} window: {err}");
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

    let filter = EnvFilter::try_from_env("FLOWTYPE_LOG")
        .unwrap_or_else(|_| EnvFilter::new("flowtype=info,warn"));

    let _ = fmt().with_env_filter(filter).try_init();
}
