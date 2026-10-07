//! Terminal helpers for setup and diagnostics.
//!
//! The API key is read from stdin rather than an argument so it never appears in
//! `ps`, shell history, or a log line. It goes straight to the Keychain.

use std::io::{BufRead, Write};

use anyhow::{bail, Context, Result};

use crate::inject::accessibility_granted;
use crate::settings::{self, Settings};

/// Read a key from stdin and store it in the Keychain.
pub fn set_api_key() -> Result<()> {
    print!("Paste your OpenAI API key (input is not echoed to any log): ");
    std::io::stdout().flush().ok();

    let mut key = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut key)
        .context("could not read from stdin")?;

    let key = key.trim();
    if key.is_empty() {
        bail!("no key entered");
    }
    if !key.starts_with("sk-") {
        bail!("that does not look like an OpenAI API key (expected it to start with 'sk-')");
    }

    settings::store_api_key(key)?;
    println!("Saved to the Keychain. TeleKey will pick it up on the next dictation.");
    Ok(())
}

pub fn clear_api_key() -> Result<()> {
    settings::clear_api_key()?;
    println!("API key removed from the Keychain.");
    Ok(())
}

/// Print what is and is not set up. Never prints the key itself.
pub fn check() -> Result<()> {
    let dir = settings::config_dir()?;
    let loaded = Settings::load(&dir);

    println!("TeleKey setup check");
    println!("--------------------");

    match &loaded {
        Ok(settings) => {
            println!("  settings file    {}", dir.join("settings.json").display());
            println!("  shortcut         {}", settings.shortcut);
            println!("  languages        {}", settings.languages.join(", "));
            println!("  vocabulary       {} term(s)", settings.keywords().len());
            println!("  polish pass      {}", on_off(settings.polish_enabled));
        }
        Err(err) => println!("  settings         UNREADABLE: {err:#}"),
    }

    let resolved = settings::resolve_api_key().unwrap_or(None);
    let key_set = resolved.is_some();
    match &resolved {
        // The source, never the key itself.
        Some((_, source)) => println!("  API key          yes  (from {source})"),
        None => println!("  API key          NO"),
    }

    let hosted = crate::session::status();
    match (&hosted.signed_in, &hosted.email) {
        (true, Some(email)) => println!("  hosted account   yes  ({email})"),
        (true, None) => println!("  hosted account   yes"),
        (false, _) => println!("  hosted account   no"),
    }

    println!("  accessibility    {}", yes_no(accessibility_granted()));
    println!("  signature        {}", describe_signing());
    println!("  input device     {}", describe_input_device());

    let ready = (key_set || hosted.signed_in) && accessibility_granted() && loaded.is_ok();
    println!();
    if ready {
        println!("Ready to dictate.");
    } else {
        println!("Not ready yet:");
        if !key_set && !hosted.signed_in {
            println!("  - run `{} set-api-key`", invocation());
            println!("    (or sign in from Settings, or set OPENAI_API_KEY in .env)");
        }
        if !accessibility_granted() {
            println!(
                "  - grant Accessibility in System Settings › Privacy & Security › Accessibility"
            );
        }
        if let Some(advice) = crate::signing::current().advice() {
            println!("  - {advice}");
        }
    }

    Ok(())
}

/// How to invoke this binary from the user's current directory.
///
/// The binary is not on `PATH` during development, so printing a bare
/// `telekey` sends people to `command not found`.
fn invocation() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return "telekey".to_string();
    };

    match std::env::current_dir() {
        Ok(cwd) => match exe.strip_prefix(&cwd) {
            Ok(relative) => format!("./{}", relative.display()),
            Err(_) => exe.display().to_string(),
        },
        Err(_) => exe.display().to_string(),
    }
}

fn describe_signing() -> String {
    use crate::signing::Signing;

    match crate::signing::current() {
        Signing::Stable => "stable (permissions survive rebuilds)".to_string(),
        Signing::Unstable => {
            "AD-HOC — permissions reset on rebuild, run ./scripts/dev-sign.sh".to_string()
        }
        Signing::Unknown => "unknown (not running from an app bundle)".to_string(),
    }
}

fn describe_input_device() -> String {
    match crate::input_device::current() {
        Some(device) => format!("{} ({})", device.name, device.id),
        None => "NONE FOUND".to_string(),
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "NO"
    }
}

fn on_off(value: bool) -> &'static str {
    if value {
        "on"
    } else {
        "off"
    }
}

