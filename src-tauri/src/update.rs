//! Keeping TeleKey up to date.
//!
//! The release workflow publishes a `latest.json` beside each release's
//! installers, naming the update for each platform and its signature. TeleKey
//! reads it from GitHub a minute after launch and every six hours after,
//! downloads anything newer in the background, and checks it against the
//! public key in `tauri.conf.json`: a file not signed with the key the
//! workflow holds is never installed.
//!
//! Then it waits for the user. "Restart to Update" appears in the menu bar and
//! in Settings, and nothing is installed until it is clicked — and not in the
//! middle of a dictation even then. macOS swaps the app in place and
//! relaunches; Windows runs the installer, which relaunches TeleKey itself;
//! Linux replaces the AppImage, or reinstalls the `.deb` behind an
//! administrator prompt. Settings, history, the Keychain and (with the same
//! Developer ID signature) macOS permissions all survive, because none of them
//! live inside the app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::overlay::Overlay;
use crate::pipeline::Pipeline;

/// Carries an [`UpdateStatus`] whenever the state changes.
pub const UPDATE_EVENT: &str = "telekey://update";

/// Points this copy at another `latest.json`, to try an update end to end
/// without publishing one. The signature is still checked against the
/// built-in key, so this cannot install anything the workflow did not sign.
pub const ENDPOINT_ENV: &str = "TELEKEY_UPDATE_URL";

/// Long enough that the first check never competes with startup, a sign-in or
/// the first dictation of the day for the network.
const FIRST_CHECK: Duration = Duration::from_secs(60);
const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);
/// A check that hangs is worse than one that fails: the menu item stays
/// greyed out. The download has no limit of its own beyond reqwest's.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// How long "Restart to Update" waits for a dictation to finish before giving up.
const IDLE_WAIT: Duration = Duration::from_secs(60);
const IDLE_POLL: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateState {
    /// Not checked yet.
    Idle,
    Checking,
    UpToDate,
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    /// Downloaded and verified; waiting for the user to restart.
    Ready { version: String },
    Installing { version: String },
    Failed { message: String },
}

/// What Settings shows: this copy's version and where the update stands.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    #[serde(flatten)]
    pub state: UpdateState,
}

/// The tray item's wording for a state, and whether it can be clicked.
pub fn menu_label(state: &UpdateState) -> (String, bool) {
    match state {
        UpdateState::Idle | UpdateState::UpToDate | UpdateState::Failed { .. } => {
            ("Check for Updates…".into(), true)
        }
        UpdateState::Checking => ("Checking for Updates…".into(), false),
        UpdateState::Downloading { version, .. } => {
            (format!("Downloading TeleKey {version}…"), false)
        }
        UpdateState::Ready { version } => (format!("Restart to Update to {version}"), true),
        UpdateState::Installing { .. } => ("Installing Update…".into(), false),
    }
}

/// Where the restart lives, in this platform's words.
fn restart_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Restart from the menu bar to update."
    } else {
        "Restart from the tray icon to update."
    }
}

/// The capsule note for a state a check ended in, if it deserves one.
///
/// An automatic check speaks only when an update is ready, and only once per
/// version; one the user asked for always answers, so the click is never met
/// with silence.
pub fn notice_for(
    state: &UpdateState,
    manual: bool,
    current: &str,
    announced: Option<&str>,
) -> Option<String> {
    match state {
        UpdateState::Ready { version } if manual || announced != Some(version.as_str()) => {
            Some(format!("TeleKey {version} is ready. {}", restart_hint()))
        }
        UpdateState::UpToDate if manual => Some(format!("TeleKey {current} is up to date.")),
        UpdateState::Failed { message } if manual => Some(message.clone()),
        _ => None,
    }
}

/// An updater error, worded for a person. The details go to the log.
fn to_message(err: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match err {
        E::Reqwest(_) | E::Network(_) => {
            "Couldn't reach the update server. Check your connection.".into()
        }
        E::ReleaseNotFound => "Couldn't find the latest version information.".into(),
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => {
            "The update's signature didn't match, so it was not installed.".into()
        }
        E::AuthenticationFailed => {
            "Updating needs an administrator password, and none was given.".into()
        }
        E::FailedToDetermineExtractPath => {
            "TeleKey can't replace itself here. Move it to Applications, then try again.".into()
        }
        E::Io(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            "TeleKey can't replace itself here. Move it to Applications, then try again.".into()
        }
        _ => "Couldn't update TeleKey. Try again later.".into(),
    }
}

