//! The smart pass: spoken lists become bullets, and "my car, sorry, my bike"
//! becomes "my bike".
//!
//! Both are opt-in, and both cost a model call, so neither runs unless a
//! check here hears its cue first: most dictations never reach the model.
//! When both fire, one call carries both instructions.
//!
//! The model's answer is checked before it is pasted. Its words must all be
//! the dictation's own, in order, and every stretch it left out must be a
//! correction ("sorry", "I mean", "scratch that") or a list marker ("first",
//! "then", "finally"). Anything else — a reworded sentence, a dropped "next
//! week" — and the dictation is pasted as spoken. In testing, the model once
//! turned "First of all, thanks for coming tonight. Next week we will talk
//! about the roadmap." into "Thanks for coming tonight. We will talk about
//! the roadmap."; this check is why that would never be pasted.

use crate::frontmost::TargetApp;

/// Instruction for corrections. Tuned on samples: an earlier wording took
/// "I mean it" for a correction and dropped half a sentence.
pub const CORRECTION_GUIDANCE: &str = "Self-corrections: only when the speaker says a word or \
phrase, then a cue such as \"sorry\", \"I mean\", \"no wait\" or \"actually\", then a \
replacement for it, keep only the replacement and drop the mistaken words and the cue. \
\"Scratch that\" or \"delete that\" drops the sentence before it. Everything else stays \
exactly as dictated: an apology (\"Sorry I'm late\"), \"I mean it\", \"actually\" used for \
emphasis, and every other word.";

/// Instruction for lists.
pub const LIST_GUIDANCE: &str = "Lists: if the text is a list of three or more items, put one \
item per line. Start each with \"1. \", \"2. \" and so on when the speaker numbered the items \
or gave steps in order (first, then, finally); otherwise with \"- \". Keep a sentence that \
introduces the list on its own line, ending in a colon. Drop spoken markers such as \"first\", \
\"second\", \"then\", \"finally\", \"number one\". No full stop after items. If it is not a \
list, leave it as it is.";

/// Where a list in the paste does harm: a terminal runs each line as a
/// command, and an editor wants code, not bullets.
const NO_LISTS: &[&str] = &[
    // macOS bundle ids
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "com.mitchellh.ghostty",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "io.alacritty",
    "com.microsoft.VSCode",
    "com.todesktop.230313mzl4w4u92",
    "com.apple.dt.Xcode",
    "dev.zed.Zed",
    // Windows executable names
    "WindowsTerminal",
    "pwsh",
    "powershell",
    "cmd",
    "Code",
    "Cursor",
];

/// Whether lists should be left alone in this app.
pub fn no_lists_in(target: &TargetApp) -> bool {
    let key = target.profile_key();
    NO_LISTS.iter().any(|known| known.eq_ignore_ascii_case(key))
        || key.starts_with("com.jetbrains.")
}

const ORDINALS: &[&str] = &[
    "first", "firstly", "second", "secondly", "third", "thirdly", "fourth", "fourthly",
    "fifth", "lastly", "finally", "next",
];

/// Words after an ordinal that make it a phrase, not a list item: "first of
/// all", "next week".
const NOT_AN_ITEM: &[&str] = &[
    "of", "time", "times", "week", "weeks", "day", "days", "month", "year", "morning",
    "evening", "night", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    "sunday", "thing", "step", "up", "place",
];

const LIST_PHRASES: &[&str] = &[
    "bullet point",
    "bullet points",
    "as follows",
    "the following:",
    "a list of",
    "here's a list",
    "here is a list",
];

