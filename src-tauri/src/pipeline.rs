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
use crate::context::{self as screen_context, ContextSlot};
use crate::live::{LiveSession, Route, Streamed};
use crate::polish::Style;
use crate::smart;
use crate::output_mute::{self, OutputMute};
use crate::permissions::{self, Permission, Platform};
use crate::hosted::{HostedPolisher, HostedTranscriber};
use crate::polish::{OpenAiPolisher, Polisher};
use crate::session;
use crate::usage::{Units, Usage};
use crate::settings::{self, Settings};
use crate::transcribe::{OpenAiTranscriber, Transcription, TranscriptionContext, Transcriber};
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
    /// A short note that is not the state of a dictation — the microphone
    /// changed, or dropped out part-way. The overlay shows it only when no
    /// dictation owns the capsule, and never in place of a result.
    Notice { text: String },
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
    /// Which dictation is current, bumped on every start. A transcribe thread
    /// remembers its own: once the user has cancelled one and started the
    /// next, `cancelled` is cleared for the new one, and without this the old
    /// thread would carry on and paste the words they cancelled into the
    /// middle of the new recording.
    generation: std::sync::atomic::AtomicU64,
    /// True only while Recording or Transcribing — Escape is a no-op otherwise.
    escape_arm: crate::escape::Arm,
    /// Silences whatever is playing for the length of the hold, when the user
    /// has asked for it. A trait so tests need no sound card.
    output: Arc<dyn OutputMute>,
    /// Whether the microphone has been opened once this process. Set by the
    /// launch warmup, or by the first setup poll to see the permission granted.
    warmed: AtomicBool,
    /// Something the audio device reported mid-recording, kept until the
    /// dictation settles so the note appears after the result, not instead
    /// of it.
    device_warning: Mutex<Option<String>>,
    /// Windows' privacy settings said the microphone was off when this
    /// recording started. Not proof, so the recording went ahead; if it comes
    /// back as pure silence, that is the answer, and nothing is uploaded.
    microphone_switched_off: AtomicBool,
    /// The dictation being streamed in Instant mode, from key-down until the
    /// transcribe step collects it (or a cancel drops it).
    live: Mutex<Option<Box<dyn Streamed>>>,
    /// Where Instant streams to, worked out on first use like the clients
    /// below, and forgotten with them when the key or the sign-in changes.
    live_route: Mutex<Option<Route>>,
    /// Instant failed and Standard stood in: worth a word after the result,
    /// since the user is paying for speed they did not get this time.
    instant_note: Mutex<Option<String>>,
    /// Where this dictation's screen context arrives, when "Use what's on
    /// screen" is on. Taken with the dictation it belongs to, so a slow read
    /// can never be used by the next one.
    screen: Mutex<Option<Arc<ContextSlot>>>,
}

/// How long the transcribe step waits for a screen read still in progress.
/// By the time a key comes up the read has normally finished long ago.
const SCREEN_WAIT: Duration = Duration::from_millis(250);

/// Said after a dictation that Instant could not handle, once Standard has.
pub const INSTANT_FELL_BACK: &str = "Instant was unavailable, so this one used Standard";

