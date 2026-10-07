//! Instant mode: stream the audio to OpenAI's live transcription while the
//! user is still speaking, so the text is ready the moment they let go.
//!
//! Standard uploads the whole clip on release and waits 3–4 s for the text.
//! Here a WebSocket is opened on key-down, audio goes up as it is captured,
//! and on release only the last few hundred milliseconds remain to send; the
//! spike measured the final text arriving ~0.9 s after the commit.
//!
//! Two routes, one protocol. With the user's own key the app talks straight
//! to OpenAI. With TeleKey credits it talks to TeleKey's relay (`relay/`),
//! which speaks the same protocol, checks the sign-in and charges for the
//! final transcript. Either way this module sends the same four events and
//! reads the same few back.
//!
//! Instant never costs a dictation. The full recording is still kept by the
//! audio engine, and anything that goes wrong here — no connection, an error
//! event, no text in time — hands it to Standard instead (`pipeline.rs`).

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};
use zeroize::Zeroize;

use crate::audio::{pcm16_le, StreamResampler, Tap, LIVE_SAMPLE_RATE};
use crate::context::ContextSlot;
use crate::transcribe::{Transcription, TranscriptionContext};
use crate::usage::Units;

/// OpenAI's live transcription. `intent=transcription` and no `model`: the
/// model goes in the session settings, and naming it here is refused.
pub const OPENAI_LIVE_URL: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
pub const LIVE_MODEL: &str = "gpt-live-transcribe";

/// How long OpenAI may take to settle the words after the commit. The spike
/// measured `low` as the fastest that did not mishear (`minimal` turned "Hi"
/// into "High").
const DELAY: &str = "low";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
/// From key-down to a session ready for audio. The spike took ~2.2–2.9 s,
/// which the user spends speaking, so this only bites on a broken network.
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);
/// If the key comes up before the session is ready, how much longer to wait
/// for it before giving up on Instant for this dictation.
const SETUP_GRACE_AFTER_STOP: Duration = Duration::from_secs(2);
/// From the commit to the final text. Measured at under a second; anything
/// past this is better spent on Standard.
const RESULT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the settings wait for the screen context, if it is still being
/// read when the session is ready. Every millisecond here delays the first
/// audio sent.
const CONTEXT_WAIT: Duration = Duration::from_millis(250);
/// How long to keep the connection for the relay to write its charge.
const CHARGE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long each wait for a message lasts, and so how often audio is sent.
const POLL: Duration = Duration::from_millis(20);
/// Bytes per second of 24 kHz 16-bit mono.
const BYTES_PER_SECOND: usize = LIVE_SAMPLE_RATE as usize * 2;
/// OpenAI refuses to commit an empty buffer; under 100 ms is a tap, not speech.
const MIN_COMMIT_BYTES: usize = BYTES_PER_SECOND / 10;
/// At most a second of audio per message: a backlog from a slow connection
/// goes up in pieces rather than one large frame.
const MAX_SAMPLES_PER_APPEND: usize = LIVE_SAMPLE_RATE as usize;

/// Where Instant streams to, and with which credential.
#[derive(Clone)]
pub enum Route {
    /// The user's own key, straight to OpenAI.
    OpenAi { key: String },
    /// TeleKey credits, through the relay. The sign-in token is fetched when
    /// the session starts, on its own thread, since refreshing it can mean a
    /// network round trip.
    Relay { url: String },
}

impl Route {
    pub fn describe(&self) -> &'static str {
        match self {
            Route::OpenAi { .. } => "openai",
            Route::Relay { .. } => "relay",
        }
    }
}

/// Audio as it is captured. The engine's [`Tap`] in the app; a fake in tests.
pub trait AudioSource: Send {
    fn drain(&self) -> Vec<f32>;
    fn source_rate(&self) -> u32;
}

impl AudioSource for Tap {
    fn drain(&self) -> Vec<f32> {
        Tap::drain(self)
    }

    fn source_rate(&self) -> u32 {
        Tap::source_rate(self)
    }
}

/// A WebSocket carrying text messages. Tungstenite in the app; a fake in tests.
pub trait Socket: Send {
    fn send(&mut self, text: &str) -> Result<()>;
    /// The next text message, or `None` if none arrived within `wait`.
    fn recv(&mut self, wait: Duration) -> Result<Option<String>>;
    fn close(&mut self);
}