fn percent(received: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    Some((received.saturating_mul(100) / total).min(100) as u8)
}

/// A downloaded, verified update, held until the restart.
struct Downloaded {
    update: Update,
    bytes: Vec<u8>,
}

pub struct Updater {
    app: AppHandle,
    overlay: Arc<Overlay>,
    state: Mutex<UpdateState>,
    ready: Mutex<Option<Downloaded>>,
    /// One check (and download) at a time; a second click while one runs is ignored.
    checking: AtomicBool,
    installing: AtomicBool,
    /// The last version a notice announced, so an automatic check that finds
    /// it again stays quiet.
    announced: Mutex<Option<String>>,
    menu_item: Mutex<Option<MenuItem<Wry>>>,
}

impl Updater {
    pub fn new(app: AppHandle, overlay: Arc<Overlay>) -> Arc<Self> {
        Arc::new(Self {
            app,
            overlay,
            state: Mutex::new(UpdateState::Idle),
            ready: Mutex::new(None),
            checking: AtomicBool::new(false),
            installing: AtomicBool::new(false),
            announced: Mutex::new(None),
            menu_item: Mutex::new(None),
        })
    }

    pub fn status(&self) -> UpdateStatus {
        UpdateStatus {
            current: self.app.package_info().version.to_string(),
            state: self.state.lock().clone(),
        }
    }

    /// The tray's update item, kept in step with the state from now on.
    pub fn set_menu_item(&self, item: MenuItem<Wry>) {
        apply_label(&item, &self.state.lock());
        *self.menu_item.lock() = Some(item);
    }

    /// The tray item was clicked: restart if an update is waiting, else check.
    pub fn menu_clicked(self: &Arc<Self>) {
        if matches!(*self.state.lock(), UpdateState::Ready { .. }) {
            self.restart_to_update();
        } else {
            self.check(true);
        }
    }

    /// Check at launch and every few hours after.
    ///
    /// Not in a debug build (`bun tauri dev`), which is not an installed app
    /// and would offer to replace itself with the release — unless a test
    /// feed was named on purpose.
    pub fn watch(self: &Arc<Self>) {
        if cfg!(debug_assertions) && std::env::var_os(ENDPOINT_ENV).is_none() {
            tracing::info!("automatic update checks are off in debug builds");
            return;
        }
        let updater = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("telekey-update".into())
            .spawn(move || {
                std::thread::sleep(FIRST_CHECK);
                loop {
                    updater.run_check(false);
                    std::thread::sleep(RECHECK);
                }
            });
        if let Err(err) = spawned {
            tracing::warn!("could not start update checks: {err}");
        }
    }

    /// Check now, on another thread. `manual` means the user asked, and is
    /// told the answer whatever it is.
    pub fn check(self: &Arc<Self>, manual: bool) {
        let updater = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("telekey-update-check".into())
            .spawn(move || updater.run_check(manual));
        if let Err(err) = spawned {
            tracing::warn!("could not start an update check: {err}");
        }
    }

    fn run_check(&self, manual: bool) {
        // Ready already: the restart is the next step, not another download.
        if matches!(
            *self.state.lock(),
            UpdateState::Ready { .. } | UpdateState::Installing { .. }
        ) {
            return;
        }
        if self.checking.swap(true, Ordering::SeqCst) {
            return;
        }
        let ended = self.check_and_download();
        self.checking.store(false, Ordering::SeqCst);
        self.set_state(ended.clone());

        let current = self.app.package_info().version.to_string();
        let mut announced = self.announced.lock();
        if let Some(text) = notice_for(&ended, manual, &current, announced.as_deref()) {
            if let UpdateState::Ready { version } = &ended {
                *announced = Some(version.clone());
            }
            drop(announced);
            self.overlay.notice(text);
        }
    }

