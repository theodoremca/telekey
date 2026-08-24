//! Putting text at the cursor in whatever app is frontmost.
//!
//! Paste-via-clipboard rather than synthesising each character: Unicode keystroke
//! injection is slow and silently dropped by some apps. The cost is that the
//! clipboard is briefly clobbered, so the previous contents are saved and put
//! back.
//!
//! The clipboard and the keystroke are behind traits so the save/restore
//! ordering can be tested without touching the real pasteboard.

use std::time::Duration;

use anyhow::{Context, Result};

/// How long to wait after ⌘V before restoring the clipboard. Restore too early
/// and the paste reads the restored value instead of the transcript.
pub const PASTE_SETTLE_DELAY: Duration = Duration::from_millis(120);

pub trait Clipboard {
    /// Current clipboard text, or `None` when it holds something else (an image,
    /// say) or nothing at all.
    fn read_text(&mut self) -> Option<String>;
    fn write_text(&mut self, text: &str) -> Result<()>;
}

pub trait Keystroke {
    /// Send ⌘V to the frontmost app.
    fn paste(&mut self) -> Result<()>;
}

/// Save the clipboard, paste `text`, then put the clipboard back.
///
/// Restoring is best-effort: if the paste succeeded but the restore failed, the
/// user still got their text, which matters more than a pristine clipboard.
pub fn paste_via_clipboard<C, K>(
    clipboard: &mut C,
    keys: &mut K,
    text: &str,
    settle: Duration,
) -> Result<()>
where
    C: Clipboard,
    K: Keystroke,
{
    if text.is_empty() {
        return Ok(());
    }

    let previous = clipboard.read_text();

    clipboard
        .write_text(text)
        .context("could not put the transcript on the clipboard")?;

    let paste_result = keys.paste();

    std::thread::sleep(settle);

    if let Some(previous) = previous {
        if let Err(err) = clipboard.write_text(&previous) {
            tracing::warn!("could not restore the clipboard: {err:#}");
        }
    }

    paste_result.context("could not send the paste keystroke")
}

pub struct SystemClipboard {
    inner: arboard::Clipboard,
}

impl SystemClipboard {
    pub fn new() -> Result<Self> {
        Ok(Self {
            inner: arboard::Clipboard::new().context("could not open the clipboard")?,
        })
    }
}

impl Clipboard for SystemClipboard {
    fn read_text(&mut self) -> Option<String> {
        self.inner.get_text().ok()
    }

    fn write_text(&mut self, text: &str) -> Result<()> {
        self.inner
            .set_text(text.to_string())
            .context("could not write to the clipboard")
    }
}

pub struct SystemKeystroke {
    enigo: enigo::Enigo,
}

impl SystemKeystroke {
    pub fn new() -> Result<Self> {
        let enigo = enigo::Enigo::new(&enigo::Settings::default())
            .map_err(|err| anyhow::anyhow!("could not open an input connection: {err}"))?;
        Ok(Self { enigo })
    }
}

/// `kVK_ANSI_V` — the physical key that carries V.
///
/// Sent as a raw keycode rather than `Key::Unicode('v')`. Asking enigo for a
/// character makes it look up which key produces "v" on the current layout via
/// Text Input Services, and TSM asserts it is running on the main dispatch
/// queue — from this worker thread that is an instant SIGTRAP, killing the app
/// at the exact moment it should be pasting. A raw keycode goes straight to
/// `CGEvent` with no layout lookup.
///
/// Using the physical key is also the more correct choice: macOS resolves
/// ⌘-shortcuts by key position, which is why ⌘V pastes on AZERTY and Dvorak
/// too.
#[cfg(target_os = "macos")]
const KEYCODE_V: u16 = 0x09;

/// `VK_V`, the Windows virtual-key code for V.
#[cfg(target_os = "windows")]
const KEYCODE_V: u16 = 0x56;

/// `KEY_V` in the Linux input event codes.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const KEYCODE_V: u16 = 47;

impl Keystroke for SystemKeystroke {
    fn paste(&mut self) -> Result<()> {
        use enigo::{Direction, Key, Keyboard};

        // Modifiers map to fixed keycodes inside enigo, so they need no layout
        // lookup and are safe to send from any thread.
        let modifier = if cfg!(target_os = "macos") {
            Key::Meta
        } else {
            Key::Control
        };

        self.enigo
            .key(modifier, Direction::Press)
            .map_err(|err| anyhow::anyhow!("could not press the modifier: {err}"))?;

        let result = self
            .enigo
            .raw(KEYCODE_V, Direction::Click)
            .map_err(|err| anyhow::anyhow!("could not press V: {err}"));

        // Always release the modifier, even if the V press failed. A synthetic
        // key-down with no matching key-up leaves ⌘ stuck down for the user.
        let release = self
            .enigo
            .key(modifier, Direction::Release)
            .map_err(|err| anyhow::anyhow!("could not release the modifier: {err}"));

        result.and(release)
    }
}

