//! Screen context: where the user is typing, sent with the audio so names and
//! terms on screen come back spelled right.
//!
//! Off unless the user switches on "Use what's on screen". Then, at key-down,
//! a thread reads the app, the focused window's title and up to ~1,000
//! characters around the cursor, and the transcription request carries them
//! as its `prompt`. Measured: with an email thread above the cursor, "Ask
//! Shivani Nandi … EK Chukwu … Ifa" became "Ask Siobhan and Nnamdi …
//! Ikechukwu … Aoife".
//!
//! What it never does:
//! - read anything while a password is being typed anywhere (secure input),
//!   or from a password field;
//! - read text in a terminal or a password manager (the title only);
//! - copy a whole document: only the window around the cursor is fetched;
//! - log or store the text. Logs carry lengths; the text is wiped after use.
//!
//! macOS reads through the Accessibility grant TeleKey already holds for
//! pasting. Windows sends the app and window title. Linux sends nothing.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use zeroize::Zeroize;

use crate::frontmost::TargetApp;

/// The most screen context a request carries, in UTF-8 bytes. The server and
/// the relay enforce the same cap.
pub const MAX_PROMPT_BYTES: usize = 1_500;

/// Characters fetched before and after the cursor, in the UTF-16 units the
/// Accessibility API counts in.
const BEFORE_CURSOR: usize = 1_000;
const AFTER_CURSOR: usize = 200;

/// How long any one Accessibility call may take. Set once for the whole
/// process; a hung app then costs this, not the system's six seconds.
#[cfg(target_os = "macos")]
const AX_TIMEOUT_SECS: f32 = 0.25;

/// Apps whose text is not ours to send: terminal scrollback holds commands
/// and secrets, and password managers hold passwords. The title only.
const TITLE_ONLY: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "com.mitchellh.ghostty",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "io.alacritty",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
];

/// What was read for one dictation. `Debug` never prints the text.
#[derive(Default, Clone, PartialEq, Eq)]
pub struct ScreenContext {
    pub app: Option<String>,
    pub title: Option<String>,
    pub nearby: Option<String>,
}

impl std::fmt::Debug for ScreenContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScreenContext")
            .field("app", &self.app)
            .field("title", &self.title.as_ref().map(|_| "…"))
            .field("nearby_chars", &self.nearby.as_ref().map(|t| t.chars().count()))
            .finish()
    }
}

impl Drop for ScreenContext {
    fn drop(&mut self) {
        if let Some(title) = self.title.as_mut() {
            title.zeroize();
        }
        if let Some(nearby) = self.nearby.as_mut() {
            nearby.zeroize();
        }
    }
}

/// The prompt for one dictation, filled in by the capture thread.
///
/// One per dictation, handed along with it: a slow read from a quick tap can
/// only ever land in its own dictation, never in the next one.
#[derive(Default)]
pub struct ContextSlot {
    state: Mutex<SlotState>,
    filled: Condvar,
}

#[derive(Default)]
struct SlotState {
    done: bool,
    prompt: Option<String>,
}

impl ContextSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn fill(&self, prompt: Option<String>) {
        let mut state = self.state.lock();
        state.prompt = prompt;
        state.done = true;
        self.filled.notify_all();
    }

    /// The prompt if the capture has finished: `None` while it is still
    /// running, `Some(None)` when it found nothing to send. A copy: Instant
    /// reads it, and Standard may need it again if Instant falls through.
    /// The slot wipes its own when the dictation drops it.
    pub fn try_get(&self) -> Option<Option<String>> {
        let state = self.state.lock();
        state.done.then(|| state.prompt.clone())
    }

    /// The prompt, waiting at most `limit` for the capture to finish.
    pub fn get_within(&self, limit: Duration) -> Option<String> {
        let deadline = Instant::now() + limit;
        let mut state = self.state.lock();
        while !state.done {
            if self.filled.wait_until(&mut state, deadline).timed_out() {
                return None;
            }
        }
        state.prompt.clone()
    }
}

impl Drop for SlotState {
    fn drop(&mut self) {
        if let Some(prompt) = self.prompt.as_mut() {
            prompt.zeroize();
        }
    }
}

