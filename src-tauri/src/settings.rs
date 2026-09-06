//! User configuration.
//!
//! Everything non-secret lives in a JSON file under the platform config dir.
//! The OpenAI API key lives in the Keychain and never touches that file — or
//! any log line.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::polish::AppProfile;
use crate::usage::Rates;

const KEYCHAIN_SERVICE: &str = "flowtype";
const KEYCHAIN_ACCOUNT: &str = "openai-api-key";

/// Deliberately not `Alt+Space`: that is ChatGPT desktop's launcher.
pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Space";

/// OpenAI treats `keywords` as hints, and warns that an over-stuffed list can
/// make unspoken terms appear in the transcript. Cap it.
pub const MAX_KEYWORDS: usize = 100;

/// Note the `rename_all`: every type crossing into the webview is camelCase, and
/// this one silently was not. The frontend read `settings.fnTrigger` as
/// `undefined` and sent it back under a name serde did not recognise, so
/// `default` reset it on every save — which looked like a toggle that would not
/// stick. The aliases keep existing snake_case files loading.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Tauri accelerator string, e.g. `Ctrl+Alt+Space`.
    pub shortcut: String,
    /// Names, jargon and product terms passed to the model as `keywords[]`.
    pub vocabulary: Vec<String>,
    /// Expected input languages, passed as `languages[]`.
    pub languages: Vec<String>,
    /// Off by default: `gpt-transcribe` already punctuates and strips fillers,
    /// so the polish pass only earns its latency for per-app formatting.
    #[serde(alias = "polish_enabled")]
    pub polish_enabled: bool,
    /// How many transcripts to keep.
    #[serde(alias = "history_limit")]
    pub history_limit: usize,
    /// Whether to keep transcripts at all. On by default, but dictation can
    /// carry anything, so it must be switchable.
    #[serde(alias = "history_enabled")]
    pub history_enabled: bool,
    /// Per-app formatting. Empty by default: with no profile, a dictation goes
    /// straight from transcript to cursor with no extra round-trip.
    pub profiles: Vec<AppProfile>,
    /// What the user pays per unit. Editable because published prices change,
    /// and a stale rate would report a confident wrong number.
    pub rates: Rates,
    /// When the rates were last set, so staleness is visible rather than silent.
    #[serde(alias = "rates_updated")]
    pub rates_updated: String,
    /// Hold Fn to dictate, in addition to the shortcut above.
    ///
    /// Off by default: it needs Input Monitoring, and turning it on unasked
    /// would prompt for a permission the user never requested.
    #[serde(alias = "fn_trigger")]
    pub fn_trigger: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.to_string(),
            vocabulary: Vec::new(),
            languages: vec!["en".to_string()],
            polish_enabled: false,
            history_limit: 200,
            history_enabled: true,
            profiles: Vec::new(),
            rates: Rates::default(),
            rates_updated: "2026-08-24".to_string(),
            fn_trigger: false,
        }
    }
}

impl Settings {
    /// Read settings from `dir/settings.json`, falling back to defaults when the
    /// file is absent. A corrupt file is an error rather than a silent reset —
    /// quietly discarding a user's vocabulary would be worse than refusing to start.
    pub fn load(dir: &Path) -> Result<Self> {
        let path = Self::path_in(dir);
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("could not read {}", path.display()))?;
        serde_json::from_str(&raw)
            .with_context(|| format!("could not parse {}", path.display()))
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("could not create {}", dir.display()))?;
        let path = Self::path_in(dir);
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, raw)
            .with_context(|| format!("could not write {}", path.display()))
    }

    fn path_in(dir: &Path) -> PathBuf {
        dir.join("settings.json")
    }

    /// The vocabulary, cleaned up for the API: trimmed, de-duplicated
    /// case-insensitively, and capped at [`MAX_KEYWORDS`].
    pub fn keywords(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        self.vocabulary
            .iter()
            .map(|term| term.trim())
            .filter(|term| !term.is_empty())
            .filter(|term| seen.insert(term.to_lowercase()))
            .take(MAX_KEYWORDS)
            .map(str::to_string)
            .collect()
    }
}

impl Settings {
    /// The formatting profile for an app, if one is configured.
    pub fn profile_for(&self, key: &str) -> Option<&AppProfile> {
        self.profiles.iter().find(|profile| profile.app == key)
    }
}

/// Where settings live, e.g. `~/Library/Application Support/flowtype`.
pub fn config_dir() -> Result<PathBuf> {
    let base = dirs::config_dir().context("could not locate the user config directory")?;
    Ok(base.join("flowtype"))
}

/// The environment variable, and the key inside a `.env` file.
pub const API_KEY_VAR: &str = "OPENAI_API_KEY";

