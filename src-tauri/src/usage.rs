//! What Flowtype has cost, and how long has been spent dictating.
//!
//! Records the billing units OpenAI reports back — audio seconds from the
//! transcription response, token counts from the formatting response — rather
//! than what we measured locally. The API is the authority on what it charged.
//!
//! Duration is the primary record and money is derived from it at display time.
//! That ordering is deliberate: if the rates go stale the minutes are still
//! exactly right, and correcting a rate re-prices the whole history without
//! needing new data.
//!
//! Records lose resolution as they age — daily for a month, monthly for two
//! years, then a single running total — so the file has a hard ceiling of a few
//! kilobytes instead of growing for the life of the install. Nothing is ever
//! discarded, so the lifetime figure stays exact.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{Datelike, Local, NaiveDate};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "usage.json";

/// Long enough for the 30-day chart, and long enough that every day of the
/// current month is always still at daily resolution — the longest month is 31
/// days, so "this month" never has to read a rolled-up bucket.
const DAILY_TIER_DAYS: i64 = 31;

/// Two years of month-by-month detail before everything folds into one total.
const MONTHLY_TIER_MONTHS: usize = 24;

/// Cached input tokens bill at a tenth of the normal rate.
const CACHED_TOKEN_DISCOUNT: f64 = 0.10;

/// Billing units for one dictation, or a sum of many.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Units {
    pub dictations: u64,
    /// Audio seconds as billed by the transcription API.
    pub transcribe_seconds: u64,
    /// Some models bill transcription by token rather than duration; kept so a
    /// future model's usage is not silently dropped on the floor.
    pub transcribe_tokens: u64,
    pub polish_input_tokens: u64,
    pub polish_cached_tokens: u64,
    pub polish_output_tokens: u64,
}

impl Units {
    /// One dictation's transcription, billed by audio duration.
    pub fn transcription(seconds: u64) -> Self {
        Self {
            dictations: 1,
            transcribe_seconds: seconds,
            ..Default::default()
        }
    }

    pub fn add(&mut self, other: &Units) {
        self.dictations += other.dictations;
        self.transcribe_seconds += other.transcribe_seconds;
        self.transcribe_tokens += other.transcribe_tokens;
        self.polish_input_tokens += other.polish_input_tokens;
        self.polish_cached_tokens += other.polish_cached_tokens;
        self.polish_output_tokens += other.polish_output_tokens;
    }

    pub fn minutes(&self) -> f64 {
        self.transcribe_seconds as f64 / 60.0
    }

    pub fn is_empty(&self) -> bool {
        *self == Units::default()
    }
}

/// What the user pays per unit. Editable, because published prices change and a
/// hardcoded rate would keep reporting a confident wrong number.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    pub transcribe_per_minute: f64,
    pub polish_input_per_million: f64,
    pub polish_output_per_million: f64,
}

impl Default for Rates {
    fn default() -> Self {
        // OpenAI's published rates as of August 2026.
        Self {
            transcribe_per_minute: 0.0045,
            polish_input_per_million: 0.20,
            polish_output_per_million: 1.20,
        }
    }
}

/// Money for a set of units, split so the UI can show where it went.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub transcription: f64,
    pub formatting: f64,
    pub total: f64,
}

impl Rates {
    pub fn cost_of(&self, units: &Units) -> Cost {
        let transcription = units.minutes() * self.transcribe_per_minute;

        // Cached tokens are included in input_tokens by the API, so they are
        // subtracted out and re-added at the discounted rate. Charging them in
        // full is the easiest way to overstate a bill.
        let full_input = units
            .polish_input_tokens
            .saturating_sub(units.polish_cached_tokens) as f64;
        let cached_input = units.polish_cached_tokens as f64;

        let formatting = (full_input / 1_000_000.0) * self.polish_input_per_million
            + (cached_input / 1_000_000.0)
                * self.polish_input_per_million
                * CACHED_TOKEN_DISCOUNT
            + (units.polish_output_tokens as f64 / 1_000_000.0) * self.polish_output_per_million;

        // Deliberately exact. A dictation costs fractions of a cent, so rounding
        // here would lose real money over a lifetime total and break the
        // property that doubling a rate doubles the cost. Rounding for display
        // is the UI's job.
        Cost {
            transcription,
            formatting,
            total: transcription + formatting,
        }
    }
}