/// Start reading the screen for this dictation, on its own thread, and
/// return the slot the prompt will arrive in. Never blocks the caller.
pub fn start(target: TargetApp) -> Arc<ContextSlot> {
    let slot = ContextSlot::new();
    let filled = Arc::clone(&slot);
    let spawned = std::thread::Builder::new()
        .name("telekey-context".into())
        .spawn(move || {
            let started = Instant::now();
            let context = capture(&target);
            tracing::debug!(
                app = context.app.as_deref(),
                title = context.title.is_some(),
                nearby_chars = context.nearby.as_ref().map_or(0, |t| t.chars().count()),
                ms = started.elapsed().as_millis() as u64,
                "screen context"
            );
            filled.fill(prompt_for(&context));
        });
    if spawned.is_err() {
        slot.fill(None);
    }
    slot
}

/// The prompt a transcription request carries: the app, the window and the
/// text near the cursor, capped at [`MAX_PROMPT_BYTES`].
pub fn prompt_for(context: &ScreenContext) -> Option<String> {
    let app = context.app.as_deref().map(str::trim).filter(|s| !s.is_empty())?;
    let mut prompt = match context.title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(title) => format!("Dictating into {app} — {title}."),
        None => format!("Dictating into {app}."),
    };
    if let Some(nearby) = context.nearby.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        prompt.push_str("\nText near the cursor: ");
        prompt.push_str(nearby);
    }
    Some(truncate_bytes(prompt, MAX_PROMPT_BYTES))
}