/// A dictation being streamed, as the pipeline sees it: a [`LiveSession`] in
/// the app, a fake in its tests.
pub trait Streamed: Send {
    /// The recording has stopped: return the text, or why there is none.
    fn finish(self: Box<Self>) -> Result<Transcription>;
    /// Nothing will be pasted; stop and discard.
    fn cancel(self: Box<Self>);
}

impl Streamed for LiveSession {
    fn finish(self: Box<Self>) -> Result<Transcription> {
        LiveSession::finish(*self)
    }

    fn cancel(self: Box<Self>) {
        LiveSession::cancel(*self)
    }
}

enum Command {
    /// The recording has stopped: send the rest, commit, return the text.
    Finish,
    /// Discard everything; nothing will be pasted.
    Cancel,
}

/// One dictation being streamed, on its own thread from key-down.
pub struct LiveSession {
    commands: Sender<Command>,
    outcome: Receiver<Result<Transcription>>,
}

impl LiveSession {
    /// Connect and start streaming `tap`. Returns at once: connecting happens
    /// on the session's thread while the user speaks, and the audio captured
    /// meanwhile waits in the tap.
    /// `screen`, when "Use what's on screen" is on, is where the screen
    /// context for this dictation arrives; it is read when the session is
    /// ready for its settings, a second or two after key-down.
    pub fn start(
        route: Route,
        tap: impl AudioSource + 'static,
        context: TranscriptionContext,
        screen: Option<std::sync::Arc<ContextSlot>>,
    ) -> Self {
        let (commands, inbox) = mpsc::channel();
        let (report, outcome) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("telekey-instant".into())
            .spawn(move || {
                let started = Instant::now();
                let mut socket = match connect_route(&route) {
                    Ok(socket) => socket,
                    Err(err) => {
                        let _ = report.send(Err(err));
                        return;
                    }
                };
                tracing::debug!(
                    route = route.describe(),
                    ms = started.elapsed().as_millis() as u64,
                    "instant connected"
                );
                let result = stream(
                    socket.as_mut(),
                    &tap,
                    &context,
                    screen.as_deref(),
                    &inbox,
                    started,
                );
                drop(tap);
                let delivered = result.is_ok();
                // The text goes to the pipeline now; staying connected below
                // costs the user nothing.
                let _ = report.send(result);
                if delivered && matches!(route, Route::Relay { .. }) {
                    await_charge(socket.as_mut());
                }
                socket.close();
            });
        if let Err(err) = spawned {
            let (report, failed) = mpsc::channel();
            let _ = report.send(Err(anyhow!("could not start Instant: {err}")));
            return Self {
                commands,
                outcome: failed,
            };
        }
        Self { commands, outcome }
    }

    /// The recording has stopped and the engine has its last samples in the
    /// tap: send them, commit, and wait for the text.
    pub fn finish(self) -> Result<Transcription> {
        let _ = self.commands.send(Command::Finish);
        // The session enforces its own deadlines; this only guards against a
        // thread that hangs in a way they cannot see.
        let limit = SETUP_TIMEOUT + RESULT_TIMEOUT + CONNECT_TIMEOUT;
        self.outcome
            .recv_timeout(limit)
            .map_err(|_| anyhow!("Instant did not answer"))?
    }

    /// Abandon the dictation. The thread clears what was sent and closes.
    pub fn cancel(self) {
        let _ = self.commands.send(Command::Cancel);
    }
}

