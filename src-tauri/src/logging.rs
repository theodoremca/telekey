//! The log file, so a bug report can come with evidence.
//!
//! An installed copy is started by Finder, the Dock, Explorer or the updater,
//! and its stdout goes nowhere. Every line therefore goes to a file of the
//! app's own as well as to stdout, which `bun tauri dev` and anyone redirecting
//! it still read as before.
//!
//! The file is written synchronously, one line per write. The case it exists
//! for is an app that froze and was force-quit, and a buffered writer (or
//! tracing-appender's non-blocking worker) loses exactly the last lines before
//! the kill. `app.exit` also ends the process without running destructors, so
//! a flush-on-drop guard would never fire. At the default info level a
//! dictation is a handful of lines, cheap to write directly.
//!
//! It is bounded by size rather than by day, so a noisy day cannot grow it
//! without limit: `telekey.log` grows to [`MAX_BYTES`], then becomes
//! `telekey.1.log`, the older files move up to `telekey.3.log`, and the oldest
//! is deleted. The folder never holds much more than 16 MB.
//!
//! The file stays on the computer. Nothing reads it but the person who opens
//! it, which is why the tray has an item that shows it in the file manager.
//! The usual rule holds with more force here: never log a key, a token or
//! transcript text.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use tracing_subscriber::fmt::MakeWriter;

/// The file being written now. Older ones are `telekey.1.log` and up.
pub const FILE_NAME: &str = "telekey.log";

/// Size at which the current file is set aside and a new one started.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// How many set-aside files are kept beside the current one.
const KEPT: usize = 3;

/// The tray item that shows the log, named for the file manager it opens.
#[cfg(target_os = "macos")]
pub const REVEAL_LABEL: &str = "Show Logs in Finder";
#[cfg(target_os = "windows")]
pub const REVEAL_LABEL: &str = "Show Logs in File Explorer";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub const REVEAL_LABEL: &str = "Open Logs Folder";

/// Where the log files live: the folder each OS keeps for them.
///
/// `~/Library/Logs/TeleKey` on macOS, which Console.app lists under Log
/// Reports. Windows and Linux have no such folder, so it is `logs` under the
/// local (not roaming) data directory: `%LOCALAPPDATA%\telekey\logs` and
/// `~/.local/share/telekey/logs`.
pub fn dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|home| home.join("Library").join("Logs").join("TeleKey"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_local_dir().map(|base| base.join("telekey").join("logs"))
    }
}

/// Start logging to stdout and the file, at `TELEKEY_LOG` or the info default.
///
/// A file that cannot be opened costs only the file: stdout still works, and
/// the reason is the first thing it says.
pub fn init() {
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_env("TELEKEY_LOG")
        .unwrap_or_else(|_| EnvFilter::new("telekey=info,warn"));

    let opened = dir()
        .context("could not locate the log directory")
        .and_then(|dir| RotatingFile::open(&dir, MAX_BYTES, KEPT));
    let (file, failure) = match opened {
        Ok(file) => (Some(file), None),
        Err(err) => (None, Some(err)),
    };
    let file_layer = file.map(file_layer);

    let installed = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .with(file_layer)
        .try_init()
        .is_ok();
    if !installed {
        return;
    }

    if let Some(err) = failure {
        tracing::warn!("not writing a log file: {err:#}");
    }
    log_panics();
    // Marks where each launch begins in a file that spans several.
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        "TeleKey starting"
    );
}

/// How lines are written to the file: plain text, and nothing from a
/// dependency below info, whatever `TELEKEY_LOG` asks for.
///
/// The file is what a user sends with a bug report, and dependencies trace
/// what they carry. tungstenite traces Instant's handshake request with its
/// `Authorization` header (the OpenAI key or the session's ID token), then
/// every frame, transcripts included. stdout still gets all of it, for
/// whoever set `TELEKEY_LOG` on purpose.
fn file_layer<S>(file: RotatingFile) -> impl tracing_subscriber::Layer<S>
where
    S: tracing::Subscriber + for<'span> tracing_subscriber::registry::LookupSpan<'span>,
{
    use tracing_subscriber::filter::filter_fn;
    use tracing_subscriber::Layer;

    let ours_or_info = filter_fn(|meta| {
        meta.target().starts_with("telekey") || *meta.level() <= tracing::Level::INFO
    });
    tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(file)
        .with_filter(ours_or_info)
}

/// Send panics to the log too. They go to stderr, which an installed copy has
/// nowhere to put; the previous hook still runs, so a terminal sees them as
/// before.
fn log_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        tracing::error!(thread = thread.name().unwrap_or("unnamed"), "{info}");
        previous(info);
    }));
}