/// Cut to at most `limit` bytes, on a character boundary.
fn truncate_bytes(mut text: String, limit: usize) -> String {
    if text.len() > limit {
        let mut end = limit;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// The range to fetch around the cursor, in the units the text is counted
/// in: up to `before` ending at the cursor and `after` beyond it, inside a
/// text `total` long. Returns `(start, length)`.
fn window_around(total: usize, cursor: usize, before: usize, after: usize) -> (usize, usize) {
    let cursor = cursor.min(total);
    let start = cursor.saturating_sub(before);
    let end = cursor.saturating_add(after).min(total);
    (start, end - start)
}

fn title_only(target: &TargetApp) -> bool {
    target
        .bundle_id
        .as_deref()
        .is_some_and(|id| TITLE_ONLY.iter().any(|known| known.eq_ignore_ascii_case(id)))
}

/// Read the screen for `target`. Blocking: run it off the pipeline thread.
#[cfg(target_os = "macos")]
pub fn capture(target: &TargetApp) -> ScreenContext {
    let mut context = ScreenContext {
        app: target.name.clone(),
        title: None,
        nearby: None,
    };
    // A password is being typed somewhere: read nothing at all.
    if macos::secure_input() || !crate::inject::accessibility_granted() {
        return context;
    }
    let Some(pid) = target.pid else {
        return context;
    };
    let read = macos::read(pid, !title_only(target));
    context.title = read.title;
    context.nearby = read.nearby;
    context
}

/// Windows: the app and the window title, which `frontmost_app` already read.
#[cfg(target_os = "windows")]
pub fn capture(target: &TargetApp) -> ScreenContext {
    ScreenContext {
        app: target.name.clone(),
        title: target.title.clone(),
        nearby: None,
    }
}

/// Linux: nothing yet. There is no frontmost app to read (`frontmost.rs`).
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn capture(_target: &TargetApp) -> ScreenContext {
    ScreenContext::default()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ptr::NonNull;

    use objc2_application_services::{AXError, AXUIElement, AXValue, AXValueType};
    use objc2_core_foundation::{CFNumber, CFRange, CFRetained, CFString, CFType};

    use super::{window_around, AFTER_CURSOR, AX_TIMEOUT_SECS, BEFORE_CURSOR};

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        /// True while any app has secure input on, i.e. a password field is
        /// focused somewhere.
        fn IsSecureEventInputEnabled() -> u8;
    }

    pub fn secure_input() -> bool {
        // SAFETY: no arguments, no state; documented as callable any time.
        unsafe { IsSecureEventInputEnabled() != 0 }
    }

    pub struct Read {
        pub title: Option<String>,
        pub nearby: Option<String>,
    }

    pub fn read(pid: i32, with_text: bool) -> Read {
        set_timeout_once();
        // SAFETY: a pid from NSRunningApplication; the element is only a
        // handle, and every call below fails cleanly if the app is gone.
        let app = unsafe { AXUIElement::new_application(pid) };

        let title = attribute(&app, "AXFocusedWindow")
            .and_then(|window| window.downcast::<AXUIElement>().ok())
            .and_then(|window| string_attribute(&window, "AXTitle"))
            .filter(|title| !title.trim().is_empty());

        let nearby = if with_text { text_near_cursor(&app) } else { None };
        Read { title, nearby }
    }

    fn text_near_cursor(app: &AXUIElement) -> Option<String> {
        let focused = attribute(app, "AXFocusedUIElement")?
            .downcast::<AXUIElement>()
            .ok()?;
        let secure = |name: &str| {
            string_attribute(&focused, name).is_some_and(|value| value == "AXSecureTextField")
        };
        if secure("AXRole") || secure("AXSubrole") {
            return None;
        }

        // Counted in UTF-16 units, as the selection is. Fetching just the
        // window below never copies a large document over IPC.
        let total = attribute(&focused, "AXNumberOfCharacters")?
            .downcast::<CFNumber>()
            .ok()?
            .as_i64()?;
        let selection = attribute(&focused, "AXSelectedTextRange")?
            .downcast::<AXValue>()
            .ok()?;
        let mut range = CFRange { location: 0, length: 0 };
        // SAFETY: the out-pointer is a valid CFRange for the requested type.
        let ok = unsafe {
            selection.value(
                AXValueType::CFRange,
                NonNull::from(&mut range).cast(),
            )
        };
        if !ok || total <= 0 {
            return None;
        }

        let (start, length) = window_around(
            total as usize,
            range.location.max(0) as usize,
            BEFORE_CURSOR,
            AFTER_CURSOR,
        );
        if length == 0 {
            return None;
        }
        let wanted = CFRange {
            location: start as isize,
            length: length as isize,
        };
        // SAFETY: the value pointer refers to a CFRange matching the type.
        let parameter = unsafe {
            AXValue::new(AXValueType::CFRange, NonNull::from(&wanted).cast())
        }?;
        let text = parameterized(&focused, "AXStringForRange", &parameter)?
            .downcast::<CFString>()
            .ok()?
            .to_string();
        // A range that split a surrogate pair leaves a replacement character
        // at either end.
        let text = text.trim_matches('\u{FFFD}').trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    fn set_timeout_once() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            // Set on the system-wide element, it applies to every element
            // this process talks to.
            // SAFETY: plain handle creation and a scalar setter.
            unsafe {
                let system = AXUIElement::new_system_wide();
                let _ = system.set_messaging_timeout(AX_TIMEOUT_SECS);
            }
        });
    }

    fn attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
        let name = CFString::from_str(name);
        let mut value: *const CFType = std::ptr::null();
        // SAFETY: a valid out-pointer; on success it holds a +1 reference we
        // take ownership of exactly once.
        let error = unsafe { element.copy_attribute_value(&name, NonNull::from(&mut value)) };
        if error != AXError::Success {
            return None;
        }
        NonNull::new(value.cast_mut()).map(|value| unsafe { CFRetained::from_raw(value) })
    }

    fn parameterized(
        element: &AXUIElement,
        name: &str,
        parameter: &CFType,
    ) -> Option<CFRetained<CFType>> {
        let name = CFString::from_str(name);
        let mut value: *const CFType = std::ptr::null();
        // SAFETY: as in `attribute`.
        let error = unsafe {
            element.copy_parameterized_attribute_value(&name, parameter, NonNull::from(&mut value))
        };
        if error != AXError::Success {
            return None;
        }
        NonNull::new(value.cast_mut()).map(|value| unsafe { CFRetained::from_raw(value) })
    }

    fn string_attribute(element: &AXUIElement, name: &str) -> Option<String> {
        attribute(element, name)?
            .downcast::<CFString>()
            .ok()
            .map(|value| value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(app: &str, title: Option<&str>, nearby: Option<&str>) -> ScreenContext {
        ScreenContext {
            app: Some(app.into()),
            title: title.map(str::to_string),
            nearby: nearby.map(str::to_string),
        }
    }

    #[test]
    fn the_prompt_names_the_app_the_window_and_the_text() {
        let prompt = prompt_for(&context(
            "Mail",
            Some("Re: Hordanso invoice"),
            Some("Hi Ikechukwu, thanks for the invoice."),
        ))
        .unwrap();
        assert_eq!(
            prompt,
            "Dictating into Mail — Re: Hordanso invoice.\nText near the cursor: Hi Ikechukwu, thanks for the invoice."
        );
    }

    #[test]
    fn what_is_missing_is_left_out() {
        assert_eq!(prompt_for(&context("Notes", None, None)).unwrap(), "Dictating into Notes.");
        assert_eq!(
            prompt_for(&context("Notes", Some("  "), Some(""))).unwrap(),
            "Dictating into Notes."
        );
        assert!(prompt_for(&ScreenContext::default()).is_none());
    }

    #[test]
    fn the_prompt_is_capped_on_a_character_boundary() {
        let long = "é".repeat(2_000);
        let prompt = prompt_for(&context("Notes", None, Some(&long))).unwrap();
        assert!(prompt.len() <= MAX_PROMPT_BYTES);
        assert!(prompt.is_char_boundary(prompt.len()));
        let emoji = "👋".repeat(1_000);
        let prompt = prompt_for(&context("Notes", None, Some(&emoji))).unwrap();
        assert!(prompt.len() <= MAX_PROMPT_BYTES);
    }

    #[test]
    fn the_window_is_taken_around_the_cursor() {
        // Cursor in the middle of a long document.
        assert_eq!(window_around(10_000, 5_000, 1_000, 200), (4_000, 1_200));
        // Near the start: less before.
        assert_eq!(window_around(10_000, 300, 1_000, 200), (0, 500));
        // At the end: nothing after.
        assert_eq!(window_around(800, 800, 1_000, 200), (0, 800));
        // A cursor past the end (a stale selection) is clamped.
        assert_eq!(window_around(100, 5_000, 1_000, 200), (0, 100));
        assert_eq!(window_around(0, 0, 1_000, 200), (0, 0));
    }

    #[test]
    fn terminals_and_password_managers_send_the_title_only() {
        let terminal = TargetApp {
            bundle_id: Some("com.apple.Terminal".into()),
            ..TargetApp::default()
        };
        let mail = TargetApp {
            bundle_id: Some("com.apple.mail".into()),
            ..TargetApp::default()
        };
        assert!(title_only(&terminal));
        assert!(!title_only(&mail));
        assert!(!title_only(&TargetApp::default()));
    }

    #[test]
    fn debug_never_prints_the_text() {
        let shown = format!(
            "{:?}",
            context("Mail", Some("Salary review"), Some("my password is hunter2"))
        );
        assert!(!shown.contains("hunter2"), "{shown}");
        assert!(!shown.contains("Salary"), "{shown}");
        assert!(shown.contains("nearby_chars"), "{shown}");
    }

    #[test]
    fn the_slot_answers_only_once_filled_and_keeps_answering() {
        let slot = ContextSlot::new();
        assert_eq!(slot.try_get(), None, "not filled yet");
        assert_eq!(slot.get_within(Duration::from_millis(5)), None);
        slot.fill(Some("Dictating into Notes.".into()));
        assert_eq!(slot.try_get(), Some(Some("Dictating into Notes.".into())));
        // Still there for Standard if Instant read it and then fell through.
        assert_eq!(
            slot.get_within(Duration::ZERO).as_deref(),
            Some("Dictating into Notes.")
        );
    }

    #[test]
    fn a_waiting_reader_gets_the_prompt_when_it_arrives() {
        let slot = ContextSlot::new();
        let filler = Arc::clone(&slot);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            filler.fill(Some("late".into()));
        });
        assert_eq!(slot.get_within(Duration::from_secs(2)).as_deref(), Some("late"));
    }
}
