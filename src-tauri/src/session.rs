//! Hosted-account session, kept in the Keychain like the OpenAI key.
//!
//! The ID token is short-lived. We store the refresh token and mint a new ID
//! token when it is close to expiry. Nothing here is logged. The session
//! arrives over `telekey://auth` after the website signs the user in.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

const KEYCHAIN_SERVICE: &str = "telekey";
const KEYCHAIN_ACCOUNT: &str = "hosted-session";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub refresh_token: String,
    pub id_token: String,
    pub uid: String,
    pub email: String,
    /// Unix seconds. Zero means "refresh on next use".
    pub id_token_expires: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub uid: Option<String>,
}

impl SessionStatus {
    pub fn signed_out() -> Self {
        Self {
            signed_in: false,
            email: None,
            uid: None,
        }
    }
}

pub fn load() -> Result<Option<Session>> {
    match read_session(&Keyring)? {
        Some(raw) => {
            let session: Session = serde_json::from_str(&raw)
                .context("stored session was not valid JSON")?;
            Ok(Some(session))
        }
        None => Ok(None),
    }
}

pub fn store(session: &Session) -> Result<()> {
    let raw = serde_json::to_string(session).context("could not serialise the session")?;
    write_session(&Keyring, &raw)
}

pub fn clear() -> Result<()> {
    delete_session(&Keyring)
}

// ---- storage ------------------------------------------------------------
//
// Windows' Credential Manager holds at most 2,560 bytes per entry and stores
// text as UTF-16, two bytes a character, so about 1,280 characters. A session
// does not fit: the Google ID token alone runs to some 1,400. On Windows the
// write failed, the app only logged it, and a sign-in silently did not stick.
// So a value too long for one entry is split across numbered entries
// (`hosted-session.1`, `.2`, …) and the first entry records how many. The same
// layout is used on every platform, so the Mac exercises it daily.

/// Held while the session's entries are read, written or deleted. A split
/// session is several entries, so without it a read during a write, or two
/// writes at once, could splice two sessions together; one entry used to make
/// every write atomic.
static STORAGE: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// Held for a whole token refresh; see `fresh_id_token`.
static REFRESH: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn storage_lock() -> std::sync::MutexGuard<'static, ()> {
    STORAGE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// UTF-16 code units per entry: 2,400 bytes, under Windows' 2,560.
const PART_UNITS: usize = 1_200;
/// The first entry's value when the session is split, followed by the count.
const PARTS_MARKER: &str = "telekey-parts:";
/// Far more than a session needs (about three); a bound for clean-up.
const MAX_PARTS: usize = 8;

/// The platform secret store, behind a trait so the layout can be tested
/// without touching the real one.
trait SecretStore {
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, value: &str) -> Result<()>;
    /// Removing something that is not there is not an error.
    fn delete(&self, account: &str) -> Result<()>;
}

/// The Keychain on macOS, Credential Manager on Windows, the Secret Service
/// on Linux.
struct Keyring;

impl SecretStore for Keyring {
    fn get(&self, account: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .context("could not open the session Keychain entry")?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(anyhow::Error::new(err).context("could not read the hosted session")),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<()> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .context("could not open the session Keychain entry")?
            .set_password(value)
            .context("could not store the hosted session")
    }

    fn delete(&self, account: &str) -> Result<()> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .context("could not open the session Keychain entry")?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(anyhow::Error::new(err).context("could not delete the hosted session")),
        }
    }
}

fn part_account(index: usize) -> String {
    format!("{KEYCHAIN_ACCOUNT}.{index}")
}

/// Cut `raw` into pieces of at most `limit` UTF-16 code units, between
/// characters, so no piece is longer than an entry can hold.
fn split_utf16(raw: &str, limit: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut units = 0;
    for ch in raw.chars() {
        let len = ch.len_utf16();
        if units + len > limit && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
            units = 0;
        }
        current.push(ch);
        units += len;
    }
    if !current.is_empty() || parts.is_empty() {
        parts.push(current);
    }
    parts
}

fn write_session(store: &impl SecretStore, raw: &str) -> Result<()> {
    let _held = storage_lock();
    if raw.encode_utf16().count() <= PART_UNITS {
        store.set(KEYCHAIN_ACCOUNT, raw)?;
        return remove_parts(store, 1);
    }

    let parts = split_utf16(raw, PART_UNITS);
    if parts.len() > MAX_PARTS {
        bail!("the sign-in is too large to store ({} parts)", parts.len());
    }
    // The parts first and the count last, so the first entry never names
    // parts that have not been written yet.
    for (index, part) in parts.iter().enumerate() {
        store.set(&part_account(index + 1), part)?;
    }
    store.set(KEYCHAIN_ACCOUNT, &format!("{PARTS_MARKER}{}", parts.len()))?;
    // A shorter session than the last one leaves parts behind; remove them.
    remove_parts(store, parts.len() + 1)
}

fn read_session(store: &impl SecretStore) -> Result<Option<String>> {
    let _held = storage_lock();
    let Some(first) = store.get(KEYCHAIN_ACCOUNT)? else {
        return Ok(None);
    };
    // A session stored whole: every one written before the split existed, and
    // any short enough for one entry.
    let Some(count) = first.strip_prefix(PARTS_MARKER) else {
        return Ok(Some(first));
    };

    let count: usize = count
        .trim()
        .parse()
        .context("the stored sign-in has an unreadable part count")?;
    if count == 0 || count > MAX_PARTS {
        bail!("the stored sign-in claims {count} parts");
    }
    let mut raw = String::new();
    for index in 1..=count {
        let part = store
            .get(&part_account(index))?
            .with_context(|| format!("the stored sign-in is missing part {index} of {count}"))?;
        raw.push_str(&part);
    }
    Ok(Some(raw))
}