/// Whether a dictation sounds like a list: two different ordinals starting
/// clauses ("first … second …", "number one … number two"), a phrase that
/// announces a list, or a colon followed by three or more items.
pub fn sounds_like_a_list(text: &str) -> bool {
    let lower = text.to_lowercase();
    if LIST_PHRASES.iter().any(|phrase| lower.contains(phrase)) {
        return true;
    }

    let mut cues = std::collections::BTreeSet::new();
    for clause in lower.split(['.', ';', ':', ',', '!', '?', '\n']) {
        let words: Vec<&str> = clause.split_whitespace().collect();
        // "and third", "then finally": skip the joining words.
        let mut rest = words.as_slice();
        while let Some((&first, tail)) = rest.split_first() {
            if matches!(first, "and" | "then" | "also" | "so") {
                rest = tail;
            } else {
                break;
            }
        }
        match rest {
            ["number", n, ..] if is_count_word(n) => {
                cues.insert(format!("number {n}"));
            }
            [ordinal, next, ..] if ORDINALS.contains(ordinal) && NOT_AN_ITEM.contains(next) => {}
            [ordinal, ..] if ORDINALS.contains(ordinal) => {
                cues.insert((*ordinal).to_string());
            }
            _ => {}
        }
    }
    if cues.len() >= 2 {
        return true;
    }

    // "I need: eggs, milk and bread." A colon after a word and before a
    // space; not a clock time (10:30) or a link (https://).
    let introduced = lower.char_indices().find_map(|(at, c)| {
        let before = lower[..at].chars().next_back();
        let after = lower[at + 1..].chars().next();
        (c == ':'
            && before.is_some_and(char::is_alphabetic)
            && after.is_some_and(char::is_whitespace))
        .then(|| &lower[at + 1..])
    });
    if let Some(after) = introduced {
        let commas = after.matches(',').count();
        let joined = after.contains(" and ") || after.contains(" or ");
        if commas >= 2 || (commas >= 1 && joined) {
            return true;
        }
    }
    false
}

fn is_count_word(word: &str) -> bool {
    matches!(
        word,
        "one" | "two" | "three" | "four" | "five" | "six" | "1" | "2" | "3" | "4" | "5" | "6"
    )
}

/// Whether a dictation sounds like the speaker corrected themselves.
///
/// Generous on purpose: an apology ("Sorry I'm late") passing this check
/// costs one model call, and the model is told to keep it.
pub fn sounds_like_a_correction(text: &str) -> bool {
    let lower = text.to_lowercase();
    let phrases = [
        "i meant", "no wait", "wait, no", "wait no", "scratch that", "delete that",
        "let me rephrase", "correction", ", actually,", "actually no", "no, actually",
        "or rather",
    ];
    if phrases.iter().any(|phrase| lower.contains(phrase)) {
        return true;
    }
    // "I mean Thursday" (or "I mean Italy"), but not "I mean it".
    let mut rest = lower.as_str();
    while let Some(at) = rest.find("i mean") {
        let after = rest[at + "i mean".len()..].trim_start_matches([',', ' ']);
        let next = after.split(|c: char| !c.is_alphanumeric()).next().unwrap_or("");
        if !next.is_empty() && next != "it" {
            return true;
        }
        rest = &rest[at + "i mean".len()..];
    }
    // "sorry" after something in the same sentence: "my car, sorry, my bike".
    lower
        .split(['.', '!', '?', '\n'])
        .any(|sentence| {
            let sentence = sentence.trim_start();
            sentence.find("sorry").is_some_and(|at| at > 0)
        })
}

/// Whether the model returned a list: two or more lines that start like one.
pub fn is_list_output(text: &str) -> bool {
    text.lines().filter(|line| list_item(line).is_some()).count() >= 2
}

/// The item text of a list line, and whether it is numbered.
fn list_item(line: &str) -> Option<(&str, bool)> {
    let line = line.trim_start();
    if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("• ")) {
        return Some((rest.trim(), false));
    }
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && digits <= 3 {
        let rest = &line[digits..];
        if let Some(item) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return Some((item.trim(), true));
        }
    }
    None
}

