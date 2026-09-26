//! Microphone capture: device audio in, 16 kHz mono PCM out.
//!
//! `cpal::Stream` is not `Send` on macOS, so the stream is owned by a dedicated
//! thread and driven over a command channel. Callers only ever see [`AudioEngine`],
//! which is `Send + Sync`.
//!
//! Audio never touches disk. The captured buffer lives in memory and is handed
//! to the caller, which is responsible for zeroizing it after upload.

use std::sync::{
    atomic::{AtomicU32, Ordering},
    mpsc, Arc,
};

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, FromSample, Sample, SampleFormat, StreamConfig};
use parking_lot::Mutex;
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};

/// What `gpt-transcribe` wants, and the rate every downstream stage assumes.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// A finished recording: mono PCM at [`TARGET_SAMPLE_RATE`], `-1.0..=1.0`.
#[derive(Debug, Clone, PartialEq)]
pub struct Clip {
    pub samples: Vec<f32>,
}

impl Clip {
    pub fn duration_secs(&self) -> f32 {
        self.samples.len() as f32 / TARGET_SAMPLE_RATE as f32
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }
}

/// A finished capture, plus anything the device reported on the way.
#[derive(Debug, Clone, PartialEq)]
pub struct Recording {
    pub clip: Clip,
    /// The device dropped out or changed mid-capture, but audio was kept. For
    /// the user to see once the dictation has settled, never instead of it.
    pub warning: Option<String>,
}

enum Cmd {
    /// Open the device and discard the audio, so the expensive first open
    /// happens at launch rather than mid-sentence.
    Warmup,
    /// Replies once the stream is actually live, so nothing tells the user to
    /// speak before the microphone is listening. Carries the pinned device id,
    /// if the user chose one.
    Start(Option<String>, mpsc::Sender<Result<()>>),
    Stop(mpsc::Sender<Result<Recording>>),
}

/// Handle to the capture thread.
pub struct AudioEngine {
    tx: mpsc::Sender<Cmd>,
    level: Arc<AtomicU32>,
}

impl AudioEngine {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<Cmd>();
        let level = Arc::new(AtomicU32::new(0));
        let thread_level = Arc::clone(&level);

        std::thread::Builder::new()
            .name("telekey-audio".into())
            .spawn(move || audio_thread(rx, thread_level))
            .expect("failed to spawn audio thread");

        Self { tx, level }
    }

    /// Open the input device once so CoreAudio is initialised.
    ///
    /// The first stream a process opens costs roughly two seconds; every one
    /// after is tens of milliseconds. Paying that at launch means the user's
    /// first dictation is not silently truncated.
    pub fn warmup(&self) {
        let _ = self.tx.send(Cmd::Warmup);
    }

    /// Begin capturing, returning once the microphone is genuinely live.
    ///
    /// Blocking here is deliberate: the caller announces "recording" on the
    /// strength of this returning, and announcing it earlier is a lie that
    /// costs the user the start of their sentence.
    ///
    /// `preferred` is a device id to open instead of the system default; when
    /// it is not connected, the default is used and a warning logged.
    pub fn start(&self, preferred: Option<String>) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(Cmd::Start(preferred, reply_tx))
            .map_err(|_| anyhow!("audio thread is gone"))?;
        reply_rx
            .recv()
            .map_err(|_| anyhow!("audio thread dropped the reply"))?
    }

    /// Stop capturing and return the clip, resampled to [`TARGET_SAMPLE_RATE`].
    pub fn stop(&self) -> Result<Recording> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(Cmd::Stop(reply_tx))
            .map_err(|_| anyhow!("audio thread is gone"))?;
        reply_rx
            .recv()
            .map_err(|_| anyhow!("audio thread dropped the reply"))?
    }

    /// Peak input level from the last callback, `0.0..=1.0`, for the level meter.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
}

fn audio_thread(rx: mpsc::Receiver<Cmd>, level: Arc<AtomicU32>) {
    let mut active: Option<ActiveStream> = None;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::Warmup => {
                let started = std::time::Instant::now();
                match start_stream(Arc::clone(&level), None) {
                    Ok(stream) => {
                        drop(stream);
                        level.store(0f32.to_bits(), Ordering::Relaxed);
                        tracing::debug!(
                            ms = started.elapsed().as_millis() as u64,
                            "audio device warmed up"
                        );
                    }
                    // Not fatal: the device may simply be unavailable right now,
                    // and the next real dictation will report it properly.
                    Err(err) => tracing::warn!("could not warm up the device: {err:#}"),
                }
            }
            Cmd::Start(preferred, reply) => {
                if active.is_some() {
                    // Key repeat while the shortcut is held.
                    let _ = reply.send(Ok(()));
                    continue;
                }
                let started = std::time::Instant::now();
                let result = match start_stream(Arc::clone(&level), preferred.as_deref()) {
                    Ok(stream) => {
                        tracing::debug!(
                            ms = started.elapsed().as_millis() as u64,
                            "capture started"
                        );
                        active = Some(stream);
                        Ok(())
                    }
                    Err(err) => {
                        tracing::error!("failed to start capture: {err:#}");
                        Err(err)
                    }
                };
                let _ = reply.send(result);
            }
            Cmd::Stop(reply) => {
                let result = match active.take() {
                    Some(stream) => stream.finish(),
                    None => Err(anyhow!("stop requested with no active recording")),
                };
                level.store(0f32.to_bits(), Ordering::Relaxed);
                let _ = reply.send(result);
            }
        }
    }
}