fn connect_route(route: &Route) -> Result<Box<dyn Socket>> {
    let socket = match route {
        Route::OpenAi { key } => WsSocket::connect(OPENAI_LIVE_URL, key)?,
        Route::Relay { url } => {
            let token = crate::session::fresh_id_token()?;
            WsSocket::connect(url, &token)?
        }
    };
    Ok(Box::new(socket))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Phase {
    /// Connected; waiting for `session.created`.
    Connected,
    /// Ready for settings, but the screen context is still being read.
    AwaitingContext,
    /// Settings sent; waiting for `session.updated` before the first audio.
    Configuring,
    Streaming,
    /// Everything sent; waiting for the final text.
    Committed,
}

/// The session itself: configure, stream, commit, return the text.
fn stream(
    socket: &mut dyn Socket,
    audio: &dyn AudioSource,
    context: &TranscriptionContext,
    screen: Option<&ContextSlot>,
    commands: &Receiver<Command>,
    started: Instant,
) -> Result<Transcription> {
    let mut context = context.clone();
    let mut phase = Phase::Connected;
    let mut context_deadline = Instant::now();
    let mut stopped_at: Option<Instant> = None;
    let mut committed_at: Option<Instant> = None;
    let mut resampler = StreamResampler::new(audio.source_rate(), LIVE_SAMPLE_RATE)?;
    let mut sent_bytes = 0usize;

    loop {
        match commands.try_recv() {
            Ok(Command::Cancel) | Err(TryRecvError::Disconnected) => {
                if phase >= Phase::Streaming {
                    let _ = socket.send(r#"{"type":"input_audio_buffer.clear"}"#);
                }
                bail!("cancelled");
            }
            Ok(Command::Finish) => {
                stopped_at.get_or_insert_with(Instant::now);
            }
            Err(TryRecvError::Empty) => {}
        }

        let now = Instant::now();
        if phase < Phase::Streaming {
            let mut deadline = started + SETUP_TIMEOUT;
            if let Some(stopped) = stopped_at {
                deadline = deadline.min(stopped + SETUP_GRACE_AFTER_STOP);
            }
            if now > deadline {
                bail!("Instant took too long to get ready");
            }
        }
        if let Some(committed) = committed_at {
            if now > committed + RESULT_TIMEOUT {
                bail!("Instant sent no text in time");
            }
        }

        if phase == Phase::AwaitingContext {
            let ready = screen.and_then(ContextSlot::try_get);
            if ready.is_some() || now > context_deadline {
                context.prompt = ready.flatten();
                socket.send(&session_update(&context).to_string())?;
                phase = Phase::Configuring;
            }
        }

        if phase == Phase::Streaming {
            let mut fresh = audio.drain();
            let mut out = resampler.push(&fresh)?;
            fresh.zeroize();
            if stopped_at.is_some() {
                out.extend(resampler.finish()?);
            }
            sent_bytes += send_audio(socket, &out)?;
            out.zeroize();

            if stopped_at.is_some() {
                if sent_bytes < MIN_COMMIT_BYTES {
                    bail!("too short for Instant");
                }
                socket.send(r#"{"type":"input_audio_buffer.commit"}"#)?;
                phase = Phase::Committed;
                committed_at = Some(Instant::now());
            }
        }

        let Some(text) = socket.recv(POLL)? else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        match event["type"].as_str().unwrap_or_default() {
            "session.created" if phase == Phase::Connected => match screen {
                // The screen is normally read long before this; if not, wait
                // a moment for it, polled above so Finish and Cancel still
                // get through, then go without.
                Some(slot) => match slot.try_get() {
                    Some(prompt) => {
                        context.prompt = prompt;
                        socket.send(&session_update(&context).to_string())?;
                        phase = Phase::Configuring;
                    }
                    None => {
                        context_deadline = Instant::now() + CONTEXT_WAIT;
                        phase = Phase::AwaitingContext;
                    }
                },
                None => {
                    socket.send(&session_update(&context).to_string())?;
                    phase = Phase::Configuring;
                }
            },
            "session.updated" if phase == Phase::Configuring => {
                tracing::debug!(
                    ms = started.elapsed().as_millis() as u64,
                    "instant ready for audio"
                );
                phase = Phase::Streaming;
            }
            "conversation.item.input_audio_transcription.completed" => {
                return Ok(transcription_from(&event, sent_bytes));
            }
            "conversation.item.input_audio_transcription.failed" | "error" => {
                bail!("{}", error_message(&event));
            }
            _ => {}
        }
    }
}

/// After a transcript from the relay, stay connected until it says the charge
/// is written. The relay hands over the text before charging, to save the
/// user the wait, and Cloud Run only lends it CPU while a connection is open.
fn await_charge(socket: &mut dyn Socket) {
    let deadline = Instant::now() + CHARGE_TIMEOUT;
    while Instant::now() < deadline {
        match socket.recv(POLL) {
            Ok(Some(text)) if text.contains(r#""telekey.charged""#) => return,
            Ok(_) => {}
            // The relay closes once it has charged.
            Err(_) => return,
        }
    }
    tracing::debug!("the relay did not confirm the charge in time");
}

/// The settings for one dictation: the live model, the user's vocabulary and
/// languages, and no voice detection — the key, not a pause, ends the speech.
fn session_update(context: &TranscriptionContext) -> Value {
    let mut transcription = json!({ "model": LIVE_MODEL, "delay": DELAY });
    if !context.keywords.is_empty() {
        transcription["keywords"] = json!(context.keywords);
    }
    if !context.languages.is_empty() {
        transcription["languages"] = json!(context.languages);
    }
    if let Some(prompt) = context.prompt.as_deref().filter(|p| !p.is_empty()) {
        transcription["prompt"] = json!(prompt);
    }
    json!({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": LIVE_SAMPLE_RATE },
                    "transcription": transcription,
                    "turn_detection": null
                }
            }
        }
    })
}

/// Send `samples` as `input_audio_buffer.append` events of at most a second
/// each, and return how many bytes of audio went.
fn send_audio(socket: &mut dyn Socket, samples: &[f32]) -> Result<usize> {
    let mut sent = 0;
    for piece in samples.chunks(MAX_SAMPLES_PER_APPEND) {
        let mut pcm = pcm16_le(piece);
        let mut encoded = base64::engine::general_purpose::STANDARD.encode(&pcm);
        let mut message = format!(r#"{{"type":"input_audio_buffer.append","audio":"{encoded}"}}"#);
        let result = socket.send(&message);
        sent += pcm.len();
        pcm.zeroize();
        encoded.zeroize();
        message.zeroize();
        result?;
    }
    Ok(sent)
}

/// The final text, and what it cost. The relay adds `units` (what it charged
/// in credits); straight from OpenAI there is only `usage`, and the audio sent
/// stands in when that is missing or counted in tokens.
fn transcription_from(event: &Value, sent_bytes: usize) -> Transcription {
    let text = event["transcript"].as_str().unwrap_or_default().trim().to_string();

    let charged = event
        .get("units")
        .and_then(|units| serde_json::from_value::<Units>(units.clone()).ok());
    let units = charged.unwrap_or_else(|| {
        let usage = &event["usage"];
        let reported = (usage["type"] == "duration")
            .then(|| usage["seconds"].as_f64())
            .flatten()
            .map(|seconds| seconds.ceil().max(0.0) as u64);
        let measured = sent_bytes.div_ceil(BYTES_PER_SECOND) as u64;
        Units::live_transcription(reported.unwrap_or(measured))
    });

    Transcription { text, units }
}

fn error_message(event: &Value) -> String {
    let error = &event["error"];
    error["message"]
        .as_str()
        .or_else(|| error["code"].as_str())
        .unwrap_or("Instant failed")
        .to_string()
}

/// The real socket: tungstenite over TLS, blocking, with read timeouts so one
/// thread can both send audio and listen.
struct WsSocket {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    /// The same TCP socket, kept to change the read timeout per wait.
    tcp: TcpStream,
}

impl WsSocket {
    fn connect(url: &str, bearer: &str) -> Result<Self> {
        let mut request = url
            .into_client_request()
            .with_context(|| format!("{url} is not a WebSocket address"))?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {bearer}")
                .parse()
                .context("the credential is not a valid header")?,
        );

        let uri = request.uri().clone();
        let host = uri.host().context("the Instant address has no host")?;
        let port = uri
            .port_u16()
            .unwrap_or(if uri.scheme_str() == Some("ws") { 80 } else { 443 });

        let mut last_error = None;
        let mut tcp = None;
        for addr in (host, port)
            .to_socket_addrs()
            .with_context(|| format!("could not look up {host}"))?
        {
            match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
                Ok(stream) => {
                    tcp = Some(stream);
                    break;
                }
                Err(err) => last_error = Some(err),
            }
        }
        let tcp = match (tcp, last_error) {
            (Some(tcp), _) => tcp,
            (None, Some(err)) => return Err(err).context("could not connect for Instant"),
            (None, None) => bail!("{host} has no address"),
        };
        tcp.set_nodelay(true).ok();
        tcp.set_read_timeout(Some(CONNECT_TIMEOUT))?;
        tcp.set_write_timeout(Some(CONNECT_TIMEOUT))?;
        let handle = tcp.try_clone().context("could not share the Instant socket")?;

        let (ws, _response) =
            tungstenite::client_tls_with_config(request, tcp, None, None).map_err(refusal)?;
        Ok(Self { ws, tcp: handle })
    }
}

