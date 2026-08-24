//! Speech to text.
//!
//! `gpt-transcribe` is a language model rather than a classic ASR engine, so it
//! punctuates, capitalises and drops filler words on its own. That is why there
//! is no cleanup stage between this module and text injection.
//!
//! Custom vocabulary rides along as `keywords[]` — a native API parameter — so
//! technical terms need no second model to fix up.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use crate::audio::{encode_wav_16bit_mono, Clip, TARGET_SAMPLE_RATE};
use crate::usage::Units;

pub const DEFAULT_MODEL: &str = "gpt-transcribe";
pub const DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";

/// The API rejects anything larger. At 16 kHz mono 16-bit that is ~13 minutes,
/// far beyond a dictation clip, but checking locally gives a better error than
/// a 413 after a long upload.
const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

/// Clips shorter than this are almost always an accidental key tap.
const MIN_CLIP_SECONDS: f32 = 0.20;

/// Per-request hints that improve recognition.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TranscriptionContext {
    /// Literal terms expected in the audio — names, jargon, product names.
    pub keywords: Vec<String>,
    /// Expected input languages, as ISO codes.
    pub languages: Vec<String>,
    /// Free-text context about the recording.
    pub prompt: Option<String>,
}

/// A transcript, plus what the API says it billed for producing it.
#[derive(Debug, Clone, PartialEq)]
pub struct Transcription {
    pub text: String,
    /// Empty when the response carried no `usage` object — the transcript is
    /// still good, so a missing figure must not fail the dictation.
    pub units: Units,
}

/// The seam that lets a local engine be dropped in later without the pipeline
/// noticing.
pub trait Transcriber: Send + Sync {
    fn transcribe(&self, clip: &Clip, context: &TranscriptionContext) -> Result<Transcription>;
}

pub struct OpenAiTranscriber {
    client: reqwest::blocking::Client,
    api_key: String,
    endpoint: String,
    model: String,
}

impl OpenAiTranscriber {
    pub fn new(api_key: impl Into<String>) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .context("could not build the HTTP client")?;

        Ok(Self {
            client,
            api_key: api_key.into(),
            endpoint: DEFAULT_ENDPOINT.to_string(),
            model: DEFAULT_MODEL.to_string(),
        })
    }

    /// Point at a different endpoint. Used by tests to talk to a mock server.
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: String,
    #[serde(default)]
    usage: Option<ApiUsage>,
}

/// The response's `usage` object.
///
/// The API returns one of two shapes — `{ seconds, type: "duration" }` for
/// duration-billed models, `{ input_tokens, output_tokens, … }` for token-billed
/// ones. Every field is optional rather than switching on `type`, so a new shape
/// degrades to a missing figure instead of a parse failure that would throw away
/// a perfectly good transcript.
#[derive(Debug, Default, Deserialize)]
struct ApiUsage {
    #[serde(default)]
    seconds: Option<f64>,
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
}

impl ApiUsage {
    fn into_units(self) -> Units {
        Units {
            dictations: 1,
            // Transcription bills to the nearest second.
            transcribe_seconds: self.seconds.unwrap_or(0.0).round().max(0.0) as u64,
            transcribe_tokens: self.input_tokens.unwrap_or(0) + self.output_tokens.unwrap_or(0),
            ..Default::default()
        }
    }
}

impl Transcriber for OpenAiTranscriber {
    fn transcribe(&self, clip: &Clip, context: &TranscriptionContext) -> Result<Transcription> {
        if clip.is_empty() {
            bail!("nothing was recorded");
        }
        if clip.duration_secs() < MIN_CLIP_SECONDS {
            bail!("recording too short ({:.2}s)", clip.duration_secs());
        }

        let wav = encode_wav_16bit_mono(&clip.samples, TARGET_SAMPLE_RATE);
        if wav.len() > MAX_UPLOAD_BYTES {
            bail!(
                "recording is {:.1} MB, over the {} MB limit",
                wav.len() as f64 / (1024.0 * 1024.0),
                MAX_UPLOAD_BYTES / (1024 * 1024)
            );
        }

        let file = reqwest::blocking::multipart::Part::bytes(wav)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .context("could not build the audio upload part")?;

        let mut form = reqwest::blocking::multipart::Form::new()
            .text("model", self.model.clone())
            .part("file", file);

        // Repeated form fields, matching the API's `keywords[]` / `languages[]`.
        for keyword in &context.keywords {
            form = form.text("keywords[]", keyword.clone());
        }
        for language in &context.languages {
            form = form.text("languages[]", language.clone());
        }
        if let Some(prompt) = &context.prompt {
            form = form.text("prompt", prompt.clone());
        }

        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .context("could not reach the transcription API")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(describe_failure(status, &body));
        }