/// Where a resolved API key came from. Reported by `flowtype check` so a key
/// coming from an unexpected place is easy to spot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiKeySource {
    /// Set in the process environment.
    Environment,
    /// Read from a `.env` file at this path.
    EnvFile(PathBuf),
    /// Stored in the macOS Keychain.
    Keychain,
}

impl std::fmt::Display for ApiKeySource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Environment => write!(f, "{API_KEY_VAR} environment variable"),
            Self::EnvFile(path) => write!(f, "{}", path.display()),
            Self::Keychain => write!(f, "Keychain"),
        }
    }
}

/// Candidate `.env` locations, most specific first.
///
/// The config-dir entry is the one that works for an installed `.app`, whose
/// working directory is not the project. The relative entries make `cargo run`
/// and `bun tauri dev` both pick up a project-local file.
fn env_file_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(explicit) = std::env::var("FLOWTYPE_ENV_FILE") {
        candidates.push(PathBuf::from(explicit));
    }
    candidates.push(PathBuf::from(".env"));
    candidates.push(PathBuf::from("../.env"));
    if let Ok(dir) = config_dir() {
        candidates.push(dir.join(".env"));
    }

    candidates
}

/// Read `OPENAI_API_KEY` out of a `.env` file without touching the process
/// environment — a stray key in our own env would leak into child processes.
fn read_key_from_env_file(path: &Path) -> Option<String> {
    let entries = dotenvy::from_path_iter(path).ok()?;

    for entry in entries {
        let (key, value) = entry.ok()?;
        if key == API_KEY_VAR {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }

    None
}

/// Find the API key, reporting where it came from.
///
/// Order: process environment, then the first `.env` file that has one, then the
/// Keychain. Environment beats file beats Keychain so a shell override or a
/// project-local file wins during development without disturbing the stored key.
pub fn resolve_api_key() -> Result<Option<(String, ApiKeySource)>> {
    if let Ok(key) = std::env::var(API_KEY_VAR) {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Ok(Some((key, ApiKeySource::Environment)));
        }
    }

    for candidate in env_file_candidates() {
        if let Some(key) = read_key_from_env_file(&candidate) {
            return Ok(Some((key, ApiKeySource::EnvFile(candidate))));
        }
    }

    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .context("could not open the Keychain entry")?;

    match entry.get_password() {
        Ok(key) => Ok(Some((key, ApiKeySource::Keychain))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(anyhow::Error::new(err).context("could not read the API key")),
    }
}

/// The API key, wherever it lives. `Ok(None)` is a normal first-run state.
pub fn load_api_key() -> Result<Option<String>> {
    Ok(resolve_api_key()?.map(|(key, _)| key))
}

pub fn store_api_key(key: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .context("could not open the Keychain entry")?;
    entry
        .set_password(key)
        .context("could not store the API key")
}

pub fn clear_api_key() -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .context("could not open the Keychain entry")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(anyhow::Error::new(err).context("could not delete the API key")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings::load(dir.path()).unwrap();
        assert_eq!(settings, Settings::default());
        assert_eq!(settings.shortcut, "Ctrl+Alt+Space");
    }

    #[test]
    fn settings_round_trip_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let original = Settings {
            shortcut: "Cmd+Shift+D".into(),
            vocabulary: vec!["Hordanso".into(), "NativeWind".into()],
            languages: vec!["en".into(), "fr".into()],
            polish_enabled: true,
            history_limit: 50,
            history_enabled: false,
            profiles: Vec::new(),
            rates: Rates::default(),
            rates_updated: "2026-08-24".to_string(),
            fn_trigger: false,
        };

        original.save(dir.path()).unwrap();
        assert_eq!(Settings::load(dir.path()).unwrap(), original);
    }

    #[test]
    fn every_field_serialises_as_camel_case() {
        // The webview reads these keys directly. A snake_case key here is
        // invisible to the frontend, and comes back under a name serde ignores —
        // so the setting silently resets on every save.
        let json = serde_json::to_value(Settings::default()).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();

        for key in &keys {
            assert!(
                !key.contains('_'),
                "`{key}` is snake_case; the frontend expects camelCase"
            );
        }

        // Spot-check the ones that actually broke.
        for expected in ["fnTrigger", "historyEnabled", "polishEnabled", "ratesUpdated"] {
            assert!(
                keys.iter().any(|k| k.as_str() == expected),
                "missing `{expected}` in {keys:?}"
            );
        }
    }

    #[test]
    fn a_setting_survives_a_round_trip_through_the_frontends_shape() {
        // Regression: this is exactly what the save path does.
        let mut settings = Settings::default();
        settings.fn_trigger = true;
        settings.history_enabled = false;

        let wire = serde_json::to_string(&settings).unwrap();
        let back: Settings = serde_json::from_str(&wire).unwrap();

        assert!(back.fn_trigger, "fn_trigger was lost in transit");
        assert!(!back.history_enabled, "history_enabled was lost in transit");
        assert_eq!(back, settings);
    }

    #[test]
    fn an_existing_snake_case_file_still_loads() {
        // Files written before the rename must not silently reset.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"shortcut":"Shift+Super+Space","polish_enabled":true,
                "history_enabled":false,"history_limit":42,
                "rates_updated":"2026-01-01","fn_trigger":true}"#,
        )
        .unwrap();

        let loaded = Settings::load(dir.path()).unwrap();
        assert_eq!(loaded.shortcut, "Shift+Super+Space");
        assert!(loaded.polish_enabled);
        assert!(!loaded.history_enabled);
        assert_eq!(loaded.history_limit, 42);
        assert_eq!(loaded.rates_updated, "2026-01-01");
        assert!(loaded.fn_trigger);
    }

    #[test]
    fn partial_file_fills_in_defaults() {
        // Forward compatibility: an older config missing newer keys still loads.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"shortcut":"Cmd+D"}"#,
        )
        .unwrap();

        let settings = Settings::load(dir.path()).unwrap();
        assert_eq!(settings.shortcut, "Cmd+D");
        assert_eq!(settings.languages, vec!["en".to_string()]);
        assert!(!settings.polish_enabled);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_silent_reset() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "{ not json").unwrap();
        assert!(Settings::load(dir.path()).is_err());
    }

    #[test]
    fn keywords_are_trimmed_deduped_and_capped() {
        let settings = Settings {
            vocabulary: vec![
                "  Hordanso  ".into(),
                "hordanso".into(), // case-insensitive duplicate
                "".into(),
                "   ".into(),
                "Zustand".into(),
            ],
            ..Default::default()
        };

        assert_eq!(
            settings.keywords(),
            vec!["Hordanso".to_string(), "Zustand".to_string()]
        );
    }

    fn write_env(contents: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".env");
        std::fs::write(&path, contents).unwrap();
        (dir, path)
    }

    #[test]
    fn reads_the_key_from_an_env_file() {
        let (_dir, path) = write_env("OPENAI_API_KEY=sk-test-123\n");
        assert_eq!(
            read_key_from_env_file(&path).as_deref(),
            Some("sk-test-123")
        );
    }

    #[test]
    fn env_file_tolerates_comments_quotes_blanks_and_other_keys() {
        let (_dir, path) = write_env(
            "# Flowtype config\n\
             \n\
             SOME_OTHER=value\n\
             OPENAI_API_KEY=\"sk-quoted-456\"\n\
             TRAILING=x\n",
        );
        assert_eq!(
            read_key_from_env_file(&path).as_deref(),
            Some("sk-quoted-456")
        );
    }

    #[test]
    fn env_file_handles_the_export_prefix() {
        let (_dir, path) = write_env("export OPENAI_API_KEY=sk-exported-789\n");
        assert_eq!(
            read_key_from_env_file(&path).as_deref(),
            Some("sk-exported-789")
        );
    }

    #[test]
    fn an_unset_or_blank_key_is_treated_as_absent() {
        let (_dir, path) = write_env("OPENAI_API_KEY=\n");
        assert_eq!(read_key_from_env_file(&path), None);

        let (_dir, path) = write_env("OTHER=1\n");
        assert_eq!(read_key_from_env_file(&path), None);
    }

    #[test]
    fn a_missing_env_file_is_not_an_error() {
        assert_eq!(
            read_key_from_env_file(Path::new("/definitely/not/here/.env")),
            None
        );
    }

    #[test]
    fn env_file_candidates_are_ordered_most_specific_first() {
        let candidates = env_file_candidates();
        assert!(candidates.contains(&PathBuf::from(".env")));
        assert!(
            candidates.iter().any(|p| p.ends_with("flowtype/.env")),
            "the config dir must be searched so the bundled app finds a key"
        );
    }

    #[test]
    fn api_key_source_reads_clearly() {
        assert_eq!(
            ApiKeySource::Environment.to_string(),
            "OPENAI_API_KEY environment variable"
        );
        assert_eq!(ApiKeySource::Keychain.to_string(), "Keychain");
        assert_eq!(
            ApiKeySource::EnvFile(PathBuf::from("/tmp/.env")).to_string(),
            "/tmp/.env"
        );
    }

    #[test]
    fn keywords_cap_is_enforced() {
        let settings = Settings {
            vocabulary: (0..MAX_KEYWORDS + 50).map(|i| format!("term{i}")).collect(),
            ..Default::default()
        };
        assert_eq!(settings.keywords().len(), MAX_KEYWORDS);
    }
}
