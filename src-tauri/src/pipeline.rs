//! The dictation loop: hold → record → transcribe → insert.
//!
//! Runs on its own thread, driven by trigger events. Everything here is
//! sequential and blocking by design — one dictation happens at a time, and the
//! simplicity is worth more than concurrency we would never use.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use zeroize::Zeroize;

use crate::audio::{AudioEngine, Clip};
use crate::frontmost::{frontmost_app, TargetApp};
use crate::history::History;
use crate::inject::{self, PASTE_SETTLE_DELAY};
use crate::polish::{OpenAiPolisher, Polisher};
use crate::usage::{Units, Usage};
use crate::settings::{self, Settings};
use crate::transcribe::{OpenAiTranscriber, TranscriptionContext, Transcriber};
use crate::trigger::TriggerEvent;

/// What the pipeline is doing, for the overlay to render.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Status {
    Idle,
    Recording,
    Transcribing,
    Inserted { text: String },
    Failed { message: String },
}

/// Anything that wants to know what the pipeline is doing — in the app, the
/// Tauri event bridge; in tests, a recorder.
pub trait StatusSink: Send + Sync {
    fn publish(&self, status: Status);
}

/// Discards status updates. Useful before any window exists.
pub struct NullSink;

impl StatusSink for NullSink {
    fn publish(&self, _status: Status) {}
}

pub struct Pipeline {
    engine: AudioEngine,
    settings: Mutex<Settings>,
    target: Mutex<TargetApp>,
    transcriber: Mutex<Option<Arc<dyn Transcriber>>>,
    polisher: Mutex<Option<Arc<dyn Polisher>>>,
    sink: Arc<dyn StatusSink>,
    history: Arc<History>,
    usage: Arc<Usage>,
    /// Read by the level ticker so it only emits while there is audio to show.
    recording: AtomicBool,
}

impl Pipeline {
    pub fn new(
        settings: Settings,
        sink: Arc<dyn StatusSink>,
        history: Arc<History>,
        usage: Arc<Usage>,
    ) -> Self {
        Self {
            engine: AudioEngine::spawn(),
            settings: Mutex::new(settings),
            target: Mutex::new(TargetApp::default()),
            transcriber: Mutex::new(None),
            polisher: Mutex::new(None),
            sink,
            history,
            usage,
            recording: AtomicBool::new(false),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().clone()
    }

    pub fn update_settings(&self, settings: Settings) {
        let limit = settings.history_limit;
        let keeping = settings.history_enabled;
        *self.settings.lock() = settings;

        // Turning history off, or lowering the cap, must take effect now rather
        // than at the next dictation — the user may have just decided the
        // existing entries should not be there.
        let outcome = if keeping {
            self.history.enforce_limit(limit)
        } else {
            self.history.clear()
        };
        if let Err(err) = outcome {
            tracing::warn!("could not apply the history limit: {err:#}");
        }
    }

    pub fn history(&self) -> &Arc<History> {
        &self.history
    }

    pub fn usage(&self) -> &Arc<Usage> {
        &self.usage
    }

    /// Record billing units. Never fatal: the text is already inserted, so a
    /// bookkeeping failure must not read as a failed dictation.
    fn meter(&self, units: &Units) {
        if units.is_empty() {
            return;
        }
        if let Err(err) = self.usage.record(units) {
            tracing::warn!("could not record usage: {err:#}");
        }
    }

    /// Drop the cached clients so the next dictation picks up a new API key.
    pub fn invalidate_transcriber(&self) {
        *self.transcriber.lock() = None;
        *self.polisher.lock() = None;
    }

    /// Current input level, for the level meter.
    pub fn level(&self) -> f32 {
        self.engine.level()
    }

    /// Initialise the audio device up front.
    ///
    /// The first stream a process opens costs ~2s; without this the user's
    /// first dictation after launch loses its opening words.
    pub fn warmup(&self) {
        self.engine.warmup();
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::Relaxed)
    }

    /// Consume trigger events until the channel closes. Blocks; call on its own thread.
    pub fn run(&self, events: Receiver<TriggerEvent>) {
        // Tracks our own view of the state. The audio engine ignores repeated
        // starts on its own, but key-repeat would otherwise re-capture the
        // target app many times per press.
        let mut recording = false;

        for event in events {
            match event {
                TriggerEvent::Start if !recording => {
                    recording = true;
                    self.begin();
                }
                TriggerEvent::Start => {}
                TriggerEvent::Stop if recording => {
                    recording = false;
                    self.finish();
                }
                TriggerEvent::Stop => {}
            }
        }
    }

