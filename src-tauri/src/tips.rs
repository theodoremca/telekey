//! The beer: a rare, polite nudge for people who dictate on their own OpenAI key.
//!
//! TeleKey is free to run on your own key. If it earns its place, a tip is how
//! the person who builds it hears about that. The rules, in order of how much
//! they matter:
//!
//! - It never opens the browser by itself. The nudge is a prompt in the capsule;
//!   only a click on it (or on a button in Settings) opens the page.
//! - It only ever follows a dictation that worked, and only after the result has
//!   been seen (`overlay.rs` queues it behind the result, like a notice).
//! - It is for people on their own key. Anyone paying with credits has already
//!   paid, so a hosted dictation neither counts nor prompts.
//! - After the second successful dictation, then at most once per calendar day,
//!   until they tip (`telekey://thanks`) or say they already did.
//!
//! The count lives in its own small file rather than in `Settings`: the settings
//! window saves a whole `Settings` back, so a window holding a stale copy would
//! write an old count over a new one. Nothing here is ever sent anywhere.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::NaiveDate;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Where a tip is made: a Stripe Payment Link with a pay-what-you-want amount.
/// The same link on staging and production. The website has its own copy of it
/// (`TIP` in `web/data/site.ts`); change both together. `src/tipLink.test.ts`
/// fails if they differ.
pub const TIP_URL: &str = "https://buy.stripe.com/fZu9AU3qv8Oe1Cj45Fao800";

/// Tells the Settings window the tipped state changed.
pub const TIPS_EVENT: &str = "telekey://tips";

/// The capsule's reply when `telekey://thanks` arrives.
pub const THANKS_NOTICE: &str = "Thanks for the beer!";

const FILE_NAME: &str = "tips.json";

/// The first prompt comes after this many successful dictations on the user's
/// own key: enough to have felt what it does, early enough to be remembered.
pub const FIRST_NUDGE_AFTER: u32 = 2;

/// Who paid for the transcription of a dictation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Payer {
    /// A TeleKey account's credits. Already paid; never nudged.
    Credits,
    /// The user's own OpenAI key.
    OwnKey,
}

/// What is kept between launches.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Record {
    /// Dictations that worked on the user's own key.
    pub own_key_dictations: u32,
    /// The local calendar day (`YYYY-MM-DD`) the prompt last appeared.
    pub last_nudged: Option<String>,
    /// They tipped (the thanks link arrived) or said they already had. Final.
    pub tipped: bool,
}

impl Record {
    /// Whether the prompt is due on `today`.
    ///
    /// "Not the same day" rather than "an earlier day": a clock set wrongly once
    /// must not be able to silence the prompt for years, and it still cannot
    /// appear twice on one date.
    pub fn is_due(&self, today: NaiveDate) -> bool {
        !self.tipped
            && self.own_key_dictations >= FIRST_NUDGE_AFTER
            && self.last_nudged.as_deref() != Some(day_key(today).as_str())
    }

    /// A dictation finished, paid for by `payer` (`None` when that is not
    /// known). Counts it if it was the user's own key, and says whether the
    /// prompt should appear now, recording that it did.
    pub fn after_dictation(&mut self, payer: Option<Payer>, today: NaiveDate) -> bool {
        if payer != Some(Payer::OwnKey) || self.tipped {
            return false;
        }
        self.own_key_dictations = self.own_key_dictations.saturating_add(1);
        if !self.is_due(today) {
            return false;
        }
        self.last_nudged = Some(day_key(today));
        true
    }
}

/// What the Settings window needs to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TipStatus {
    pub tipped: bool,
}

/// The record, and the file it is kept in.
pub struct Tips {
    path: Option<PathBuf>,
    record: Mutex<Record>,
}

impl Tips {
    /// Load from `dir`. A missing or unreadable file starts fresh: this is a
    /// courtesy counter, and refusing to launch over it would be absurd.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(FILE_NAME);
        let record = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|err| {
                tracing::warn!("tips file unreadable, starting fresh: {err}");
                Record::default()
            }),
            Err(_) => Record::default(),
        };
        Self {
            path: Some(path),
            record: Mutex::new(record),
        }
    }

    /// Kept in memory only. What a `Pipeline` has until it is given a file, so
    /// no test and no CLI command can write to a real config directory.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            record: Mutex::new(Record::default()),
        }
    }

    pub fn status(&self) -> TipStatus {
        TipStatus {
            tipped: self.record.lock().tipped,
        }
    }

    /// A dictation finished. Returns whether to show the prompt now.
    pub fn after_dictation(&self, payer: Option<Payer>, today: NaiveDate) -> bool {
        let mut record = self.record.lock();
        let before = record.clone();
        let nudge = record.after_dictation(payer, today);
        if *record != before {
            self.persist(&record);
        }
        nudge
    }

    /// Stop prompting for good. Idempotent.
    pub fn mark_tipped(&self) -> TipStatus {
        let mut record = self.record.lock();
        if !record.tipped {
            record.tipped = true;
            self.persist(&record);
        }
        TipStatus { tipped: true }
    }

    /// Never fatal: the dictation has already been pasted, and a counter that
    /// failed to save only means the prompt may come a little late.
    fn persist(&self, record: &Record) {
        let Some(path) = &self.path else {
            return;
        };
        if let Err(err) = write(path, record) {
            tracing::warn!("could not save the tips file: {err:#}");
        }
    }
}

