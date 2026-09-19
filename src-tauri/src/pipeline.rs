//! The dictation loop: hold → record → transcribe → insert.
//!
//! Runs on its own thread, driven by trigger events. Everything here is
//! sequential and blocking by design — one dictation happens at a time, and the
//! simplicity is worth more than concurrency we would never use.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use parking_lot::Mutex;
use zeroize::Zeroize;

use crate::audio::{AudioEngine, Clip};
use crate::frontmost::{frontmost_app, TargetApp};
use crate::history::History;
use crate::inject::{self, PASTE_SETTLE_DELAY};
use crate::hosted::{HostedPolisher, HostedTranscriber};
use crate::polish::{OpenAiPolisher, Polisher};
use crate::session;
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
    /// Recording discarded, or transcription abandoned. Nothing was pasted.
    Cancelled,
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
    /// Set as soon as the user cancels, so the transcribe worker will not paste
    /// even if the pipeline thread has not yet drained the Cancel event.
    cancelled: AtomicBool,
    /// True only while Recording or Transcribing — Escape is a no-op otherwise.
    escape_arm: crate::escape::Arm,
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
            cancelled: AtomicBool::new(false),
            escape_arm: crate::escape::new_arm(),
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

    pub fn escape_arm(&self) -> crate::escape::Arm {
        Arc::clone(&self.escape_arm)
    }

    /// Latch cancel immediately. The matching [`TriggerEvent::Cancel`] still
    /// has to arrive so the event loop can discard audio or drop the worker.
    pub fn mark_cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn announce(&self, status: Status) {
        let live = matches!(status, Status::Recording | Status::Transcribing);
        self.escape_arm.store(live, Ordering::SeqCst);
        self.sink.publish(status);
    }

    /// Consume trigger events until the channel closes. Blocks; call on its own thread.
    pub fn run(self: &Arc<Self>, events: Receiver<TriggerEvent>) {
        // Tracks our own view of the state. The audio engine ignores repeated
        // starts on its own, but key-repeat would otherwise re-capture the
        // target app many times per press.
        let mut recording = false;
        let mut work: Option<Receiver<Result<Option<String>, String>>> = None;

        loop {
            if work.is_some() {
                self.pump_transcribe(&events, &mut work);
                continue;
            }

            match events.recv() {
                Ok(TriggerEvent::Start) if !recording => {
                    self.cancelled.store(false, Ordering::SeqCst);
                    recording = true;
                    self.begin();
                }
                Ok(TriggerEvent::Start) => {}
                Ok(TriggerEvent::Stop) if recording => {
                    recording = false;
                    work = self.begin_transcribe();
                }
                Ok(TriggerEvent::Stop) => {}
                Ok(TriggerEvent::Cancel) if recording => {
                    recording = false;
                    self.abort_recording();
                }
                Ok(TriggerEvent::Cancel) => {
                    // Idle: Escape and the overlay button must not flash Cancelled.
                }
                Err(_) => return,
            }
        }
    }

    /// Prefer Cancel over completion so a late cancel still wins the race.
    fn pump_transcribe(
        &self,
        events: &Receiver<TriggerEvent>,
        work: &mut Option<Receiver<Result<Option<String>, String>>>,
    ) {
        match events.try_recv() {
            Ok(TriggerEvent::Cancel) => {
                self.cancelled.store(true, Ordering::SeqCst);
                self.announce_cancelled();
                *work = None;
                return;
            }
            Ok(_) => {}
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                *work = None;
                return;
            }
        }

        let Some(rx) = work.as_ref() else {
            return;
        };

        match rx.try_recv() {
            Ok(outcome) => {
                *work = None;
                self.settle_transcribe(outcome);
                return;
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                *work = None;
                self.fail("transcription stopped unexpectedly".into());
                return;
            }
        }

        match events.recv_timeout(Duration::from_millis(25)) {
            Ok(TriggerEvent::Cancel) => {
                self.cancelled.store(true, Ordering::SeqCst);
                self.announce_cancelled();
                *work = None;
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                *work = None;
            }
        }
    }

    fn announce_cancelled(&self) {
        self.recording.store(false, Ordering::Relaxed);
        self.announce(Status::Cancelled);
    }

    fn abort_recording(&self) {
        self.recording.store(false, Ordering::Relaxed);
        match self.engine.stop() {
            Ok(mut clip) => clip.samples.zeroize(),
            Err(err) => tracing::debug!("nothing to discard: {err:#}"),
        }
        self.announce(Status::Cancelled);
    }

    fn begin_transcribe(self: &Arc<Self>) -> Option<Receiver<Result<Option<String>, String>>> {
        let started = Instant::now();
        self.recording.store(false, Ordering::Relaxed);

        let clip = match self.engine.stop() {
            Ok(clip) => clip,
            Err(err) => {
                tracing::error!("could not stop recording: {err:#}");
                self.fail(format!("Recording failed: {err}"));
                return None;
            }
        };

        let duration = clip.duration_secs();
        self.announce(Status::Transcribing);

        let (tx, rx) = mpsc::channel();
        let me = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("telekey-transcribe".into())
            .spawn(move || {
                let result = me
                    .transcribe_and_insert(clip)
                    .map_err(|err| format!("{err:#}"));
                if let Ok(Some(text)) = &result {
                    tracing::info!(
                        audio_secs = duration,
                        total_ms = started.elapsed().as_millis() as u64,
                        chars = text.len(),
                        "dictation complete"
                    );
                }
                let _ = tx.send(result);
            });

        if let Err(err) = spawned {
            self.fail(format!("Could not transcribe: {err}"));
            return None;
        }

        Some(rx)
    }

    fn settle_transcribe(&self, outcome: Result<Option<String>, String>) {
        if self.cancelled.load(Ordering::SeqCst) {
            self.announce_cancelled();
            return;
        }

        match outcome {
            Ok(Some(text)) => {
                self.remember(&text);
                self.announce(Status::Inserted { text });
            }
            Ok(None) => self.announce_cancelled(),
            Err(message) => {
                tracing::error!("dictation failed: {message}");
                self.fail(message);
            }
        }
    }

    fn begin(&self) {
        // Capture the target app before anything else can steal focus.
        let target = frontmost_app();
        tracing::info!(target = target.profile_key(), "dictation started");
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
        self.announce(Status::Recording);
    }

    fn transcribe_and_insert(&self, mut clip: Clip) -> Result<Option<String>> {
        let transcriber = self.transcriber()?;
        let context = self.context();

        let upload_started = Instant::now();
        if self.cancelled.load(Ordering::SeqCst) {
            clip.samples.zeroize();
            return Ok(None);
        }

        let result = transcriber.transcribe(&clip, &context);

        // The audio has served its purpose; wipe it whether or not the call
        // worked. It was never written to disk, so this is the only copy.
        clip.samples.zeroize();

        let transcription = result?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Ok(None);
        }

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

        if self.cancelled.load(Ordering::SeqCst) {
            return Ok(None);
        }

        let text = self.format_for_target(text);

        if self.cancelled.load(Ordering::SeqCst) {
            return Ok(None);
        }

        let insert_started = Instant::now();
        self.insert(&text)?;
        tracing::debug!(
            insert_ms = insert_started.elapsed().as_millis() as u64,
            "text inserted"
        );

        Ok(Some(text))
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

        if session::is_signed_in() {
            let polisher: Arc<dyn Polisher> = Arc::new(HostedPolisher::new()?);
            *cached = Some(Arc::clone(&polisher));
            return Ok(polisher);
        }

        let key = settings::load_api_key()?;
        if let Some(key) = key {
            let polisher: Arc<dyn Polisher> = Arc::new(OpenAiPolisher::new(key)?);
            *cached = Some(Arc::clone(&polisher));
            return Ok(polisher);
        }

        anyhow::bail!("No OpenAI API key set")
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

        // Signed-in credits take precedence. A leftover BYOK key used to hide
        // the hosted path, which made "I signed in" look broken.
        if session::is_signed_in() {
            let transcriber: Arc<dyn Transcriber> = Arc::new(HostedTranscriber::new()?);
            *cached = Some(Arc::clone(&transcriber));
            return Ok(transcriber);
        }

        let key = settings::load_api_key()?;
        if let Some(key) = key {
            let transcriber: Arc<dyn Transcriber> = Arc::new(OpenAiTranscriber::new(key)?);
            *cached = Some(Arc::clone(&transcriber));
            return Ok(transcriber);
        }

        anyhow::bail!("No OpenAI API key set — add one in TeleKey's settings, or sign in")
    }

    fn fail(&self, message: String) {
        self.recording.store(false, Ordering::Relaxed);
        self.announce(Status::Failed { message });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::TARGET_SAMPLE_RATE;

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

    fn inject(pipeline: &Pipeline, transcriber: Arc<dyn Transcriber>) {
        *pipeline.transcriber.lock() = Some(transcriber);
    }

    fn silent_clip() -> Clip {
        Clip {
            samples: vec![0.01; TARGET_SAMPLE_RATE as usize / 5],
        }
    }

    struct ScriptedTranscriber {
        text: String,
        units: Units,
        state: std::sync::Mutex<Gate>,
        cv: std::sync::Condvar,
    }

    #[derive(Default)]
    struct Gate {
        started: bool,
        blocked: bool,
    }

    impl ScriptedTranscriber {
        fn immediate(text: &str, units: Units) -> Arc<Self> {
            Arc::new(Self {
                text: text.into(),
                units,
                state: std::sync::Mutex::new(Gate::default()),
                cv: std::sync::Condvar::new(),
            })
        }

        fn gated(text: &str, units: Units) -> Arc<Self> {
            Arc::new(Self {
                text: text.into(),
                units,
                state: std::sync::Mutex::new(Gate {
                    started: false,
                    blocked: true,
                }),
                cv: std::sync::Condvar::new(),
            })
        }

        fn wait_until_started(&self) {
            let mut gate = self.state.lock().unwrap();
            while !gate.started {
                gate = self.cv.wait(gate).unwrap();
            }
        }

        fn release(&self) {
            let mut gate = self.state.lock().unwrap();
            gate.blocked = false;
            self.cv.notify_all();
        }
    }

    impl Transcriber for ScriptedTranscriber {
        fn transcribe(
            &self,
            _clip: &Clip,
            _context: &TranscriptionContext,
        ) -> Result<crate::transcribe::Transcription> {
            let mut gate = self.state.lock().unwrap();
            gate.started = true;
            self.cv.notify_all();
            while gate.blocked {
                gate = self.cv.wait(gate).unwrap();
            }
            Ok(crate::transcribe::Transcription {
                text: self.text.clone(),
                units: self.units,
            })
        }
    }

    #[test]
    fn cancelled_status_serialises_for_the_overlay() {
        let json = serde_json::to_value(Status::Cancelled).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "cancelled" }));
    }

    #[test]
    fn cancel_before_upload_skips_transcription_and_does_not_meter() {
        let pipeline = Pipeline::new(
            Settings::default(),
            Arc::new(NullSink),
            test_history(),
            test_usage(),
        );
        inject(
            &pipeline,
            ScriptedTranscriber::immediate("should not run", Units::transcription(3)),
        );
        pipeline.mark_cancel();

        let result = pipeline.transcribe_and_insert(silent_clip()).unwrap();
        assert!(result.is_none());
        assert_eq!(pipeline.usage().today().dictations, 0);
    }

    #[test]
    fn cancel_during_upload_does_not_paste_or_meter() {
        let pipeline = Arc::new(Pipeline::new(
            Settings::default(),
            Arc::new(NullSink),
            test_history(),
            test_usage(),
        ));
        let transcriber = ScriptedTranscriber::gated("hello", Units::transcription(3));
        inject(&pipeline, Arc::clone(&transcriber) as Arc<dyn Transcriber>);

        let worker = Arc::clone(&pipeline);
        let handle = std::thread::spawn(move || worker.transcribe_and_insert(silent_clip()));

        transcriber.wait_until_started();
        pipeline.mark_cancel();
        transcriber.release();

        let result = handle.join().unwrap().unwrap();
        assert!(result.is_none());
        assert_eq!(pipeline.usage().today().dictations, 0);
    }

    #[test]
    fn cancel_while_idle_does_not_publish_cancelled() {
        let sink = Arc::new(RecordingSink::default());
        let pipeline = Arc::new(Pipeline::new(
            Settings::default(),
            Arc::clone(&sink) as Arc<dyn StatusSink>,
            test_history(),
            test_usage(),
        ));
        let (tx, rx) = mpsc::channel();
        let worker = Arc::clone(&pipeline);
        let thread = std::thread::spawn(move || worker.run(rx));

        tx.send(TriggerEvent::Cancel).unwrap();
        drop(tx);
        thread.join().unwrap();

        assert!(
            !sink.seen.lock().iter().any(|s| *s == Status::Cancelled),
            "idle cancel leaked a status: {:?}",
            sink.seen.lock()
        );
    }
}