fn delete_session(store: &impl SecretStore) -> Result<()> {
    let _held = storage_lock();
    store.delete(KEYCHAIN_ACCOUNT)?;
    remove_parts(store, 1)
}

fn remove_parts(store: &impl SecretStore, from: usize) -> Result<()> {
    for index in from..=MAX_PARTS {
        store.delete(&part_account(index))?;
    }
    Ok(())
}

pub fn status() -> SessionStatus {
    match load() {
        Ok(Some(session)) => SessionStatus {
            signed_in: true,
            email: Some(session.email),
            uid: Some(session.uid),
        },
        Ok(None) => SessionStatus::signed_out(),
        Err(err) => {
            tracing::warn!("could not read the hosted session: {err:#}");
            SessionStatus::signed_out()
        }
    }
}

pub fn is_signed_in() -> bool {
    status().signed_in
}

/// Refresh the ID token if it expires within a minute.
pub fn fresh_id_token() -> Result<String> {
    // One refresh at a time. A dictation and the Settings window can both find
    // the token expired; the second waits here, then finds the first one's
    // fresh token below instead of refreshing (and saving) again. The network
    // call happens under this lock only, never the storage lock, so a status
    // check on the main thread never waits on it.
    let _refreshing = REFRESH.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut session = load()?.context("Sign in to use TeleKey's key, or add your own OpenAI key")?;
    let now = chrono::Utc::now().timestamp();
    if session.id_token_expires > now + 60 && !session.id_token.is_empty() {
        return Ok(session.id_token);
    }

    let api_key = firebase_web_api_key().context(
        "Hosted accounts are not configured in this build (missing TELEKEY_FIREBASE_API_KEY)",
    )?;
    let client = reqwest::blocking::Client::new();
    let url = format!(
        "https://securetoken.googleapis.com/v1/token?key={api_key}"
    );
    let response = client
        .post(url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", session.refresh_token.as_str()),
        ])
        .send()
        .context("could not refresh the hosted session")?;

    if !response.status().is_success() {
        anyhow::bail!("Session expired — sign in again");
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        id_token: String,
        refresh_token: String,
        #[serde(default)]
        expires_in: String,
    }

    let body: TokenResponse = response.json().context("refresh response was not JSON")?;
    let expires_in: i64 = body.expires_in.parse().unwrap_or(3600);
    session.id_token = body.id_token.clone();
    session.refresh_token = body.refresh_token;
    session.id_token_expires = now + expires_in;
    store(&session)?;
    Ok(body.id_token)
}

// ---- stage and endpoints --------------------------------------------------
//
// A release is built for one stage and has to keep talking to that stage's
// server whatever else is on the machine. release.yml bakes `TELEKEY_STAGE` in
// with `option_env!`: a plain `vX.Y.Z` tag builds production, a tag with a
// suffix builds staging. It used to be possible to stay on staging after
// updating to a production build, because the app wrote the stage, and the URLs
// it had resolved, into `.env` files in its config directory, loaded them back
// into the process environment at the next launch, and anything in the
// environment beat the baked-in value.
//
// The order now, for the stage and for each of the three URLs that differ
// between stages, strongest first:
//
//   1. the real process environment: something a developer exported in a shell
//      or passed with `open --env` (run.sh does). A build that knows its stage
//      reads no `.env` file (see `hydrate_env`), so nothing on disk can end up
//      here and be mistaken for a deliberate override;
//   2. the value fixed when the app was built;
//   3. the built-in default for the stage; for the stage itself, staging.
//
// A development build (`cargo run`, `bun tauri dev`) has nothing baked in, so
// there it is as it always was: `.env`, `.env.staging` or `.env.production`
// from the project (or the config directory) are loaded into the environment
// and decide. Nothing writes those files any more.

/// Public Firebase web API key (same value as `web/lib/firebaseConfig.ts`).
/// It is not a secret; without a compile-time bake or `.env`, Dock launches
/// still have to refresh ID tokens.
const DEFAULT_FIREBASE_WEB_API_KEY: &str = "AIzaSyCdylrBqOKtlz_MJl6XnSBgGZMg3rDfQuI";
const DEFAULT_STAGING_API: &str = "https://us-east1-telekey-app.cloudfunctions.net/staging";
const DEFAULT_PRODUCTION_API: &str = "https://us-east1-telekey-app.cloudfunctions.net/api";
const DEFAULT_STAGING_SITE: &str = "https://telekey-staging.vercel.app";
/// The official address is `www.telekey.app`. The apex (`telekey.app`) and
/// `telekey.vercel.app` both redirect to it; sign-in and the account page
/// always open on this one.
const DEFAULT_PRODUCTION_SITE: &str = "https://www.telekey.app";
/// The Instant relay (`relay/` in the private `telekey-server` repository) on Cloud Run. Cloud Run addresses are
/// `<service>-<project number>.<region>.run.app`, so these are known before
/// either service is deployed.
const DEFAULT_STAGING_RELAY: &str =
    "wss://telekey-relay-staging-502266841237.us-east1.run.app/v1/realtime?intent=transcription";
const DEFAULT_PRODUCTION_RELAY: &str =
    "wss://telekey-relay-production-502266841237.us-east1.run.app/v1/realtime?intent=transcription";

