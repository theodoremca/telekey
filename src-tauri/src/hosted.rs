//! Transcription and polish through TeleKey's Cloud Functions.
//!
//! The OpenAI key never leaves the server. This client sends audio (or text)
//! plus a Firebase ID token and receives the transcript plus remaining credits.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use crate::audio::{encode_wav_16bit_mono, Clip, TARGET_SAMPLE_RATE};
use crate::polish::{Polished, Polisher, Style};
use crate::session;
use crate::tips::Payer;
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

/// What the context headers may add up to, in bytes. Node refuses a request
/// whose headers pass 16 KiB in all, and the sign-in token takes a good part
/// of that; past this, the screen context is left off rather than the whole
/// dictation failing.
const CONTEXT_HEADER_BUDGET: usize = 6 * 1024;

/// The screen context as a header value: base64 of the UTF-8, so nothing
/// outside ASCII has to survive the trip.
fn prompt_header(context: &TranscriptionContext, others: usize) -> Option<String> {
    use base64::Engine as _;
    let prompt = context.prompt.as_deref().filter(|p| !p.is_empty())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(prompt);
    if others + encoded.len() > CONTEXT_HEADER_BUDGET {
        tracing::debug!(bytes = encoded.len(), "screen context left off: headers too large");
        return None;
    }
    Some(encoded)
}

impl Transcriber for HostedTranscriber {
    fn payer(&self) -> Option<Payer> {
        Some(Payer::Credits)
    }

