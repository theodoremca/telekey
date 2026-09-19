//! Per-app formatting.
//!
//! `gpt-transcribe` already punctuates and strips fillers, so this stage exists
//! only to match the register of where the text is going: terse in Slack, formal
//! in Mail, literal in a terminal.
//!
//! Styles split deliberately. `Literal` is a handful of deterministic rules —
//! sending "git status" to a language model to have a full stop removed would
//! cost money and a round-trip for something a regex does perfectly. Only the
//! styles that need judgement make a call.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::usage::Units;

pub const DEFAULT_MODEL: &str = "gpt-5.6-luna";
pub const DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1/responses";

/// A rewrite that balloons is a model that has started explaining itself rather
/// than rewriting. Fall back to the transcript instead of pasting an essay.
const MAX_GROWTH: f32 = 3.0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Style {
    /// Shell commands and code: no sentence capital, no trailing full stop.
    Literal,
    /// Chat: short and direct, no greeting or sign-off.
    Terse,
    /// Email: complete sentences, professional register.
    Formal,
    /// Whatever the user asked for.
    Custom(String),
}

impl Style {
    /// Whether this style needs a model call, or is handled locally.
    pub fn needs_model(&self) -> bool {
        !matches!(self, Style::Literal)
    }

    /// The instruction sent to the model, for styles that need one.
    pub(crate) fn instruction(&self) -> Option<String> {
        let guidance = match self {
            Style::Literal => return None,
            Style::Terse => {
                "Keep it short and direct. Drop greetings, sign-offs and hedging. \
                 Prefer short sentences."
            }
            Style::Formal => {
                "Use complete sentences and a polite, professional register \
                 suitable for email."
            }
            Style::Custom(instruction) => instruction.as_str(),
        };

        Some(format!(
            "You reformat dictated text. {guidance}\n\n\
             Rules: preserve the meaning exactly and never add information, \
             facts, greetings or sign-offs that were not dictated. Return only \
             the reformatted text — no commentary, no quotation marks, no \
             preamble."
        ))
    }
}

/// Which app a transcript is bound for, and how it should read there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppProfile {
    /// Matches `TargetApp::profile_key` — a bundle id, or a name as fallback.
    pub app: String,
    /// What to show in settings, e.g. "Slack".
    pub label: String,
    pub style: Style,
}

/// Reformatted text, plus what the API says it billed.
#[derive(Debug, Clone, PartialEq)]
pub struct Polished {
    pub text: String,
    /// Zero for a locally-applied style, and zero when the response carried no
    /// `usage` object.
    pub units: Units,
}

/// The seam, so the pipeline can be tested without a network.
pub trait Polisher: Send + Sync {
    fn polish(&self, text: &str, style: &Style) -> Result<Polished>;
}

/// The Responses API `usage` object. Optional throughout so a shape change
/// costs a figure rather than the rewrite itself.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiUsage {
    #[serde(default, alias = "input_tokens")]
    input_tokens: Option<u64>,
    #[serde(default, alias = "output_tokens")]
    output_tokens: Option<u64>,
    #[serde(default, alias = "input_tokens_details")]
    input_tokens_details: Option<InputDetails>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputDetails {
    #[serde(default, alias = "cached_tokens")]
    cached_tokens: Option<u64>,
}

impl ApiUsage {
    fn into_units(self) -> Units {
        Units {
            polish_input_tokens: self.input_tokens.unwrap_or(0),
            polish_cached_tokens: self
                .input_tokens_details
                .and_then(|d| d.cached_tokens)
                .unwrap_or(0),
            polish_output_tokens: self.output_tokens.unwrap_or(0),
            ..Default::default()
        }
    }
}

/// Apply the deterministic rules for [`Style::Literal`].
///
/// Dictation arrives sentence-cased and full-stopped, which is wrong almost
/// everywhere a shell prompt is.
pub fn apply_literal(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let without_stop = strip_trailing_stop(trimmed);
    lowercase_sentence_capital(without_stop)
}

/// Drop a full stop that is attached to the last word.
///
/// A period preceded by a space is left alone: `ls -la .` means the current
/// directory, and removing it would break the command.
fn strip_trailing_stop(text: &str) -> &str {
    let Some(without) = text.strip_suffix('.') else {
        return text;
    };

    match without.chars().last() {
        // " ." — an argument, not punctuation.
        Some(last) if last.is_whitespace() => text,
        // "foo.." or an ellipsis — leave it be.
        Some('.') => text,
        Some(_) => without,
        None => text,
    }
}

/// Lower-case a leading sentence capital, but leave acronyms and CamelCase.
///
/// "Git status" is dictation artefact and becomes "git status". "AWS configure"
/// and "GitHub clone" are the words the user meant.
fn lowercase_sentence_capital(text: &str) -> String {
    let first_word = text.split_whitespace().next().unwrap_or_default();
    let mut chars = first_word.chars();

    let Some(first) = chars.next() else {
        return text.to_string();
    };
    if !first.is_uppercase() {
        return text.to_string();
    }
    // Any further capital means it is a name, not sentence casing.
    if chars.any(char::is_uppercase) {
        return text.to_string();
    }

    let mut out = String::with_capacity(text.len());
    out.extend(first.to_lowercase());
    out.push_str(&text[first.len_utf8()..]);
    out
}