/// Stream a recording through Instant as if it were being spoken, and say how
/// long the text took after the end of it.
///
/// Uses the same route a dictation would: the signed-in account through
/// TeleKey's relay (which charges it, as a dictation would), or the stored
/// OpenAI key. The audio is released at the pace it was recorded, so the
/// timing is what a user would see. `--compare` also uploads it the Standard
/// way and times that.
pub fn instant_check(path: Option<&str>, compare: bool) -> Result<()> {
    use std::time::{Duration, Instant};

    let path = path.context("usage: telekey instant-check <recording.wav> [--compare]")?;
    crate::session::hydrate_env();

    let (samples, rate) = read_wav(std::path::Path::new(path))?;
    let seconds = samples.len() as f64 / f64::from(rate);
    let settings = Settings::load(&settings::config_dir()?).unwrap_or_default();
    let context = crate::transcribe::TranscriptionContext {
        keywords: settings.keywords(),
        languages: settings.languages.clone(),
        prompt: None,
    };

    let route = if crate::session::is_signed_in() {
        let url = crate::session::relay_url().context("no Instant relay is configured")?;
        crate::live::Route::Relay { url }
    } else if let Some(key) = settings::load_api_key()? {
        crate::live::Route::OpenAi { key }
    } else {
        bail!("sign in or add an OpenAI key first");
    };

    println!("Instant check: {seconds:.1} s of audio via {}", route.describe());
    let paced = Paced::new(samples.clone(), rate);
    let started = Instant::now();
    let session = crate::live::LiveSession::start(route, paced, context.clone());
    // Released in real time, as a microphone would; the key "comes up" when
    // the last sample has been.
    std::thread::sleep(Duration::from_secs_f64(seconds) + Duration::from_millis(40));
    let released = Instant::now();
    let result = session.finish();
    let after = released.elapsed();
    match result {
        Ok(transcription) => {
            println!("  text after release   {:.2} s", after.as_secs_f64());
            println!("  whole session        {:.2} s", started.elapsed().as_secs_f64());
            println!(
                "  billed               {} s at the Instant rate",
                transcription.units.live_transcribe_seconds
            );
            println!("  transcript           {}", transcription.text);
        }
        Err(err) => println!("  FAILED after {:.2} s: {err:#}", after.as_secs_f64()),
    }
    // The relay charges just after handing over the text, while the session
    // thread holds the connection open for it; leaving at once would cut it.
    std::thread::sleep(Duration::from_secs(2));

    if compare {
        let clip = crate::audio::Clip {
            samples: resample_for_upload(&samples, rate)?,
        };
        let transcriber: Box<dyn crate::transcribe::Transcriber> = if crate::session::is_signed_in() {
            Box::new(crate::hosted::HostedTranscriber::new()?)
        } else {
            let key = settings::load_api_key()?.context("no OpenAI key")?;
            Box::new(crate::transcribe::OpenAiTranscriber::new(key)?)
        };
        let uploaded = Instant::now();
        match transcriber.transcribe(&clip, &context) {
            Ok(transcription) => {
                println!("Standard for comparison");
                println!("  text after release   {:.2} s", uploaded.elapsed().as_secs_f64());
                println!("  transcript           {}", transcription.text);
            }
            Err(err) => println!("Standard FAILED: {err:#}"),
        }
    }
    Ok(())
}

/// Releases a recording at the pace it was made, like a microphone.
struct Paced {
    samples: Vec<f32>,
    rate: u32,
    started: std::time::Instant,
    taken: std::sync::atomic::AtomicUsize,
}

impl Paced {
    fn new(samples: Vec<f32>, rate: u32) -> Self {
        Self {
            samples,
            rate,
            started: std::time::Instant::now(),
            taken: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl crate::live::AudioSource for Paced {
    fn drain(&self) -> Vec<f32> {
        use std::sync::atomic::Ordering;
        let due = ((self.started.elapsed().as_secs_f64() * f64::from(self.rate)) as usize)
            .min(self.samples.len());
        let from = self.taken.swap(due, Ordering::SeqCst).min(due);
        self.samples[from..due].to_vec()
    }

    fn source_rate(&self) -> u32 {
        self.rate
    }
}

fn resample_for_upload(samples: &[f32], rate: u32) -> Result<Vec<f32>> {
    let mut resampler =
        crate::audio::StreamResampler::new(rate, crate::audio::TARGET_SAMPLE_RATE)?;
    let mut out = resampler.push(samples)?;
    out.extend(resampler.finish()?);
    Ok(out)
}

/// A 16-bit PCM WAV, mixed down to mono: what `afconvert -d LEI16` writes.
fn read_wav(path: &std::path::Path) -> Result<(Vec<f32>, u32)> {
    let bytes = std::fs::read(path).with_context(|| format!("could not read {}", path.display()))?;
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        bail!("{} is not a WAV file", path.display());
    }
    let mut at = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into()?) as usize;
        let body = &bytes[at + 8..(at + 8 + len).min(bytes.len())];
        if id == b"fmt " && body.len() >= 16 {
            format = Some((
                u16::from_le_bytes(body[0..2].try_into()?),
                u16::from_le_bytes(body[2..4].try_into()?),
                u32::from_le_bytes(body[4..8].try_into()?),
                u16::from_le_bytes(body[14..16].try_into()?),
            ));
        } else if id == b"data" {
            let (kind, channels, rate, bits) = format.context("the WAV has no format chunk")?;
            if kind != 1 || bits != 16 || channels == 0 {
                bail!("only 16-bit PCM WAV is supported (convert with afconvert -d LEI16)");
            }
            let channels = channels as usize;
            let samples = body
                .chunks_exact(2 * channels)
                .map(|frame| {
                    frame
                        .chunks_exact(2)
                        .map(|s| f32::from(i16::from_le_bytes([s[0], s[1]])) / f32::from(i16::MAX))
                        .sum::<f32>()
                        / channels as f32
                })
                .collect();
            return Ok((samples, rate));
        }
        at += 8 + len + (len & 1);
    }
    bail!("the WAV has no audio")
}