/// Show the log in the file manager, for attaching to a bug report.
///
/// Waits for the opener, so call it off the main thread.
pub fn reveal() -> Result<()> {
    let dir = dir().context("could not locate the log directory")?;
    fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;

    #[cfg(target_os = "macos")]
    {
        // -R opens the folder with the current file selected, beside the
        // older ones.
        let current = dir.join(FILE_NAME);
        let mut open = Command::new("open");
        if current.exists() {
            open.arg("-R").arg(&current);
        } else {
            open.arg(&dir);
        }
        let status = open.status().context("could not open Finder")?;
        if !status.success() {
            bail!("Finder could not show {}", dir.display());
        }
    }
    #[cfg(target_os = "windows")]
    {
        // explorer.exe exits with 1 even when it opened the window, so its
        // status says nothing; only failing to start it is an error.
        Command::new("explorer")
            .arg(&dir)
            .spawn()
            .context("could not open File Explorer")?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let status = Command::new("xdg-open")
            .arg(&dir)
            .status()
            .context("could not open the file manager")?;
        if !status.success() {
            bail!("the file manager could not show {}", dir.display());
        }
    }
    Ok(())
}

/// A log file that is set aside once it reaches a size, keeping a few old ones.
pub struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    kept: usize,
    state: Mutex<State>,
}

struct State {
    /// `None` after a failed reopen; the next line tries again.
    file: Option<File>,
    /// Bytes in the current file, counted rather than asked for on every line.
    len: u64,
}

impl RotatingFile {
    /// Open (or create) `dir/telekey.log` for appending, carrying on from
    /// where the previous launch left it.
    pub fn open(dir: &Path, max_bytes: u64, kept: usize) -> Result<Self> {
        let log = Self {
            path: dir.join(FILE_NAME),
            max_bytes,
            kept,
            state: Mutex::new(State { file: None, len: 0 }),
        };
        log.reopen(&mut log.state.lock())
            .with_context(|| format!("could not open {}", log.path.display()))?;
        Ok(log)
    }

    /// Write one formatted line, setting the current file aside first if the
    /// line would take it past the cap. A line is never split across two
    /// files; a single line longer than the cap is still written whole, to a
    /// file of its own.
    pub fn append(&self, line: &[u8]) -> io::Result<()> {
        let mut guard = self.state.lock();
        let state = &mut *guard;

        let len = line.len() as u64;
        if state.len > 0 && state.len.saturating_add(len) > self.max_bytes {
            // Closed before it is renamed, which Windows needs.
            state.file = None;
            self.shift();
            self.reopen(state)?;
        }
        if state.file.is_none() {
            self.reopen(state)?;
        }
        if let Some(file) = state.file.as_mut() {
            file.write_all(line)?;
            state.len += len;
        }
        Ok(())
    }

    fn reopen(&self, state: &mut State) -> io::Result<()> {
        // Recreated if someone deleted the folder while the app was running.
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        state.len = file.metadata()?.len();
        state.file = Some(file);
        Ok(())
    }

    fn set_aside(&self, n: usize) -> PathBuf {
        self.path.with_file_name(format!("telekey.{n}.log"))
    }

    /// Drop the oldest file, move each other up one, and make the current one
    /// `telekey.1.log`. A rename that fails leaves that file where it is; the
    /// next rotation tries again.
    fn shift(&self) {
        if self.kept == 0 {
            let _ = fs::remove_file(&self.path);
            return;
        }
        let _ = fs::remove_file(self.set_aside(self.kept));
        for n in (1..self.kept).rev() {
            let _ = fs::rename(self.set_aside(n), self.set_aside(n + 1));
        }
        let _ = fs::rename(&self.path, self.set_aside(1));
    }
}

impl<'a> MakeWriter<'a> for RotatingFile {
    type Writer = Line<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        Line(self)
    }
}

/// What the formatter writes one event through. It hands over each event as a
/// single `write_all`, so one call to `write` is one whole line.
pub struct Line<'a>(&'a RotatingFile);