struct ActiveStream {
    stream: cpal::Stream,
    buffer: Arc<Mutex<Vec<f32>>>,
    source_rate: u32,
    /// The first thing the device reported going wrong, if anything did. cpal
    /// does not move a stream to a new device: unplugging the one in use ends
    /// the audio, and the user has to be told rather than handed a transcript
    /// of the first half of their sentence with no explanation.
    fault: Arc<Mutex<Option<ErrorKind>>>,
}

impl ActiveStream {
    fn finish(self) -> Result<Recording> {
        let ActiveStream {
            stream,
            buffer,
            source_rate,
            fault,
        } = self;

        // Dropping the stream stops CoreAudio calling back, so the buffer is
        // settled by the time we take it.
        drop(stream);

        let fault = fault.lock().take();
        let raw = std::mem::take(&mut *buffer.lock());
        if raw.is_empty() {
            if let Some(kind) = &fault {
                anyhow::bail!("{} — nothing was recorded", describe_fault(kind));
            }
        }

        let samples = resample_to_target(raw, source_rate)?;
        let clip = Clip { samples };
        let warning = fault.map(|kind| {
            format!(
                "{} — kept the first {:.0} s",
                describe_fault(&kind),
                clip.duration_secs()
            )
        });
        Ok(Recording { clip, warning })
    }
}

/// Words for what the device reported, in the overlay's two-line budget.
fn describe_fault(kind: &ErrorKind) -> &'static str {
    match kind {
        ErrorKind::DeviceNotAvailable => "Microphone disconnected",
        ErrorKind::StreamInvalidated => "Microphone changed mid-sentence",
        _ => "Microphone stopped",
    }
}

/// The device to open: the one the user pinned, if it is connected, else the
/// system default.
///
/// Looked up by id rather than by scanning every device's configurations —
/// this runs between key-down and the stream going live, and enumerating
/// input devices probes each one.
fn pick_device(host: &cpal::Host, preferred: Option<&str>) -> Result<cpal::Device> {
    if let Some(wanted) = preferred {
        let found = wanted
            .parse::<cpal::DeviceId>()
            .ok()
            .and_then(|id| host.device_by_id(&id));
        match found {
            Some(device) => return Ok(device),
            None => tracing::warn!(
                device = wanted,
                "the chosen microphone is not connected; using the system default"
            ),
        }
    }
    host.default_input_device()
        .context("no input device available")
}

fn start_stream(level: Arc<AtomicU32>, preferred: Option<&str>) -> Result<ActiveStream> {
    let host = cpal::default_host();
    let device = pick_device(&host, preferred)?;
    let supported = device
        .default_input_config()
        .context("could not read the default input config")?;

    let source_rate: u32 = supported.sample_rate();
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();

    tracing::debug!(source_rate, channels, ?sample_format, "opening input stream");

    let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
    let fault = Arc::new(Mutex::new(None::<ErrorKind>));
    let err_fn = {
        let fault = Arc::clone(&fault);
        move |err: cpal::Error| match err.kind() {
            // A dropped buffer is a glitch, not a broken device.
            ErrorKind::Xrun => tracing::debug!("audio stream overrun: {err}"),
            kind => {
                tracing::error!("audio stream error: {err}");
                fault.lock().get_or_insert(kind);
            }
        }
    };

    // One arm per sample format cpal may hand us; each funnels into `ingest`.
    macro_rules! build_stream {
        ($sample:ty) => {{
            let buffer = Arc::clone(&buffer);
            let level = Arc::clone(&level);
            device.build_input_stream(
                config.clone(),
                move |data: &[$sample], _: &cpal::InputCallbackInfo| {
                    ingest(data, channels, &buffer, &level);
                },
                err_fn,
                None,
            )?
        }};
    }

    let stream = match sample_format {
        SampleFormat::I8 => build_stream!(i8),
        SampleFormat::I16 => build_stream!(i16),
        SampleFormat::I32 => build_stream!(i32),
        SampleFormat::F32 => build_stream!(f32),
        other => return Err(anyhow!("unsupported input sample format: {other}")),
    };

    stream.play().context("failed to start the input stream")?;

    Ok(ActiveStream {
        stream,
        buffer,
        source_rate,
        fault,
    })
}

/// Convert a callback's worth of interleaved samples to mono and append it.
fn ingest<T>(data: &[T], channels: usize, buffer: &Mutex<Vec<f32>>, level: &AtomicU32)
where
    T: Sample + Copy,
    f32: FromSample<T>,
{
    if channels == 0 {
        return;
    }

    let mut peak = 0f32;
    let mut guard = buffer.lock();

    for frame in data.chunks(channels) {
        // Average rather than take channel 0: on a stereo mic the speech may sit
        // mostly in one channel, and averaging keeps it either way.
        let sum: f32 = frame.iter().map(|&s| f32::from_sample(s)).sum();
        let mono = sum / frame.len() as f32;
        peak = peak.max(mono.abs());
        guard.push(mono);
    }

    level.store(peak.to_bits(), Ordering::Relaxed);
}