    fn check_and_download(&self) -> UpdateState {
        self.set_state(UpdateState::Checking);
        let updater = match self.updater() {
            Ok(updater) => updater,
            Err(err) => {
                tracing::warn!("update checks are misconfigured: {err}");
                return UpdateState::Failed {
                    message: to_message(&err),
                };
            }
        };

        let found = tauri::async_runtime::block_on(updater.check());
        let update = match found {
            Ok(Some(update)) => update,
            Ok(None) => {
                tracing::info!("TeleKey is up to date");
                return UpdateState::UpToDate;
            }
            Err(err) => {
                tracing::info!("update check failed: {err}");
                return UpdateState::Failed {
                    message: to_message(&err),
                };
            }
        };

        let version = update.version.clone();
        tracing::info!(%version, "downloading an update");
        self.set_state(UpdateState::Downloading {
            version: version.clone(),
            percent: None,
        });
        let mut received = 0u64;
        let mut shown = None;
        let downloaded = tauri::async_runtime::block_on(update.download(
            |chunk, total| {
                received += chunk as u64;
                let now = percent(received, total);
                if now != shown {
                    shown = now;
                    self.set_state(UpdateState::Downloading {
                        version: version.clone(),
                        percent: now,
                    });
                }
            },
            || {},
        ));

        // `download` verifies the signature before it returns the bytes.
        match downloaded {
            Ok(bytes) => {
                tracing::info!(%version, bytes = bytes.len(), "update downloaded and verified");
                *self.ready.lock() = Some(Downloaded { update, bytes });
                UpdateState::Ready { version }
            }
            Err(err) => {
                tracing::warn!(%version, "update download failed: {err}");
                UpdateState::Failed {
                    message: to_message(&err),
                }
            }
        }
    }

    /// Install the waiting update and relaunch, once no dictation is running.
    pub fn restart_to_update(self: &Arc<Self>) {
        if self.installing.swap(true, Ordering::SeqCst) {
            return;
        }
        let updater = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("telekey-update-install".into())
            .spawn(move || {
                updater.install();
                updater.installing.store(false, Ordering::SeqCst);
            });
        if let Err(err) = spawned {
            self.installing.store(false, Ordering::SeqCst);
            tracing::warn!("could not start the update: {err}");
        }
    }

    fn install(&self) {
        let deadline = Instant::now() + IDLE_WAIT;
        while self.dictating() {
            if Instant::now() >= deadline {
                tracing::info!("update restart abandoned: a dictation ran for too long");
                self.overlay
                    .notice("Finish dictating, then restart to update.".into());
                return;
            }
            std::thread::sleep(IDLE_POLL);
        }

        let Some(Downloaded { update, bytes }) = self.ready.lock().take() else {
            return;
        };
        let version = update.version.clone();
        self.set_state(UpdateState::Installing {
            version: version.clone(),
        });
        tracing::info!(%version, "installing the update");

        // On Windows this does not return: the installer takes over and
        // starts TeleKey again when it is done.
        match update.install(&bytes) {
            Ok(()) => {
                tracing::info!(%version, "update installed, restarting");
                self.app.restart();
            }
            Err(err) => {
                tracing::warn!(%version, "could not install the update: {err}");
                *self.ready.lock() = Some(Downloaded { update, bytes });
                self.set_state(UpdateState::Ready { version });
                self.overlay.notice(to_message(&err));
            }
        }
    }

    /// From key-down until the result has gone, a restart would lose words.
    fn dictating(&self) -> bool {
        let recording = self
            .app
            .try_state::<Arc<Pipeline>>()
            .is_some_and(|pipeline| pipeline.is_recording());
        recording || self.overlay.is_busy()
    }

    fn updater(&self) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
        let app = self.app.clone();
        let mut builder = self
            .app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            // Windows ends the process to run the installer, skipping the
            // usual exit path; never leave the speakers muted.
            .on_before_exit(move || {
                if let Some(pipeline) = app.try_state::<Arc<Pipeline>>() {
                    pipeline.restore_output();
                }
            });
        if let Some(url) = std::env::var(ENDPOINT_ENV).ok().filter(|url| !url.is_empty()) {
            tracing::info!(%url, "checking a test update feed");
            builder = builder.endpoints(vec![url.parse()?])?;
        }
        builder.build()
    }

    fn set_state(&self, state: UpdateState) {
        {
            let mut current = self.state.lock();
            if *current == state {
                return;
            }
            *current = state.clone();
        }
        if let Some(item) = self.menu_item.lock().as_ref() {
            apply_label(item, &state);
        }
        if let Err(err) = self.app.emit(UPDATE_EVENT, self.status()) {
            tracing::warn!("could not announce the update state: {err}");
        }
    }
}

