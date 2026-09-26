//! The bridge between the settings window and the pipeline.
//!
//! Commands return `Result<_, String>` because Tauri needs a serialisable
//! error; the string is the human-readable message the UI shows verbatim, so
//! it is written for a person rather than a log.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::frontmost::{running_apps, TargetApp};
use crate::history::Entry;
use crate::permissions::{self, Permissions, SettingsPane};
use crate::pipeline::Pipeline;
use crate::settings::{self, ApiKeySource, Settings};
use crate::setup::{self, SetupState};
use crate::signing::{self, Signing};
use crate::usage::{Cost, DailyPoint, Units};
use crate::trigger;

/// Anything that went wrong is shown to the user, so keep the cause chain.
fn to_message(err: anyhow::Error) -> String {
    format!("{err:#}")
}

/// Whether a key is set, and where it came from — never the key itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    pub is_set: bool,
    /// Human-readable origin, e.g. "Keychain" or a `.env` path.
    pub source: Option<String>,
    /// False when an environment variable or `.env` file is winning, in which
    /// case saving to the Keychain would appear to do nothing.
    pub keychain_is_effective: bool,
}

impl ApiKeyStatus {
    pub fn read() -> Self {
        match settings::resolve_api_key() {
            Ok(Some((_, source))) => Self {
                is_set: true,
                source: Some(source.to_string()),
                keychain_is_effective: matches!(source, ApiKeySource::Keychain),
            },
            Ok(None) => Self {
                is_set: false,
                source: None,
                keychain_is_effective: true,
            },
            Err(err) => {
                tracing::warn!("could not read the API key: {err:#}");
                Self {
                    is_set: false,
                    source: None,
                    keychain_is_effective: true,
                }
            }
        }
    }
}

#[tauri::command]
pub fn load_settings(pipeline: State<'_, Arc<Pipeline>>) -> Settings {
    pipeline.settings()
}

/// Persist settings and apply anything that takes effect immediately.
///
/// The shortcut is rebound *before* the file is written: if the accelerator is
/// invalid or already taken by another app, the user keeps their working
/// shortcut and their config on disk stays consistent with reality.
#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    pipeline: State<'_, Arc<Pipeline>>,
    settings: Settings,
) -> Result<Settings, String> {
    let previous = pipeline.settings();

    if settings.shortcut != previous.shortcut {
        trigger::rebind(&app, &settings.shortcut).map_err(to_message)?;
    }

    let dir = settings::config_dir().map_err(to_message)?;
    // Written and made current under one lock: see `Pipeline::save_settings`.
    let saved = pipeline.save_settings(&dir, settings).map_err(to_message)?;

    if saved.fn_trigger != previous.fn_trigger {
        // The tap owns a run loop on its own thread for the life of the
        // process, so toggling it takes effect on relaunch. The UI says so.
        tracing::info!(
            enabled = saved.fn_trigger,
            "hold-Fn setting changed; applies on relaunch"
        );
    }

    tracing::info!("settings saved");
    announce_settings(&app, &saved);

    Ok(saved)
}

/// Switch hold-Fn on or off without the caller holding a copy of `Settings`.
///
/// The setup window uses this to let someone skip Input Monitoring. Changing
/// the one field under the lock means a Settings window open at the same time
/// cannot write its older copy back over the change, and the event below tells
/// it to reload.
#[tauri::command]
pub fn set_fn_trigger(
    app: AppHandle,
    pipeline: State<'_, Arc<Pipeline>>,
    enabled: bool,
) -> Result<Settings, String> {
    let dir = settings::config_dir().map_err(to_message)?;
    let saved = pipeline.set_fn_trigger(&dir, enabled).map_err(to_message)?;
    tracing::info!(enabled, "hold-Fn setting changed; applies on relaunch");
    announce_settings(&app, &saved);
    Ok(saved)
}