pub struct OpenAiPolisher {
    client: reqwest::blocking::Client,
    api_key: String,
    endpoint: String,
    model: String,
}

impl OpenAiPolisher {
    pub fn new(api_key: impl Into<String>) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            // Shorter than transcription: this is a small rewrite, and the user
            // is already waiting with text that is good enough without it.
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .context("could not build the HTTP client")?;

        Ok(Self {
            client,
            api_key: api_key.into(),
            endpoint: DEFAULT_ENDPOINT.to_string(),
            model: DEFAULT_MODEL.to_string(),
        })
    }

    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }
}

impl Polisher for OpenAiPolisher {
    fn polish(&self, text: &str, style: &Style) -> Result<Polished> {
        let Some(instructions) = style.instruction() else {
            // Applied on this Mac: nothing was billed.
            return Ok(Polished {
                text: apply_literal(text),
                units: Units::default(),
            });
        };

        let body = serde_json::json!({
            "model": self.model,
            // A formatting rewrite wants speed, not deliberation.
            "reasoning": { "effort": "low" },
            "instructions": instructions,
            "input": text,
        });

        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .context("could not reach the formatting API")?;

        let status = response.status();
        let raw = response.text().unwrap_or_default();

        if !status.is_success() {
            anyhow::bail!("formatting failed ({status})");
        }

        let value: serde_json::Value =
            serde_json::from_str(&raw).context("could not parse the formatting response")?;

        let polished = extract_text(&value).unwrap_or_default();
        let units = serde_json::from_value::<ApiUsage>(value.get("usage").cloned().unwrap_or_default())
            .unwrap_or_default()
            .into_units();

        Ok(Polished {
            text: guard(text, polished),
            units,
        })
    }
}

/// Pull the text out of a Responses API body.
///
/// The documented shape is `output[].content[].text`; `output_text` is accepted
/// too because some SDK-shaped bodies include it.
fn extract_text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.get("output_text").and_then(|v| v.as_str()) {
        return Some(text.trim().to_string());
    }

    let mut collected = String::new();

    for item in value.get("output")?.as_array()? {
        let Some(content) = item.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        for part in content {
            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                collected.push_str(text);
            }
        }
    }

    let collected = collected.trim().to_string();
    (!collected.is_empty()).then_some(collected)
}