fn apply_label(item: &MenuItem<Wry>, state: &UpdateState) {
    let (text, enabled) = menu_label(state);
    if let Err(err) = item.set_text(text) {
        tracing::warn!("could not relabel the update menu item: {err}");
    }
    if let Err(err) = item.set_enabled(enabled) {
        tracing::warn!("could not enable the update menu item: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(version: &str) -> UpdateState {
        UpdateState::Ready {
            version: version.into(),
        }
    }

    #[test]
    fn the_menu_offers_a_restart_only_when_an_update_is_ready() {
        assert_eq!(menu_label(&UpdateState::Idle), ("Check for Updates…".into(), true));
        assert_eq!(
            menu_label(&ready("0.3.0")),
            ("Restart to Update to 0.3.0".into(), true)
        );
        for busy in [
            UpdateState::Checking,
            UpdateState::Downloading {
                version: "0.3.0".into(),
                percent: Some(40),
            },
            UpdateState::Installing {
                version: "0.3.0".into(),
            },
        ] {
            assert!(!menu_label(&busy).1, "{busy:?} should not be clickable");
        }
    }

    #[test]
    fn an_automatic_check_speaks_only_about_a_new_ready_version() {
        assert_eq!(notice_for(&UpdateState::UpToDate, false, "0.2.3", None), None);
        let failed = UpdateState::Failed {
            message: "Couldn't reach the update server. Check your connection.".into(),
        };
        assert_eq!(notice_for(&failed, false, "0.2.3", None), None);
        assert!(notice_for(&ready("0.3.0"), false, "0.2.3", None)
            .unwrap()
            .starts_with("TeleKey 0.3.0 is ready."));
        assert_eq!(notice_for(&ready("0.3.0"), false, "0.2.3", Some("0.3.0")), None);
        assert!(notice_for(&ready("0.3.1"), false, "0.2.3", Some("0.3.0")).is_some());
    }

    #[test]
    fn a_check_the_user_asked_for_always_answers() {
        assert_eq!(
            notice_for(&UpdateState::UpToDate, true, "0.2.3", None).as_deref(),
            Some("TeleKey 0.2.3 is up to date.")
        );
        let failed = UpdateState::Failed {
            message: "Couldn't find the latest version information.".into(),
        };
        assert_eq!(
            notice_for(&failed, true, "0.2.3", None).as_deref(),
            Some("Couldn't find the latest version information.")
        );
        assert!(notice_for(&ready("0.3.0"), true, "0.2.3", Some("0.3.0")).is_some());
    }

    #[test]
    fn progress_is_a_whole_percentage_or_unknown() {
        assert_eq!(percent(0, Some(200)), Some(0));
        assert_eq!(percent(50, Some(200)), Some(25));
        assert_eq!(percent(250, Some(200)), Some(100));
        assert_eq!(percent(50, None), None);
        assert_eq!(percent(50, Some(0)), None);
    }

    #[test]
    fn the_status_reads_as_one_flat_object() {
        let status = UpdateStatus {
            current: "0.2.3".into(),
            state: UpdateState::Downloading {
                version: "0.3.0".into(),
                percent: Some(12),
            },
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "current": "0.2.3",
                "state": "downloading",
                "version": "0.3.0",
                "percent": 12
            })
        );
        let idle = UpdateStatus {
            current: "0.2.3".into(),
            state: UpdateState::Idle,
        };
        assert_eq!(
            serde_json::to_value(&idle).unwrap(),
            serde_json::json!({ "current": "0.2.3", "state": "idle" })
        );
    }

    /// rustls panics when it is asked for a client config with two crypto
    /// backends compiled in and neither installed as the default, and
    /// tungstenite asks on every wss:// handshake: Instant would crash on
    /// key-down. The updater's default features bring in the second one.
    #[test]
    fn one_tls_backend_so_instant_can_connect() {
        let _ = rustls::ClientConfig::builder();
    }

    #[test]
    fn errors_never_reach_the_user_raw() {
        let message = to_message(&tauri_plugin_updater::Error::ReleaseNotFound);
        assert!(!message.contains("JSON"), "{message}");
        let message = to_message(&tauri_plugin_updater::Error::InvalidUpdaterFormat);
        assert_eq!(message, "Couldn't update TeleKey. Try again later.");
    }
}