    fn transcribe(&self, clip: &Clip, context: &TranscriptionContext) -> Result<Transcription> {
        let wav = encode_wav_16bit_mono(&clip.samples, TARGET_SAMPLE_RATE);
        let token = session::fresh_id_token()?;
        let keywords = serde_json::to_string(&context.keywords).unwrap_or_else(|_| "[]".into());
        let languages = serde_json::to_string(&context.languages).unwrap_or_else(|_| "[]".into());
        let prompt = prompt_header(context, keywords.len() + languages.len());

        let send = |prompt: Option<&str>| {
            let mut request = self
                .client
                .post(&self.endpoint)
                .bearer_auth(&token)
                .header("content-type", "audio/wav")
                .header("x-telekey-keywords", keywords.as_str())
                .header("x-telekey-languages", languages.as_str());
            if let Some(prompt) = prompt {
                request = request.header("x-telekey-prompt", prompt);
            }
            request.body(wav.clone()).send().context("could not reach TeleKey")
        };

        let mut response = send(prompt.as_deref())?;
        // Headers too large after all: the screen context is a nicety, the
        // dictation is not. Once more without it.
        if response.status().as_u16() == 431 && prompt.is_some() {
            tracing::warn!("TeleKey refused the headers; retrying without the screen context");
            response = send(None)?;
        }

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

/// What the person is told when TeleKey's server failed and said nothing
/// readable (a proxy's HTML page, an empty body). No "credit" in it: the
/// overlay opens the Buy credits window for any failure that says so.
const TROUBLE: &str = "TeleKey is having trouble right now — try again in a moment";

/// A failed request as a sentence for the person. 401, 402 and 429 are
/// TeleKey's own sign-in, balance and rate guard. The server answers 503 when
/// OpenAI is what failed (a revoked key, an exhausted quota) and 500 when
/// something of its own broke, each with a message written for people ("…
/// Nothing was charged."), so that is shown as it is. A 500, 502, 503 or 504
/// from Google's front end or a proxy has an HTML or plain-text body instead,
/// and none of that belongs in the capsule. Only the server's own JSON
/// `error` string is ever shown; the body itself never is.
fn hosted_error(status: u16, body: &str) -> anyhow::Error {
    match status {
        401 => anyhow!("Session expired — sign in again"),
        402 => anyhow!("Out of credits — buy more in TeleKey"),
        429 => anyhow!("busy — try again"),
        500 | 502 | 503 | 504 => match extract_error(body) {
            Some(message) => anyhow!("{message}"),
            None => anyhow!("{TROUBLE}"),
        },
        _ => match extract_error(body) {
            Some(message) => anyhow!("{message}"),
            None => anyhow!("TeleKey could not complete that (error {status}) — try again in a moment"),
        },
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
    /// What the pack costs.
    pub cents: i64,
    /// What the pack adds to the balance, when that is more than it costs
    /// (a bonus: the $25 pack gives $27.50). Absent from an older server, and
    /// from a pack with no bonus; the window then shows the price alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit_cents: Option<i64>,
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

    fn with_prompt(prompt: &str) -> TranscriptionContext {
        TranscriptionContext {
            keywords: vec![],
            languages: vec![],
            prompt: Some(prompt.into()),
        }
    }

    #[test]
    fn the_prompt_header_is_base64_of_the_utf8() {
        use base64::Engine as _;
        let header = prompt_header(&with_prompt("Dictating into Mail — Zoë"), 0).unwrap();
        assert!(header.is_ascii());
        let decoded = base64::engine::general_purpose::STANDARD.decode(header).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "Dictating into Mail — Zoë");
    }

    #[test]
    fn the_prompt_is_left_off_when_the_headers_would_be_too_large() {
        assert!(prompt_header(&with_prompt("short"), CONTEXT_HEADER_BUDGET).is_none());
        assert!(prompt_header(&with_prompt("short"), 0).is_some());
        assert!(prompt_header(&TranscriptionContext::default(), 0).is_none());
    }

    #[test]
    fn hosted_error_maps_out_of_credits() {
        assert!(hosted_error(402, r#"{"error":"nope"}"#)
            .to_string()
            .contains("credits"));
    }

    #[test]
    fn telekeys_own_refusals_keep_their_wording() {
        assert_eq!(
            hosted_error(401, r#"{"error":"x"}"#).to_string(),
            "Session expired — sign in again"
        );
        assert_eq!(hosted_error(429, "").to_string(), "busy — try again");
        assert_eq!(
            hosted_error(403, r#"{"error":"a@b.c is not on the list."}"#).to_string(),
            "a@b.c is not on the list."
        );
    }

    #[test]
    fn a_503_shows_the_servers_message() {
        let body = r#"{"error":"TeleKey's transcription service is having trouble. Nothing was charged.","code":"upstream"}"#;
        let message = hosted_error(503, body).to_string();
        assert_eq!(
            message,
            "TeleKey's transcription service is having trouble. Nothing was charged."
        );
        // The overlay opens the Buy credits window for any failure that says credit.
        assert!(!message.to_lowercase().contains("credit"), "{message}");
    }

    #[test]
    fn a_503_that_is_not_ours_is_a_plain_sentence() {
        let message =
            hosted_error(503, "<html><body>Service Unavailable</body></html>").to_string();
        assert_eq!(message, "TeleKey is having trouble right now — try again in a moment");
        assert!(!message.to_lowercase().contains("credit"));
    }

    #[test]
    fn a_500_502_or_504_follows_the_same_rule_as_a_503() {
        let html = "<html><body><h1>Error</h1><p>Server Error</p></body></html>";
        for status in [500, 502, 503, 504] {
            // No readable body: a plain sentence, never the markup.
            for body in [html, "", "upstream connect error", "   "] {
                let message = hosted_error(status, body).to_string();
                assert_eq!(
                    message,
                    "TeleKey is having trouble right now — try again in a moment",
                    "{status} {body:?}"
                );
            }
            // The server's own sentence, when it sent one.
            let json = r#"{"error":"Something went wrong on TeleKey's side. Try again."}"#;
            assert_eq!(
                hosted_error(status, json).to_string(),
                "Something went wrong on TeleKey's side. Try again."
            );
        }
    }

    #[test]
    fn no_server_failure_message_opens_the_buy_credits_window() {
        for status in [500, 502, 503, 504] {
            let message = hosted_error(status, "").to_string().to_lowercase();
            assert!(!message.contains("credit"), "{status}: {message}");
        }
    }

    #[test]
    fn raw_html_is_never_shown_for_any_status() {
        let html = "<!DOCTYPE html><html><head><title>413 Request Entity Too Large</title></head></html>";
        for status in [400, 403, 404, 413, 500, 502, 503, 504] {
            let message = hosted_error(status, html).to_string();
            assert!(!message.contains('<'), "{status}: {message}");
            assert!(!message.to_lowercase().contains("html"), "{status}: {message}");
            assert!(!message.to_lowercase().contains("credit"), "{status}: {message}");
        }
        assert_eq!(
            hosted_error(404, html).to_string(),
            "TeleKey could not complete that (error 404) — try again in a moment"
        );
    }

    #[test]
    fn a_request_the_server_rejected_shows_its_sentence() {
        let body = r#"{"error":"That recording could not be transcribed. Try a shorter one.","code":"rejected"}"#;
        assert_eq!(
            hosted_error(400, body).to_string(),
            "That recording could not be transcribed. Try a shorter one."
        );
        let body = r#"{"error":"That recording is too long to transcribe. Try a shorter one."}"#;
        assert_eq!(
            hosted_error(413, body).to_string(),
            "That recording is too long to transcribe. Try a shorter one."
        );
    }

    #[test]
    fn an_older_server_sends_packs_without_a_bonus() {
        let account: HostedAccount = serde_json::from_str(
            r#"{"email":"a@b.c","balanceCents":500,"packs":[{"id":"starter","name":"$5","cents":500}]}"#,
        )
        .unwrap();
        assert_eq!(account.packs[0].credit_cents, None);

        // And it is not invented on the way back to the window.
        let json = serde_json::to_value(&account.packs[0]).unwrap();
        assert!(json.get("creditCents").is_none(), "{json}");
    }

    #[test]
    fn a_pack_with_a_bonus_carries_it_to_the_window_in_camel_case() {
        let account: HostedAccount = serde_json::from_str(
            r#"{"email":null,"balanceCents":0,"packs":[
                {"id":"plus","name":"$25","cents":2500,"creditCents":2750}]}"#,
        )
        .unwrap();
        assert_eq!(account.packs[0].credit_cents, Some(2750));
        let json = serde_json::to_value(&account.packs[0]).unwrap();
        assert_eq!(json["creditCents"], 2750);
        assert_eq!(json["cents"], 2500);
    }
}