pub fn firebase_web_api_key() -> Option<String> {
    lookup("TELEKEY_FIREBASE_API_KEY", &real_env, &baked_in)
        .map(|(value, _)| value)
        .or_else(|| Some(DEFAULT_FIREBASE_WEB_API_KEY.to_string()))
}

pub fn api_base() -> Option<String> {
    Some(resolve_endpoint(API_BASE, &real_env, &baked_in).0)
}

pub fn site_url() -> Option<String> {
    Some(resolve_endpoint(SITE_URL, &real_env, &baked_in).0)
}

/// Where Instant streams to when the dictation is paid for with credits.
pub fn relay_url() -> Option<String> {
    Some(resolve_endpoint(RELAY_URL, &real_env, &baked_in).0)
}

pub(crate) fn default_relay_url_for(stage: &str) -> &'static str {
    if stage == "production" {
        DEFAULT_PRODUCTION_RELAY
    } else {
        DEFAULT_STAGING_RELAY
    }
}

pub(crate) fn default_api_base_for(stage: &str) -> &'static str {
    if stage == "production" {
        DEFAULT_PRODUCTION_API
    } else {
        DEFAULT_STAGING_API
    }
}

pub(crate) fn default_site_url_for(stage: &str) -> &'static str {
    if stage == "production" {
        DEFAULT_PRODUCTION_SITE
    } else {
        DEFAULT_STAGING_SITE
    }
}

/// `production` only when the stage resolves to `production`; everything else
/// is staging.
pub fn stage() -> &'static str {
    resolve_stage(&real_env, &baked_in).0
}

pub(crate) fn stage_from(value: Option<&str>) -> &'static str {
    match value {
        Some(value) if value.eq_ignore_ascii_case("production") => "production",
        _ => "staging",
    }
}

/// Where a setting's value came from. `telekey check` prints it, so a copy on
/// the wrong stage says why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// A variable in the process environment. In a development build that
    /// includes what a `.env` file put there.
    Environment,
    /// Fixed when this app was built.
    Build,
    /// Nothing sets it: the built-in default for the stage.
    Default,
}

/// One resolved setting and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// The environment variable that overrides it.
    pub var: &'static str,
    pub value: String,
    pub source: Source,
}

/// Everything that differs between the stages, as the app resolves it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hosted {
    pub stage: Resolved,
    pub api_base: Resolved,
    pub site_url: Resolved,
    pub relay_url: Resolved,
}

/// What this copy talks to and why, for `telekey check`. No secrets in it.
pub fn hosted() -> Hosted {
    resolve_hosted(&real_env, &baked_in)
}

/// A way to read a named setting.
type Lookup<'a> = &'a dyn Fn(&str) -> Option<String>;

