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
                let buy = message.to_ascii_lowercase().contains("credit");
                self.overlay.set_clickable(buy);
                self.overlay.linger_after_failure();
                if buy {
                    if let Err(err) = open_main_window(&self.app, "usage") {
                        tracing::warn!("could not open credits: {err}");
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
            // truncated waiting for CoreAudio to initialise.
            pipeline.warmup();

            spawn_level_ticker(app.handle().clone(), Arc::clone(&pipeline));

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

            if loaded.fn_trigger {
                if !fn_key::input_monitoring_granted() {
                    tracing::info!("asking for Input Monitoring so hold-Fn can work");
                    let _ = fn_key::request_input_monitoring();
                }
                // Failing here is not fatal: the shortcut above still works, so
                // the user loses the nicer gesture rather than dictation.
                if let Err(err) = fn_key::spawn(fn_bus) {
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
            //
            // On a worker thread, because deciding means reading the key, and
            // reading the key can touch the Keychain — which is entitled to put
            // an authorisation dialog on screen, and did: doing this inline
            // stalled startup for as long as the dialog went unanswered. Only
            // the window itself goes back to the main thread, where AppKit
            // requires it (see rule 1 in CLAUDE.md).
            let handle = app.handle().clone();
            let fn_trigger = loaded.fn_trigger;
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
                if outstanding.complete {
                    tracing::info!("setup is complete, nothing to prompt for");
                    return;
                }
                tracing::info!(missing, "opening the setup window");

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
    .inner_size(460.0, 760.0)
    .resizable(false)
    .center()
    .build()?;

    window.set_focus()?;
    Ok(())
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
                if let Err(err) = open_main_window(app, "usage") {
                    tracing::warn!("could not open credits after sign-in: {err}");
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