/// Resample a complete clip to [`TARGET_SAMPLE_RATE`].
///
/// Uses rubato's FFT resampler, which applies an anti-aliasing filter — naive
/// sample dropping would fold high frequencies back into the speech band and
/// cost transcription accuracy.
fn resample_to_target(samples: Vec<f32>, source_rate: u32) -> Result<Vec<f32>> {
    if samples.is_empty() || source_rate == TARGET_SAMPLE_RATE {
        return Ok(samples);
    }

    let mut resampler = Fft::<f32>::new(
        source_rate as usize,
        TARGET_SAMPLE_RATE as usize,
        1024,
        1,
        FixedSync::Both,
    )
    .map_err(|err| anyhow!("could not build resampler: {err}"))?;

    let input = InterleavedSlice::new(&samples, 1, samples.len())
        .map_err(|err| anyhow!("bad resampler input buffer: {err}"))?;

    let output = resampler
        .process_all(&input, samples.len(), None)
        .map_err(|err| anyhow!("resampling failed: {err}"))?;

    Ok(output.take_data())
}

/// Encode mono `f32` samples as a 16-bit PCM WAV.
///
/// Hand-rolled rather than via `hound` because `WavWriter::finalize` consumes the
/// writer, which makes writing to an in-memory buffer awkward. The header is a
/// fixed 44 bytes for this format; tests decode the result with `hound` to prove
/// it round-trips.
pub fn encode_wav_16bit_mono(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    const HEADER_LEN: usize = 44;
    let data_len = samples.len() * 2;

    let mut out = Vec::with_capacity(HEADER_LEN + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((HEADER_LEN - 8 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk length
    out.extend_from_slice(&1u16.to_le_bytes()); // format: PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // channels: mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());

    for &sample in samples {
        let scaled = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        out.extend_from_slice(&scaled.to_le_bytes());
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode with a real WAV parser: proves the hand-rolled header is valid.
    #[test]
    fn wav_round_trips_through_a_real_decoder() {
        let samples: Vec<f32> = (0..1000)
            .map(|i| (i as f32 * 0.01).sin() * 0.5)
            .collect();

        let bytes = encode_wav_16bit_mono(&samples, TARGET_SAMPLE_RATE);
        let mut reader =
            hound::WavReader::new(std::io::Cursor::new(&bytes)).expect("valid wav header");

        let spec = reader.spec();
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, TARGET_SAMPLE_RATE);
        assert_eq!(spec.bits_per_sample, 16);

        let decoded: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(decoded.len(), samples.len());

        for (original, actual) in samples.iter().zip(&decoded) {
            let expected = (original * i16::MAX as f32).round() as i16;
            assert_eq!(expected, *actual);
        }
    }

    #[test]
    fn wav_header_is_exactly_44_bytes() {
        let bytes = encode_wav_16bit_mono(&[0.0; 10], TARGET_SAMPLE_RATE);
        assert_eq!(bytes.len(), 44 + 20);
    }

    #[test]
    fn wav_clamps_out_of_range_samples() {
        let bytes = encode_wav_16bit_mono(&[2.0, -2.0], TARGET_SAMPLE_RATE);
        let mut reader = hound::WavReader::new(std::io::Cursor::new(&bytes)).unwrap();
        let decoded: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(decoded, vec![i16::MAX, -i16::MAX]);
    }

    #[test]
    fn resampling_a_matching_rate_is_a_no_op() {
        let samples = vec![0.1, 0.2, 0.3];
        let out = resample_to_target(samples.clone(), TARGET_SAMPLE_RATE).unwrap();
        assert_eq!(out, samples);
    }

    #[test]
    fn resampling_48k_to_16k_yields_a_third_of_the_frames() {
        // One second of 48 kHz audio should come back as roughly one second at 16 kHz.
        let samples: Vec<f32> = (0..48_000)
            .map(|i| (i as f32 / 48_000.0 * 440.0 * std::f32::consts::TAU).sin() * 0.5)
            .collect();

        let out = resample_to_target(samples, 48_000).unwrap();

        let expected = TARGET_SAMPLE_RATE as usize;
        let drift = (out.len() as i64 - expected as i64).abs();
        assert!(
            drift < 200,
            "expected ~{expected} frames, got {} (drift {drift})",
            out.len()
        );
    }

    #[test]
    fn resampling_an_empty_clip_is_harmless() {
        assert!(resample_to_target(Vec::new(), 48_000).unwrap().is_empty());
    }

    #[test]
    fn clip_reports_duration_from_the_target_rate() {
        let clip = Clip {
            samples: vec![0.0; TARGET_SAMPLE_RATE as usize * 2],
        };
        assert!((clip.duration_secs() - 2.0).abs() < f32::EPSILON);
    }
}
