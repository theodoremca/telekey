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
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .context("could not open the session Keychain entry")?;
    match entry.get_password() {
        Ok(raw) => {
            let session: Session = serde_json::from_str(&raw)
                .context("stored session was not valid JSON")?;
            Ok(Some(session))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(anyhow::Error::new(err).context("could not read the hosted session")),
    }
}

pub fn store(session: &Session) -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .context("could not open the session Keychain entry")?;
    let raw = serde_json::to_string(session).context("could not serialise the session")?;
    entry
        .set_password(&raw)
        .context("could not store the hosted session")
}

pub fn clear() -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .context("could not open the session Keychain entry")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(anyhow::Error::new(err).context("could not delete the hosted session")),
    }
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

    Ok(Session {
        refresh_token,
        id_token,
        uid,
        email,
        id_token_expires: chrono::Utc::now().timestamp() + expires_in.max(60),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