/// Every window reloads its settings on this, so no window can save a stale
/// copy over another's change.
fn announce_settings(app: &AppHandle, saved: &Settings) {
    use tauri::Emitter;
    if let Err(err) = app.emit(crate::SETTINGS_EVENT, saved) {
        tracing::warn!("could not announce the settings change: {err}");
    }
}

/// Check an accelerator without binding it, so the recorder can give feedback
/// as the user presses keys.
/// Whether this platform can silence system output.
///
/// The settings window hides the "mute while dictating" toggle when it cannot,
/// so no switch is offered that would quietly do nothing.
#[tauri::command]
pub fn can_mute_output(pipeline: State<'_, Arc<Pipeline>>) -> bool {
    pipeline.can_mute_output()
}

#[tauri::command]
pub fn validate_shortcut(accelerator: String) -> Result<(), String> {
    trigger::parse_accelerator(&accelerator)
        .map(|_| ())
        .map_err(to_message)
}

#[tauri::command]
pub fn api_key_status() -> ApiKeyStatus {
    ApiKeyStatus::read()
}

#[tauri::command]
pub fn set_api_key(
    pipeline: State<'_, Arc<Pipeline>>,
    key: String,
) -> Result<ApiKeyStatus, String> {
    let key = key.trim();

    if key.is_empty() {
        return Err("Enter a key first.".to_string());
    }
    if !key.starts_with("sk-") {
        return Err("That does not look like an OpenAI key — they start with 'sk-'.".to_string());
    }

    settings::store_api_key(key).map_err(to_message)?;

    // The cached client holds the old key.
    pipeline.invalidate_transcriber();

    Ok(ApiKeyStatus::read())
}

#[tauri::command]
pub fn clear_api_key(pipeline: State<'_, Arc<Pipeline>>) -> Result<ApiKeyStatus, String> {
    settings::clear_api_key().map_err(to_message)?;
    pipeline.invalidate_transcriber();
    Ok(ApiKeyStatus::read())
}

#[tauri::command]
pub fn permissions_status() -> Permissions {
    permissions::current()
}

/// The permissions this process saw when it started.
///
/// Held for the setup window, which has to tell "granted, working" apart from
/// "granted, but not until you relaunch" — a difference macOS gives no way to
/// observe, since both read back as trusted. See [`setup::evaluate`].
pub struct LaunchPermissions(pub Permissions);

#[tauri::command]
pub fn setup_state(
    pipeline: State<'_, Arc<Pipeline>>,
    at_launch: State<'_, LaunchPermissions>,
) -> SetupState {
    let now = permissions::current();
    // Launch skips the warmup while the microphone has never been asked for,
    // so the first poll to see it granted pays that cost now instead of on the
    // user's first sentence. A no-op once anything has warmed up.
    if now.microphone.is_granted() {
        pipeline.warmup_once();
    }
    setup::evaluate(
        at_launch.0,
        now,
        credentials_ready(),
        pipeline.settings().fn_trigger,
    )
}

pub fn credentials_ready() -> bool {
    ApiKeyStatus::read().is_set || crate::session::is_signed_in()
}

#[tauri::command]
pub fn session_status() -> crate::session::SessionStatus {
    crate::session::status()
}

#[tauri::command]
pub fn set_session(
    pipeline: State<'_, Arc<Pipeline>>,
    session: crate::session::Session,
) -> Result<crate::session::SessionStatus, String> {
    crate::session::store(&session).map_err(to_message)?;
    pipeline.invalidate_transcriber();
    Ok(crate::session::status())
}

#[tauri::command]
pub fn clear_session(
    pipeline: State<'_, Arc<Pipeline>>,
) -> Result<crate::session::SessionStatus, String> {
    crate::session::clear().map_err(to_message)?;
    pipeline.invalidate_transcriber();
    Ok(crate::session::status())
}

#[tauri::command]
pub fn open_hosted_login() -> Result<(), String> {
    crate::session::open_hosted_login().map_err(to_message)
}

#[tauri::command]
pub fn open_hosted_account() -> Result<(), String> {
    crate::session::open_hosted_account().map_err(to_message)
}