fn real_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn baked_in(name: &str) -> Option<String> {
    match name {
        "TELEKEY_STAGE" => option_env!("TELEKEY_STAGE").map(str::to_string),
        "TELEKEY_FIREBASE_API_KEY" => option_env!("TELEKEY_FIREBASE_API_KEY").map(str::to_string),
        "TELEKEY_API_BASE" => option_env!("TELEKEY_API_BASE").map(str::to_string),
        "TELEKEY_SITE_URL" => option_env!("TELEKEY_SITE_URL").map(str::to_string),
        "TELEKEY_RELAY_URL" => option_env!("TELEKEY_RELAY_URL").map(str::to_string),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

/// The environment first, then what was baked in. An empty value is unset in
/// both.
fn lookup(name: &str, env: Lookup, baked: Lookup) -> Option<(String, Source)> {
    env(name)
        .filter(|value| !value.is_empty())
        .map(|value| (value, Source::Environment))
        .or_else(|| {
            baked(name)
                .filter(|value| !value.is_empty())
                .map(|value| (value, Source::Build))
        })
}

fn resolve_stage(env: Lookup, baked: Lookup) -> (&'static str, Source) {
    match lookup("TELEKEY_STAGE", env, baked) {
        Some((value, source)) => (stage_from(Some(&value)), source),
        None => ("staging", Source::Default),
    }
}

/// One of the URLs that differ between the stages.
#[derive(Clone, Copy)]
struct Endpoint {
    var: &'static str,
    default_for: fn(&str) -> &'static str,
}

const API_BASE: Endpoint = Endpoint {
    var: "TELEKEY_API_BASE",
    default_for: default_api_base_for,
};
const SITE_URL: Endpoint = Endpoint {
    var: "TELEKEY_SITE_URL",
    default_for: default_site_url_for,
};
const RELAY_URL: Endpoint = Endpoint {
    var: "TELEKEY_RELAY_URL",
    default_for: default_relay_url_for,
};

fn resolve_endpoint(endpoint: Endpoint, env: Lookup, baked: Lookup) -> (String, Source) {
    lookup(endpoint.var, env, baked).unwrap_or_else(|| {
        let stage = resolve_stage(env, baked).0;
        ((endpoint.default_for)(stage).to_string(), Source::Default)
    })
}

fn resolve_hosted(env: Lookup, baked: Lookup) -> Hosted {
    let (stage, stage_source) = resolve_stage(env, baked);
    Hosted {
        stage: Resolved::new("TELEKEY_STAGE", stage.to_string(), stage_source),
        api_base: Resolved::from_endpoint(API_BASE, env, baked),
        site_url: Resolved::from_endpoint(SITE_URL, env, baked),
        relay_url: Resolved::from_endpoint(RELAY_URL, env, baked),
    }
}

impl Resolved {
    fn new(var: &'static str, value: String, source: Source) -> Self {
        Self { var, value, source }
    }

    fn from_endpoint(endpoint: Endpoint, env: Lookup, baked: Lookup) -> Self {
        let (value, source) = resolve_endpoint(endpoint, env, baked);
        Self::new(endpoint.var, value, source)
    }
}

/// The process environment, behind a trait so the loading rules can be tested
/// on a map: tests run in parallel, and changing the real environment under
/// them is not safe.
trait EnvVars {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&mut self, name: &str, value: &str);
}

struct ProcessEnv;

impl EnvVars for ProcessEnv {
    fn get(&self, name: &str) -> Option<String> {
        real_env(name)
    }

    fn set(&mut self, name: &str, value: &str) {
        // SAFETY: called once at process start, before other threads.
        unsafe { std::env::set_var(name, value) };
    }
}

/// The `TELEKEY_*` entries of a `.env` file that may go into the environment.
///
/// An `overlay` (`.env.staging`, `.env.production`, or the file named by
/// `TELEKEY_ENV_FILE`) carries only the three URLs; the stage is never chosen
/// by one.
fn telekey_entries(path: &Path, overlay: bool) -> Vec<(String, String)> {
    let Ok(iter) = dotenvy::from_path_iter(path) else {
        return Vec::new();
    };
    iter.flatten()
        .filter(|(key, value)| {
            key.starts_with("TELEKEY_")
                && !value.is_empty()
                && !matches!(
                    key.as_str(),
                    "TELEKEY_ENV_FILE" | "TELEKEY_LOG" | "TELEKEY_LOG_FILE"
                )
                && (!overlay || [API_BASE.var, SITE_URL.var, RELAY_URL.var].contains(&key.as_str()))
        })
        .collect()
}

/// A shared file never replaces something already in the environment; an
/// overlay does, which is what makes it an overlay.
fn apply_file(env: &mut impl EnvVars, path: &Path, overlay: bool) {
    for (key, value) in telekey_entries(path, overlay) {
        if !overlay && env.get(&key).is_some() {
            continue;
        }
        env.set(&key, &value);
    }
}

/// Load the project's public config into the environment, for development.
///
/// `.env` first (shared public keys), then `.env.staging` or `.env.production`
/// for the stage it chose. Default stage is staging. `TELEKEY_ENV_FILE`
/// replaces the stage overlay.
///
/// **A build that has its stage baked in reads none of these**, apart from
/// `TELEKEY_ENV_FILE`, which only a person at a shell sets. It does not need
/// them, since the stage, the public Firebase key and every URL have a
/// built-in value, and a file on disk, say one an older TeleKey left in the
/// config directory, must not be able to move an installed copy to another
/// stage. Nothing is written back: the app used to save the stage and the
/// resolved URLs here, which is how a machine stayed on staging.
pub fn hydrate_env() {
    let explicit = std::env::var("TELEKEY_ENV_FILE")
        .ok()
        .filter(|path| !path.is_empty())
        .map(std::path::PathBuf::from);
    hydrate_into(
        &mut ProcessEnv,
        &baked_in,
        &crate::settings::env_file_candidates(),
        explicit.as_deref(),
        &crate::settings::stage_env_file_candidates,
    );
}

fn hydrate_into(
    env: &mut impl EnvVars,
    baked: Lookup,
    shared: &[std::path::PathBuf],
    explicit: Option<&Path>,
    stage_overlay: &dyn Fn(&str) -> Vec<std::path::PathBuf>,
) {
    let stage_is_baked = baked("TELEKEY_STAGE").is_some_and(|stage| !stage.is_empty());

    if !stage_is_baked {
        for path in shared {
            if explicit == Some(path.as_path()) {
                continue;
            }
            apply_file(env, path, false);
        }
    }

    if let Some(explicit) = explicit {
        apply_file(env, explicit, true);
        return;
    }

    if !stage_is_baked {
        let stage = resolve_stage(&|name| env.get(name), baked).0;
        for path in stage_overlay(stage) {
            apply_file(env, &path, true);
        }
    }
}

/// Sign-in page in the system browser. Google and the magic link live there
/// because WKWebView is a poor host for OAuth popups.
pub fn open_hosted_login() -> Result<()> {
    let site = site_url().context("Hosted accounts are not configured (missing TELEKEY_SITE_URL)")?;
    let url = format!("{}/login?desktop=1", site.trim_end_matches('/'));
    open_in_browser(&url)
}

/// Account page in the system browser — Stripe Checkout lives there too.
pub fn open_hosted_account() -> Result<()> {
    let site = site_url().context("Hosted accounts are not configured (missing TELEKEY_SITE_URL)")?;
    let url = format!("{}/account", site.trim_end_matches('/'));
    open_in_browser(&url)
}

pub fn open_in_browser(url: &str) -> Result<()> {
    let status = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(url).status()
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // TeleKey has no console, so cmd.exe would open one of its own and
            // flash it over the screen for as long as `start` takes.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std::process::Command::new("cmd")
                .args(["/C", "start", "", url])
                .creation_flags(CREATE_NO_WINDOW)
                .status()
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            std::process::Command::new("xdg-open").arg(url).status()
        }
    }
    .context("could not open the browser")?;

    if !status.success() {
        bail!("could not open {url}");
    }
    Ok(())
}

