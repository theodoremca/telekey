//! The push-to-talk trigger.
//!
//! `tauri-plugin-global-shortcut` reports both `Pressed` and `Released` for a
//! registered accelerator, which is all hold-to-talk needs. Only one shortcut is
//! ever registered at a time, so the handler does not need to match on which one
//! fired.
//!
//! Note the limitation this design accepts: accelerators must be
//! modifier-plus-key. A bare modifier held alone — Wispr Flow's `Fn` gesture —
//! is not registerable this way and would need a `CGEventTap` plus Input
//! Monitoring permission.

use std::str::FromStr;
use std::sync::{mpsc, Arc};

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerEvent {
    /// Key went down — start capturing.
    Start,
    /// Key came up — stop capturing and transcribe.
    Stop,
    /// Discard the recording or abandon an in-flight transcription. Never paste.
    Cancel,
}

/// Fan-in for every trigger: the chord, hold-Fn, Escape, and the overlay button.
///
/// `mpsc::Sender` is `Send` but not `Sync`, so the mutex is what lets the
/// shortcut plugin, the event taps, and a Tauri command all share one channel.
#[derive(Clone)]
pub struct Bus {
    tx: Arc<Mutex<mpsc::Sender<TriggerEvent>>>,
}

impl Bus {
    pub fn new(tx: mpsc::Sender<TriggerEvent>) -> Self {
        Self {
            tx: Arc::new(Mutex::new(tx)),
        }
    }

    pub fn emit(&self, event: TriggerEvent) {
        let tx = self.tx.lock().clone();
        if tx.send(event).is_err() {
            tracing::error!("trigger receiver is gone; dropping {event:?}");
        }
    }
}

/// Parse a Tauri accelerator string such as `Ctrl+Alt+Space`.
pub fn parse_accelerator(accelerator: &str) -> Result<Shortcut> {
    Shortcut::from_str(accelerator)
        .map_err(|err| anyhow!("'{accelerator}' is not a valid shortcut: {err}"))
}

/// Build the plugin, forwarding press/release onto the shared bus.
pub fn plugin<R: Runtime>(bus: Bus) -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |_app, _shortcut, event| {
            let trigger = match event.state {
                ShortcutState::Pressed => TriggerEvent::Start,
                ShortcutState::Released => TriggerEvent::Stop,
            };
            bus.emit(trigger);
        })
        .build()
}

/// Point the trigger at a new accelerator, replacing whatever was bound before.
///
/// The accelerator is validated before anything is unregistered, so a bad string
/// leaves the existing binding working rather than dropping the user with no
/// shortcut at all.
pub fn rebind<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<()> {
    let shortcut = parse_accelerator(accelerator)?;
    let shortcuts = app.global_shortcut();

    shortcuts
        .unregister_all()
        .map_err(|err| anyhow!("could not clear existing shortcuts: {err}"))?;

    shortcuts
        .register(shortcut)
        .map_err(|err| anyhow!("could not register '{accelerator}': {err}"))?;

    tracing::info!("push-to-talk bound to {accelerator}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_default_accelerator() {
        assert!(parse_accelerator(crate::settings::DEFAULT_SHORTCUT).is_ok());
    }

    #[test]
    fn parses_common_accelerator_spellings() {
        for accelerator in [
            "Ctrl+Alt+Space",
            "CmdOrCtrl+Shift+D",
            "Super+Alt+KeyD",
            "Alt+F1",
        ] {
            assert!(
                parse_accelerator(accelerator).is_ok(),
                "expected '{accelerator}' to parse"
            );
        }
    }

    #[test]
    fn rejects_nonsense_accelerators() {
        for accelerator in ["", "NotAKey", "Ctrl+", "Ctrl+NotAKey"] {
            assert!(
                parse_accelerator(accelerator).is_err(),
                "expected '{accelerator}' to be rejected"
            );
        }
    }

    #[test]
    fn a_bare_modifier_is_rejected() {
        // Documents the design limitation: hold-Fn style triggers need an event
        // tap, not an accelerator.
        assert!(parse_accelerator("Alt").is_err());
    }

    #[test]
    fn the_bus_delivers_cancel() {
        let (tx, rx) = std::sync::mpsc::channel();
        Bus::new(tx).emit(TriggerEvent::Cancel);
        assert_eq!(rx.recv().unwrap(), TriggerEvent::Cancel);
    }
}