/// The same list as HTML, so editors that take rich text (Notes, Mail,
/// Slack, Docs) make real bullets of it. `None` when it is not a list.
pub fn list_html(text: &str) -> Option<String> {
    if !is_list_output(text) {
        return None;
    }
    let mut html = String::new();
    let mut open: Option<bool> = None; // Some(numbered) while a list is open
    for line in text.lines() {
        match list_item(line) {
            Some((item, numbered)) => {
                if open != Some(numbered) {
                    if let Some(was) = open {
                        html.push_str(if was { "</ol>" } else { "</ul>" });
                    }
                    html.push_str(if numbered { "<ol>" } else { "<ul>" });
                    open = Some(numbered);
                }
                html.push_str("<li>");
                html.push_str(&escape(item));
                html.push_str("</li>");
            }
            None => {
                if let Some(was) = open.take() {
                    html.push_str(if was { "</ol>" } else { "</ul>" });
                }
                if !line.trim().is_empty() {
                    html.push_str("<p>");
                    html.push_str(&escape(line.trim()));
                    html.push_str("</p>");
                }
            }
        }
    }
    if let Some(was) = open {
        html.push_str(if was { "</ol>" } else { "</ul>" });
    }
    Some(html)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Words a list may lose: the spoken markers it replaces with bullets.
const LIST_MARKERS: &[&str] = &[
    "first", "firstly", "second", "secondly", "third", "thirdly", "fourth", "fourthly", "fifth",
    "sixth", "seventh", "eighth", "ninth", "tenth", "next", "then", "finally", "lastly",
    "number", "bullet", "point", "points",
];

/// Joining words a list may also lose between items: "milk and bread".
const LIST_JOINERS: &[&str] = &["and", "also", "plus", "or"];

/// Counts a list may lose only as part of a marker ("number one"), never on
/// their own: "two apples" without the "two" is a different list.
const LIST_COUNTS: &[&str] = &[
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
];

/// Whether a dropped stretch is just list scaffolding. A count goes only
/// as part of "number one"; "first two apples" keeps its "two".
fn only_list_markers(span: &[&str]) -> bool {
    span.iter().enumerate().all(|(at, w)| {
        LIST_MARKERS.contains(w)
            || LIST_JOINERS.contains(w)
            || (LIST_COUNTS.contains(w) && at > 0 && span[at - 1] == "number")
    })
}

/// Words that mark a correction; a dropped stretch must contain one.
const CORRECTION_CUES: &[&str] = &[
    "sorry", "mean", "meant", "wait", "actually", "scratch", "delete", "correction",
    "rephrase", "rather", "no",
];

/// Whether the model's answer only did what was asked: every word of
/// `after` is the dictation's own, in order, and each stretch it dropped is
/// a correction (when corrections were asked for) or list markers (when a
/// list was).
pub fn acceptable(before: &str, after: &str, lists: bool, corrections: bool) -> bool {
    let spoken = tokens(before);
    let b: Vec<String> = spoken.iter().map(|t| t.word.clone()).collect();
    let a = words(&without_list_numbers(after));
    if a.is_empty() {
        return false;
    }
    let Some(kept) = keep_in_order(&b, &a) else {
        return false;
    };

    // Check each run of dropped words, by where it starts and ends.
    let dropped_ok = |start: usize, end: usize| {
        let span: Vec<&str> = b[start..end].iter().map(String::as_str).collect();
        span.is_empty()
            || (corrections && is_correction(&spoken, start, end))
            || (lists && only_list_markers(&span))
    };
    let mut start = 0;
    for (index, survives) in kept.iter().enumerate() {
        if *survives {
            if !dropped_ok(start, index) {
                return false;
            }
            start = index + 1;
        }
    }
    dropped_ok(start, b.len())
}

/// Whether the dropped words `spoken[start..end]` are a correction.
///
/// "Scratch that" (or "delete that") may take the sentence before it. Any
/// other cue must end the dropped words — what follows it is the replacement,
/// and must be kept — and may take only as many words before it as the
/// replacement has, plus one, within one sentence: "my car" for "my bike",
/// "the hiring plan" for "the hiring freeze", but not "we lost the logs" for
/// "the backups". "I mean it" is not a cue.
fn is_correction(spoken: &[Token], start: usize, end: usize) -> bool {
    let span: Vec<&str> = spoken[start..end].iter().map(|t| t.word.as_str()).collect();
    let scratch = span
        .windows(2)
        .any(|pair| matches!(pair, [cue, "that"] if *cue == "scratch" || *cue == "delete"));
    if scratch {
        return true;
    }
    if !matches!(span.last(), Some(last) if CORRECTION_CUES.contains(last)) {
        return false;
    }
    // A sentence may not end inside what was dropped.
    if spoken[start..end - 1].iter().any(|t| t.ends_sentence) {
        return false;
    }
    // The cue itself may be several words: "no wait", "I mean", "or rather".
    let cue_words = span
        .iter()
        .rev()
        .take_while(|w| CORRECTION_CUES.contains(w) || matches!(**w, "i" | "or"))
        .count();
    let mistaken = span.len() - cue_words;
    // The replacement: from after the cue to the end of its phrase.
    let replacement = spoken[end..]
        .iter()
        .position(|t| t.ends_phrase)
        .map_or(spoken.len() - end, |at| at + 1);
    mistaken >= 1 && mistaken <= replacement + 1
}

/// The text with list numbering and bullets taken off each line, so "1."
/// is not mistaken for a word while a spoken "500" still counts.
fn without_list_numbers(text: &str) -> String {
    text.lines()
        .map(|line| list_item(line).map_or(line, |(item, _)| item))
        .collect::<Vec<_>>()
        .join("\n")
}

/// For each word of `b`, whether it survives in `a`, when `a` is `b` with
/// words removed; `None` when `a` has a word `b` does not, or reorders them.
/// Longest common subsequence.
fn keep_in_order(b: &[String], a: &[String]) -> Option<Vec<bool>> {
    let (n, m) = (b.len(), a.len());
    if m > n {
        return None;
    }
    let mut table = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i][j] = if b[i] == a[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    if usize::from(table[0][0]) != m {
        return None;
    }
    // Drop a word whenever that costs nothing, so a repeated phrase keeps its
    // later copy: a correction takes back what came first ("let's meet at
    // three. Scratch that, let's meet at four").
    let mut kept = vec![false; n];
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if table[i + 1][j] == table[i][j] {
            i += 1;
        } else if b[i] == a[j] {
            kept[i] = true;
            i += 1;
            j += 1;
        } else {
            j += 1;
        }
    }
    Some(kept)
}

