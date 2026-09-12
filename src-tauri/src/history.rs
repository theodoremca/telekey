//! Recent transcripts.
//!
//! This is the one place TeleKey persists what you said. Audio never reaches
//! disk, but text does, and dictation can carry anything — so the file is
//! written `0600`, capped, and can be emptied or switched off entirely.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "history.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    pub text: String,
    /// Unix milliseconds. Formatting is the UI's job — it knows the locale.
    pub at: i64,
    /// The app the text was inserted into, for recognising an entry at a glance.
    pub app: Option<String>,
    pub words: usize,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    next_id: u64,
    entries: Vec<Entry>,
}

pub struct History {
    path: PathBuf,
    state: Mutex<Stored>,
}

impl History {
    /// Load from `dir`, starting empty if the file is missing or unreadable.
    ///
    /// A corrupt history is discarded rather than fatal: unlike settings, there
    /// is nothing here the user configured, and refusing to start over a
    /// damaged convenience log would be the wrong trade.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(FILE_NAME);

        let state = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|err| {
                tracing::warn!("history file unreadable, starting fresh: {err}");
                Stored::default()
            }),
            Err(_) => Stored::default(),
        };

        Self {
            path,
            state: Mutex::new(state),
        }
    }

    /// Newest first, which is the order the UI wants.
    pub fn entries(&self) -> Vec<Entry> {
        let state = self.state.lock();
        state.entries.iter().rev().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.state.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Record a transcript, trimming to `limit`.
    pub fn record(&self, text: &str, app: Option<String>, limit: usize) -> Result<Entry> {
        let entry = {
            let mut state = self.state.lock();

            let id = state.next_id;
            state.next_id = state.next_id.wrapping_add(1);

            let entry = Entry {
                id,
                text: text.to_string(),
                at: now_millis(),
                app,
                words: count_words(text),
            };

            state.entries.push(entry.clone());
            trim(&mut state.entries, limit);
            entry
        };

        self.persist()?;
        Ok(entry)
    }

    pub fn delete(&self, id: u64) -> Result<()> {
        self.state.lock().entries.retain(|entry| entry.id != id);
        self.persist()
    }

    pub fn clear(&self) -> Result<()> {
        self.state.lock().entries.clear();
        self.persist()
    }

    /// Apply a new retention limit immediately, so lowering it in settings
    /// actually removes the excess rather than waiting for the next dictation.
    pub fn enforce_limit(&self, limit: usize) -> Result<()> {
        {
            let mut state = self.state.lock();
            if state.entries.len() <= limit {
                return Ok(());
            }
            trim(&mut state.entries, limit);
        }
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

/// Owner read/write only. Dictated text is as sensitive as whatever the user
/// happened to be saying.
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

/// Drop the oldest entries beyond `limit`.
fn trim(entries: &mut Vec<Entry>, limit: usize) {
    if limit == 0 {
        entries.clear();
        return;
    }
    if entries.len() > limit {
        let excess = entries.len() - limit;
        // Entries are stored oldest-first, so the excess is at the front.
        let kept: VecDeque<Entry> = entries.drain(excess..).collect();
        *entries = kept.into();
    }
}

fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history() -> (tempfile::TempDir, History) {
        let dir = tempfile::tempdir().unwrap();
        let history = History::load(dir.path());
        (dir, history)
    }

    #[test]
    fn records_and_returns_newest_first() {
        let (_dir, history) = history();

        history.record("first", Some("Slack".into()), 10).unwrap();
        history.record("second", None, 10).unwrap();

        let entries = history.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text, "second");
        assert_eq!(entries[1].text, "first");
        assert_eq!(entries[1].app.as_deref(), Some("Slack"));
    }

    #[test]
    fn counts_words_for_the_list() {
        let (_dir, history) = history();
        let entry = history
            .record("ship it on wednesday", None, 10)
            .unwrap();
        assert_eq!(entry.words, 4);
    }

    #[test]
    fn ids_are_unique_across_entries() {
        let (_dir, history) = history();
        for i in 0..5 {
            history.record(&format!("entry {i}"), None, 10).unwrap();
        }

        let ids: std::collections::HashSet<u64> =
            history.entries().iter().map(|entry| entry.id).collect();
        assert_eq!(ids.len(), 5);
    }

    #[test]
    fn the_oldest_entries_fall_off_the_end() {
        let (_dir, history) = history();
        for i in 0..5 {
            history.record(&format!("entry {i}"), None, 3).unwrap();
        }

        let entries = history.entries();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].text, "entry 4");
        assert_eq!(entries[2].text, "entry 2");
    }

    #[test]
    fn a_zero_limit_keeps_nothing() {
        let (_dir, history) = history();
        history.record("secret", None, 0).unwrap();
        assert!(history.is_empty());
    }

    #[test]
    fn lowering_the_limit_trims_straight_away() {
        let (_dir, history) = history();
        for i in 0..10 {
            history.record(&format!("entry {i}"), None, 100).unwrap();
        }

        history.enforce_limit(4).unwrap();

        let entries = history.entries();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].text, "entry 9");
    }

    #[test]
    fn entries_survive_a_reload() {
        let dir = tempfile::tempdir().unwrap();

        {
            let history = History::load(dir.path());
            history.record("persisted", Some("Mail".into()), 10).unwrap();
        }

        let reopened = History::load(dir.path());
        let entries = reopened.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "persisted");
        assert_eq!(entries[0].app.as_deref(), Some("Mail"));
    }

    #[test]
    fn ids_keep_climbing_after_a_reload() {
        // Reusing ids would make deletion remove the wrong entry.
        let dir = tempfile::tempdir().unwrap();

        let first_id = {
            let history = History::load(dir.path());
            history.record("one", None, 10).unwrap().id
        };

        let history = History::load(dir.path());
        let second_id = history.record("two", None, 10).unwrap().id;

        assert_ne!(first_id, second_id);
    }

    #[test]
    fn deleting_removes_only_that_entry() {
        let (_dir, history) = history();
        history.record("keep", None, 10).unwrap();
        let doomed = history.record("remove", None, 10).unwrap();
        history.record("keep too", None, 10).unwrap();

        history.delete(doomed.id).unwrap();

        let texts: Vec<String> = history.entries().into_iter().map(|e| e.text).collect();
        assert_eq!(texts, vec!["keep too".to_string(), "keep".to_string()]);
    }

    #[test]
    fn clearing_empties_the_file_too() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::load(dir.path());
        history.record("sensitive", None, 10).unwrap();

        history.clear().unwrap();

        assert!(history.is_empty());
        let raw = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(
            !raw.contains("sensitive"),
            "cleared text must not survive on disk: {raw}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let history = History::load(dir.path());
        history.record("private", None, 10).unwrap();

        let mode = std::fs::metadata(dir.path().join(FILE_NAME))
            .unwrap()
            .permissions()
            .mode();

        assert_eq!(mode & 0o777, 0o600, "got {:o}", mode & 0o777);
    }

    #[test]
    fn a_corrupt_file_starts_fresh_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), "{ not json").unwrap();

        let history = History::load(dir.path());
        assert!(history.is_empty());

        // And is still usable afterwards.
        history.record("new", None, 10).unwrap();
        assert_eq!(history.len(), 1);
    }

    #[test]
    fn a_missing_file_is_an_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        assert!(History::load(dir.path()).is_empty());
    }
}