    fn begin(&self) {
        // Capture the target app before anything else can steal focus.
        let target = frontmost_app();
        tracing::debug!(target = target.profile_key(), "dictation started");
        *self.target.lock() = target;

        // Blocks until the stream is actually live. Announcing "recording"
        // before that point is what made the user speak into a microphone that
        // was not yet open.
        if let Err(err) = self.engine.start() {
            tracing::error!("could not start recording: {err:#}");
            self.fail(format!("Could not start recording: {err}"));
            return;
        }

        self.recording.store(true, Ordering::Relaxed);
        self.sink.publish(Status::Recording);
    }

    fn finish(&self) {
        let started = Instant::now();
        self.recording.store(false, Ordering::Relaxed);

        let clip = match self.engine.stop() {
            Ok(clip) => clip,
            Err(err) => {
                tracing::error!("could not stop recording: {err:#}");
                self.fail(format!("Recording failed: {err}"));
                return;
            }
        };

        let duration = clip.duration_secs();
        self.sink.publish(Status::Transcribing);

        match self.transcribe_and_insert(clip) {
            Ok(text) => {
                tracing::info!(
                    audio_secs = duration,
                    total_ms = started.elapsed().as_millis() as u64,
                    chars = text.len(),
                    "dictation complete"
                );
                self.remember(&text);
                self.sink.publish(Status::Inserted { text });
            }
            Err(err) => {
                tracing::error!("dictation failed: {err:#}");
                self.fail(format!("{err:#}"));
            }
        }
    }

    fn transcribe_and_insert(&self, mut clip: Clip) -> Result<String> {
        let transcriber = self.transcriber()?;
        let context = self.context();

        let upload_started = Instant::now();
        let result = transcriber.transcribe(&clip, &context);

        // The audio has served its purpose; wipe it whether or not the call
        // worked. It was never written to disk, so this is the only copy.
        clip.samples.zeroize();

        let transcription = result?;
        tracing::debug!(
            api_ms = upload_started.elapsed().as_millis() as u64,
            billed_seconds = transcription.units.transcribe_seconds,
            "transcription returned"
        );
        self.meter(&transcription.units);

        let text = transcription.text;
        if text.is_empty() {
            anyhow::bail!("nothing was transcribed — try speaking a little longer");
        }

        let text = self.format_for_target(text);

        let insert_started = Instant::now();
        self.insert(&text)?;
        tracing::debug!(
            insert_ms = insert_started.elapsed().as_millis() as u64,
            "text inserted"
        );

        Ok(text)
    }

    /// Apply the target app's formatting profile, if it has one.
    ///
    /// Never fails the dictation: the transcript is already correct, so a
    /// formatting problem falls back to it rather than losing the user's words.
    fn format_for_target(&self, text: String) -> String {
        let style = {
            let settings = self.settings.lock();
            if !settings.polish_enabled {
                return text;
            }
            let key = self.target.lock().profile_key().to_string();
            match settings.profile_for(&key) {
                Some(profile) => profile.style.clone(),
                None => return text,
            }
        };

        // Deterministic styles need no client, and so work offline and instantly.
        if !style.needs_model() {
            return crate::polish::apply_literal(&text);
        }

        let started = Instant::now();
        match self.polisher().and_then(|p| p.polish(&text, &style)) {
            Ok(formatted) => {
                tracing::debug!(
                    polish_ms = started.elapsed().as_millis() as u64,
                    "formatting applied"
                );
                self.meter(&formatted.units);
                formatted.text
            }
            Err(err) => {
                tracing::warn!("formatting failed, keeping the transcript: {err:#}");
                text
            }
        }
    }

    fn polisher(&self) -> Result<Arc<dyn Polisher>> {
        let mut cached = self.polisher.lock();
        if let Some(existing) = cached.as_ref() {
            return Ok(Arc::clone(existing));
        }

        let key = settings::load_api_key()?.context("No OpenAI API key set")?;
        let polisher: Arc<dyn Polisher> = Arc::new(OpenAiPolisher::new(key)?);
        *cached = Some(Arc::clone(&polisher));
        Ok(polisher)
    }