/// Keep the original when the rewrite looks wrong.
///
/// The transcript is already correct; formatting is a nicety. Pasting an empty
/// or runaway result would turn a working dictation into a broken one.
fn guard(original: &str, polished: String) -> String {
    if polished.is_empty() {
        tracing::warn!("formatting returned nothing; keeping the transcript");
        return original.to_string();
    }

    if polished.len() as f32 > original.len() as f32 * MAX_GROWTH {
        tracing::warn!(
            original = original.len(),
            polished = polished.len(),
            "formatting grew implausibly; keeping the transcript"
        );
        return original.to_string();
    }

    polished
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn literal_drops_a_trailing_full_stop() {
        assert_eq!(apply_literal("git status."), "git status");
        assert_eq!(apply_literal("cargo test --lib."), "cargo test --lib");
    }

    #[test]
    fn literal_keeps_a_period_that_is_an_argument() {
        // `ls -la .` means the current directory; stripping it breaks the command.
        assert_eq!(apply_literal("ls -la ."), "ls -la .");
        assert_eq!(apply_literal("cp file.txt ."), "cp file.txt .");
    }

    #[test]
    fn literal_leaves_ellipsis_and_inner_dots_alone() {
        assert_eq!(apply_literal("wait for it.."), "wait for it..");
        assert_eq!(apply_literal("cat file.txt"), "cat file.txt");
    }

    #[test]
    fn literal_lowercases_a_dictation_capital() {
        assert_eq!(apply_literal("Git status"), "git status");
        assert_eq!(apply_literal("Show me the logs"), "show me the logs");
    }

    #[test]
    fn literal_leaves_acronyms_and_camel_case_intact() {
        // These are the words the user meant, not sentence casing.
        assert_eq!(apply_literal("AWS configure"), "AWS configure");
        assert_eq!(apply_literal("GitHub clone the repo"), "GitHub clone the repo");
        assert_eq!(apply_literal("npm install"), "npm install");
    }

    #[test]
    fn literal_handles_empty_and_whitespace_input() {
        assert_eq!(apply_literal(""), "");
        assert_eq!(apply_literal("   "), "");
        assert_eq!(apply_literal("  git status.  "), "git status");
    }

    #[test]
    fn literal_is_safe_on_non_ascii() {
        assert_eq!(apply_literal("École ouverte."), "école ouverte");
        assert_eq!(apply_literal("日本語"), "日本語");
    }

    #[test]
    fn only_literal_avoids_a_model_call() {
        assert!(!Style::Literal.needs_model());
        assert!(Style::Terse.needs_model());
        assert!(Style::Formal.needs_model());
        assert!(Style::Custom("shout".into()).needs_model());
    }

    #[test]
    fn instructions_forbid_inventing_content() {
        let instruction = Style::Terse.instruction().unwrap();
        assert!(instruction.contains("never add information"));
        assert!(instruction.contains("Return only"));
        assert!(Style::Literal.instruction().is_none());
    }

    #[test]
    fn a_custom_instruction_reaches_the_model() {
        let instruction = Style::Custom("Write in British English".into())
            .instruction()
            .unwrap();
        assert!(instruction.contains("Write in British English"));
    }

    #[test]
    fn styles_round_trip_through_settings_json() {
        for style in [
            Style::Literal,
            Style::Terse,
            Style::Formal,
            Style::Custom("be nice".into()),
        ] {
            let json = serde_json::to_string(&style).unwrap();
            assert_eq!(serde_json::from_str::<Style>(&json).unwrap(), style);
        }

        assert_eq!(
            serde_json::to_value(Style::Literal).unwrap(),
            serde_json::json!({ "kind": "literal" })
        );
        assert_eq!(
            serde_json::to_value(Style::Custom("x".into())).unwrap(),
            serde_json::json!({ "kind": "custom", "value": "x" })
        );
    }

    #[test]
    fn text_is_extracted_from_the_documented_shape() {
        let body = serde_json::json!({
            "output": [{
                "type": "message",
                "content": [{ "type": "output_text", "text": "  ship it  " }]
            }]
        });
        assert_eq!(extract_text(&body).as_deref(), Some("ship it"));
    }

    #[test]
    fn text_extraction_accepts_the_convenience_field() {
        let body = serde_json::json!({ "output_text": "ship it" });
        assert_eq!(extract_text(&body).as_deref(), Some("ship it"));
    }

    #[test]
    fn text_extraction_skips_non_text_parts() {
        let body = serde_json::json!({
            "output": [
                { "type": "reasoning", "summary": [] },
                { "type": "message", "content": [{ "type": "output_text", "text": "kept" }] }
            ]
        });
        assert_eq!(extract_text(&body).as_deref(), Some("kept"));
    }

    #[test]
    fn text_extraction_returns_none_for_an_empty_body() {
        assert_eq!(extract_text(&serde_json::json!({})), None);
        assert_eq!(
            extract_text(&serde_json::json!({ "output": [] })),
            None
        );
    }

    #[test]
    fn the_transcript_wins_when_the_rewrite_is_empty() {
        assert_eq!(guard("original text", String::new()), "original text");
    }

    #[test]
    fn the_transcript_wins_when_the_rewrite_runs_away() {
        // A model that starts explaining itself must not replace the dictation.
        let runaway = "explanation ".repeat(50);
        assert_eq!(guard("short", runaway), "short");
    }

    #[test]
    fn a_reasonable_rewrite_is_kept() {
        assert_eq!(guard("i think we should ship", "Ship it.".into()), "Ship it.");
    }

    #[tokio::test]
    async fn a_model_style_sends_instructions_and_returns_the_rewrite() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "output": [{
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "Ship it Wednesday." }]
                }],
                "usage": {
                    "input_tokens": 210,
                    "output_tokens": 42,
                    "input_tokens_details": { "cached_tokens": 64 }
                }
            })))
            .mount(&server)
            .await;

        let endpoint = format!("{}/v1/responses", server.uri());
        let polished = tokio::task::spawn_blocking(move || {
            OpenAiPolisher::new("k")
                .unwrap()
                .with_endpoint(endpoint)
                .polish(
                    "so I think maybe we should ship it on Wednesday",
                    &Style::Terse,
                )
        })
        .await
        .unwrap()
        .unwrap();

        assert_eq!(polished.text, "Ship it Wednesday.");
        assert_eq!(polished.units.polish_input_tokens, 210);
        assert_eq!(polished.units.polish_cached_tokens, 64);
        assert_eq!(polished.units.polish_output_tokens, 42);

        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["model"], DEFAULT_MODEL);
        assert_eq!(body["reasoning"]["effort"], "low");
        assert!(body["instructions"]
            .as_str()
            .unwrap()
            .contains("short and direct"));
        assert_eq!(body["input"], "so I think maybe we should ship it on Wednesday");
    }

    #[tokio::test]
    async fn a_literal_style_never_calls_the_api() {
        let server = MockServer::start().await;
        // No mock mounted: any request would 404 and fail the assertion below.

        let endpoint = format!("{}/v1/responses", server.uri());
        let polished = tokio::task::spawn_blocking(move || {
            OpenAiPolisher::new("k")
                .unwrap()
                .with_endpoint(endpoint)
                .polish("Git status.", &Style::Literal)
        })
        .await
        .unwrap()
        .unwrap();

        assert_eq!(polished.text, "git status");
        assert!(
            polished.units.is_empty(),
            "a local style bills nothing: {:?}",
            polished.units
        );
        assert!(
            server.received_requests().await.unwrap().is_empty(),
            "Literal must be handled locally"
        );
    }
}
