//! Transcription and polish through TeleKey's Cloud Functions.
//!
//! The OpenAI key never leaves the server. This client sends audio (or text)
//! plus a Firebase ID token and receives the transcript plus remaining credits.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use crate::audio::{encode_wav_16bit_mono, Clip, TARGET_SAMPLE_RATE};
use crate::polish::{Polished, Polisher, Style};
use crate::session;
use crate::transcribe::{Transcription, TranscriptionContext, Transcriber};
use crate::usage::Units;

pub struct HostedTranscriber {
    client: reqwest::blocking::Client,
    endpoint: String,
}

impl HostedTranscriber {
    pub fn new() -> Result<Self> {
        let base = session::api_base().context(
            "Hosted accounts are not configured in this build (missing TELEKEY_API_BASE)",
        )?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .context("could not build the HTTP client")?;
        Ok(Self {
            client,
            endpoint: format!("{}/transcribe", base.trim_end_matches('/')),
        })
    }
}

impl Transcriber for HostedTranscriber {
    fn transcribe(&self, clip: &Clip, context: &TranscriptionContext) -> Result<Transcription> {
        let wav = encode_wav_16bit_mono(&clip.samples, TARGET_SAMPLE_RATE);
        let token = session::fresh_id_token()?;
        let keywords = serde_json::to_string(&context.keywords).unwrap_or_else(|_| "[]".into());
        let languages = serde_json::to_string(&context.languages).unwrap_or_else(|_| "[]".into());

        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(token)
            .header("content-type", "audio/wav")
            .header("x-telekey-keywords", keywords)
            .header("x-telekey-languages", languages)
            .body(wav)
            .send()
            .context("could not reach TeleKey")?;

        let status = response.status();
        let body = response.text().unwrap_or_default();
        if !status.is_success() {
            bail!("{}", hosted_error(status.as_u16(), &body));
        }

        let parsed: HostedText = serde_json::from_str(&body)
            .context("TeleKey returned an unexpected transcription")?;
        Ok(Transcription {
            text: parsed.text.trim().to_string(),
            units: parsed.units.unwrap_or_default(),
        })
    }
}

pub struct HostedPolisher {
    client: reqwest::blocking::Client,
    endpoint: String,
}

impl HostedPolisher {
    pub fn new() -> Result<Self> {
        let base = session::api_base().context(
            "Hosted accounts are not configured in this build (missing TELEKEY_API_BASE)",
        )?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .context("could not build the HTTP client")?;
        Ok(Self {
            client,
            endpoint: format!("{}/polish", base.trim_end_matches('/')),
        })
    }
}

impl Polisher for HostedPolisher {
    fn polish(&self, text: &str, style: &Style) -> Result<Polished> {
        let Some(instruction) = style.instruction() else {
            return Ok(Polished {
                text: crate::polish::apply_literal(text),
                units: Units::default(),
            });
        };

        let token = session::fresh_id_token()?;
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(token)
            .json(&serde_json::json!({ "text": text, "instruction": instruction }))
            .send()
            .context("could not reach TeleKey")?;

        let status = response.status();
        let body = response.text().unwrap_or_default();
        if !status.is_success() {
            bail!("{}", hosted_error(status.as_u16(), &body));
        }

        let parsed: HostedText = serde_json::from_str(&body)
            .context("TeleKey returned an unexpected rewrite")?;
        Ok(Polished {
            text: parsed.text,
            units: parsed.units.unwrap_or_default(),
        })
    }
}

#[derive(Debug, Deserialize)]
struct HostedText {
    text: String,
    #[serde(default)]
    units: Option<Units>,
}

fn hosted_error(status: u16, body: &str) -> anyhow::Error {
    let detail = extract_error(body).unwrap_or_else(|| body.chars().take(180).collect());
    match status {
        401 => anyhow!("Session expired — sign in again"),
        402 => anyhow!("Out of credits — buy more in TeleKey"),
        429 => anyhow!("busy — try again"),
        _ => anyhow!("{detail}"),
    }
}

fn extract_error(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value.get("error")?.as_str().map(str::to_string)
}

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("could not build the HTTP client")
}

fn endpoint(path: &str) -> Result<String> {
    let base = session::api_base().context(
        "Hosted accounts are not configured in this build (missing TELEKEY_API_BASE)",
    )?;
    Ok(format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    ))
}

/// Balance, packs, and recent server usage for the signed-in account.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedAccount {
    pub email: Option<String>,
    pub balance_cents: i64,
    #[serde(default)]
    pub packs: Vec<CreditPack>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditPack {
    pub id: String,
    pub name: String,
    pub cents: i64,
}

pub fn fetch_account() -> Result<HostedAccount> {
    let token = session::fresh_id_token()?;
    let response = client()?
        .get(endpoint("me")?)
        .bearer_auth(token)
        .send()
        .context("could not reach TeleKey")?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        bail!("{}", hosted_error(status.as_u16(), &body));
    }
    serde_json::from_str(&body).context("TeleKey returned an unexpected account")
}

pub fn create_checkout(pack_id: &str) -> Result<String> {
    let token = session::fresh_id_token()?;
    let response = client()?
        .post(endpoint("createCheckoutSession")?)
        .bearer_auth(&token)
        .json(&serde_json::json!({ "packId": pack_id }))
        .send()
        .context("could not start checkout")?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        bail!("{}", hosted_error(status.as_u16(), &body));
    }
    #[derive(Deserialize)]
    struct Checkout {
        url: String,
    }
    let parsed: Checkout = serde_json::from_str(&body).context("checkout response was not JSON")?;
    Ok(parsed.url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_error_maps_out_of_credits() {
        assert!(hosted_error(402, r#"{"error":"nope"}"#)
            .to_string()
            .contains("credits"));
    }
}