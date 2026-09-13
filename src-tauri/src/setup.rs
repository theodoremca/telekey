//! What still stands between the user and a working dictation.
//!
//! Permissions are the awkward part of shipping this app: three of them, each
//! granted somewhere different, two of which do nothing until the process is
//! restarted. This module turns that into a list of rows the setup window can
//! render, and it is deliberately pure — permissions as they were at launch,
//! permissions as they are now, and two facts about configuration in; rows
//! out. No Tauri, no macOS APIs, so the cases that actually bite are testable:
//! hold-Fn switched off, and a permission granted since the process started.

use serde::Serialize;

use crate::permissions::{Permission, Permissions};

/// One row of the setup window, and the thing the frontend acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    ApiKey,
    Microphone,
    Accessibility,
    InputMonitoring,
}

impl Step {
    /// Whether this is only read while the process is starting.
    ///
    /// Accessibility is resolved into the process's trust state at launch, and
    /// the Fn event tap is installed at launch or not at all — so granting
    /// either one mid-session changes nothing until a restart. The microphone
    /// is live. Being generous with this would mean asking for restarts that
    /// achieve nothing, which is how an onboarding screen turns into a nag, so
    /// it is stated once, here.
    fn read_at_launch(self) -> bool {
        matches!(self, Self::Accessibility | Self::InputMonitoring)
    }
}

/// How a step reads to the user.
///
/// [`Permission`] maps onto this, but so does the API key, which is not a
/// permission at all — hence a separate type rather than pretending it is one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepState {
    Done,
    Missing,
    /// macOS asks by itself the first time it is needed, so this is not a
    /// failure yet — and showing it in red would be a lie.
    AsksOnFirstUse,
    Unknown,
}

impl From<Permission> for StepState {
    fn from(permission: Permission) -> Self {
        match permission {
            Permission::Granted => Self::Done,
            Permission::Denied => Self::Missing,
            Permission::NotAsked => Self::AsksOnFirstUse,
            Permission::Unknown => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub step: Step,
    pub state: StepState,
    /// Granted, but not in force until the process starts again.
    pub needs_restart: bool,
}

impl Requirement {
    pub fn is_done(&self) -> bool {
        matches!(self.state, StepState::Done)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub requirements: Vec<Requirement>,
    /// Nothing left for the user to do. A pending restart still counts as
    /// complete: they have granted everything asked of them, and the window
    /// should stop blocking them on a screen they have finished with.
    pub complete: bool,
    pub restart_pending: bool,
}

/// Work out what the setup window should show.
pub fn evaluate(
    at_launch: Permissions,
    now: Permissions,
    api_key_is_set: bool,
    fn_trigger: bool,
) -> SetupState {
    let mut requirements = vec![
        Requirement {
            step: Step::ApiKey,
            state: if api_key_is_set {
                StepState::Done
            } else {
                StepState::Missing
            },
            // A new key is picked up immediately: the pipeline drops its cached
            // transcriber when one is saved.
            needs_restart: false,
        },
        requirement(Step::Microphone, at_launch.microphone, now.microphone),
        requirement(
            Step::Accessibility,
            at_launch.accessibility,
            now.accessibility,
        ),
    ];

    // Input Monitoring buys nothing unless hold-Fn is switched on. Asking for a
    // permission the user has no use for costs trust, and this one is the most
    // alarming-sounding of the three.
    if fn_trigger {
        requirements.push(requirement(
            Step::InputMonitoring,
            at_launch.input_monitoring,
            now.input_monitoring,
        ));
    }

    SetupState {
        complete: requirements.iter().all(Requirement::is_done),
        restart_pending: requirements.iter().any(|row| row.needs_restart),
        requirements,
    }
}

fn requirement(step: Step, at_launch: Permission, now: Permission) -> Requirement {
    Requirement {
        step,
        state: now.into(),
        needs_restart: step.read_at_launch() && now.is_granted() && !at_launch.is_granted(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nothing_granted() -> Permissions {
        Permissions {
            accessibility: Permission::Denied,
            microphone: Permission::NotAsked,
            input_monitoring: Permission::Denied,
        }
    }

    fn everything_granted() -> Permissions {
        Permissions {
            accessibility: Permission::Granted,
            microphone: Permission::Granted,
            input_monitoring: Permission::Granted,
        }
    }

    fn row(state: &SetupState, step: Step) -> Requirement {
        *state
            .requirements
            .iter()
            .find(|row| row.step == step)
            .unwrap_or_else(|| panic!("{step:?} should be listed"))
    }

    #[test]
    fn a_fresh_install_has_everything_left_to_do() {
        let state = evaluate(nothing_granted(), nothing_granted(), false, false);

        assert!(!state.complete);
        assert!(
            !state.restart_pending,
            "nothing has been granted to restart for"
        );
        assert_eq!(row(&state, Step::ApiKey).state, StepState::Missing);
        assert_eq!(row(&state, Step::Accessibility).state, StepState::Missing);
    }

    #[test]
    fn a_microphone_that_has_never_been_asked_for_is_not_a_failure() {
        let state = evaluate(nothing_granted(), nothing_granted(), false, false);

        assert_eq!(
            row(&state, Step::Microphone).state,
            StepState::AsksOnFirstUse,
            "macOS prompts on first use, so this must not read as denied"
        );
    }

    #[test]
    fn input_monitoring_is_listed_only_when_hold_fn_is_on() {
        let without = evaluate(nothing_granted(), nothing_granted(), true, false);
        let with = evaluate(nothing_granted(), nothing_granted(), true, true);

        assert_eq!(without.requirements.len(), 3);
        assert!(!without
            .requirements
            .iter()
            .any(|row| row.step == Step::InputMonitoring));
        assert_eq!(with.requirements.len(), 4);
    }

    #[test]
    fn granting_accessibility_after_launch_asks_for_a_restart() {
        let state = evaluate(nothing_granted(), everything_granted(), true, false);

        assert!(row(&state, Step::Accessibility).needs_restart);
        assert!(state.restart_pending);
    }

    #[test]
    fn a_permission_granted_before_launch_never_asks_for_a_restart() {
        let state = evaluate(everything_granted(), everything_granted(), true, true);

        assert!(!state.restart_pending);
        assert!(state.requirements.iter().all(|row| !row.needs_restart));
    }

    #[test]
    fn the_microphone_never_asks_for_a_restart() {
        // Granted during this session, unlike at launch — and still live.
        let state = evaluate(nothing_granted(), everything_granted(), true, false);

        assert!(
            !row(&state, Step::Microphone).needs_restart,
            "the microphone takes effect immediately; asking to restart for it is a nag"
        );
    }

    #[test]
    fn everything_granted_is_complete_even_with_a_restart_pending() {
        let state = evaluate(nothing_granted(), everything_granted(), true, true);

        assert!(state.complete, "the user has done everything asked of them");
        assert!(state.restart_pending, "but it is not in force yet");
    }

    #[test]
    fn a_missing_key_alone_blocks_completion() {
        let state = evaluate(everything_granted(), everything_granted(), false, true);

        assert!(!state.complete);
        assert!(state
            .requirements
            .iter()
            .filter(|row| row.step != Step::ApiKey)
            .all(Requirement::is_done));
    }
}