/// A refused handshake as the person reading the log should see it. The relay
/// answers in JSON (`{"error": "Out of credits — …"}`), OpenAI likewise.
fn refusal(err: tungstenite::HandshakeError<tungstenite::ClientHandshake<MaybeTlsStream<TcpStream>>>) -> anyhow::Error {
    match err {
        tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response)) => {
            let status = response.status().as_u16();
            let detail = response
                .body()
                .as_deref()
                .and_then(|body| serde_json::from_slice::<Value>(body).ok())
                .and_then(|body| {
                    body["error"]
                        .as_str()
                        .or_else(|| body["error"]["message"].as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default();
            // The body is only what arrived with the headers, so it can be
            // missing; the status alone still says enough.
            match (status, detail.is_empty()) {
                (_, false) => anyhow!("{detail}"),
                (401, true) => anyhow!("Instant refused the credential (401)"),
                (402, true) => anyhow!("Out of credits — buy more in TeleKey."),
                (403, true) => anyhow!("Instant is not available to this account (403)"),
                _ => anyhow!("Instant refused the connection ({status})"),
            }
        }
        tungstenite::HandshakeError::Failure(other) => anyhow!("could not connect for Instant: {other}"),
        tungstenite::HandshakeError::Interrupted(_) => anyhow!("Instant took too long to connect"),
    }
}

impl Socket for WsSocket {
    fn send(&mut self, text: &str) -> Result<()> {
        self.ws
            .send(Message::text(text))
            .context("the Instant connection dropped")
    }

    fn recv(&mut self, wait: Duration) -> Result<Option<String>> {
        self.tcp.set_read_timeout(Some(wait.max(Duration::from_millis(1))))?;
        match self.ws.read() {
            Ok(Message::Text(text)) => Ok(Some(text.to_string())),
            Ok(Message::Close(_)) => bail!("the Instant connection closed"),
            // Pings are answered by tungstenite on the next send.
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(err))
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            Err(err) => Err(err).context("the Instant connection dropped"),
        }
    }

    fn close(&mut self) {
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::collections::VecDeque;
    use std::sync::Arc;

    /// Plays OpenAI's part from a script, and records what it was sent.
    #[derive(Clone, Default)]
    struct FakeSocket {
        sent: Arc<Mutex<Vec<Value>>>,
        /// Replies keyed by the type of the event that triggers them.
        on_connect: Arc<Mutex<VecDeque<String>>>,
        replies: Arc<Mutex<Vec<(String, String)>>>,
        inbox: Arc<Mutex<VecDeque<String>>>,
    }

    impl FakeSocket {
        fn openai(transcript: &str, usage: Value) -> Self {
            let fake = Self::default();
            fake.on_connect
                .lock()
                .push_back(json!({ "type": "session.created" }).to_string());
            fake.reply("session.update", json!({ "type": "session.updated" }));
            fake.reply(
                "input_audio_buffer.commit",
                json!({
                    "type": "conversation.item.input_audio_transcription.completed",
                    "transcript": format!(" {transcript} "),
                    "usage": usage,
                }),
            );
            fake
        }

        fn reply(&self, to: &str, with: Value) {
            self.replies.lock().push((to.to_string(), with.to_string()));
        }

        fn sent_types(&self) -> Vec<String> {
            self.sent
                .lock()
                .iter()
                .map(|event| event["type"].as_str().unwrap_or_default().to_string())
                .collect()
        }

        fn audio_bytes(&self) -> usize {
            self.sent
                .lock()
                .iter()
                .filter_map(|event| event["audio"].as_str())
                .map(|audio| base64::engine::general_purpose::STANDARD.decode(audio).unwrap().len())
                .sum()
        }
    }

    impl Socket for FakeSocket {
        fn send(&mut self, text: &str) -> Result<()> {
            let event: Value = serde_json::from_str(text)?;
            let kind = event["type"].as_str().unwrap_or_default().to_string();
            self.sent.lock().push(event);
            for (to, with) in self.replies.lock().iter() {
                if *to == kind {
                    self.inbox.lock().push_back(with.clone());
                }
            }
            Ok(())
        }

        fn recv(&mut self, wait: Duration) -> Result<Option<String>> {
            if let Some(first) = self.on_connect.lock().pop_front() {
                return Ok(Some(first));
            }
            match self.inbox.lock().pop_front() {
                Some(message) => Ok(Some(message)),
                None => {
                    std::thread::sleep(wait.min(Duration::from_millis(2)));
                    Ok(None)
                }
            }
        }

        fn close(&mut self) {}
    }

    /// A microphone that has captured `samples` at 24 kHz, all at once.
    struct FakeAudio(Mutex<Vec<f32>>);

    impl FakeAudio {
        fn seconds(seconds: f32) -> Self {
            Self(Mutex::new(vec![0.1; (LIVE_SAMPLE_RATE as f32 * seconds) as usize]))
        }
    }

    impl AudioSource for FakeAudio {
        fn drain(&self) -> Vec<f32> {
            std::mem::take(&mut *self.0.lock())
        }

        fn source_rate(&self) -> u32 {
            LIVE_SAMPLE_RATE
        }
    }

    fn context() -> TranscriptionContext {
        TranscriptionContext {
            keywords: vec!["TeleKey".into()],
            languages: vec!["en".into()],
            prompt: None,
        }
    }

    /// Run a session that is told to finish straight away, as if the key came
    /// up after the audio was captured.
    fn finished(socket: &mut FakeSocket, audio: &FakeAudio) -> Result<Transcription> {
        let (tx, rx) = mpsc::channel();
        tx.send(Command::Finish).unwrap();
        stream(socket, audio, &context(), None, &rx, Instant::now())
    }

    #[test]
    fn a_dictation_configures_streams_commits_and_returns_the_text() {
        let mut socket = FakeSocket::openai("Hello there.", json!({ "type": "duration", "seconds": 2 }));
        let audio = FakeAudio::seconds(1.5);

        let result = finished(&mut socket, &audio).unwrap();

        assert_eq!(result.text, "Hello there.");
        assert_eq!(result.units, Units::live_transcription(2));
        let types = socket.sent_types();
        assert_eq!(types.first().map(String::as_str), Some("session.update"));
        assert_eq!(types.last().map(String::as_str), Some("input_audio_buffer.commit"));
        // A second and a half, as at most a second per message.
        assert_eq!(types.iter().filter(|t| *t == "input_audio_buffer.append").count(), 2);
        assert_eq!(socket.audio_bytes(), 36_000 * 2);
    }

    #[test]
    fn the_settings_name_the_live_model_and_turn_off_voice_detection() {
        let mut socket = FakeSocket::openai("x", json!(null));
        finished(&mut socket, &FakeAudio::seconds(0.5)).unwrap();
        let sent = socket.sent.lock();
        let input = &sent[0]["session"]["audio"]["input"];
        assert_eq!(input["transcription"]["model"], LIVE_MODEL);
        assert_eq!(input["transcription"]["keywords"], json!(["TeleKey"]));
        assert_eq!(input["transcription"]["languages"], json!(["en"]));
        assert_eq!(input["transcription"]["delay"], DELAY);
        assert_eq!(input["format"]["rate"], LIVE_SAMPLE_RATE);
        assert!(input["turn_detection"].is_null());
    }

    #[test]
    fn no_audio_goes_before_the_session_is_ready() {
        let mut socket = FakeSocket::openai("x", json!(null));
        finished(&mut socket, &FakeAudio::seconds(0.5)).unwrap();
        let types = socket.sent_types();
        let first_audio = types.iter().position(|t| t == "input_audio_buffer.append").unwrap();
        assert!(first_audio > 0, "audio was sent before the settings: {types:?}");
    }

    #[test]
    fn the_relays_charge_is_what_is_recorded() {
        let mut socket = FakeSocket::openai("x", json!({ "type": "duration", "seconds": 2 }));
        socket.replies.lock().retain(|(to, _)| to != "input_audio_buffer.commit");
        socket.reply(
            "input_audio_buffer.commit",
            json!({
                "type": "conversation.item.input_audio_transcription.completed",
                "transcript": "Paid for.",
                "units": { "dictations": 1, "liveTranscribeSeconds": 3 },
            }),
        );
        let result = finished(&mut socket, &FakeAudio::seconds(1.0)).unwrap();
        assert_eq!(result.text, "Paid for.");
        assert_eq!(result.units.live_transcribe_seconds, 3);
        assert_eq!(result.units.dictations, 1);
    }

    #[test]
    fn without_usage_the_audio_sent_is_the_bill() {
        let mut socket = FakeSocket::openai("x", json!({ "type": "tokens", "input_tokens": 5 }));
        let result = finished(&mut socket, &FakeAudio::seconds(2.2)).unwrap();
        assert_eq!(result.units, Units::live_transcription(3));
    }

    #[test]
    fn the_screen_context_rides_in_the_settings() {
        let mut socket = FakeSocket::openai("x", json!(null));
        let slot = ContextSlot::new();
        slot.fill(Some("Dictating into Mail — Re: invoice.".into()));
        let (tx, rx) = mpsc::channel();
        tx.send(Command::Finish).unwrap();
        stream(&mut socket, &FakeAudio::seconds(0.5), &context(), Some(&slot), &rx, Instant::now())
            .unwrap();
        let sent = socket.sent.lock();
        assert_eq!(
            sent[0]["session"]["audio"]["input"]["transcription"]["prompt"],
            "Dictating into Mail — Re: invoice."
        );
    }

    #[test]
    fn a_screen_read_that_is_late_is_waited_for_briefly_then_skipped() {
        let mut socket = FakeSocket::openai("x", json!(null));
        let slot = ContextSlot::new(); // never filled
        let (tx, rx) = mpsc::channel();
        tx.send(Command::Finish).unwrap();
        let started = Instant::now();
        let result =
            stream(&mut socket, &FakeAudio::seconds(0.5), &context(), Some(&slot), &rx, Instant::now());
        assert!(result.is_ok(), "{result:?}");
        assert!(started.elapsed() >= CONTEXT_WAIT);
        let sent = socket.sent.lock();
        assert!(sent[0]["session"]["audio"]["input"]["transcription"]["prompt"].is_null());
    }

    #[test]
    fn after_the_text_the_relay_gets_time_to_charge() {
        let mut socket = FakeSocket::default();
        socket.inbox.lock().push_back(json!({ "type": "conversation.item.done" }).to_string());
        socket.inbox.lock().push_back(json!({ "type": "telekey.charged" }).to_string());
        socket.inbox.lock().push_back(json!({ "type": "never read" }).to_string());
        let started = Instant::now();
        await_charge(&mut socket);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(socket.inbox.lock().len(), 1, "stops at the confirmation");
    }

    #[test]
    fn an_error_event_fails_the_session_with_its_message() {
        let mut socket = FakeSocket::openai("x", json!(null));
        socket.replies.lock().clear();
        socket.reply(
            "session.update",
            json!({ "type": "error", "error": { "code": "out_of_credits", "message": "Out of credits — buy more in TeleKey." } }),
        );
        let err = finished(&mut socket, &FakeAudio::seconds(1.0)).unwrap_err();
        assert!(err.to_string().contains("credits"), "{err}");
    }

    #[test]
    fn a_tap_on_the_key_is_too_short_to_commit() {
        let mut socket = FakeSocket::openai("x", json!(null));
        let err = finished(&mut socket, &FakeAudio::seconds(0.05)).unwrap_err();
        assert!(err.to_string().contains("too short"), "{err}");
        assert!(!socket.sent_types().contains(&"input_audio_buffer.commit".to_string()));
    }

    #[test]
    fn a_session_that_never_gets_ready_gives_up_soon_after_the_key_comes_up() {
        let mut socket = FakeSocket::default(); // never says session.created
        let started = Instant::now();
        let err = finished(&mut socket, &FakeAudio::seconds(1.0)).unwrap_err();
        assert!(err.to_string().contains("too long"), "{err}");
        let waited = started.elapsed();
        assert!(
            waited >= SETUP_GRACE_AFTER_STOP && waited < SETUP_GRACE_AFTER_STOP + Duration::from_secs(1),
            "waited {waited:?}"
        );
    }

    #[test]
    fn cancel_clears_what_was_sent_and_returns_nothing() {
        let mut socket = FakeSocket::openai("x", json!(null));
        socket.replies.lock().retain(|(to, _)| to != "input_audio_buffer.commit");
        let audio = FakeAudio::seconds(0.5);
        let (tx, rx) = mpsc::channel();
        let sent = Arc::clone(&socket.sent);
        let handle = std::thread::spawn(move || stream(&mut socket, &audio, &context(), None, &rx, Instant::now()));
        // Let it configure and stream, then cancel.
        let deadline = Instant::now() + Duration::from_secs(2);
        while !sent.lock().iter().any(|e| e["type"] == "input_audio_buffer.append") {
            assert!(Instant::now() < deadline, "never streamed");
            std::thread::sleep(Duration::from_millis(5));
        }
        tx.send(Command::Cancel).unwrap();
        assert!(handle.join().unwrap().is_err());
        let types: Vec<String> = sent
            .lock()
            .iter()
            .map(|e| e["type"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(types.last().map(String::as_str), Some("input_audio_buffer.clear"));
        assert!(!types.contains(&"input_audio_buffer.commit".to_string()));
    }

    /// The real client against a local WebSocket server playing OpenAI: the
    /// handshake, the bearer credential and the read timeouts, without TLS.
    #[test]
    // The large error is tungstenite's own callback type, not ours to shrink.
    #[allow(clippy::result_large_err)]
    fn the_real_client_talks_to_a_local_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut seen_auth = String::new();
            let mut ws = tungstenite::accept_hdr(stream, |req: &tungstenite::handshake::server::Request, res| {
                seen_auth = req
                    .headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                Ok(res)
            })
            .unwrap();
            ws.send(Message::text(json!({ "type": "session.created" }).to_string())).unwrap();
            let mut appended = 0usize;
            loop {
                let Message::Text(text) = ws.read().unwrap() else { continue };
                let event: Value = serde_json::from_str(&text).unwrap();
                match event["type"].as_str().unwrap() {
                    "session.update" => ws
                        .send(Message::text(json!({ "type": "session.updated" }).to_string()))
                        .unwrap(),
                    "input_audio_buffer.append" => {
                        appended += base64::engine::general_purpose::STANDARD
                            .decode(event["audio"].as_str().unwrap())
                            .unwrap()
                            .len()
                    }
                    "input_audio_buffer.commit" => {
                        ws.send(Message::text(
                            json!({
                                "type": "conversation.item.input_audio_transcription.completed",
                                "transcript": "Over the wire.",
                                "usage": { "type": "duration", "seconds": 1 }
                            })
                            .to_string(),
                        ))
                        .unwrap();
                        break;
                    }
                    _ => {}
                }
            }
            (seen_auth, appended)
        });

        let mut socket = WsSocket::connect(&format!("ws://127.0.0.1:{port}/v1/realtime"), "sk-local").unwrap();
        let audio = FakeAudio::seconds(1.0);
        let (tx, rx) = mpsc::channel();
        tx.send(Command::Finish).unwrap();
        let result = stream(&mut socket, &audio, &context(), None, &rx, Instant::now()).unwrap();
        socket.close();

        let (auth, appended) = server.join().unwrap();
        assert_eq!(result.text, "Over the wire.");
        assert_eq!(auth, "Bearer sk-local");
        assert_eq!(appended, BYTES_PER_SECOND);
    }

    #[test]
    fn a_refused_handshake_reads_as_the_servers_reason() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = listener.accept().unwrap();
            // The whole request, or closing early resets the connection and
            // the client sees that instead of the answer.
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => request.extend_from_slice(&buf[..n]),
                }
            }
            let body = r#"{"error":"Out of credits — buy more in TeleKey.","code":"out_of_credits"}"#;
            // One write, as the relay sends it: the client only reads the
            // part of the body that came with the headers.
            let response = format!(
                "HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        let err = WsSocket::connect(&format!("ws://127.0.0.1:{port}/v1/realtime"), "token")
            .err()
            .expect("the handshake should be refused");
        assert_eq!(err.to_string(), "Out of credits — buy more in TeleKey.");
    }
}