    /// Append to history, if the user keeps it. Never fatal: the text is
    /// already in their document, so a failure here must not read as a failed
    /// dictation.
    fn remember(&self, text: &str) {
        let (enabled, limit) = {
            let settings = self.settings.lock();
            (settings.history_enabled, settings.history_limit)
        };
        if !enabled {
            return;
        }

        let app = self.target.lock().name.clone();
        if let Err(err) = self.history.record(text, app, limit) {
            tracing::warn!("could not record history: {err:#}");
        }
    }

    fn insert(&self, text: &str) -> Result<()> {
        if !inject::accessibility_granted() {
            // Kept short enough to survive the overlay's two-line clamp: an
            // error that truncates its own fix is worse than no error.
            anyhow::bail!("Needs Accessibility permission — grant it in System Settings");
        }

        // Built per dictation: these hold OS input/pasteboard connections that
        // are not worth keeping open while idle.
        let mut clipboard = inject::SystemClipboard::new()?;
        let mut keys = inject::SystemKeystroke::new()?;

        inject::paste_via_clipboard(&mut clipboard, &mut keys, text, PASTE_SETTLE_DELAY)
    }

    fn context(&self) -> TranscriptionContext {
        let settings = self.settings.lock();
        TranscriptionContext {
            keywords: settings.keywords(),
            languages: settings.languages.clone(),
            prompt: None,
        }
    }

    /// The API client, built on first use and cached until the key changes.
    fn transcriber(&self) -> Result<Arc<dyn Transcriber>> {
        let mut cached = self.transcriber.lock();

        if let Some(existing) = cached.as_ref() {
            return Ok(Arc::clone(existing));
        }

        let key = settings::load_api_key()?
            .context("No OpenAI API key set — add one in Flowtype's settings")?;

        let transcriber: Arc<dyn Transcriber> = Arc::new(OpenAiTranscriber::new(key)?);
        *cached = Some(Arc::clone(&transcriber));
        Ok(transcriber)
    }

    fn fail(&self, message: String) {
        self.recording.store(false, Ordering::Relaxed);
        self.sink.publish(Status::Failed { message });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_usage() -> Arc<Usage> {
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        Arc::new(Usage::load(dir.path()))
    }

    fn test_history() -> Arc<History> {
        // Leaks a temp dir for the duration of the test process, which is fine
        // for a handful of unit tests and keeps the helper a one-liner.
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        Arc::new(History::load(dir.path()))
    }

    #[derive(Default)]
    struct RecordingSink {
        seen: Mutex<Vec<Status>>,
    }

    impl StatusSink for RecordingSink {
        fn publish(&self, status: Status) {
            self.seen.lock().push(status);
        }
    }

    #[test]
    fn status_serialises_with_a_discriminant_the_ui_can_switch_on() {
        let json = serde_json::to_value(Status::Recording).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "recording" }));

        let json = serde_json::to_value(Status::Inserted {
            text: "hello".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "inserted", "text": "hello" })
        );
    }

    #[test]
    fn a_sink_receives_what_is_published() {
        let sink = Arc::new(RecordingSink::default());
        sink.publish(Status::Recording);
        sink.publish(Status::Idle);
        assert_eq!(
            *sink.seen.lock(),
            vec![Status::Recording, Status::Idle]
        );
    }

    #[test]
    fn the_null_sink_swallows_everything() {
        NullSink.publish(Status::Recording);
    }

    #[test]
    fn context_is_built_from_settings() {
        let settings = Settings {
            vocabulary: vec!["Hordanso".into(), "  hordanso ".into()],
            languages: vec!["en".into(), "fr".into()],
            ..Default::default()
        };

        let pipeline = Pipeline::new(settings, Arc::new(NullSink), test_history(), test_usage());
        let context = pipeline.context();

        assert_eq!(context.keywords, vec!["Hordanso".to_string()]);
        assert_eq!(
            context.languages,
            vec!["en".to_string(), "fr".to_string()]
        );
        assert!(context.prompt.is_none());
    }

    #[test]
    fn updating_settings_changes_the_next_context() {
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());
        assert!(pipeline.context().keywords.is_empty());

        pipeline.update_settings(Settings {
            vocabulary: vec!["Zustand".into()],
            ..Default::default()
        });

        assert_eq!(pipeline.context().keywords, vec!["Zustand".to_string()]);
    }
}
