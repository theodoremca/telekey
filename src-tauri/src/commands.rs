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
    fn read() -> Self {
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
    settings.save(&dir).map_err(to_message)?;

    if settings.fn_trigger != previous.fn_trigger {
        // The tap owns a run loop on its own thread for the life of the
        // process, so toggling it takes effect on relaunch. The UI says so.
        tracing::info!(
            enabled = settings.fn_trigger,
            "hold-Fn setting changed; applies on relaunch"
        );
    }

    pipeline.update_settings(settings.clone());
    tracing::info!("settings saved");

    Ok(settings)
}

/// Check an accelerator without binding it, so the recorder can give feedback
/// as the user presses keys.
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

/// Whether this build's signature can hold a permission grant.
/// Ask macOS for Input Monitoring, which registers Flowtype in the list.
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
    // For Accessibility, ask macOS to prompt first: that registers Flowtype in
    // the list, so the user only has to flip a switch that is already there
    // rather than find the right bundle with the + button.
    if matches!(pane, SettingsPane::Accessibility) {
        permissions::prompt_for_accessibility();
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
#[tauri::command]
pub fn input_device() -> Option<String> {
    use cpal::traits::{DeviceTrait, HostTrait};

    cpal::default_host()
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| format!("{id}"))
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
}