/// Parse `telekey://auth?refreshToken=…&idToken=…&uid=…&email=…`.
pub fn session_from_callback_url(raw: &str) -> Result<Session> {
    let parsed = Url::parse(raw).context("sign-in link was not a valid URL")?;
    if parsed.scheme() != "telekey" || parsed.host_str() != Some("auth") {
        bail!("sign-in link was not a TeleKey callback");
    }

    let mut refresh_token = String::new();
    let mut id_token = String::new();
    let mut uid = String::new();
    let mut email = String::new();
    let mut expires_in: i64 = 3600;

    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "refreshToken" => refresh_token = value.into_owned(),
            "idToken" => id_token = value.into_owned(),
            "uid" => uid = value.into_owned(),
            "email" => email = value.into_owned(),
            "expiresIn" => expires_in = value.parse().unwrap_or(3600),
            _ => {}
        }
    }

    if refresh_token.is_empty() || uid.is_empty() {
        bail!("sign-in link was missing the session");
    }

    // The website no longer sends the ID token: with it the link ran past the
    // roughly 2,048 characters a Windows browser will hand to an app, and the
    // browser dropped it without a word. Without one, the first hosted call
    // mints a token from the refresh token (`fresh_id_token`).
    let id_token_expires = if id_token.is_empty() {
        0
    } else {
        chrono::Utc::now().timestamp() + expires_in.max(60)
    };

    Ok(Session {
        refresh_token,
        id_token,
        uid,
        email,
        id_token_expires,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::BTreeMap;
    use std::sync::Mutex;

    /// Windows' per-entry limit, in bytes of UTF-16.
    const WINDOWS_ENTRY_BYTES: usize = 2_560;

    /// A secret store that also enforces Windows' size limit, so a layout that
    /// would fail there fails here.
    #[derive(Default)]
    struct MemoryStore {
        entries: Mutex<BTreeMap<String, String>>,
    }

    impl MemoryStore {
        fn accounts(&self) -> Vec<String> {
            self.entries.lock().unwrap().keys().cloned().collect()
        }
    }

    impl SecretStore for MemoryStore {
        fn get(&self, account: &str) -> Result<Option<String>> {
            Ok(self.entries.lock().unwrap().get(account).cloned())
        }

        fn set(&self, account: &str, value: &str) -> Result<()> {
            let bytes = value.encode_utf16().count() * 2;
            if bytes > WINDOWS_ENTRY_BYTES {
                bail!("{bytes} bytes is over Windows' {WINDOWS_ENTRY_BYTES}");
            }
            self.entries
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<()> {
            self.entries.lock().unwrap().remove(account);
            Ok(())
        }
    }

    /// A session the size a real Google sign-in produces.
    fn realistic_session() -> String {
        serde_json::to_string(&Session {
            refresh_token: "r".repeat(900),
            id_token: "i".repeat(1_400),
            uid: "a".repeat(28),
            email: "theodoreimonigie@gmail.com".into(),
            id_token_expires: 1_790_000_000,
        })
        .unwrap()
    }

    #[test]
    fn a_real_sessions_size_would_not_fit_one_windows_entry() {
        // The bug this layout exists for.
        assert!(realistic_session().encode_utf16().count() * 2 > WINDOWS_ENTRY_BYTES);
    }

    #[test]
    fn a_real_session_round_trips_in_parts_that_each_fit_windows() {
        let store = MemoryStore::default();
        let raw = realistic_session();

        write_session(&store, &raw).unwrap();

        assert_eq!(read_session(&store).unwrap(), Some(raw));
        let first = store.get(KEYCHAIN_ACCOUNT).unwrap().unwrap();
        assert!(first.starts_with(PARTS_MARKER), "first entry: {first}");
    }

    #[test]
    fn a_short_value_is_stored_whole_with_no_parts() {
        let store = MemoryStore::default();
        write_session(&store, "{\"short\":true}").unwrap();

        assert_eq!(store.accounts(), vec![KEYCHAIN_ACCOUNT.to_string()]);
        assert_eq!(read_session(&store).unwrap().as_deref(), Some("{\"short\":true}"));
    }

    #[test]
    fn a_session_stored_whole_before_the_split_still_loads() {
        let store = MemoryStore::default();
        store
            .entries
            .lock()
            .unwrap()
            .insert(KEYCHAIN_ACCOUNT.into(), "{\"legacy\":1}".into());
        assert_eq!(read_session(&store).unwrap().as_deref(), Some("{\"legacy\":1}"));
    }

    #[test]
    fn a_shorter_session_removes_the_parts_it_no_longer_needs() {
        let store = MemoryStore::default();
        write_session(&store, &"x".repeat(3_000)).unwrap();
        assert_eq!(store.accounts().len(), 4, "{:?}", store.accounts());

        write_session(&store, &"y".repeat(1_500)).unwrap();
        assert_eq!(store.accounts().len(), 3, "{:?}", store.accounts());
        assert_eq!(read_session(&store).unwrap(), Some("y".repeat(1_500)));

        write_session(&store, "short").unwrap();
        assert_eq!(store.accounts(), vec![KEYCHAIN_ACCOUNT.to_string()]);
    }

    #[test]
    fn characters_outside_the_basic_plane_count_twice() {
        // An emoji is two UTF-16 units; splitting by characters alone would
        // overfill an entry.
        let raw = "😀".repeat(1_000);
        let parts = split_utf16(&raw, PART_UNITS);
        assert!(parts.iter().all(|p| p.encode_utf16().count() <= PART_UNITS));
        assert_eq!(parts.concat(), raw);

        let store = MemoryStore::default();
        write_session(&store, &raw).unwrap();
        assert_eq!(read_session(&store).unwrap(), Some(raw));
    }

    #[test]
    fn signing_out_removes_every_part() {
        let store = MemoryStore::default();
        write_session(&store, &realistic_session()).unwrap();
        delete_session(&store).unwrap();
        assert!(store.accounts().is_empty(), "{:?}", store.accounts());
        assert_eq!(read_session(&store).unwrap(), None);
    }

    #[test]
    fn a_missing_part_is_an_error_not_a_truncated_session() {
        let store = MemoryStore::default();
        write_session(&store, &"z".repeat(3_000)).unwrap();
        store.delete(&part_account(2)).unwrap();
        let err = read_session(&store).unwrap_err();
        assert!(format!("{err:#}").contains("missing part 2"), "{err:#}");
    }

    #[test]
    fn session_status_serialises_camel_case() {
        let json = serde_json::to_value(SessionStatus {
            signed_in: true,
            email: Some("you@example.com".into()),
            uid: Some("abc".into()),
        })
        .unwrap();
        let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["email", "signedIn", "uid"]);
    }

    #[test]
    fn callback_url_round_trips_the_session() {
        let session = session_from_callback_url(
            "telekey://auth?refreshToken=rt&idToken=id&uid=user-1&email=you%40example.com&expiresIn=1200",
        )
        .unwrap();
        assert_eq!(session.refresh_token, "rt");
        assert_eq!(session.id_token, "id");
        assert_eq!(session.uid, "user-1");
        assert_eq!(session.email, "you@example.com");
        assert!(session.id_token_expires > chrono::Utc::now().timestamp());
    }

    #[test]
    fn a_link_without_an_id_token_is_refreshed_on_first_use() {
        let session = session_from_callback_url(
            "telekey://auth?refreshToken=rt&uid=user-1&email=you%40example.com",
        )
        .unwrap();
        assert!(session.id_token.is_empty());
        assert_eq!(session.id_token_expires, 0, "so fresh_id_token refreshes at once");
    }

    #[test]
    fn concurrent_writers_and_readers_never_see_a_spliced_session() {
        // Two long sessions of the same length, written over and over from two
        // threads while two more read. Every read must be one or the other
        // whole, which only the storage lock guarantees once a session spans
        // several entries.
        let store = std::sync::Arc::new(MemoryStore::default());
        let a = "a".repeat(3_000);
        let b = "b".repeat(3_000);
        write_session(&*store, &a).unwrap();

        let mut threads = Vec::new();
        for value in [a.clone(), b.clone()] {
            let store = std::sync::Arc::clone(&store);
            threads.push(std::thread::spawn(move || {
                for _ in 0..200 {
                    write_session(&*store, &value).unwrap();
                }
            }));
        }
        for _ in 0..2 {
            let store = std::sync::Arc::clone(&store);
            let (a, b) = (a.clone(), b.clone());
            threads.push(std::thread::spawn(move || {
                for _ in 0..400 {
                    let read = read_session(&*store).unwrap().unwrap();
                    assert!(read == a || read == b, "spliced read of {} chars", read.len());
                }
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
    }

    #[test]
    fn a_foreign_url_is_rejected() {
        assert!(session_from_callback_url("https://evil.example/auth?uid=1&refreshToken=x").is_err());
        assert!(session_from_callback_url("telekey://auth").is_err());
    }

    #[test]
    fn stage_defaults_to_staging() {
        assert_eq!(stage_from(None), "staging");
        assert_eq!(stage_from(Some("")), "staging");
        assert_eq!(stage_from(Some("staging")), "staging");
        assert_eq!(stage_from(Some("production")), "production");
        assert_eq!(stage_from(Some("PRODUCTION")), "production");
    }

    #[test]
    fn hosted_urls_have_offline_fallbacks() {
        assert_eq!(
            default_api_base_for("staging"),
            "https://us-east1-telekey-app.cloudfunctions.net/staging"
        );
        assert_eq!(
            default_api_base_for("production"),
            "https://us-east1-telekey-app.cloudfunctions.net/api"
        );
        assert_eq!(
            default_site_url_for("staging"),
            "https://telekey-staging.vercel.app"
        );
        assert_eq!(
            default_site_url_for("production"),
            "https://www.telekey.app",
            "the official address (www), not the apex or the vercel.app one, which both redirect"
        );
    }

    #[test]
    fn each_stage_streams_to_its_own_relay() {
        // Staging's relay spends test credits and admits listed testers only;
        // a mix-up would bill real users at staging's prices, or the reverse.
        assert!(default_relay_url_for("staging").contains("telekey-relay-staging-"));
        assert!(default_relay_url_for("production").contains("telekey-relay-production-"));
        for stage in ["staging", "production"] {
            let url = default_relay_url_for(stage);
            assert!(url.starts_with("wss://"), "{url}");
            assert!(url.ends_with("/v1/realtime?intent=transcription"), "{url}");
        }
    }

    // ---- which stage an install is on --------------------------------------
    //
    // These run the real loading and resolution code on a map standing in for
    // the process environment, with the "baked in" values passed in, because
    // the real ones are fixed when the test binary is compiled.

    use std::path::PathBuf;

    #[derive(Default)]
    struct FakeEnv(BTreeMap<String, String>);

    impl FakeEnv {
        fn with(pairs: &[(&str, &str)]) -> Self {
            Self(
                pairs
                    .iter()
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect(),
            )
        }
    }

    impl EnvVars for FakeEnv {
        fn get(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }

        fn set(&mut self, name: &str, value: &str) {
            self.0.insert(name.to_string(), value.to_string());
        }
    }

    fn baked(pairs: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        let pairs = pairs.to_vec();
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    /// A config directory as an older TeleKey left it: `persist_hosted_config`
    /// wrote the stage and the Firebase key into `.env`, and the URLs it had
    /// resolved into `.env.staging` or `.env.production`.
    struct Files {
        dir: tempfile::TempDir,
    }

    impl Files {
        fn new(files: &[(&str, &str)]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            for (name, contents) in files {
                std::fs::write(dir.path().join(name), contents).unwrap();
            }
            Self { dir }
        }

        fn shared(&self) -> Vec<PathBuf> {
            vec![self.dir.path().join(".env")]
        }

        fn stage_overlay(&self, stage: &str) -> Vec<PathBuf> {
            let name = if stage == "production" {
                ".env.production"
            } else {
                ".env.staging"
            };
            vec![self.dir.path().join(name)]
        }
    }

    const LEFT_BEHIND_BY_A_STAGING_BUILD: &[(&str, &str)] = &[
        (
            ".env",
            "# Written by TeleKey so hosted URLs survive a Dock launch.\n\
             TELEKEY_STAGE=staging\nTELEKEY_FIREBASE_API_KEY=stale-key\n",
        ),
        (
            ".env.staging",
            "TELEKEY_API_BASE=https://staging.example/api\n\
             TELEKEY_SITE_URL=https://staging.example\n\
             TELEKEY_RELAY_URL=wss://staging.example/relay\n",
        ),
    ];

    /// Load `files` the way `hydrate_env` does, then resolve.
    fn load(
        files: &Files,
        env: &mut FakeEnv,
        baked_values: &[(&'static str, &'static str)],
        explicit: Option<&Path>,
    ) -> Hosted {
        let baked = baked(baked_values);
        hydrate_into(env, &baked, &files.shared(), explicit, &|stage| {
            files.stage_overlay(stage)
        });
        resolve_hosted(&|name| env.get(name), &baked)
    }

    #[test]
    fn a_production_build_ignores_what_a_staging_build_left_in_the_config_dir() {
        // The bug: a machine that ever ran a staging build stayed on staging
        // after updating to production.
        let files = Files::new(LEFT_BEHIND_BY_A_STAGING_BUILD);
        let mut env = FakeEnv::default();

        let hosted = load(&files, &mut env, &[("TELEKEY_STAGE", "production")], None);

        assert_eq!(hosted.stage.value, "production");
        assert_eq!(hosted.stage.source, Source::Build);
        assert_eq!(hosted.api_base.value, DEFAULT_PRODUCTION_API);
        assert_eq!(hosted.api_base.source, Source::Default);
        assert_eq!(hosted.site_url.value, "https://www.telekey.app");
        assert_eq!(hosted.relay_url.value, DEFAULT_PRODUCTION_RELAY);
        assert!(
            env.0.is_empty(),
            "nothing from disk reached the environment: {:?}",
            env.0
        );
    }

    #[test]
    fn a_production_build_does_not_take_the_stale_firebase_key_either() {
        let files = Files::new(LEFT_BEHIND_BY_A_STAGING_BUILD);
        let mut env = FakeEnv::default();
        load(&files, &mut env, &[("TELEKEY_STAGE", "production")], None);

        let baked = baked(&[("TELEKEY_STAGE", "production")]);
        assert_eq!(
            lookup("TELEKEY_FIREBASE_API_KEY", &|n| env.get(n), &baked),
            None
        );
    }

    #[test]
    fn a_staging_build_ignores_a_production_config_dir_too() {
        // The same rule the other way: a release candidate does not drift to
        // production because of what an earlier build wrote.
        let files = Files::new(&[
            (".env", "TELEKEY_STAGE=production\n"),
            (
                ".env.production",
                "TELEKEY_API_BASE=https://prod.example/api\n",
            ),
        ]);
        let mut env = FakeEnv::default();

        let hosted = load(&files, &mut env, &[("TELEKEY_STAGE", "staging")], None);

        assert_eq!(hosted.stage.value, "staging");
        assert_eq!(hosted.api_base.value, DEFAULT_STAGING_API);
        assert_eq!(hosted.site_url.value, DEFAULT_STAGING_SITE);
    }

    #[test]
    fn a_build_without_a_baked_stage_still_follows_its_env_files() {
        // Development: `cargo run` and `bun tauri dev` have nothing baked in.
        let files = Files::new(&[
            (".env", "TELEKEY_STAGE=production\n"),
            (
                ".env.production",
                "TELEKEY_API_BASE=https://prod.example/api\nTELEKEY_SITE_URL=https://prod.example\n",
            ),
        ]);
        let mut env = FakeEnv::default();

        let hosted = load(&files, &mut env, &[], None);

        assert_eq!(hosted.stage.value, "production");
        assert_eq!(hosted.stage.source, Source::Environment);
        assert_eq!(hosted.api_base.value, "https://prod.example/api");
        assert_eq!(hosted.site_url.value, "https://prod.example");
        // No URL for the relay in the file: the default for the stage.
        assert_eq!(hosted.relay_url.value, DEFAULT_PRODUCTION_RELAY);
        assert_eq!(hosted.relay_url.source, Source::Default);
    }

    #[test]
    fn with_nothing_set_anywhere_it_is_staging() {
        let files = Files::new(&[]);
        let mut env = FakeEnv::default();

        let hosted = load(&files, &mut env, &[], None);

        assert_eq!(hosted.stage.value, "staging");
        assert_eq!(hosted.stage.source, Source::Default);
        assert_eq!(hosted.api_base.value, DEFAULT_STAGING_API);
        assert_eq!(hosted.site_url.value, DEFAULT_STAGING_SITE);
    }

    #[test]
    fn a_shared_file_does_not_replace_a_variable_already_set() {
        let files = Files::new(&[(".env", "TELEKEY_STAGE=production\n")]);
        let mut env = FakeEnv::with(&[("TELEKEY_STAGE", "staging")]);

        let hosted = load(&files, &mut env, &[], None);

        assert_eq!(hosted.stage.value, "staging", "the shell beats the file");
    }

    #[test]
    fn the_real_environment_still_overrides_a_baked_stage() {
        // run.sh builds for one stage and launches with the same one; a
        // developer can also point a production build at staging from a shell.
        // Only the real environment can do it: a build that knows its stage
        // loads no file into it.
        let files = Files::new(&[]);
        let mut env = FakeEnv::with(&[("TELEKEY_STAGE", "staging")]);

        let hosted = load(&files, &mut env, &[("TELEKEY_STAGE", "production")], None);

        assert_eq!(hosted.stage.value, "staging");
        assert_eq!(hosted.stage.source, Source::Environment);
        assert_eq!(
            hosted.api_base.value, DEFAULT_STAGING_API,
            "the URLs follow the stage"
        );
    }

    #[test]
    fn a_real_url_override_beats_a_baked_one_which_beats_the_default() {
        let none = |_: &str| None;
        let baked_api = baked(&[("TELEKEY_API_BASE", "https://baked.example")]);
        let real_api = FakeEnv::with(&[("TELEKEY_API_BASE", "http://127.0.0.1:5001/api")]);

        let (value, source) = resolve_endpoint(API_BASE, &none, &baked_api);
        assert_eq!(
            (value.as_str(), source),
            ("https://baked.example", Source::Build)
        );

        let (value, source) = resolve_endpoint(API_BASE, &|n| real_api.get(n), &baked_api);
        assert_eq!(
            (value.as_str(), source),
            ("http://127.0.0.1:5001/api", Source::Environment)
        );

        let (value, source) = resolve_endpoint(API_BASE, &none, &none);
        assert_eq!(
            (value.as_str(), source),
            (DEFAULT_STAGING_API, Source::Default)
        );
    }

    #[test]
    fn an_empty_value_counts_as_unset() {
        let env = FakeEnv::with(&[("TELEKEY_STAGE", "")]);
        let baked = baked(&[("TELEKEY_STAGE", "production")]);

        let (stage, source) = resolve_stage(&|n| env.get(n), &baked);

        assert_eq!((stage, source), ("production", Source::Build));
    }

    #[test]
    fn an_explicit_env_file_sets_urls_but_never_the_stage() {
        // `TELEKEY_ENV_FILE` is exported in a shell, so a production build
        // honours it, for the three URLs only.
        let files = Files::new(&[
            (
                "custom.env",
                "TELEKEY_STAGE=staging\nTELEKEY_API_BASE=http://127.0.0.1:5001/api\n",
            ),
            (".env", "TELEKEY_STAGE=staging\n"),
        ]);
        let explicit = files.dir.path().join("custom.env");
        let mut env = FakeEnv::default();

        let hosted = load(
            &files,
            &mut env,
            &[("TELEKEY_STAGE", "production")],
            Some(&explicit),
        );

        assert_eq!(hosted.stage.value, "production");
        assert_eq!(hosted.api_base.value, "http://127.0.0.1:5001/api");
        assert_eq!(hosted.site_url.value, "https://www.telekey.app");
    }

    #[test]
    fn an_explicit_env_file_replaces_the_stage_overlay() {
        let files = Files::new(&[
            ("custom.env", "TELEKEY_SITE_URL=http://localhost:3000\n"),
            (".env.staging", "TELEKEY_API_BASE=https://overlay.example\n"),
        ]);
        let explicit = files.dir.path().join("custom.env");
        let mut env = FakeEnv::default();

        let hosted = load(&files, &mut env, &[], Some(&explicit));

        assert_eq!(hosted.site_url.value, "http://localhost:3000");
        assert_eq!(
            hosted.api_base.value, DEFAULT_STAGING_API,
            ".env.staging is not read"
        );
    }

    #[test]
    fn an_overlay_cannot_set_anything_but_the_three_urls() {
        let files = Files::new(&[(
            ".env.staging",
            "TELEKEY_STAGE=production\nTELEKEY_UPDATE_URL=https://evil.example\n\
             TELEKEY_LOG=trace\nTELEKEY_API_BASE=https://overlay.example\n",
        )]);

        let entries = telekey_entries(&files.dir.path().join(".env.staging"), true);

        assert_eq!(
            entries,
            vec![(
                "TELEKEY_API_BASE".to_string(),
                "https://overlay.example".to_string()
            )]
        );
    }

    #[test]
    fn a_shared_file_skips_the_process_settings_and_blank_values() {
        let files = Files::new(&[(
            ".env",
            "TELEKEY_STAGE=staging\nTELEKEY_LOG=trace\nTELEKEY_LOG_FILE=/tmp/x\n\
             TELEKEY_ENV_FILE=/tmp/y\nTELEKEY_SITE_URL=\nOPENAI_API_KEY=sk-nope\n",
        )]);

        let entries = telekey_entries(&files.dir.path().join(".env"), false);

        assert_eq!(
            entries,
            vec![("TELEKEY_STAGE".to_string(), "staging".to_string())]
        );
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        assert!(telekey_entries(Path::new("/definitely/not/here/.env"), false).is_empty());
    }
}