/// Both of these make a blocking HTTP request. A synchronous command runs on
/// the main thread, which would freeze every window (and the overlay) for as
/// long as the network takes; `async` moves them to Tauri's thread pool.
#[tauri::command(async)]
pub fn hosted_account() -> Result<crate::hosted::HostedAccount, String> {
    crate::hosted::fetch_account().map_err(to_message)
}

/// Start Stripe Checkout in the browser. The webhook credits the ledger.
#[tauri::command(async)]
pub fn create_checkout(pack_id: String) -> Result<(), String> {
    let url = crate::hosted::create_checkout(&pack_id).map_err(to_message)?;
    crate::session::open_in_browser(&url).map_err(to_message)
}

#[tauri::command]
pub fn open_credits(app: tauri::AppHandle) -> Result<(), String> {
    crate::open_main_window(&app, "usage").map_err(|err| err.to_string())
}

/// Trigger macOS's own microphone prompt.
///
/// Better than sending someone to System Settings for a permission that has
/// never been asked for: the system dialog grants it in one click, whereas the
/// pane makes them find the app in a list. Opening a stream is what makes macOS
/// ask, so this borrows the warmup path — on its own thread, because the first
/// open of the session costs a couple of seconds and this must not block the UI.
#[tauri::command]
pub fn prompt_for_microphone(pipeline: State<'_, Arc<Pipeline>>) {
    let pipeline = Arc::clone(pipeline.inner());
    std::thread::spawn(move || pipeline.warmup());
}

/// Set in the environment before a restart from the setup window. The new
/// process inherits it and opens the setup window even though nothing is left
/// to do, so the user sees "TeleKey is ready" rather than nothing at all.
pub const SETUP_AFTER_RESTART: &str = "TELEKEY_SETUP_AFTER_RESTART";

/// Quit and relaunch.
///
/// Accessibility trust and the Fn event tap are both read while the process
/// starts, so for those two this is the only way to finish the job.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    // SAFETY: the process is about to exec its replacement; no other thread
    // reads the environment between here and that.
    unsafe { std::env::set_var(SETUP_AFTER_RESTART, "1") };
    app.restart()
}

/// Discard an in-flight recording or abandon transcription. Never pastes.
#[tauri::command]
pub fn cancel_dictation(
    pipeline: State<'_, Arc<Pipeline>>,
    bus: State<'_, crate::trigger::Bus>,
) {
    pipeline.mark_cancel();
    bus.emit(crate::trigger::TriggerEvent::Cancel);
}

/// Whether this build's signature can hold a permission grant.
/// Ask macOS for Input Monitoring, which registers TeleKey in the list.
#[tauri::command]
pub fn request_input_monitoring() -> bool {
    crate::fn_key::request_input_monitoring()
}

#[tauri::command]
pub fn signing_status() -> Signing {
    signing::current()
}

#[tauri::command]
pub fn open_permission_settings(pane: SettingsPane) -> Result<(), String> {
    // Ask macOS to prompt first: that registers TeleKey in the list, so the
    // user only has to flip a switch that is already there rather than find
    // the right bundle with the + button. The dialog's own button leads to the
    // same pane, which is open behind it; a prompt macOS has already shown
    // once does nothing, and then the pane is the only way.
    match pane {
        SettingsPane::Accessibility => {
            permissions::prompt_for_accessibility();
        }
        SettingsPane::InputMonitoring => {
            crate::fn_key::request_input_monitoring();
        }
        SettingsPane::Microphone => {}
    }
    permissions::open_settings_pane(pane).map_err(to_message)
}

#[tauri::command]
pub fn history_entries(pipeline: State<'_, Arc<Pipeline>>) -> Vec<Entry> {
    pipeline.history().entries()
}

#[tauri::command]
pub fn delete_history_entry(
    pipeline: State<'_, Arc<Pipeline>>,
    id: u64,
) -> Result<Vec<Entry>, String> {
    let history = pipeline.history();
    history.delete(id).map_err(to_message)?;
    Ok(history.entries())
}

