//! "When I say … write …": fixes applied to the finished text.
//!
//! Vocabulary hints a name to the model, which usually gets it right; a
//! replacement is for the word it keeps getting wrong anyway ("cloud code" for
//! "Claude Code"). It runs last, just before pasting, so nothing after it —
//! Literal's lowercasing, a formatting model's rewording — can undo it.
//!
//! One pass over the text with every phrase at once, longest first, so the
//! output of one replacement is never matched by another.

use regex::{Regex, RegexBuilder};

use crate::settings::Replacement;

/// Apply every replacement to `text`.
///
/// Matching ignores case, and the words of a phrase may be separated by
/// spaces, hyphens or commas, because the transcriber writes "e-mail" one day
/// and "my, email" the next. A phrase must stand on its own: "cloud" does not
/// match inside "cloudy", and "c++" still matches though it ends in symbols.
/// When the whole dictation is the phrase, the result is exactly `write`,
/// without the full stop the transcriber puts after a sentence.
pub fn apply(text: &str, replacements: &[Replacement]) -> String {
    // A phrase with no words in it ("-", ",") would match between every
    // two characters.
    let usable: Vec<&Replacement> = replacements
        .iter()
        .filter(|r| !phrase_pattern(&r.said).is_empty())
        .collect();
    if usable.is_empty() {
        return text.to_string();
    }
    let Some(matcher) = Matcher::new(&usable) else {
        return text.to_string();
    };

    let bare = text.trim().trim_end_matches(['.', '!', '?']).trim_end();
    if let Some(write) = matcher.whole(bare) {
        return write.to_string();
    }
    matcher.replace_all(text)
}

struct Matcher<'a> {
    regex: Regex,
    /// What to write for each capture group, in group order.
    writes: Vec<&'a str>,
}

impl<'a> Matcher<'a> {
    fn new(replacements: &[&'a Replacement]) -> Option<Self> {
        let mut ordered: Vec<&&Replacement> = replacements.iter().collect();
        // Longest first, so "cloud code" wins over "cloud".
        ordered.sort_by_key(|r| std::cmp::Reverse(r.said.trim().chars().count()));

        let alternatives: Vec<String> = ordered
            .iter()
            .map(|r| format!("({})", phrase_pattern(&r.said)))
            .collect();
        let pattern = format!(r"\b{{start-half}}(?:{})\b{{end-half}}", alternatives.join("|"));
        let regex = match RegexBuilder::new(&pattern).case_insensitive(true).build() {
            Ok(regex) => regex,
            Err(err) => {
                tracing::warn!("could not build the replacements: {err}");
                return None;
            }
        };
        let writes = ordered.iter().map(|r| r.write.as_str()).collect();
        Some(Self { regex, writes })
    }

    fn write_for(&self, captures: &regex::Captures) -> &'a str {
        (1..captures.len())
            .find(|&group| captures.get(group).is_some())
            .map(|group| self.writes[group - 1])
            .unwrap_or_default()
    }

    /// The replacement when `text` is nothing but one phrase.
    fn whole(&self, text: &str) -> Option<&'a str> {
        let captures = self.regex.captures(text)?;
        let found = captures.get(0)?;
        (found.start() == 0 && found.end() == text.len()).then(|| self.write_for(&captures))
    }

    fn replace_all(&self, text: &str) -> String {
        self.regex
            .replace_all(text, |captures: &regex::Captures| self.write_for(captures).to_string())
            .into_owned()
    }
}