/// What the user sees when they hold the key before allowing the microphone.
/// The setup window opens alongside it (see `TauriSink`), so "in Setup" is a
/// place they are looking at, not one they have to find.
pub const MICROPHONE_NEEDED: &str = "Allow the microphone in Setup, then hold again";

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
            generation: std::sync::atomic::AtomicU64::new(0),
            escape_arm: crate::escape::new_arm(),
            output: output_mute::for_this_platform(),
            warmed: AtomicBool::new(false),
            device_warning: Mutex::new(None),
            microphone_switched_off: AtomicBool::new(false),
            live: Mutex::new(None),
            live_route: Mutex::new(None),
            instant_note: Mutex::new(None),
            screen: Mutex::new(None),
        }
    }

    /// Swap in another output control. Tests use it to watch mute and restore
    /// without touching the machine's volume.
    pub fn with_output_mute(mut self, output: Arc<dyn OutputMute>) -> Self {
        self.output = output;
        self
    }

    /// Whether this platform can silence system output at all. The settings
    /// window hides the toggle when it cannot, rather than offering one that
    /// quietly does nothing.
    pub fn can_mute_output(&self) -> bool {
        self.output.supported()
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().clone()
    }

    pub fn update_settings(&self, settings: Settings) {
        let limit = settings.history_limit;
        let keeping = settings.history_enabled;
        *self.settings.lock() = settings;
        self.apply_history_policy(keeping, limit);
    }

    /// Write `next` to disk and make it current, as one step.
    ///
    /// The lock is held across the write so two windows saving at once — the
    /// setup window switching hold-Fn off while Settings is open, say — cannot
    /// interleave a read, a write and a cache update and lose one of the saves.
    /// The history policy runs after the lock is released: `enforce_limit`
    /// never touches the settings lock, but keeping the two apart costs nothing
    /// and removes a whole class of deadlock.
    pub fn save_settings(&self, dir: &std::path::Path, next: Settings) -> Result<Settings> {
        let limit = next.history_limit;
        let keeping = next.history_enabled;
        {
            let mut current = self.settings.lock();
            next.save(dir)?;
            *current = next.clone();
        }
        self.apply_history_policy(keeping, limit);
        Ok(next)
    }

    /// Change one field under the lock, so a stale copy held by another window
    /// cannot be written back over it.
    pub fn set_fn_trigger(&self, dir: &std::path::Path, enabled: bool) -> Result<Settings> {
        let mut current = self.settings.lock();
        let mut next = current.clone();
        next.fn_trigger = enabled;
        next.save(dir)?;
        *current = next.clone();
        Ok(next)
    }

    /// Turning history off, or lowering the cap, must take effect now rather
    /// than at the next dictation — the user may have just decided the existing
    /// entries should not be there.
    fn apply_history_policy(&self, keeping: bool, limit: usize) {
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

    /// Silence system output for the length of the hold, if that is switched on.
    ///
    /// Never fatal. A dictation that could not quiet the speakers is still a
    /// good dictation, the same rule history and usage follow.
    fn mute_output(&self) {
        if !self.settings.lock().mute_while_recording {
            return;
        }
        if let Err(err) = self.output.mute() {
            tracing::warn!("could not mute system output: {err:#}");
        }
    }

    /// Put system output back.
    ///
    /// Deliberately unconditional, not gated on the setting: switching the
    /// toggle off mid-dictation must still hand back the audio, and restoring
    /// when nothing was muted does nothing. Also called on the way out of the
    /// app, so quitting mid-dictation cannot leave the machine silent.
    pub fn restore_output(&self) {
        if let Err(err) = self.output.restore() {
            tracing::warn!("could not restore system output: {err:#}");
        }
    }

    /// Drop the cached clients so the next dictation picks up a new API key.
    pub fn invalidate_transcriber(&self) {
        *self.transcriber.lock() = None;
        *self.polisher.lock() = None;
        *self.live_route.lock() = None;
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
        self.warmed.store(true, Ordering::SeqCst);
        self.engine.warmup();
    }

    /// Warm up if nothing has yet. For the user who allowed the microphone
    /// after launch: the launch skipped the warmup so as not to prompt them
    /// before the setup window could say why, and this pays it as soon as the
    /// permission lands rather than on their first sentence.
    pub fn warmup_once(&self) {
        if !self.warmed.swap(true, Ordering::SeqCst) {
            self.engine.warmup();
        }
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

    /// A short note in the capsule that is not about a dictation, shown when
    /// the capsule is free (see `Overlay::notice`).
    pub fn notice(&self, text: String) {
        self.sink.publish(Status::Notice { text });
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
                    self.generation.fetch_add(1, Ordering::SeqCst);
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

    /// Whether dictation `mine` must not paste: it was cancelled, or a newer
    /// one has started since (which is only possible after a cancel).
    fn stale(&self, mine: u64) -> bool {
        self.cancelled.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != mine
    }

    fn announce_cancelled(&self) {
        self.recording.store(false, Ordering::Relaxed);
        self.announce(Status::Cancelled);
    }

    fn abort_recording(&self) {
        self.recording.store(false, Ordering::Relaxed);
        if let Some(live) = self.live.lock().take() {
            live.cancel();
        }
        self.screen.lock().take();
        self.restore_output();
        match self.engine.stop() {
            Ok(mut recording) => recording.clip.samples.zeroize(),
            Err(err) => tracing::debug!("nothing to discard: {err:#}"),
        }
        self.announce(Status::Cancelled);
    }

    fn begin_transcribe(self: &Arc<Self>) -> Option<Receiver<Result<Option<String>, String>>> {
        let started = Instant::now();
        self.recording.store(false, Ordering::Relaxed);
        // The key is up and the audio is captured: hand playback back now,
        // rather than holding the room silent for the transcription too.
        self.restore_output();

        // Taken now, so every way out below either hands it to the transcribe
        // step or cancels it. The engine stops first: the tap then holds the
        // very end of the recording for the stream's last message.
        let live = self.live.lock().take();
        let screen = self.screen.lock().take();
        let recording = match self.engine.stop() {
            Ok(recording) => recording,
            Err(err) => {
                tracing::error!("could not stop recording: {err:#}");
                if let Some(live) = live {
                    live.cancel();
                }
                self.fail(format!("Recording failed: {err}"));
                return None;
            }
        };
        let mut clip = recording.clip;
        // Windows said the microphone was off, and the device agreed: nothing
        // but zeros. Uploading that would bill for "nothing was transcribed".
        if self.microphone_switched_off.swap(false, Ordering::Relaxed)
            && clip.is_digital_silence()
        {
            tracing::warn!("the microphone is switched off in Windows privacy settings");
            clip.samples.zeroize();
            if let Some(live) = live {
                live.cancel();
            }
            self.fail(MICROPHONE_NEEDED.to_string());
            return None;
        }
        // Shown once the dictation has settled, after its result.
        *self.device_warning.lock() = recording.warning;

        let duration = clip.duration_secs();
        let instant = live.is_some();
        let mine = self.generation.load(Ordering::SeqCst);
        self.announce(Status::Transcribing);

        let (tx, rx) = mpsc::channel();
        let me = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("telekey-transcribe".into())
            .spawn(move || {
                let result = me
                    .transcribe_and_insert_with(clip, live, screen, mine)
                    .map_err(|err| format!("{err:#}"));
                if let Ok(Some(text)) = &result {
                    tracing::info!(
                        audio_secs = duration,
                        total_ms = started.elapsed().as_millis() as u64,
                        chars = text.len(),
                        instant,
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
        } else {
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

        // After the result, whatever it was: a microphone that dropped out is
        // worth knowing about whether the words made it or not, but it is
        // never the headline.
        if let Some(text) = self.device_warning.lock().take() {
            self.sink.publish(Status::Notice { text });
        }
        if let Some(text) = self.instant_note.lock().take() {
            self.sink.publish(Status::Notice { text });
        }
    }

    fn begin(&self) {
        // Without the permission the stream opens on silence, and that silence
        // would be uploaded, billed and reported as "nothing was transcribed".
        // Opening the device is what makes macOS ask, so a never-asked user
        // still gets the system dialog here — and the setup window with it.
        let microphone = permissions::microphone();
        match microphone {
            Permission::NotAsked => {
                self.warmup();
                self.fail(MICROPHONE_NEEDED.to_string());
                return;
            }
            Permission::Denied if Platform::current().microphone_denial_is_final() => {
                self.fail(MICROPHONE_NEEDED.to_string());
                return;
            }
            Permission::Denied => {
                tracing::warn!(
                    "Windows privacy settings have the microphone switched off; trying anyway"
                );
            }
            Permission::Granted | Permission::Unknown => {}
        }
        let switched_off = microphone == Permission::Denied;
        self.microphone_switched_off
            .store(switched_off, Ordering::Relaxed);

        // Capture the target app before anything else can steal focus.
        let target = frontmost_app();
        tracing::info!(target = target.profile_key(), "dictation started");
        // Read in parallel with opening the microphone; nothing waits on it.
        let screen = self
            .settings
            .lock()
            .screen_context
            .then(|| screen_context::start(target.clone()));
        *self.screen.lock() = screen.clone();
        *self.target.lock() = target;

        // Blocks until the stream is actually live. Announcing "recording"
        // before that point is what made the user speak into a microphone that
        // was not yet open.
        let (preferred, instant) = {
            let settings = self.settings.lock();
            (settings.input_device.clone(), settings.instant)
        };
        let tap = match self.engine.start(preferred, instant) {
            Ok(tap) => tap,
            Err(err) => {
                tracing::error!("could not start recording: {err:#}");
                // With the privacy switch off, Windows refuses the device with
                // "Access is denied"; the setup window says where the switch is.
                if switched_off {
                    self.fail(MICROPHONE_NEEDED.to_string());
                } else {
                    self.fail(format!("Could not start recording: {err}"));
                }
                return;
            }
        };

        // Instant: connect now, while the user speaks. Without a key or a
        // sign-in to stream with, the tap is dropped and this is a Standard
        // dictation, which then reports the missing credential as usual.
        if let Some(tap) = tap {
            match self.live_route() {
                Some(route) => {
                    let session = LiveSession::start(route, tap, self.context(), screen);
                    *self.live.lock() = Some(Box::new(session));
                }
                None => drop(tap),
            }
        }

        // After the stream is live, so a device that refuses to mute cannot
        // delay the recording the user is already speaking into.
        self.mute_output();

        self.recording.store(true, Ordering::Relaxed);
        self.announce(Status::Recording);
    }

    #[cfg(test)]
    fn transcribe_and_insert(&self, clip: Clip) -> Result<Option<String>> {
        let mine = self.generation.load(Ordering::SeqCst);
        self.transcribe_and_insert_with(clip, None, None, mine)
    }

    fn transcribe_and_insert_with(
        &self,
        clip: Clip,
        live: Option<Box<dyn Streamed>>,
        screen: Option<Arc<ContextSlot>>,
        mine: u64,
    ) -> Result<Option<String>> {
        let Some(transcription) = self.transcribe(clip, live, screen, mine)? else {
            return Ok(None);
        };
        if self.stale(mine) {
            return Ok(None);
        }
        self.meter(&transcription.units);

        let text = transcription.text;
        if text.is_empty() {
            anyhow::bail!("nothing was transcribed — try speaking a little longer");
        }

        if self.stale(mine) {
            return Ok(None);
        }

        let text = self.finish_text(text);

        if self.stale(mine) {
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

    /// The transcript: Instant's, when it was streaming and came through, and
    /// otherwise Standard's from the recording. `None` when cancelled.
    fn transcribe(
        &self,
        mut clip: Clip,
        live: Option<Box<dyn Streamed>>,
        screen: Option<Arc<ContextSlot>>,
        mine: u64,
    ) -> Result<Option<Transcription>> {
        if self.stale(mine) {
            clip.samples.zeroize();
            if let Some(live) = live {
                live.cancel();
            }
            return Ok(None);
        }

        if let Some(live) = live {
            let waited = Instant::now();
            match live.finish() {
                Ok(transcription) => {
                    clip.samples.zeroize();
                    tracing::debug!(
                        after_release_ms = waited.elapsed().as_millis() as u64,
                        billed_seconds = transcription.units.live_transcribe_seconds,
                        "instant transcript"
                    );
                    return Ok(Some(transcription));
                }
                Err(err) => {
                    tracing::warn!("Instant failed, using Standard instead: {err:#}");
                    // A tap on the key is too short for either; saying Instant
                    // was unavailable would only confuse that.
                    if clip.duration_secs() >= 0.3 {
                        *self.instant_note.lock() = Some(INSTANT_FELL_BACK.to_string());
                    }
                }
            }
        }

        let transcriber = match self.transcriber() {
            Ok(transcriber) => transcriber,
            Err(err) => {
                clip.samples.zeroize();
                return Err(err);
            }
        };
        let mut context = self.context();
        // The same screen read Instant used, if it got that far.
        context.prompt = screen.and_then(|slot| slot.get_within(SCREEN_WAIT));
        let upload_started = Instant::now();
        if self.stale(mine) {
            clip.samples.zeroize();
            return Ok(None);
        }

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
        Ok(Some(transcription))
    }

    /// Where Instant should stream, or `None` for a Standard dictation.
    ///
    /// Same order as [`Self::transcriber`]: a sign-in wins over a stored key,
    /// and pays through the relay; a key alone goes straight to OpenAI.
    fn live_route(&self) -> Option<Route> {
        let mut cached = self.live_route.lock();
        if let Some(route) = cached.as_ref() {
            return Some(route.clone());
        }
        let route = if session::is_signed_in() {
            session::relay_url().map(|url| Route::Relay { url })
        } else {
            match settings::load_api_key() {
                Ok(Some(key)) => Some(Route::OpenAi { key }),
                Ok(None) => None,
                Err(err) => {
                    tracing::warn!("Instant has no key to stream with: {err:#}");
                    None
                }
            }
        };
        cached.clone_from(&route);
        route
    }

    /// Everything between the transcript and the paste: formatting, then the
    /// user's replacements — last, so nothing after them can undo their fix.
    fn finish_text(&self, text: String) -> String {
        let text = self.format_for_target(text);
        let replacements = self.settings.lock().replacements.clone();
        crate::replace::apply(&text, &replacements)
    }

    /// The formatting between the transcript and the paste: the app's style,
    /// and the smart pass when a list or a correction is heard.
    ///
    /// Never fails the dictation: the transcript is already correct, so a
    /// formatting problem falls back to it rather than losing the user's words.
    fn format_for_target(&self, text: String) -> String {
        let (style, lists, corrections) = {
            let settings = self.settings.lock();
            let target = self.target.lock();
            let profile = settings.profile_for(target.profile_key());
            let literal = matches!(profile.map(|p| &p.style), Some(Style::Literal));
            let style = profile
                .filter(|_| settings.polish_enabled)
                .map(|profile| profile.style.clone());
            let fits = smart::within_limit(&text);
            // No lists where a list does harm: a terminal runs each line, an
            // editor wants code, and a Literal profile asked for none.
            let lists = settings.smart_lists
                && fits
                && !literal
                && !smart::no_lists_in(&target)
                && smart::sounds_like_a_list(&text);
            let corrections =
                settings.fix_corrections && fits && smart::sounds_like_a_correction(&text);
            (style, lists, corrections)
        };

        let text = if lists || corrections {
            self.smart_pass(text, style.as_ref(), lists, corrections)
        } else if let Some(style) = style.as_ref().filter(|style| style.needs_model()) {
            return self.polish_with(text, style);
        } else {
            text
        };

        // Deterministic styles need no client, and so work offline and instantly.
        match style {
            Some(Style::Literal) => crate::polish::apply_literal(&text),
            _ => text,
        }
    }

    /// The app's model style, alone.
    fn polish_with(&self, text: String, style: &Style) -> String {
        let started = Instant::now();
        match self.polisher().and_then(|p| p.polish(&text, style)) {
            Ok(formatted) => {
                tracing::debug!(
                    polish_ms = started.elapsed().as_millis() as u64,
                    "formatting applied"
                );
                self.meter(&formatted.units);
                crate::polish::guard(&text, formatted.text)
            }
            Err(err) => {
                tracing::warn!("formatting failed, keeping the transcript: {err:#}");
                text
            }
        }
    }

    /// One model call for whatever was heard — a list, a correction, or both
    /// — together with the app's model style, if it has one.
    ///
    /// Without a style, the answer is pasted only if it changed nothing but
    /// what was asked for (`smart::acceptable`); otherwise the dictation goes
    /// as spoken. With one, the user already chose to let the model reword
    /// text in that app.
    fn smart_pass(
        &self,
        text: String,
        style: Option<&Style>,
        lists: bool,
        corrections: bool,
    ) -> String {
        let styled = style.and_then(Style::guidance);
        let mut parts: Vec<&str> = styled.into_iter().collect();
        if corrections {
            parts.push(smart::CORRECTION_GUIDANCE);
        }
        if lists {
            parts.push(smart::LIST_GUIDANCE);
        }
        let asked = Style::Custom(parts.join("\n\n"));

        let started = Instant::now();
        match self.polisher().and_then(|p| p.polish(&text, &asked)) {
            Ok(formatted) => {
                self.meter(&formatted.units);
                let answer = crate::polish::guard(&text, formatted.text);
                let accepted =
                    styled.is_some() || smart::acceptable(&text, &answer, lists, corrections);
                tracing::debug!(
                    ms = started.elapsed().as_millis() as u64,
                    lists,
                    corrections,
                    accepted,
                    "smart pass"
                );
                if accepted {
                    answer
                } else {
                    text
                }
            }
            Err(err) => {
                tracing::warn!("the smart pass failed, keeping the transcript: {err:#}");
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

        // A list from the smart pass also goes as HTML, so Notes, Mail and
        // Slack make real bullets of it.
        let html = self
            .settings
            .lock()
            .smart_lists
            .then(|| smart::list_html(text))
            .flatten();
        inject::paste_via_clipboard(
            &mut clipboard,
            &mut keys,
            text,
            html.as_deref(),
            PASTE_SETTLE_DELAY,
        )
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

    use std::sync::atomic::AtomicUsize;

    /// Watches mute and restore without touching the machine's volume.
    #[derive(Default)]
    struct FakeOutput {
        mutes: AtomicUsize,
        restores: AtomicUsize,
        held: AtomicBool,
        /// Stands in for a device with neither a mute flag nor a volume control.
        broken: bool,
    }

    impl FakeOutput {
        fn broken() -> Self {
            Self {
                broken: true,
                ..Self::default()
            }
        }

        fn counts(&self) -> (usize, usize) {
            (
                self.mutes.load(Ordering::SeqCst),
                self.restores.load(Ordering::SeqCst),
            )
        }
    }

    impl crate::output_mute::OutputMute for FakeOutput {
        fn mute(&self) -> Result<()> {
            self.mutes.fetch_add(1, Ordering::SeqCst);
            if self.broken {
                return Err(anyhow::anyhow!("no mute or volume control"));
            }
            self.held.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn restore(&self) -> Result<()> {
            self.restores.fetch_add(1, Ordering::SeqCst);
            self.held.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn supported(&self) -> bool {
            true
        }
    }

    fn with_muting(enabled: bool) -> (Arc<Pipeline>, Arc<FakeOutput>) {
        let output = Arc::new(FakeOutput::default());
        let settings = Settings {
            mute_while_recording: enabled,
            ..Settings::default()
        };
        let pipeline = Pipeline::new(settings, Arc::new(NullSink), test_history(), test_usage())
            .with_output_mute(Arc::clone(&output) as Arc<dyn crate::output_mute::OutputMute>);
        (Arc::new(pipeline), output)
    }

    #[test]
    fn muting_is_opt_in() {
        let (pipeline, output) = with_muting(false);
        pipeline.mute_output();
        assert_eq!(output.counts(), (0, 0), "the toggle was off");
        assert!(!output.held.load(Ordering::SeqCst));
    }

    #[test]
    fn muting_silences_output_when_switched_on() {
        let (pipeline, output) = with_muting(true);
        pipeline.mute_output();
        assert_eq!(output.counts(), (1, 0));
        assert!(output.held.load(Ordering::SeqCst));
    }

    #[test]
    fn releasing_the_key_hands_playback_back() {
        let (pipeline, output) = with_muting(true);
        pipeline.mute_output();
        // Stop: what the pipeline runs when the key comes up.
        pipeline.begin_transcribe();
        assert_eq!(output.counts().1, 1, "restored on stop");
        assert!(!output.held.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelling_hands_playback_back() {
        let (pipeline, output) = with_muting(true);
        pipeline.mute_output();
        pipeline.abort_recording();
        assert_eq!(output.counts().1, 1, "restored on cancel");
        assert!(!output.held.load(Ordering::SeqCst));
    }

    /// Switching the toggle off mid-dictation must still give the audio back:
    /// restoring is deliberately not gated on the setting.
    #[test]
    fn turning_the_toggle_off_mid_dictation_still_restores() {
        let (pipeline, output) = with_muting(true);
        pipeline.mute_output();
        pipeline.update_settings(Settings::default());

        pipeline.restore_output();
        assert_eq!(output.counts().1, 1);
        assert!(!output.held.load(Ordering::SeqCst));
    }

    /// A device that cannot be silenced is a warning in the log, never a failed
    /// dictation — the same rule history and usage follow. The pipeline carries
    /// on to the transcribe step exactly as it would have.
    #[test]
    fn a_device_that_will_not_mute_does_not_fail_the_dictation() {
        let output = Arc::new(FakeOutput::broken());
        let settings = Settings {
            mute_while_recording: true,
            ..Settings::default()
        };
        let pipeline = Arc::new(
            Pipeline::new(settings, Arc::new(NullSink), test_history(), test_usage())
                .with_output_mute(Arc::clone(&output) as Arc<dyn crate::output_mute::OutputMute>),
        );

        pipeline.mute_output();
        assert_eq!(output.counts().0, 1, "it tried");
        assert!(!output.held.load(Ordering::SeqCst), "and it did not take");

        // Releasing the key still runs the rest of the dictation, and still
        // hands playback back even though the mute never took.
        pipeline.begin_transcribe();
        assert_eq!(output.counts().1, 1);
    }

    /// Notes how many history entries exist at the moment `Inserted` is
    /// published. The settings window refetches history on that event, so the
    /// entry has to be on disk first or the refetch shows the old list.
    struct HistoryWatchingSink {
        history: Arc<History>,
        entries_at_inserted: Mutex<Option<usize>>,
    }

    impl StatusSink for HistoryWatchingSink {
        fn publish(&self, status: Status) {
            if matches!(status, Status::Inserted { .. }) {
                *self.entries_at_inserted.lock() = Some(self.history.entries().len());
            }
        }
    }

    fn settle_with_history(enabled: bool) -> Option<usize> {
        let history = test_history();
        let sink = Arc::new(HistoryWatchingSink {
            history: Arc::clone(&history),
            entries_at_inserted: Mutex::new(None),
        });
        let settings = Settings {
            history_enabled: enabled,
            ..Settings::default()
        };
        let pipeline = Pipeline::new(
            settings,
            Arc::clone(&sink) as Arc<dyn StatusSink>,
            history,
            test_usage(),
        );

        // `insert()` needs Accessibility, so the paste path is not reachable
        // in a test; settling is where history and the announcement meet.
        pipeline.settle_transcribe(Ok(Some("hello there".into())));
        let seen = *sink.entries_at_inserted.lock();
        seen
    }

    #[test]
    fn history_is_written_before_inserted_is_announced() {
        assert_eq!(settle_with_history(true), Some(1));
    }

    #[test]
    fn inserted_is_still_announced_with_history_off() {
        assert_eq!(settle_with_history(false), Some(0));
    }

    #[test]
    fn saving_settings_holds_the_lock_and_returns_what_was_saved() {
        let dir = tempfile::tempdir().unwrap();
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());

        let saved = pipeline
            .save_settings(
                dir.path(),
                Settings {
                    vocabulary: vec!["Zustand".into()],
                    ..Settings::default()
                },
            )
            .unwrap();

        assert_eq!(saved.vocabulary, vec!["Zustand".to_string()]);
        assert_eq!(pipeline.settings().vocabulary, vec!["Zustand".to_string()]);
        assert_eq!(
            Settings::load(dir.path()).unwrap().vocabulary,
            vec!["Zustand".to_string()]
        );
    }

    #[test]
    fn switching_fn_off_keeps_every_other_setting() {
        let dir = tempfile::tempdir().unwrap();
        let pipeline = Pipeline::new(
            Settings {
                vocabulary: vec!["Hordanso".into()],
                fn_trigger: true,
                ..Settings::default()
            },
            Arc::new(NullSink),
            test_history(),
            test_usage(),
        );

        let saved = pipeline.set_fn_trigger(dir.path(), false).unwrap();

        assert!(!saved.fn_trigger);
        assert_eq!(saved.vocabulary, vec!["Hordanso".to_string()]);
        assert!(!Settings::load(dir.path()).unwrap().fn_trigger);
    }

    #[test]
    fn warmup_once_only_opens_the_device_the_first_time() {
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());
        assert!(!pipeline.warmed.load(Ordering::SeqCst));
        pipeline.warmup_once();
        assert!(pipeline.warmed.load(Ordering::SeqCst));
        // A second call is a no-op; the flag stays set either way.
        pipeline.warmup_once();
        assert!(pipeline.warmed.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelled_status_serialises_for_the_overlay() {
        let json = serde_json::to_value(Status::Cancelled).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "cancelled" }));
    }

    /// Instant's side of a dictation, scripted: what `finish` returns, and
    /// whether the pipeline cancelled it.
    struct ScriptedStream {
        outcome: Result<Transcription, String>,
        cancelled: Arc<AtomicBool>,
    }

    impl ScriptedStream {
        fn ok(text: &str, seconds: u64) -> (Box<dyn Streamed>, Arc<AtomicBool>) {
            Self::boxed(Ok(Transcription {
                text: text.into(),
                units: Units::live_transcription(seconds),
            }))
        }

        fn failing(reason: &str) -> (Box<dyn Streamed>, Arc<AtomicBool>) {
            Self::boxed(Err(reason.into()))
        }

        fn boxed(outcome: Result<Transcription, String>) -> (Box<dyn Streamed>, Arc<AtomicBool>) {
            let cancelled = Arc::new(AtomicBool::new(false));
            let stream = Self {
                outcome,
                cancelled: Arc::clone(&cancelled),
            };
            (Box::new(stream), cancelled)
        }
    }

    impl Streamed for ScriptedStream {
        fn finish(self: Box<Self>) -> Result<Transcription> {
            self.outcome.map_err(|reason| anyhow::anyhow!(reason))
        }

        fn cancel(self: Box<Self>) {
            self.cancelled.store(true, Ordering::SeqCst);
        }
    }

    fn half_second_clip() -> Clip {
        Clip {
            samples: vec![0.01; TARGET_SAMPLE_RATE as usize / 2],
        }
    }

    /// A formatting model that answers from a script and records each
    /// instruction it was given.
    struct ScriptedPolisher {
        answer: String,
        asked: Mutex<Vec<String>>,
    }

    impl ScriptedPolisher {
        fn answering(answer: &str) -> Arc<Self> {
            Arc::new(Self {
                answer: answer.into(),
                asked: Mutex::new(Vec::new()),
            })
        }
    }

    impl Polisher for ScriptedPolisher {
        fn polish(&self, _text: &str, style: &Style) -> Result<crate::polish::Polished> {
            self.asked.lock().push(style.instruction().unwrap_or_default());
            Ok(crate::polish::Polished {
                text: self.answer.clone(),
                units: Units::default(),
            })
        }
    }

    fn smart_pipeline(
        polisher: &Arc<ScriptedPolisher>,
        app: &str,
        configure: impl FnOnce(&mut Settings),
    ) -> Pipeline {
        let mut settings = Settings {
            smart_lists: true,
            fix_corrections: true,
            ..Settings::default()
        };
        configure(&mut settings);
        let pipeline = Pipeline::new(settings, Arc::new(NullSink), test_history(), test_usage());
        *pipeline.polisher.lock() = Some(Arc::clone(polisher) as Arc<dyn Polisher>);
        *pipeline.target.lock() = TargetApp {
            bundle_id: Some(app.into()),
            ..TargetApp::default()
        };
        pipeline
    }

    const CAR: &str = "I'm going to be using my car, sorry, my bike, to get to the office.";

    #[test]
    fn a_heard_correction_is_fixed_in_one_call() {
        let polisher = ScriptedPolisher::answering("I'm going to be using my bike to get to the office.");
        let pipeline = smart_pipeline(&polisher, "com.apple.mail", |_| {});
        assert_eq!(
            pipeline.finish_text(CAR.into()),
            "I'm going to be using my bike to get to the office."
        );
        let asked = polisher.asked.lock();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].contains("Self-corrections"));
        assert!(!asked[0].contains("Lists:"), "no list was heard");
    }

    #[test]
    fn nothing_heard_means_no_model_call() {
        let polisher = ScriptedPolisher::answering("never");
        let pipeline = smart_pipeline(&polisher, "com.apple.mail", |_| {});
        let plain = "Can you send the contract over before lunch?";
        assert_eq!(pipeline.finish_text(plain.into()), plain);
        assert!(polisher.asked.lock().is_empty());
    }

    #[test]
    fn with_the_toggles_off_nothing_changes() {
        let polisher = ScriptedPolisher::answering("never");
        let pipeline = smart_pipeline(&polisher, "com.apple.mail", |s| {
            s.smart_lists = false;
            s.fix_corrections = false;
        });
        assert_eq!(pipeline.finish_text(CAR.into()), CAR);
        assert!(polisher.asked.lock().is_empty());
    }

    #[test]
    fn a_list_and_a_correction_share_one_call() {
        let text = "Agenda for tomorrow: first the budget, second the hiring plan, sorry, the hiring freeze, and third the offsite.";
        let polisher = ScriptedPolisher::answering("Agenda for tomorrow:\n- the budget\n- the hiring freeze\n- the offsite");
        let pipeline = smart_pipeline(&polisher, "com.apple.Notes", |_| {});
        assert_eq!(
            pipeline.finish_text(text.into()),
            "Agenda for tomorrow:\n- the budget\n- the hiring freeze\n- the offsite"
        );
        let asked = polisher.asked.lock();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].contains("Self-corrections") && asked[0].contains("Lists:"));
    }

    #[test]
    fn an_answer_that_rewrote_more_than_asked_is_not_pasted() {
        let polisher = ScriptedPolisher::answering("I'll cycle to the office.");
        let pipeline = smart_pipeline(&polisher, "com.apple.mail", |_| {});
        assert_eq!(pipeline.finish_text(CAR.into()), CAR);
    }

    #[test]
    fn an_empty_answer_keeps_the_dictation() {
        let polisher = ScriptedPolisher::answering("");
        let pipeline = smart_pipeline(&polisher, "com.apple.mail", |_| {});
        assert_eq!(pipeline.finish_text(CAR.into()), CAR);
    }

    #[test]
    fn no_lists_in_a_terminal() {
        let polisher = ScriptedPolisher::answering("never");
        let pipeline = smart_pipeline(&polisher, "com.apple.Terminal", |s| s.fix_corrections = false);
        let text = "To deploy, first run the tests, then build the bundle, and finally upload it.";
        assert_eq!(pipeline.finish_text(text.into()), text);
        assert!(polisher.asked.lock().is_empty());
    }

    #[test]
    fn the_apps_own_style_rides_in_the_same_call() {
        let polisher = ScriptedPolisher::answering("Using my bike tomorrow.");
        let pipeline = smart_pipeline(&polisher, "com.tinyspeck.slackmacgap", |s| {
            s.polish_enabled = true;
            s.profiles = vec![crate::polish::AppProfile {
                app: "com.tinyspeck.slackmacgap".into(),
                label: "Slack".into(),
                style: Style::Terse,
            }];
        });
        // A style the user chose rewrites by design, so its answer is used.
        assert_eq!(pipeline.finish_text(CAR.into()), "Using my bike tomorrow.");
        let asked = polisher.asked.lock();
        assert_eq!(asked.len(), 1, "one call, not two");
        assert!(asked[0].contains("Keep it short") && asked[0].contains("Self-corrections"));
    }

    #[test]
    fn replacements_come_after_formatting_so_it_cannot_undo_them() {
        let mut settings = Settings::default();
        settings.polish_enabled = true;
        settings.profiles = vec![crate::polish::AppProfile {
            app: "com.apple.Terminal".into(),
            label: "Terminal".into(),
            style: crate::polish::Style::Literal,
        }];
        settings.replacements = vec![crate::settings::Replacement {
            said: "cloud code".into(),
            write: "Claude Code".into(),
        }];
        let pipeline = Pipeline::new(settings, Arc::new(NullSink), test_history(), test_usage());
        *pipeline.target.lock() = TargetApp {
            bundle_id: Some("com.apple.Terminal".into()),
            ..TargetApp::default()
        };
        // Literal lowercases the first word; the replacement, applied after,
        // still writes "Claude Code" exactly.
        assert_eq!(pipeline.finish_text("Cloud code.".into()), "Claude Code");
        assert_eq!(pipeline.finish_text("Run cloud code now.".into()), "run Claude Code now");
    }

    #[test]
    fn instant_text_is_used_and_nothing_is_uploaded() {
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());
        let standard = ScriptedTranscriber::gated("from the upload", Units::transcription(3));
        inject(&pipeline, Arc::clone(&standard) as Arc<dyn Transcriber>);
        let (stream, _) = ScriptedStream::ok("streamed", 2);

        // A gated transcriber would block forever if it were called.
        let result = pipeline.transcribe(half_second_clip(), Some(stream), None, 0).unwrap().unwrap();

        assert_eq!(result.text, "streamed");
        assert_eq!(result.units, Units::live_transcription(2));
        assert!(pipeline.instant_note.lock().is_none());
    }

    #[test]
    fn a_failed_stream_falls_back_to_standard_and_says_so_after() {
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());
        inject(
            &pipeline,
            ScriptedTranscriber::immediate("from the upload", Units::transcription(1)),
        );
        let (stream, _) = ScriptedStream::failing("Instant took too long to get ready");

        let result = pipeline.transcribe(half_second_clip(), Some(stream), None, 0).unwrap().unwrap();

        assert_eq!(result.text, "from the upload");
        assert_eq!(result.units, Units::transcription(1));
        assert_eq!(pipeline.instant_note.lock().as_deref(), Some(INSTANT_FELL_BACK));
    }

    #[test]
    fn the_fallback_note_comes_after_the_result() {
        let sink = Arc::new(RecordingSink::default());
        let pipeline = Pipeline::new(
            Settings::default(),
            Arc::clone(&sink) as Arc<dyn StatusSink>,
            test_history(),
            test_usage(),
        );
        *pipeline.instant_note.lock() = Some(INSTANT_FELL_BACK.to_string());
        pipeline.settle_transcribe(Ok(Some("hello".into())));
        let seen = sink.seen.lock();
        assert_eq!(
            *seen,
            vec![
                Status::Inserted { text: "hello".into() },
                Status::Notice { text: INSTANT_FELL_BACK.into() },
            ]
        );
    }

    #[test]
    fn a_tap_too_short_for_either_gets_no_fallback_note() {
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());
        inject(&pipeline, ScriptedTranscriber::immediate("x", Units::transcription(1)));
        let (stream, _) = ScriptedStream::failing("too short for Instant");
        let tap = Clip { samples: vec![0.01; TARGET_SAMPLE_RATE as usize / 10] };
        let _ = pipeline.transcribe(tap, Some(stream), None, 0);
        assert!(pipeline.instant_note.lock().is_none());
    }

    #[test]
    fn a_cancel_before_the_text_stops_the_stream_and_uploads_nothing() {
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());
        let standard = ScriptedTranscriber::gated("never", Units::transcription(3));
        inject(&pipeline, Arc::clone(&standard) as Arc<dyn Transcriber>);
        let (stream, cancelled) = ScriptedStream::ok("streamed", 2);
        pipeline.mark_cancel();

        assert!(pipeline.transcribe(half_second_clip(), Some(stream), None, 0).unwrap().is_none());
        assert!(cancelled.load(Ordering::SeqCst));
    }

    /// Records the context each upload was given.
    #[derive(Default)]
    struct ContextRecorder {
        prompts: Mutex<Vec<Option<String>>>,
    }

    impl Transcriber for ContextRecorder {
        fn transcribe(&self, _clip: &Clip, context: &TranscriptionContext) -> Result<Transcription> {
            self.prompts.lock().push(context.prompt.clone());
            Ok(Transcription {
                text: "uploaded".into(),
                units: Units::transcription(1),
            })
        }
    }

    #[test]
    fn the_screen_context_goes_with_the_upload_even_after_instant_read_it() {
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());
        let recorder = Arc::new(ContextRecorder::default());
        inject(&pipeline, Arc::clone(&recorder) as Arc<dyn Transcriber>);
        let slot = ContextSlot::new();
        slot.fill(Some("Dictating into Mail.".into()));
        // Instant read it, then failed: Standard still has it.
        assert_eq!(slot.try_get(), Some(Some("Dictating into Mail.".into())));
        let (stream, _) = ScriptedStream::failing("no connection");

        pipeline
            .transcribe(half_second_clip(), Some(stream), Some(Arc::clone(&slot)), 0)
            .unwrap();

        assert_eq!(*recorder.prompts.lock(), vec![Some("Dictating into Mail.".to_string())]);
    }

    #[test]
    fn without_screen_context_the_upload_carries_no_prompt() {
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());
        let recorder = Arc::new(ContextRecorder::default());
        inject(&pipeline, Arc::clone(&recorder) as Arc<dyn Transcriber>);
        pipeline.transcribe(half_second_clip(), None, None, 0).unwrap();
        assert_eq!(*recorder.prompts.lock(), vec![None]);
    }

    #[test]
    fn instant_minutes_are_metered_at_their_own_rate() {
        let usage = test_usage();
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), Arc::clone(&usage));
        pipeline.meter(&Units::live_transcription(60));
        let today = usage.today();
        assert_eq!(today.live_transcribe_seconds, 60);
        assert_eq!(today.transcribe_seconds, 0);
        let cost = crate::usage::Rates::default().cost_of(&today);
        assert!((cost.instant - 0.017).abs() < 1e-9, "{cost:?}");
        assert!((cost.total - 0.017).abs() < 1e-9, "{cost:?}");
    }

    #[test]
    fn a_cancelled_dictation_never_pastes_after_the_next_one_starts() {
        // Esc during transcribing, then the shortcut again at once: the new
        // start clears `cancelled`, and the old thread must still stand down.
        let pipeline = Pipeline::new(Settings::default(), Arc::new(NullSink), test_history(), test_usage());
        let mine = pipeline.generation.load(Ordering::SeqCst);
        pipeline.mark_cancel();
        assert!(pipeline.stale(mine));
        // What the run loop does on the next Start.
        pipeline.generation.fetch_add(1, Ordering::SeqCst);
        pipeline.cancelled.store(false, Ordering::SeqCst);
        assert!(pipeline.stale(mine), "the old dictation must stay cancelled");
        assert!(!pipeline.stale(mine + 1), "the new one is live");

        inject(&pipeline, ScriptedTranscriber::immediate("cancelled words", Units::transcription(1)));
        let result = pipeline
            .transcribe_and_insert_with(half_second_clip(), None, None, mine)
            .unwrap();
        assert!(result.is_none(), "nothing pasted for the cancelled dictation");
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