#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    /// Keyed `YYYY-MM-DD`, local time. BTreeMap so keys stay sorted, which
    /// makes both compaction and the chart a straight iteration.
    days: BTreeMap<String, Units>,
    /// Keyed `YYYY-MM`.
    months: BTreeMap<String, Units>,
    /// Everything older than the monthly tier.
    before: Units,
}

pub struct Usage {
    path: PathBuf,
    state: Mutex<Stored>,
}

/// One day's bar in the chart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyPoint {
    pub date: String,
    pub units: Units,
}

impl Usage {
    /// Load from `dir`, starting empty when the file is missing or unreadable.
    ///
    /// A corrupt usage file is discarded rather than fatal — it is a record of
    /// spending, not something the user configured, and refusing to launch over
    /// it would be the wrong trade.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(FILE_NAME);

        let state = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|err| {
                tracing::warn!("usage file unreadable, starting fresh: {err}");
                Stored::default()
            }),
            Err(_) => Stored::default(),
        };

        Self {
            path,
            state: Mutex::new(state),
        }
    }

    /// Add units to today's bucket.
    pub fn record(&self, units: &Units) -> Result<()> {
        self.record_on(today(), units)
    }

    /// Add units to a specific day. Separate so tests can build a history.
    pub fn record_on(&self, date: NaiveDate, units: &Units) -> Result<()> {
        {
            let mut state = self.state.lock();
            state
                .days
                .entry(day_key(date))
                .or_default()
                .add(units);
            compact(&mut state, today());
        }
        self.persist()
    }

    /// Units for today.
    pub fn today(&self) -> Units {
        let state = self.state.lock();
        state.days.get(&day_key(today())).copied().unwrap_or_default()
    }

    /// Units for the calendar month containing today.
    ///
    /// Reads only the daily tier: the daily window is at least as long as the
    /// longest month, so the current month is never partly rolled up.
    pub fn this_month(&self) -> Units {
        let prefix = month_key(today());
        let state = self.state.lock();

        let mut total = Units::default();
        for (key, units) in &state.days {
            if key.starts_with(&prefix) {
                total.add(units);
            }
        }
        total
    }

    /// Everything ever recorded, across all tiers.
    pub fn lifetime(&self) -> Units {
        let state = self.state.lock();

        let mut total = state.before;
        for units in state.months.values() {
            total.add(units);
        }
        for units in state.days.values() {
            total.add(units);
        }
        total
    }

    /// The last `days` calendar days, oldest first, including empty days so the
    /// chart has an even time axis rather than only the days that had activity.
    pub fn recent_days(&self, days: i64) -> Vec<DailyPoint> {
        let state = self.state.lock();
        let end = today();

        (0..days)
            .rev()
            .filter_map(|back| end.checked_sub_days(chrono::Days::new(back as u64)))
            .map(|date| {
                let key = day_key(date);
                let units = state.days.get(&key).copied().unwrap_or_default();
                DailyPoint { date: key, units }
            })
            .collect()
    }

    pub fn clear(&self) -> Result<()> {
        *self.state.lock() = Stored::default();
        self.persist()
    }

    fn persist(&self) -> Result<()> {
        let raw = {
            let state = self.state.lock();
            serde_json::to_string(&*state)?
        };

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }

        std::fs::write(&self.path, raw)
            .with_context(|| format!("could not write {}", self.path.display()))?;

        restrict_permissions(&self.path)?;
        Ok(())
    }
}