        let parsed: TranscriptionResponse = response
            .json()
            .context("could not parse the transcription response")?;

        let units = parsed
            .usage
            .map(ApiUsage::into_units)
            // No usage object still counts as one dictation; only the billing
            // figures are unknown.
            .unwrap_or(Units {
                dictations: 1,
                ..Default::default()
            });

        Ok(Transcription {
            text: parsed.text.trim().to_string(),
            units,
        })
    }
}

/// Turn an HTTP failure into something worth showing a user.
fn describe_failure(status: reqwest::StatusCode, body: &str) -> anyhow::Error {
    let detail = extract_api_message(body).unwrap_or_else(|| body.trim().to_string());

    match status.as_u16() {
        401 => anyhow!("API key rejected — check it in Settings"),
        429 => anyhow!("rate limited or out of credit: {detail}"),
        413 => anyhow!("recording was too large for the API"),
        500..=599 => anyhow!("OpenAI is having trouble ({status}): {detail}"),
        _ => anyhow!("transcription failed ({status}): {detail}"),
    }
}

/// OpenAI errors arrive as `{"error": {"message": ...}}`.
fn extract_api_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .get("error")?
        .get("message")?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn speech_like_clip(seconds: f32) -> Clip {
        let count = (TARGET_SAMPLE_RATE as f32 * seconds) as usize;
        Clip {
            samples: (0..count)
                .map(|i| (i as f32 / 40.0).sin() * 0.3)
                .collect(),
        }
    }

    /// The client call is blocking, so it must not run on the runtime thread
    /// driving the mock server.
    async fn run_blocking<T, F>(work: F) -> T
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        tokio::task::spawn_blocking(work).await.unwrap()
    }

    #[tokio::test]
    async fn sends_the_clip_and_returns_the_text() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/audio/transcriptions"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({
                        "text": "  Ship it on Wednesday.  ",
                        "usage": { "seconds": 6.4, "type": "duration" }
                    })),
            )
            .mount(&server)
            .await;

        let endpoint = format!("{}/v1/audio/transcriptions", server.uri());
        let text = run_blocking(move || {
            let transcriber = OpenAiTranscriber::new("test-key")
                .unwrap()
                .with_endpoint(endpoint);
            transcriber.transcribe(&speech_like_clip(1.0), &TranscriptionContext::default())
        })
        .await
        .unwrap();

        assert_eq!(text.text, "Ship it on Wednesday.");
        // 6.4s bills as 6 — the API rounds to the nearest second.
        assert_eq!(text.units.transcribe_seconds, 6);
        assert_eq!(text.units.dictations, 1);
    }

    #[tokio::test]
    async fn sends_keywords_and_languages_as_repeated_fields() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "text": "ok" })),
            )
            .mount(&server)
            .await;

        let endpoint = server.uri();
        run_blocking(move || {
            let transcriber = OpenAiTranscriber::new("k").unwrap().with_endpoint(endpoint);
            transcriber.transcribe(
                &speech_like_clip(1.0),
                &TranscriptionContext {
                    keywords: vec!["Hordanso".into(), "NativeWind".into()],
                    languages: vec!["en".into()],
                    prompt: Some("A standup update.".into()),
                },
            )
        })
        .await
        .unwrap();

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let body = String::from_utf8_lossy(&requests[0].body);

        assert!(body.contains("name=\"model\""), "model field missing");
        assert!(body.contains("gpt-transcribe"), "model name missing");
        assert!(body.contains("name=\"keywords[]\""), "keywords missing");
        assert!(body.contains("Hordanso"), "first keyword missing");
        assert!(body.contains("NativeWind"), "second keyword missing");
        assert!(body.contains("name=\"languages[]\""), "languages missing");
        assert!(body.contains("name=\"prompt\""), "prompt missing");
        assert!(body.contains("filename=\"audio.wav\""), "file part missing");
        assert!(body.contains("RIFF"), "wav payload missing");
    }

    #[tokio::test]
    async fn a_bad_key_says_so_plainly() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "message": "Incorrect API key provided" }
            })))
            .mount(&server)
            .await;

        let endpoint = server.uri();
        let err = run_blocking(move || {
            let transcriber = OpenAiTranscriber::new("bad").unwrap().with_endpoint(endpoint);
            transcriber.transcribe(&speech_like_clip(1.0), &TranscriptionContext::default())
        })
        .await
        .unwrap_err();

        assert!(
            err.to_string().contains("API key rejected"),
            "unhelpful message: {err}"
        );
    }

    #[tokio::test]
    async fn server_errors_surface_the_api_message() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
                "error": { "message": "upstream exploded" }
            })))
            .mount(&server)
            .await;

        let endpoint = server.uri();
        let err = run_blocking(move || {
            let transcriber = OpenAiTranscriber::new("k").unwrap().with_endpoint(endpoint);
            transcriber.transcribe(&speech_like_clip(1.0), &TranscriptionContext::default())
        })
        .await
        .unwrap_err();

        assert!(err.to_string().contains("upstream exploded"), "got: {err}");
    }

    #[test]
    fn empty_and_tiny_clips_are_rejected_before_upload() {
        let transcriber = OpenAiTranscriber::new("k")
            .unwrap()
            .with_endpoint("http://127.0.0.1:1/unused");

        let empty = Clip { samples: vec![] };
        let err = transcriber
            .transcribe(&empty, &TranscriptionContext::default())
            .unwrap_err();
        assert!(err.to_string().contains("nothing was recorded"));

        let blip = speech_like_clip(0.05);
        let err = transcriber
            .transcribe(&blip, &TranscriptionContext::default())
            .unwrap_err();
        assert!(err.to_string().contains("too short"), "got: {err}");
    }

    #[test]
    fn both_documented_usage_shapes_parse() {
        // Duration-billed models report seconds; token-billed ones report
        // tokens. Neither may be dropped, and neither may fail the parse.
        let duration: ApiUsage =
            serde_json::from_value(serde_json::json!({ "seconds": 12.6, "type": "duration" }))
                .unwrap();
        let units = duration.into_units();
        assert_eq!(units.transcribe_seconds, 13, "rounds to the nearest second");
        assert_eq!(units.transcribe_tokens, 0);

        let tokens: ApiUsage = serde_json::from_value(serde_json::json!({
            "input_tokens": 300, "output_tokens": 40, "total_tokens": 340, "type": "tokens"
        }))
        .unwrap();
        let units = tokens.into_units();
        assert_eq!(units.transcribe_tokens, 340);
        assert_eq!(units.transcribe_seconds, 0);
    }

    #[test]
    fn an_unknown_usage_shape_still_counts_the_dictation() {
        let odd: ApiUsage = serde_json::from_value(serde_json::json!({ "widgets": 3 })).unwrap();
        let units = odd.into_units();
        assert_eq!(units.dictations, 1, "the dictation happened regardless");
        assert_eq!(units.transcribe_seconds, 0);
    }

    #[test]
    fn a_response_without_usage_still_returns_the_text() {
        // Older or unusual responses omit `usage`; losing a billing figure must
        // never cost the user their transcript.
        let parsed: TranscriptionResponse =
            serde_json::from_value(serde_json::json!({ "text": "hello" })).unwrap();
        assert!(parsed.usage.is_none());
        assert_eq!(parsed.text, "hello");
    }

    #[test]
    fn api_error_messages_are_extracted() {
        let body = r#"{"error":{"message":"nope","type":"invalid_request_error"}}"#;
        assert_eq!(extract_api_message(body).as_deref(), Some("nope"));
        assert_eq!(extract_api_message("not json"), None);
        assert_eq!(extract_api_message("{}"), None);
    }
}