#[tauri::command]
pub fn clear_history(pipeline: State<'_, Arc<Pipeline>>) -> Result<Vec<Entry>, String> {
    let history = pipeline.history();
    history.clear().map_err(to_message)?;
    Ok(history.entries())
}

/// Copy text to the clipboard from the Rust side.
///
/// The webview's own clipboard API is gated behind a user-gesture check that a
/// programmatic call does not always satisfy; going through the pasteboard
/// directly is predictable.
#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    use crate::inject::Clipboard;

    let mut clipboard = crate::inject::SystemClipboard::new().map_err(to_message)?;
    clipboard.write_text(&text).map_err(to_message)
}

/// Which span of time the Usage tab is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Period {
    Today,
    Month,
    Lifetime,
}

/// Units and money for one period.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub units: Units,
    pub cost: Cost,
    /// Minutes, precomputed so the UI never has to know the unit is seconds.
    pub minutes: f64,
}

#[tauri::command]
pub fn usage_summary(pipeline: State<'_, Arc<Pipeline>>, period: Period) -> UsageSummary {
    let usage = pipeline.usage();
    let units = match period {
        Period::Today => usage.today(),
        Period::Month => usage.this_month(),
        Period::Lifetime => usage.lifetime(),
    };

    let rates = pipeline.settings().rates;
    UsageSummary {
        cost: rates.cost_of(&units),
        minutes: units.minutes(),
        units,
    }
}

/// The last `days` days for the chart, including days with no activity.
#[tauri::command]
pub fn usage_daily(pipeline: State<'_, Arc<Pipeline>>, days: i64) -> Vec<DailyPoint> {
    pipeline.usage().recent_days(days.clamp(1, 366))
}

#[tauri::command]
pub fn clear_usage(pipeline: State<'_, Arc<Pipeline>>) -> Result<(), String> {
    pipeline.usage().clear().map_err(to_message)
}

/// Apps that are open right now, so a formatting profile can be picked from a
/// list rather than typed as a bundle identifier.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    /// Stable key used to match a profile to a dictation target.
    pub key: String,
    pub label: String,
}

#[tauri::command]
pub fn open_apps() -> Vec<RunningApp> {
    running_apps()
        .into_iter()
        .map(|app: TargetApp| RunningApp {
            key: app.profile_key().to_string(),
            label: app.name.clone().unwrap_or_else(|| app.profile_key().to_string()),
        })
        .collect()
}

/// The default input device, so the user can confirm which microphone is live.
/// Async because describing a device reads its configurations, which is not
/// instant, and this must not hold the main thread.
#[tauri::command(async)]
pub fn input_device() -> Option<crate::input_device::InputDevice> {
    crate::input_device::current()
}

/// Every input device, for the picker in Settings.
#[tauri::command(async)]
pub fn input_devices() -> Vec<crate::input_device::InputDevice> {
    crate::input_device::list()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_status_never_carries_the_key() {
        let json = serde_json::to_value(ApiKeyStatus {
            is_set: true,
            source: Some("Keychain".into()),
            keychain_is_effective: true,
        })
        .unwrap();

        let fields: Vec<&String> = json.as_object().unwrap().keys().collect();
        assert_eq!(fields, vec!["isSet", "keychainIsEffective", "source"]);
    }

    #[test]
    fn error_messages_keep_the_whole_cause_chain() {
        let err = anyhow::anyhow!("root cause").context("outer context");
        let message = to_message(err);
        assert!(message.contains("outer context"), "got: {message}");
        assert!(message.contains("root cause"), "got: {message}");
    }

    #[test]
    fn hosted_account_serialises_camel_case() {
        let json = serde_json::to_value(crate::hosted::HostedAccount {
            email: Some("you@example.com".into()),
            balance_cents: 500,
            packs: vec![crate::hosted::CreditPack {
                id: "starter".into(),
                name: "$5".into(),
                cents: 500,
            }],
        })
        .unwrap();
        let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["balanceCents", "email", "packs"]);
    }
}