/// Fold ageing records into coarser buckets.
///
/// Runs on write, so it is bounded work on a path that already touches disk and
/// needs no timer. Totals are preserved exactly — data loses resolution, never
/// substance — and the operation is idempotent, since anything already folded no
/// longer appears in the tier it came from.
fn compact(state: &mut Stored, now: NaiveDate) {
    let daily_cutoff = now - chrono::Duration::days(DAILY_TIER_DAYS);

    let ageing: Vec<String> = state
        .days
        .keys()
        .filter(|key| parse_day(key).is_none_or(|date| date < daily_cutoff))
        .cloned()
        .collect();

    for key in ageing {
        let Some(units) = state.days.remove(&key) else {
            continue;
        };
        // An unparseable key has no month to belong to; it still must not lose
        // its numbers, so it goes straight to the lifetime total.
        match parse_day(&key) {
            Some(date) => state.months.entry(month_key(date)).or_default().add(&units),
            None => state.before.add(&units),
        }
    }

    while state.months.len() > MONTHLY_TIER_MONTHS {
        // BTreeMap keys sort chronologically for `YYYY-MM`, so the first is oldest.
        let Some(oldest) = state.months.keys().next().cloned() else {
            break;
        };
        if let Some(units) = state.months.remove(&oldest) {
            state.before.add(&units);
        }
    }
}

fn today() -> NaiveDate {
    Local::now().date_naive()
}

