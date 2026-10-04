//! Hosted-account session, kept in the Keychain like the OpenAI key.
//!
//! The ID token is short-lived. We store the refresh token and mint a new ID
//! token when it is close to expiry. Nothing here is logged. The session
//! arrives over `telekey://auth` after the website signs the user in.

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

/// Public Firebase web API key (same value as `web/lib/firebaseConfig.ts`).
/// It is not a secret; without a compile-time bake or `.env`, Dock launches
/// still have to refresh ID tokens.
const DEFAULT_FIREBASE_WEB_API_KEY: &str = "AIzaSyCdylrBqOKtlz_MJl6XnSBgGZMg3rDfQuI";
const DEFAULT_STAGING_API: &str = "https://us-east1-telekey-app.cloudfunctions.net/staging";
const DEFAULT_PRODUCTION_API: &str = "https://us-east1-telekey-app.cloudfunctions.net/api";
const DEFAULT_STAGING_SITE: &str = "https://telekey-staging.vercel.app";
const DEFAULT_PRODUCTION_SITE: &str = "https://telekey.vercel.app";

pub fn firebase_web_api_key() -> Option<String> {
    env_value("TELEKEY_FIREBASE_API_KEY")
        .or_else(|| Some(DEFAULT_FIREBASE_WEB_API_KEY.to_string()))
}

pub fn api_base() -> Option<String> {
    env_value("TELEKEY_API_BASE").or_else(|| Some(default_api_base_for(stage()).to_string()))
}

pub fn site_url() -> Option<String> {
    env_value("TELEKEY_SITE_URL").or_else(|| Some(default_site_url_for(stage()).to_string()))
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

/// `production` only when `TELEKEY_STAGE=production`; everything else is staging.
pub fn stage() -> &'static str {
    stage_from(env_value("TELEKEY_STAGE").as_deref())
}

pub(crate) fn stage_from(value: Option<&str>) -> &'static str {
    match value {
        Some(value) if value.eq_ignore_ascii_case("production") => "production",
        _ => "staging",
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| baked_in(name))
}

fn baked_in(name: &str) -> Option<String> {
    match name {
        "TELEKEY_STAGE" => option_env!("TELEKEY_STAGE").map(str::to_string),
        "TELEKEY_FIREBASE_API_KEY" => option_env!("TELEKEY_FIREBASE_API_KEY").map(str::to_string),
        "TELEKEY_API_BASE" => option_env!("TELEKEY_API_BASE").map(str::to_string),
        "TELEKEY_SITE_URL" => option_env!("TELEKEY_SITE_URL").map(str::to_string),
        _ => None,
    }
    .filter(|value| !value.is_empty())
}

fn apply_telekey_env(path: &std::path::Path, overlay: bool) {
    let Ok(iter) = dotenvy::from_path_iter(path) else {
        return;
    };
    for (key, value) in iter.flatten() {
        if !key.starts_with("TELEKEY_") || value.is_empty() {
            continue;
        }
        if matches!(
            key.as_str(),
            "TELEKEY_ENV_FILE" | "TELEKEY_LOG" | "TELEKEY_LOG_FILE"
        ) {
            continue;
        }
        if !overlay && std::env::var(&key).is_ok() {
            continue;
        }
        if overlay && key != "TELEKEY_API_BASE" && key != "TELEKEY_SITE_URL" {
            continue;
        }
        // SAFETY: called once at process start, before other threads.
        unsafe { std::env::set_var(key, value) };
    }
}

/// `.env` first (shared public keys), then `.env.staging` or `.env.production`.
///
/// Default stage is staging. `TELEKEY_ENV_FILE` replaces the stage overlay.
pub fn hydrate_env() {
    for path in crate::settings::env_file_candidates() {
        if std::env::var("TELEKEY_ENV_FILE")
            .ok()
            .is_some_and(|explicit| std::path::Path::new(&explicit) == path)
        {
            continue;
        }
        apply_telekey_env(&path, false);
    }

    if let Ok(explicit) = std::env::var("TELEKEY_ENV_FILE") {
        apply_telekey_env(std::path::Path::new(&explicit), true);
        return;
    }

    for path in crate::settings::stage_env_file_candidates(stage()) {
        apply_telekey_env(&path, true);
    }

    persist_hosted_config();
}

/// Dock launches have no project `.env`. Write the public hosted URLs into
/// Application Support so the next cold start still finds them.
fn persist_hosted_config() {
    let Ok(dir) = crate::settings::config_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }

    let current_stage = stage();
    let mut base = String::from("# Written by TeleKey so hosted URLs survive a Dock launch.\n");
    base.push_str(&format!("TELEKEY_STAGE={current_stage}\n"));
    if let Some(key) = firebase_web_api_key() {
        base.push_str(&format!("TELEKEY_FIREBASE_API_KEY={key}\n"));
    }
    if std::fs::write(dir.join(".env"), base).is_err() {
        tracing::warn!("could not persist hosted .env");
    }

    let overlay_name = if current_stage == "production" {
        ".env.production"
    } else {
        ".env.staging"
    };
    let mut overlay = String::new();
    if let Some(base_url) = api_base() {
        overlay.push_str(&format!("TELEKEY_API_BASE={base_url}\n"));
    }
    if let Some(site) = site_url() {
        overlay.push_str(&format!("TELEKEY_SITE_URL={site}\n"));
    }
    if !overlay.is_empty() && std::fs::write(dir.join(overlay_name), overlay).is_err() {
        tracing::warn!("could not persist hosted overlay env");
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
            std::process::Command::new("cmd")
                .args(["/C", "start", "", url])
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
            "https://telekey.vercel.app"
        );
    }
}