/// A phrase's words, escaped, joined by any run of spaces, hyphens or commas
/// on the same line: a match never crosses a line, so it cannot merge two
/// bullets of a list the smart pass laid out.
fn phrase_pattern(said: &str) -> String {
    said.split(|c: char| c.is_whitespace() || c == '-' || c == ',')
        .filter(|word| !word.is_empty())
        .map(regex::escape)
        .collect::<Vec<_>>()
        .join(r"[ \t,\-–—]+")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(said: &str, write: &str) -> Replacement {
        Replacement {
            said: said.into(),
            write: write.into(),
        }
    }

    #[test]
    fn a_phrase_is_replaced_whatever_its_case() {
        let rules = [rule("cloud code", "Claude Code")];
        assert_eq!(
            apply("I asked Cloud Code to review it.", &rules),
            "I asked Claude Code to review it."
        );
        assert_eq!(apply("cloud code, then lunch", &rules), "Claude Code, then lunch");
    }

    #[test]
    fn words_may_be_split_by_hyphens_commas_or_spaces() {
        let rules = [rule("my email", "theo@example.com")];
        assert_eq!(apply("send it to my-email please", &rules), "send it to theo@example.com please");
        assert_eq!(apply("send it to my, email please", &rules), "send it to theo@example.com please");
        assert_eq!(apply("send it to my   email please", &rules), "send it to theo@example.com please");
    }

    #[test]
    fn a_phrase_inside_a_longer_word_is_left_alone() {
        let rules = [rule("cloud", "Claude")];
        assert_eq!(apply("It is cloudy and overcast.", &rules), "It is cloudy and overcast.");
        assert_eq!(apply("Ask cloud.", &rules), "Ask Claude.");
    }

    #[test]
    fn phrases_that_start_or_end_in_symbols_still_match() {
        let rules = [rule("c++", "C++20"), rule("@home", "at home")];
        assert_eq!(apply("written in c++ mostly", &rules), "written in C++20 mostly");
        assert_eq!(apply("I am @home today", &rules), "I am at home today");
        assert_eq!(apply("x@home", &rules), "x@home", "not inside a word");
    }

    #[test]
    fn the_longest_phrase_wins() {
        let rules = [rule("cloud", "Claude"), rule("cloud code", "Claude Code")];
        assert_eq!(apply("open cloud code now", &rules), "open Claude Code now");
        assert_eq!(apply("open cloud now", &rules), "open Claude now");
    }

    #[test]
    fn one_replacements_output_is_never_replaced_again() {
        let rules = [rule("teleport", "TeleKey"), rule("telekey", "WRONG")];
        assert_eq!(apply("teleport is great", &rules), "TeleKey is great");
    }

    #[test]
    fn a_dictation_that_is_only_the_phrase_becomes_exactly_the_text() {
        let rules = [rule("my address", "12 High Street\nLondon")];
        assert_eq!(apply("My address.", &rules), "12 High Street\nLondon");
        assert_eq!(apply("  my address!  ", &rules), "12 High Street\nLondon");
    }

    #[test]
    fn nothing_to_do_returns_the_text_untouched() {
        assert_eq!(apply("Hello there.", &[]), "Hello there.");
        assert_eq!(apply("Hello there.", &[rule("  ", "x")]), "Hello there.");
        assert_eq!(apply("Hello there.", &[rule("goodbye", "x")]), "Hello there.");
    }

    #[test]
    fn a_match_never_crosses_a_line() {
        let rules = [rule("cloud code", "Claude Code")];
        let list = "Steps:\n- ask cloud\n- code review\n- ship";
        assert_eq!(apply(list, &rules), list);
    }

    #[test]
    fn a_phrase_with_no_words_is_ignored() {
        let rules = [rule("-", "X"), rule(" , ", "Y")];
        assert_eq!(apply("one - two, three", &rules), "one - two, three");
    }

    #[test]
    fn regex_characters_in_a_phrase_are_literal() {
        let rules = [rule("a.b (c)", "ok")];
        assert_eq!(apply("say a.b (c) now", &rules), "say ok now");
        assert_eq!(apply("say axb (c) now", &rules), "say axb (c) now");
    }

    #[test]
    fn accents_and_other_scripts_match() {
        let rules = [rule("zoe", "Zoë"), rule("東京", "Tokyo")];
        assert_eq!(apply("tell zoe about 東京", &rules), "tell Zoë about Tokyo");
    }
}