fn day_key(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn month_key(date: NaiveDate) -> String {
    format!("{:04}-{:02}", date.year(), date.month())
}

fn parse_day(key: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(key, "%Y-%m-%d").ok()
}

/// Owner read/write only. Not transcript text, but still a record of when and
/// how much the user dictated.
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("could not restrict permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Usage) {
        let dir = tempfile::tempdir().unwrap();
        let usage = Usage::load(dir.path());
        (dir, usage)
    }

    fn units(dictations: u64, seconds: u64) -> Units {
        Units {
            dictations,
            transcribe_seconds: seconds,
            ..Default::default()
        }
    }

    fn days_ago(n: u64) -> NaiveDate {
        today() - chrono::Duration::days(n as i64)
    }

    // ---- recording -------------------------------------------------------

    #[test]
    fn a_dictation_lands_in_todays_bucket() {
        let (_dir, usage) = store();
        usage.record(&Units::transcription(90)).unwrap();

        assert_eq!(usage.today().dictations, 1);
        assert_eq!(usage.today().transcribe_seconds, 90);
        assert!((usage.today().minutes() - 1.5).abs() < f64::EPSILON);
    }

    #[test]
    fn recordings_accumulate_within_a_day() {
        let (_dir, usage) = store();
        for _ in 0..3 {
            usage.record(&Units::transcription(60)).unwrap();
        }
        assert_eq!(usage.today().dictations, 3);
        assert_eq!(usage.today().transcribe_seconds, 180);
    }

    #[test]
    fn yesterdays_dictation_is_not_counted_as_today() {
        let (_dir, usage) = store();
        usage.record_on(days_ago(1), &units(5, 300)).unwrap();

        assert!(usage.today().is_empty(), "today must be untouched");
        assert_eq!(usage.lifetime().dictations, 5);
    }

    #[test]
    fn this_month_covers_the_calendar_month_only() {
        let (_dir, usage) = store();
        let now = today();

        usage.record_on(now, &units(1, 60)).unwrap();
        // 40 days back is both a previous month and outside the daily tier.
        usage.record_on(now - chrono::Duration::days(40), &units(1, 600)).unwrap();

        assert_eq!(usage.this_month().transcribe_seconds, 60);
        assert_eq!(usage.lifetime().transcribe_seconds, 660);
    }

    // ---- compaction ------------------------------------------------------

    #[test]
    fn compaction_preserves_the_total_exactly() {
        // The property that makes losing resolution acceptable.
        let mut state = Stored::default();
        let now = today();

        let mut expected = Units::default();
        for back in 0..400 {
            let day = now - chrono::Duration::days(back);
            let u = units(1, 30 + back as u64);
            expected.add(&u);
            state.days.insert(day_key(day), u);
        }

        compact(&mut state, now);

        let mut actual = state.before;
        for u in state.months.values() {
            actual.add(u);
        }
        for u in state.days.values() {
            actual.add(u);
        }

        assert_eq!(actual, expected, "compaction must not change the total");
    }

    #[test]
    fn compaction_is_idempotent() {
        let mut state = Stored::default();
        let now = today();
        for back in 0..200 {
            state.days.insert(day_key(now - chrono::Duration::days(back)), units(1, 60));
        }

        compact(&mut state, now);
        let once = (state.days.len(), state.months.len(), state.before);
        compact(&mut state, now);
        let twice = (state.days.len(), state.months.len(), state.before);

        assert_eq!(once, twice, "running compaction twice must not double-count");
    }

    #[test]
    fn the_daily_tier_boundary_is_exact() {
        let mut state = Stored::default();
        let now = today();

        state.days.insert(day_key(now - chrono::Duration::days(31)), units(1, 10));
        state.days.insert(day_key(now - chrono::Duration::days(32)), units(1, 20));

        compact(&mut state, now);

        assert!(
            state.days.contains_key(&day_key(now - chrono::Duration::days(31))),
            "31 days old must stay at daily resolution"
        );
        assert!(
            !state.days.contains_key(&day_key(now - chrono::Duration::days(32))),
            "32 days old must roll up"
        );
    }

    #[test]
    fn every_day_of_the_current_month_stays_daily() {
        // "this month" reads only the daily tier, so this is load-bearing.
        let mut state = Stored::default();
        // Pick the 31st so the month is as long as it can be.
        let now = NaiveDate::from_ymd_opt(2026, 1, 31).unwrap();

        for day in 1..=31 {
            let date = NaiveDate::from_ymd_opt(2026, 1, day).unwrap();
            state.days.insert(day_key(date), units(1, 60));
        }

        compact(&mut state, now);

        assert_eq!(
            state.days.len(),
            31,
            "no day of the current month may be rolled up"
        );
    }

    #[test]
    fn the_monthly_tier_is_capped() {
        let mut state = Stored::default();
        let now = today();

        // Five years of daily records.
        for back in 0..(365 * 5) {
            state.days.insert(day_key(now - chrono::Duration::days(back)), units(1, 60));
        }

        compact(&mut state, now);

        assert!(
            state.months.len() <= MONTHLY_TIER_MONTHS,
            "monthly tier grew to {}",
            state.months.len()
        );
        assert!(!state.before.is_empty(), "older data must land in the total");
    }

    #[test]
    fn the_file_stays_bounded_across_years() {
        let dir = tempfile::tempdir().unwrap();
        let usage = Usage::load(dir.path());
        let now = today();

        for back in (0..(365 * 3)).step_by(1) {
            usage
                .record_on(now - chrono::Duration::days(back), &units(1, 120))
                .unwrap();
        }

        let bytes = std::fs::metadata(dir.path().join(FILE_NAME)).unwrap().len();
        assert!(bytes < 32_768, "usage.json grew to {bytes} bytes");
        assert_eq!(usage.lifetime().dictations, 365 * 3);
    }

    #[test]
    fn an_unparseable_day_key_keeps_its_numbers() {
        // Rather than vanishing into a month it cannot be assigned to.
        let mut state = Stored::default();
        state.days.insert("not-a-date".into(), units(2, 99));

        compact(&mut state, today());

        assert_eq!(state.before.transcribe_seconds, 99);
        assert!(state.days.is_empty());
    }

    // ---- pricing ---------------------------------------------------------

    #[test]
    fn transcription_is_priced_per_minute() {
        let rates = Rates::default();
        let cost = rates.cost_of(&Units::transcription(600)); // 10 minutes
        assert!((cost.transcription - 0.045).abs() < 1e-9, "got {cost:?}");
        assert_eq!(cost.formatting, 0.0);
    }

    #[test]
    fn cached_tokens_are_priced_at_a_tenth() {
        let rates = Rates::default();

        let uncached = rates.cost_of(&Units {
            polish_input_tokens: 1_000_000,
            ..Default::default()
        });
        let all_cached = rates.cost_of(&Units {
            polish_input_tokens: 1_000_000,
            polish_cached_tokens: 1_000_000,
            ..Default::default()
        });

        assert!((uncached.formatting - 0.20).abs() < 1e-9, "got {uncached:?}");
        assert!(
            (all_cached.formatting - 0.02).abs() < 1e-9,
            "cached tokens must cost a tenth, got {all_cached:?}"
        );
    }

    #[test]
    fn a_partly_cached_request_is_priced_in_two_parts() {
        let rates = Rates::default();
        let cost = rates.cost_of(&Units {
            polish_input_tokens: 1_000_000,
            polish_cached_tokens: 500_000,
            ..Default::default()
        });
        // 500k at full rate + 500k at a tenth.
        assert!((cost.formatting - (0.10 + 0.01)).abs() < 1e-9, "got {cost:?}");
    }

    #[test]
    fn output_tokens_are_priced_separately() {
        let rates = Rates::default();
        let cost = rates.cost_of(&Units {
            polish_output_tokens: 1_000_000,
            ..Default::default()
        });
        assert!((cost.formatting - 1.20).abs() < 1e-9, "got {cost:?}");
    }

    #[test]
    fn the_breakdown_always_sums_to_the_total() {
        // Exact arithmetic, so this holds by construction — kept as a guard in
        // case anyone is tempted to round in here again. Rounding the parts
        // would break rate proportionality for sub-cent amounts.
        let rates = Rates::default();

        for seconds in [1_u64, 7, 59, 137, 601, 9_999, 88_888] {
            for tokens in [0_u64, 13, 977, 12_345, 987_654] {
                let cost = rates.cost_of(&Units {
                    dictations: 1,
                    transcribe_seconds: seconds,
                    polish_input_tokens: tokens,
                    polish_output_tokens: tokens / 3,
                    ..Default::default()
                });

                assert!(
                    (cost.total - (cost.transcription + cost.formatting)).abs() < 1e-9,
                    "{seconds}s / {tokens} tokens: {cost:?} does not sum"
                );
            }
        }
    }

    #[test]
    fn nothing_used_costs_nothing() {
        let cost = Rates::default().cost_of(&Units::default());
        assert_eq!(cost.total, 0.0);
        assert!(cost.total.is_finite(), "must not be NaN");
    }

    #[test]
    fn editing_a_rate_reprices_stored_units() {
        // The reason units are stored and money is derived.
        let units = Units::transcription(600);

        let cheap = Rates {
            transcribe_per_minute: 0.0045,
            ..Rates::default()
        };
        let dear = Rates {
            transcribe_per_minute: 0.009,
            ..Rates::default()
        };

        assert!((dear.cost_of(&units).total / cheap.cost_of(&units).total - 2.0).abs() < 1e-9);
    }

    // ---- chart and persistence -------------------------------------------

    #[test]
    fn recent_days_returns_an_even_axis_including_gaps() {
        let (_dir, usage) = store();
        usage.record_on(days_ago(3), &units(1, 60)).unwrap();

        let points = usage.recent_days(7);
        assert_eq!(points.len(), 7);
        assert_eq!(points.last().unwrap().date, day_key(today()), "newest last");

        let active: Vec<&DailyPoint> = points.iter().filter(|p| !p.units.is_empty()).collect();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].date, day_key(days_ago(3)));
    }

    #[test]
    fn usage_survives_a_reload() {
        let dir = tempfile::tempdir().unwrap();

        {
            let usage = Usage::load(dir.path());
            usage.record(&Units::transcription(120)).unwrap();
        }

        let reopened = Usage::load(dir.path());
        assert_eq!(reopened.today().transcribe_seconds, 120);
    }

    #[test]
    fn clearing_empties_the_file_too() {
        let dir = tempfile::tempdir().unwrap();
        let usage = Usage::load(dir.path());
        usage.record(&Units::transcription(120)).unwrap();

        usage.clear().unwrap();

        assert!(usage.lifetime().is_empty());
        assert!(Usage::load(dir.path()).lifetime().is_empty());
    }

    #[test]
    fn a_corrupt_file_starts_fresh_and_stays_usable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), "{ not json").unwrap();

        let usage = Usage::load(dir.path());
        assert!(usage.lifetime().is_empty());

        usage.record(&Units::transcription(60)).unwrap();
        assert_eq!(usage.today().transcribe_seconds, 60);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let usage = Usage::load(dir.path());
        usage.record(&Units::transcription(60)).unwrap();

        let mode = std::fs::metadata(dir.path().join(FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "got {:o}", mode & 0o777);
    }
}