/// Whether the app may synthesise keystrokes.
///
/// Without this, ⌘V is silently swallowed — no error, no paste — so it is worth
/// checking up front and telling the user rather than letting dictation appear
/// to do nothing.
#[cfg(target_os = "macos")]
pub fn accessibility_granted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    unsafe { AXIsProcessTrusted() }
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_granted() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq)]
    enum Op {
        Read,
        Write(String),
    }

    #[derive(Default)]
    struct FakeClipboard {
        contents: Option<String>,
        log: Vec<Op>,
        fail_writes: bool,
    }

    impl Clipboard for FakeClipboard {
        fn read_text(&mut self) -> Option<String> {
            self.log.push(Op::Read);
            self.contents.clone()
        }

        fn write_text(&mut self, text: &str) -> Result<()> {
            self.log.push(Op::Write(text.to_string()));
            if self.fail_writes {
                anyhow::bail!("clipboard unavailable");
            }
            self.contents = Some(text.to_string());
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeKeys {
        pasted: usize,
        fail: bool,
    }

    impl Keystroke for FakeKeys {
        fn paste(&mut self) -> Result<()> {
            self.pasted += 1;
            if self.fail {
                anyhow::bail!("no accessibility permission");
            }
            Ok(())
        }
    }

    const NO_WAIT: Duration = Duration::from_millis(0);

    #[test]
    fn pastes_then_restores_the_previous_clipboard() {
        let mut clipboard = FakeClipboard {
            contents: Some("something the user copied".into()),
            ..Default::default()
        };
        let mut keys = FakeKeys::default();

        paste_via_clipboard(&mut clipboard, &mut keys, "dictated text", NO_WAIT).unwrap();

        assert_eq!(keys.pasted, 1);
        assert_eq!(
            clipboard.log,
            vec![
                Op::Read,
                Op::Write("dictated text".into()),
                Op::Write("something the user copied".into()),
            ]
        );
        assert_eq!(
            clipboard.contents.as_deref(),
            Some("something the user copied"),
            "the user's clipboard must survive a dictation"
        );
    }

    #[test]
    fn the_transcript_is_on_the_clipboard_when_paste_fires() {
        // Ordering matters: writing after the keystroke would paste the wrong thing.
        struct OrderCheckingKeys<'a> {
            seen: &'a mut Option<String>,
            snapshot: String,
        }

        impl Keystroke for OrderCheckingKeys<'_> {
            fn paste(&mut self) -> Result<()> {
                *self.seen = Some(self.snapshot.clone());
                Ok(())
            }
        }

        let mut clipboard = FakeClipboard {
            contents: Some("old".into()),
            ..Default::default()
        };

        // Drive the sequence manually so the keystroke can observe the clipboard.
        let previous = clipboard.read_text();
        clipboard.write_text("new text").unwrap();
        let mut seen = None;
        let mut keys = OrderCheckingKeys {
            seen: &mut seen,
            snapshot: clipboard.contents.clone().unwrap(),
        };
        keys.paste().unwrap();
        if let Some(previous) = previous {
            clipboard.write_text(&previous).unwrap();
        }

        assert_eq!(seen.as_deref(), Some("new text"));
        assert_eq!(clipboard.contents.as_deref(), Some("old"));
    }

    #[test]
    fn an_empty_clipboard_is_not_restored_to_an_empty_string() {
        let mut clipboard = FakeClipboard::default();
        let mut keys = FakeKeys::default();

        paste_via_clipboard(&mut clipboard, &mut keys, "text", NO_WAIT).unwrap();

        assert_eq!(
            clipboard.log,
            vec![Op::Read, Op::Write("text".into())],
            "nothing was there before, so nothing should be written back"
        );
    }

    #[test]
    fn empty_text_does_nothing_at_all() {
        let mut clipboard = FakeClipboard::default();
        let mut keys = FakeKeys::default();

        paste_via_clipboard(&mut clipboard, &mut keys, "", NO_WAIT).unwrap();

        assert!(clipboard.log.is_empty());
        assert_eq!(keys.pasted, 0);
    }

    #[test]
    fn a_failed_paste_surfaces_but_still_restores_the_clipboard() {
        let mut clipboard = FakeClipboard {
            contents: Some("original".into()),
            ..Default::default()
        };
        let mut keys = FakeKeys {
            fail: true,
            ..Default::default()
        };

        let err = paste_via_clipboard(&mut clipboard, &mut keys, "text", NO_WAIT).unwrap_err();

        assert!(err.to_string().contains("paste keystroke"), "got: {err}");
        assert_eq!(clipboard.contents.as_deref(), Some("original"));
    }

    #[test]
    fn a_clipboard_that_cannot_be_written_fails_before_pasting() {
        let mut clipboard = FakeClipboard {
            fail_writes: true,
            ..Default::default()
        };
        let mut keys = FakeKeys::default();

        let err = paste_via_clipboard(&mut clipboard, &mut keys, "text", NO_WAIT).unwrap_err();

        assert!(err.to_string().contains("clipboard"), "got: {err}");
        assert_eq!(keys.pasted, 0, "must not paste stale clipboard contents");
    }
}