fn write(path: &Path, record: &Record) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(record)?;
    std::fs::write(path, raw).with_context(|| format!("could not write {}", path.display()))
}

fn day_key(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// The prompt's wording.
///
/// `clickable` is whether the capsule can take a click here. On Linux it
/// cannot (the overlay is an ordinary window there, and a click on it would
/// take focus from the app the next dictation is meant for), so the prompt says
/// where to go instead of offering a button that does nothing.
///
/// No "credit" in either: the overlay opens Buy credits for any failure that
/// says so, and a word that is reserved there is best kept out of here too.
pub fn nudge_text(clickable: bool) -> &'static str {
    if clickable {
        "Enjoying TeleKey on your own key? Buy me a beer \u{1F37A}"
    } else {
        "Enjoying TeleKey? Buy me a beer in Settings \u{203A} Support TeleKey \u{1F37A}"
    }
}

/// Whether `url` is the link the thanks page sends the app: `telekey://thanks`.
/// Anything after it (a slash, a query) is ignored.
pub fn is_thanks_url(url: &url::Url) -> bool {
    url.scheme() == "telekey"
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("thanks"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, day).unwrap()
    }

    /// Run `count` own-key dictations on `today`, returning how many prompted.
    fn dictate(record: &mut Record, count: u32, today: NaiveDate) -> u32 {
        (0..count)
            .filter(|_| record.after_dictation(Some(Payer::OwnKey), today))
            .count() as u32
    }

    #[test]
    fn the_first_dictation_does_not_prompt_but_the_second_does() {
        let mut record = Record::default();
        assert!(!record.after_dictation(Some(Payer::OwnKey), day(1)));
        assert!(record.after_dictation(Some(Payer::OwnKey), day(1)));
        assert_eq!(record.own_key_dictations, 2);
        assert_eq!(record.last_nudged.as_deref(), Some("2026-10-01"));
    }

    #[test]
    fn once_per_calendar_day_however_many_dictations() {
        let mut record = Record::default();
        assert_eq!(dictate(&mut record, 40, day(1)), 1);
        // Same day again: nothing, however much they dictate.
        assert_eq!(dictate(&mut record, 40, day(1)), 0);
        // The next day brings exactly one more.
        assert_eq!(dictate(&mut record, 40, day(2)), 1);
        assert_eq!(dictate(&mut record, 3, day(2)), 0);
        assert_eq!(dictate(&mut record, 1, day(5)), 1);
    }

    #[test]
    fn a_quiet_day_is_skipped_not_made_up_for() {
        let mut record = Record::default();
        assert_eq!(dictate(&mut record, 2, day(1)), 1);
        // Days pass with no dictating at all; the next one still prompts once.
        assert_eq!(dictate(&mut record, 5, day(9)), 1);
    }

    #[test]
    fn a_clock_set_wrongly_cannot_silence_the_prompt() {
        let mut record = Record {
            own_key_dictations: 10,
            last_nudged: Some("2099-01-01".into()),
            tipped: false,
        };
        assert!(record.is_due(day(1)), "a different day, even an earlier one");
        record.last_nudged = Some("not a date".into());
        assert!(record.is_due(day(1)));
    }

    #[test]
    fn people_on_credits_are_never_counted_or_prompted() {
        let mut record = Record::default();
        for _ in 0..50 {
            assert!(!record.after_dictation(Some(Payer::Credits), day(1)));
        }
        assert_eq!(record, Record::default(), "a hosted dictation changes nothing");
    }

    #[test]
    fn an_unknown_payer_is_treated_as_not_ours() {
        let mut record = Record::default();
        for _ in 0..5 {
            assert!(!record.after_dictation(None, day(1)));
        }
        assert_eq!(record.own_key_dictations, 0);
    }

    #[test]
    fn credits_dictations_do_not_advance_the_count_toward_the_first_prompt() {
        let mut record = Record::default();
        assert!(!record.after_dictation(Some(Payer::OwnKey), day(1)));
        for _ in 0..10 {
            record.after_dictation(Some(Payer::Credits), day(1));
        }
        // Still only one own-key dictation: this one is the second.
        assert!(record.after_dictation(Some(Payer::OwnKey), day(1)));
    }

    #[test]
    fn tipping_stops_it_for_good() {
        let mut record = Record {
            own_key_dictations: 10,
            ..Record::default()
        };
        record.tipped = true;
        assert!(!record.is_due(day(1)));
        for d in 1..=20 {
            assert!(!record.after_dictation(Some(Payer::OwnKey), day(d)));
        }
        assert_eq!(record.own_key_dictations, 10, "and nothing is counted any more");
    }

    #[test]
    fn a_file_from_before_a_field_existed_still_loads() {
        let record: Record = serde_json::from_str(r#"{"ownKeyDictations":3}"#).unwrap();
        assert_eq!(record.own_key_dictations, 3);
        assert!(!record.tipped);
        assert!(record.last_nudged.is_none());
        let empty: Record = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Record::default());
    }

    #[test]
    fn every_key_is_camel_case() {
        let json = serde_json::to_value(Record::default()).unwrap();
        for key in json.as_object().unwrap().keys() {
            assert!(!key.contains('_'), "`{key}` is snake_case");
        }
        let json = serde_json::to_value(TipStatus { tipped: true }).unwrap();
        assert_eq!(json, serde_json::json!({ "tipped": true }));
    }

    #[test]
    fn the_count_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let first = Tips::load(dir.path());
        assert!(!first.after_dictation(Some(Payer::OwnKey), day(1)));
        drop(first);

        // A new process: the second dictation is still the second.
        let second = Tips::load(dir.path());
        assert!(second.after_dictation(Some(Payer::OwnKey), day(1)));
        drop(second);

        // And the day it prompted on is remembered too.
        let third = Tips::load(dir.path());
        assert!(!third.after_dictation(Some(Payer::OwnKey), day(1)));
        assert!(third.after_dictation(Some(Payer::OwnKey), day(2)));
    }

    #[test]
    fn having_tipped_survives_a_restart_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let tips = Tips::load(dir.path());
        assert!(!tips.status().tipped);
        assert!(tips.mark_tipped().tipped);
        assert!(tips.mark_tipped().tipped);
        drop(tips);

        let reloaded = Tips::load(dir.path());
        assert!(reloaded.status().tipped);
        for d in 1..=5 {
            assert!(!reloaded.after_dictation(Some(Payer::OwnKey), day(d)));
        }
    }

    #[test]
    fn a_corrupt_file_starts_fresh_instead_of_stopping_the_app() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), "{ not json").unwrap();
        let tips = Tips::load(dir.path());
        assert_eq!(tips.status(), TipStatus { tipped: false });
    }

    #[test]
    fn in_memory_tips_write_nothing() {
        let tips = Tips::in_memory();
        assert!(!tips.after_dictation(Some(Payer::OwnKey), day(1)));
        assert!(tips.after_dictation(Some(Payer::OwnKey), day(1)));
        tips.mark_tipped();
        assert!(tips.status().tipped);
    }

    #[test]
    fn only_telekey_thanks_is_the_thanks_link() {
        let yes = |raw: &str| is_thanks_url(&url::Url::parse(raw).unwrap());
        assert!(yes("telekey://thanks"));
        assert!(yes("telekey://thanks/"));
        assert!(yes("telekey://thanks?from=stripe"));
        assert!(yes("telekey://THANKS"));
        assert!(!yes("telekey://auth?refreshToken=x&uid=y"));
        assert!(!yes("telekey://thanks.example.com"));
        assert!(!yes("https://thanks"));
        assert!(!yes("telekey://x/thanks"));
    }

    #[test]
    fn the_prompt_says_something_a_person_can_act_on() {
        let clickable = nudge_text(true);
        assert!(clickable.contains("beer"));
        assert!(!clickable.contains("Settings"), "the button is the way there");

        let linux = nudge_text(false);
        assert!(linux.contains("Settings"), "no button, so it says where to go");
        assert!(linux.contains("Support TeleKey"), "the row is called that");

        for text in [clickable, linux] {
            assert!(!text.to_lowercase().contains("credit"), "{text}");
            // Two lines of the capsule: about 36 characters each.
            assert!(text.chars().count() <= 72, "{text}");
        }
    }

    #[test]
    fn the_tip_page_is_a_secure_link() {
        assert!(TIP_URL.starts_with("https://buy.stripe.com/"));
    }
}