impl Write for Line<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // The log is bookkeeping: a full disk or a vanished folder costs the
        // line, never the dictation, and an error here would only make the
        // formatter complain on stderr for every line after it.
        let _ = self.0.append(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        // Every line went straight to the file; nothing is buffered here.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(dir: &Path, name: &str) -> Option<String> {
        fs::read_to_string(dir.join(name)).ok()
    }

    #[test]
    fn sets_the_file_aside_before_a_line_would_pass_the_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let log = RotatingFile::open(tmp.path(), 100, 3).unwrap();

        let first = format!("{}\n", "a".repeat(59));
        let second = format!("{}\n", "b".repeat(59));
        log.append(first.as_bytes()).unwrap();
        log.append(second.as_bytes()).unwrap();

        assert_eq!(
            read(tmp.path(), "telekey.1.log").as_deref(),
            Some(first.as_str())
        );
        assert_eq!(
            read(tmp.path(), FILE_NAME).as_deref(),
            Some(second.as_str())
        );
    }

    #[test]
    fn keeps_only_the_newest_files() {
        let tmp = tempfile::tempdir().unwrap();
        let log = RotatingFile::open(tmp.path(), 10, 2).unwrap();

        for n in 1..=6 {
            log.append(format!("line {n:02}\n").as_bytes()).unwrap();
        }

        assert_eq!(read(tmp.path(), FILE_NAME).as_deref(), Some("line 06\n"));
        assert_eq!(
            read(tmp.path(), "telekey.1.log").as_deref(),
            Some("line 05\n")
        );
        assert_eq!(
            read(tmp.path(), "telekey.2.log").as_deref(),
            Some("line 04\n")
        );
        assert_eq!(read(tmp.path(), "telekey.3.log"), None);
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 3);
    }

    #[test]
    fn no_file_goes_over_the_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let log = RotatingFile::open(tmp.path(), 64, 3).unwrap();

        for n in 0..200 {
            log.append(format!("event number {n}\n").as_bytes())
                .unwrap();
        }

        for entry in fs::read_dir(tmp.path()).unwrap() {
            let len = entry.unwrap().metadata().unwrap().len();
            assert!(len <= 64, "a file reached {len} bytes");
        }
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 4);
    }

    #[test]
    fn carries_on_from_the_last_launch() {
        let tmp = tempfile::tempdir().unwrap();
        let earlier = format!("{}\n", "x".repeat(49));
        RotatingFile::open(tmp.path(), 100, 3)
            .unwrap()
            .append(earlier.as_bytes())
            .unwrap();

        // The next launch counts what is already there, so its first long
        // line sets the old file aside instead of running past the cap.
        let log = RotatingFile::open(tmp.path(), 100, 3).unwrap();
        let later = format!("{}\n", "y".repeat(59));
        log.append(later.as_bytes()).unwrap();

        assert_eq!(
            read(tmp.path(), "telekey.1.log").as_deref(),
            Some(earlier.as_str())
        );
        assert_eq!(read(tmp.path(), FILE_NAME).as_deref(), Some(later.as_str()));
    }

    #[test]
    fn a_line_longer_than_the_cap_is_written_whole() {
        let tmp = tempfile::tempdir().unwrap();
        let log = RotatingFile::open(tmp.path(), 10, 3).unwrap();
        let long = format!("{}\n", "z".repeat(40));

        log.append(b"short\n").unwrap();
        log.append(long.as_bytes()).unwrap();

        assert_eq!(
            read(tmp.path(), "telekey.1.log").as_deref(),
            Some("short\n")
        );
        assert_eq!(read(tmp.path(), FILE_NAME).as_deref(), Some(long.as_str()));
    }

    // Unix only: Windows may refuse to delete a folder while a file in it is
    // open, which is the very state this sets up.
    #[cfg(unix)]
    #[test]
    fn recreates_a_folder_deleted_while_running() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        let log = RotatingFile::open(&dir, 10, 3).unwrap();
        log.append(b"before\n").unwrap();

        fs::remove_dir_all(&dir).unwrap();
        log.append(b"after it was deleted\n").unwrap();
        log.append(b"and again\n").unwrap();

        assert_eq!(read(&dir, FILE_NAME).as_deref(), Some("and again\n"));
    }

    #[test]
    fn events_arrive_as_plain_text_lines() {
        use tracing_subscriber::prelude::*;

        let tmp = tempfile::tempdir().unwrap();
        let log = RotatingFile::open(tmp.path(), MAX_BYTES, KEPT).unwrap();
        let subscriber = tracing_subscriber::registry().with(file_layer(log));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(seconds = 3, "dictation finished");
            tracing::warn!("second line");
        });

        let text = read(tmp.path(), FILE_NAME).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].contains("INFO") && lines[0].contains("dictation finished seconds=3"));
        assert!(lines[1].contains("WARN") && lines[1].contains("second line"));
        assert!(
            !text.contains('\u{1b}'),
            "colour codes in the file: {text:?}"
        );
    }

    #[test]
    fn a_dependencys_trace_never_reaches_the_file() {
        use tracing_subscriber::prelude::*;

        let tmp = tempfile::tempdir().unwrap();
        let log = RotatingFile::open(tmp.path(), MAX_BYTES, KEPT).unwrap();
        let subscriber = tracing_subscriber::registry().with(file_layer(log));
        tracing::subscriber::with_default(subscriber, || {
            tracing::trace!(target: "tungstenite::handshake::client", "Request: Authorization: Bearer sk-secret");
            tracing::debug!(target: "hyper::proto", "headers");
            tracing::warn!(target: "tungstenite::protocol", "connection reset");
            tracing::debug!(target: "telekey_lib::live", "instant ready for audio");
        });

        let text = read(tmp.path(), FILE_NAME).unwrap();
        assert!(
            !text.contains("sk-secret") && !text.contains("headers"),
            "{text}"
        );
        assert!(text.contains("connection reset"), "{text}");
        assert!(text.contains("instant ready for audio"), "{text}");
    }

    #[test]
    fn lives_in_the_platforms_own_folder() {
        let dir = dir().expect("a log directory");
        #[cfg(target_os = "macos")]
        assert!(dir.ends_with("Library/Logs/TeleKey"), "{}", dir.display());
        #[cfg(not(target_os = "macos"))]
        assert!(
            dir.ends_with(Path::new("telekey").join("logs")),
            "{}",
            dir.display()
        );
    }
}