/// Lowercased words without surrounding punctuation, so "Run" matches
/// "run". Numbers are words too: an answer that loses "500" is refused.
fn words(text: &str) -> Vec<String> {
    tokens(text).into_iter().map(|t| t.word).collect()
}

/// A spoken word, and the punctuation the transcriber put after it.
struct Token {
    word: String,
    /// A full stop, question mark or exclamation mark follows.
    ends_sentence: bool,
    /// Any of those, or a comma, semicolon or colon.
    ends_phrase: bool,
}

fn tokens(text: &str) -> Vec<Token> {
    text.split_whitespace()
        .filter_map(|raw| {
            let word = raw
                .trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
                .to_lowercase();
            let tail = raw.trim_end_matches(['"', '\'', ')', '”', '’']);
            let ends_sentence = tail.ends_with(['.', '!', '?']);
            let ends_phrase = ends_sentence || tail.ends_with([',', ';', ':']);
            (!word.is_empty()).then_some(Token {
                word,
                ends_sentence,
                ends_phrase,
            })
        })
        .collect()
}

/// Dictations longer than this skip the check's word alignment, which is
/// quadratic; at this length the smart pass is skipped altogether.
pub const MAX_WORDS: usize = 600;

/// Whether a dictation is short enough for the smart pass.
pub fn within_limit(text: &str) -> bool {
    text.split_whitespace().count() <= MAX_WORDS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_are_heard() {
        for text in [
            "For the trip I need three things: first, my passport; second, the charger; and third, some snacks.",
            "To deploy, first run the tests, then build the bundle, and finally upload it.",
            "Number one, the budget. Number two, hiring.",
            "Agenda: the budget, the hiring freeze and the offsite.",
            "Here's a list of what we need.",
            "Firstly the venue. Secondly the catering.",
        ] {
            assert!(sounds_like_a_list(text), "should sound like a list: {text}");
        }
    }

    #[test]
    fn ordinary_sentences_are_not_lists() {
        for text in [
            "It was the first time I had been there.",
            "First of all, thanks for coming tonight. Next week we will talk about the roadmap.",
            "See you next week.",
            "The following day we flew home.",
            "First, thanks for coming.",
            "Can you send the contract over before lunch?",
            "Re: the invoice, I'll pay it tomorrow.",
        ] {
            assert!(!sounds_like_a_list(text), "should not sound like a list: {text}");
        }
    }

    #[test]
    fn corrections_are_heard() {
        for text in [
            "I'm going to be using my car, sorry, my bike, to get to the office.",
            "Send it to Tuesday's team, I mean Thursday's team.",
            "Let's meet at three. Scratch that, let's meet at four.",
            "Book the red one, no wait, the blue one.",
            "It costs ten pounds, or rather twelve.",
        ] {
            assert!(sounds_like_a_correction(text), "should sound like a correction: {text}");
        }
    }

    #[test]
    fn plain_sentences_are_not_corrections() {
        for text in [
            "Sorry I'm late, the traffic was awful.",
            "I mean it, thank you so much.",
            "Can you send the contract over before lunch?",
        ] {
            assert!(!sounds_like_a_correction(text), "should not sound like a correction: {text}");
        }
    }

    #[test]
    fn a_real_correction_is_accepted() {
        assert!(acceptable(
            "I'm going to be using my car, sorry, my bike, to get to the office tomorrow.",
            "I'm going to be using my bike to get to the office tomorrow.",
            false,
            true
        ));
        assert!(acceptable(
            "Let's meet at three. Scratch that, let's meet at four instead.",
            "Let's meet at four instead.",
            false,
            true
        ));
        assert!(acceptable(
            "Send it to Tuesday's team, I mean Thursday's team, before lunch.",
            "Send it to Thursday's team before lunch.",
            false,
            true
        ));
    }

    #[test]
    fn dropping_words_that_are_not_a_correction_is_refused() {
        // The model, once, on an apology: half the sentence gone.
        assert!(!acceptable(
            "Sorry I'm late, the meeting ran over. I mean it, I'll be on time next week.",
            "Sorry I'm late, I'll be on time next week.",
            false,
            true
        ));
        // And on a non-list: "First of all" and "Next week" gone.
        assert!(!acceptable(
            "First of all, thanks for coming tonight. Next week we will talk about the roadmap.",
            "Thanks for coming tonight. We will talk about the roadmap.",
            true,
            false
        ));
    }

    #[test]
    fn a_lost_or_changed_number_is_refused() {
        assert!(!acceptable("Let's meet at 3, no wait, 4.", "Let's meet at 3.", false, true));
        assert!(acceptable("Let's meet at 3, no wait, 4.", "Let's meet at 4.", false, true));
        assert!(!acceptable("Send 500 pounds to Tom, sorry, Tim.", "Send pounds to Tim.", false, true));
        assert!(!acceptable(
            "Shopping list: first two apples, second three oranges, third four pears.",
            "Shopping list:\n- apples\n- oranges\n- pears",
            true,
            false
        ));
        assert!(acceptable(
            "Shopping list: first two apples, second three oranges, third four pears.",
            "Shopping list:\n1. two apples\n2. three oranges\n3. four pears",
            true,
            false
        ));
    }

    #[test]
    fn a_correction_cannot_take_an_earlier_sentence_with_it() {
        // Only "scratch that" retracts a sentence.
        assert!(!acceptable(
            "The server crashed. We lost the logs, sorry, the backups.",
            "The server crashed. The backups.",
            false,
            true
        ));
        assert!(!acceptable(
            "The server crashed at noon. We lost the logs, sorry, the backups.",
            "The backups.",
            false,
            true
        ));
        assert!(acceptable(
            "The server crashed. We lost the logs, sorry, the backups.",
            "The server crashed. We lost the backups.",
            false,
            true
        ));
    }

    #[test]
    fn list_numbers_count_for_nothing_but_joining_words_may_go() {
        assert!(acceptable(
            "I need eggs, milk and bread.",
            "I need:\n- eggs\n- milk\n- bread",
            true,
            false
        ));
        assert!(acceptable(
            "Number one, the budget. Number two, hiring.",
            "1. The budget\n2. Hiring",
            true,
            false
        ));
    }

    #[test]
    fn clock_times_and_links_are_not_lists() {
        assert!(!sounds_like_a_list("Meet at 10:30, then 11:30 and 12:30 if needed."));
        assert!(!sounds_like_a_list("See https://example.com/a, b and c for details."));
        assert!(sounds_like_a_list("I need: eggs, milk and bread."));
    }

    #[test]
    fn i_mean_is_heard_before_any_word_but_it() {
        assert!(sounds_like_a_correction("Fly to Spain, I mean Italy, next week."));
        assert!(sounds_like_a_correction("Bring the laptop, I mean the item on my desk."));
        assert!(!sounds_like_a_correction("I mean it, thank you."));
        assert!(!sounds_like_a_correction("I mean, it's fine."));
    }

    #[test]
    fn new_or_reordered_words_are_refused() {
        assert!(!acceptable("Send the report today.", "Please send the report today.", true, true));
        assert!(!acceptable("Send the report today.", "Today send the report.", true, true));
        assert!(!acceptable("Send the report.", "", true, true));
    }

    #[test]
    fn a_list_made_of_the_dictation_is_accepted() {
        assert!(acceptable(
            "For the trip I need three things: first, my passport; second, the charger; and third, some snacks for the flight.",
            "For the trip I need three things:\n1. my passport\n2. the charger\n3. some snacks for the flight",
            true,
            false
        ));
        assert!(acceptable(
            "To deploy, first run the tests, then build the bundle, and finally upload it to the server.",
            "To deploy:\n1. Run the tests\n2. Build the bundle\n3. Upload it to the server",
            true,
            false
        ));
    }

    #[test]
    fn a_list_and_a_correction_in_one_answer() {
        assert!(acceptable(
            "Agenda for tomorrow: first the budget, second the hiring plan, sorry, the hiring freeze, and third the offsite.",
            "Agenda for tomorrow:\n- the budget\n- the hiring freeze\n- the offsite",
            true,
            true
        ));
        // The same answer when only lists were asked for drops a correction
        // nobody asked to fix.
        assert!(!acceptable(
            "Agenda for tomorrow: first the budget, second the hiring plan, sorry, the hiring freeze, and third the offsite.",
            "Agenda for tomorrow:\n- the budget\n- the hiring freeze\n- the offsite",
            true,
            false
        ));
    }

    #[test]
    fn an_unchanged_answer_is_fine() {
        let text = "Sorry I'm late, the meeting ran over.";
        assert!(acceptable(text, text, true, true));
    }

    #[test]
    fn list_output_is_recognised() {
        assert!(is_list_output("Need:\n- eggs\n- milk"));
        assert!(is_list_output("1. one\n2. two"));
        assert!(!is_list_output("- just one"));
        assert!(!is_list_output("A sentence.\nAnother."));
    }

    #[test]
    fn list_html_is_escaped_and_typed() {
        assert_eq!(
            list_html("Need:\n- eggs & ham\n- <milk>").unwrap(),
            "<p>Need:</p><ul><li>eggs &amp; ham</li><li>&lt;milk&gt;</li></ul>"
        );
        assert_eq!(
            list_html("1. run\n2. build").unwrap(),
            "<ol><li>run</li><li>build</li></ol>"
        );
        assert!(list_html("not a list").is_none());
    }

    #[test]
    fn terminals_and_editors_get_no_lists() {
        let app = |key: &str| TargetApp {
            bundle_id: Some(key.into()),
            ..TargetApp::default()
        };
        assert!(no_lists_in(&app("com.apple.Terminal")));
        assert!(no_lists_in(&app("com.microsoft.VSCode")));
        assert!(no_lists_in(&app("com.jetbrains.intellij")));
        assert!(!no_lists_in(&app("com.apple.Notes")));
        let windows = TargetApp {
            name: Some("WindowsTerminal".into()),
            ..TargetApp::default()
        };
        assert!(no_lists_in(&windows));
    }
}
