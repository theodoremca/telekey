#!/usr/bin/env bash
#
# Put this Mac back the way a brand-new TeleKey user finds it, so the next
# install is a genuine first run: the Setup window, every permission prompt,
# signed out, and a new user's staging welcome credit.
#
# What it clears, in this order, and why the order matters:
#   1. quits TeleKey normally. Never force-killed: a normal quit is what hands
#      the audio back if "mute while dictating" is on.
#   2. resets Accessibility, Microphone and Input Monitoring, for TeleKey only.
#      This must happen BEFORE the app is deleted: tccutil finds the app
#      through Launch Services and fails with -10814 once it is gone.
#   3. resets the signed-in account's staging credits, via
#      functions/scripts/reset-staging-user.cjs (staging only, by construction)
#   4. removes the saved sign-in, and any stored OpenAI key, from the Keychain
#   5. deletes the app and every file it keeps, old Flowtype leftovers
#      included: the app adopts those on its first launch, which would quietly
#      turn a first run into a migration.
#
# Every path is written out in full. There is deliberately no wildcard: a glob
# on "flowtype" under ~/Library also matches Claude Code's cache for this
# repository.
#
# Usage:
#   ./scripts/reset-to-first-run.sh              show the plan, ask, then reset
#   ./scripts/reset-to-first-run.sh --dry-run    show the plan; change nothing
#   ./scripts/reset-to-first-run.sh --reinstall  reset, then ./scripts/run.sh
#
#   --keep-credits     leave the staging account alone
#   --email <address>  reset this staging account instead of the signed-in one
#   --yes              do not ask (for use without a terminal)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# System tools first, as run.sh does: some Python distributions shadow them.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

BUNDLE_ID="com.theodoremca.telekey"
APP="/Applications/TeleKey.app"
BIN="$APP/Contents/MacOS/TeleKey"

# tccutil service names for what the app asks for: AXIsProcessTrustedWithOptions,
# AVCaptureDevice audio, and CGRequestListenEventAccess (Input Monitoring).
PERMISSIONS=(Accessibility Microphone ListenEvent)

# service and account pairs. The flowtype ones are what adopt_legacy_key would
# copy back in on first launch.
KEYCHAIN_ITEMS=(
  "telekey hosted-session"
  "telekey openai-api-key"
  "flowtype openai-api-key"
  "flowtype hosted-session"
)

die() {
  printf '\n%s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '/^# Usage:/,/^# *--yes/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

DRY_RUN=false
ASSUME_YES=false
KEEP_CREDITS=false
REINSTALL=false
EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --yes | -y) ASSUME_YES=true ;;
    --keep-credits) KEEP_CREDITS=true ;;
    --reinstall) REINSTALL=true ;;
    --email)
      if [[ $# -lt 2 || -z "$2" ]]; then
        printf -- '--email needs an address.\n\n' >&2
        usage >&2
        exit 64
      fi
      EMAIL="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || die "This resets a macOS install. Run it on the Mac."
[[ -n "${HOME:-}" && "$HOME" != "/" ]] || die "HOME is not set sensibly. Refusing to delete anything."

# ---- what to remove ---------------------------------------------------------

# The crash reporter names its file after the process and this Mac's hardware
# id, so the exact path is known without searching for it.
hw_uuid="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '!seen && /IOPlatformUUID/ {print $4; seen = 1}')" || hw_uuid=""

TARGETS=(
  "$APP"
  "$HOME/Library/Application Support/telekey"
  "$HOME/Library/Application Support/flowtype"
  "$HOME/Library/WebKit/com.theodoremca.telekey"
  "$HOME/Library/WebKit/com.theodoremca.flowtype"
  "$HOME/Library/WebKit/flowtype"
  "$HOME/Library/Caches/com.theodoremca.telekey"
  "$HOME/Library/Caches/com.theodoremca.flowtype"
  "$HOME/Library/Caches/flowtype"
  "$HOME/Library/HTTPStorages/com.theodoremca.telekey"
  "$HOME/Library/Saved Application State/com.theodoremca.telekey.savedState"
  "$HOME/Library/Logs/telekey.log"
  "$HOME/Library/Logs/flowtype.log"
)
if [[ -n "$hw_uuid" ]]; then
  TARGETS+=(
    "$HOME/Library/Application Support/CrashReporter/TeleKey_${hw_uuid}.plist"
    "$HOME/Library/Application Support/CrashReporter/flowtype_${hw_uuid}.plist"
  )
fi

# Belt and braces. Every target above is a literal, but a later edit could add a
# typo or a computed path, so each one must also pass all of these before it is
# deleted:
#   - it is the app itself, or somewhere under ~/Library
#   - it has no "." or ".." component, which a prefix check alone would let
#     resolve outside ~/Library (~/Library/../.ssh passes a bare prefix test)
#   - its last component names TeleKey or Flowtype, so an unrelated ~/Library
#     folder such as Mail or Keychains is refused however it got in
#   - it does not name Claude Code's cache, which also contains "flowtype"
assert_removable() {
  local path="$1"
  case "$path" in
    "$APP") return 0 ;;
    "$HOME/Library/"?*) ;;
    *) die "Refusing to remove an unexpected path: $path" ;;
  esac
  case "/$path/" in
    */./* | */../*) die "Refusing a path with a . or .. component: $path" ;;
  esac
  local name
  name="$(printf '%s' "${path##*/}" | tr '[:upper:]' '[:lower:]')"
  [[ "$name" == *telekey* || "$name" == *flowtype* ]] ||
    die "Refusing to remove something that does not name TeleKey or Flowtype: $path"
  [[ "$path" != *claude-cli* ]] || die "Refusing to touch Claude Code's cache: $path"
}
for target in "${TARGETS[@]}"; do
  assert_removable "$target"
done

tilde() {
  printf '%s' "${1/#$HOME/~}"
}

permission_name() {
  case "$1" in
    ListenEvent) printf 'Input Monitoring' ;;
    *) printf '%s' "$1" ;;
  esac
}

# Read one key=value line from the credits helper's output.
kv() {
  printf '%s\n' "$2" | sed -n "s/^$1=//p" | tail -n 1
}

# ---- survey: nothing below changes anything --------------------------------

running=false
pgrep -x TeleKey >/dev/null 2>&1 && running=true

present=()
for target in "${TARGETS[@]}"; do
  [[ -e "$target" || -L "$target" ]] && present+=("$target")
done

keychain_present=()
openai_key_present=false
for item in "${KEYCHAIN_ITEMS[@]}"; do
  read -r service account <<<"$item"
  # Metadata only. Never -w or -g, which would print the secret.
  if security find-generic-password -s "$service" -a "$account" >/dev/null 2>&1; then
    keychain_present+=("$item")
    [[ "$account" == openai-api-key ]] && openai_key_present=true
  fi
done

prefs_present=false
defaults read "$BUNDLE_ID" >/dev/null 2>&1 && prefs_present=true

# Credits: ask the installed app which account it is signed in to, before the
# app and its session are gone. It prints the email; the session itself stays
# in the Keychain untouched.
credits_account=""
credits_note=""
if $KEEP_CREDITS; then
  credits_note="left alone (--keep-credits)"
else
  signed_in=false
  if [[ -z "$EMAIL" && -x "$BIN" ]]; then
    check_output="$("$BIN" check 2>/dev/null || true)"
    # Bash's own matching, not grep -q or awk in a pipe: an early-exiting
    # reader can SIGPIPE the writer, and under pipefail a true test reads false.
    signed_in_re='hosted account[[:space:]]+yes'
    email_re='hosted account[[:space:]]+yes[[:space:]]+[(]([^)]*)[)]'
    if [[ "$check_output" =~ $signed_in_re ]]; then
      signed_in=true
      if [[ "$check_output" =~ $email_re ]]; then
        EMAIL="${BASH_REMATCH[1]}"
      fi
    fi
  fi

  if [[ -z "$EMAIL" ]] && $signed_in; then
    die "TeleKey says it is signed in, but not to which account, so there is no safe way to
tell whose credits to reset. Run it again with --email <address>, or with --keep-credits."
  elif [[ -z "$EMAIL" ]]; then
    credits_note="nothing to reset: TeleKey is not signed in to an account (pass --email to reset one anyway)"
  else
    command -v node >/dev/null 2>&1 ||
      die "Resetting credits needs Node, which is not installed. Install it, or pass --keep-credits."
    [[ -d "$ROOT/functions/node_modules/firebase-admin" ]] ||
      die "Resetting credits needs firebase-admin. Run 'cd functions && npm install', or pass --keep-credits."

    # Read-only lookup, so the plan shows exactly whose credits go before
    # anything is deleted, and a credentials problem stops the run here rather
    # than halfway through.
    if ! lookup="$(cd "$ROOT/functions" && node scripts/reset-staging-user.cjs --email "$EMAIL" --dry-run 2>&1)"; then
      if [[ "$(kv account "$lookup")" == ambiguous ]]; then
        die "More than one staging account has the email $EMAIL, so this will not guess which to reset:
$lookup

Remove the duplicate in the Firebase console and run again, or pass --keep-credits."
      fi
      die "Could not look up the staging account for $EMAIL:
$lookup

Fix that and run again, or pass --keep-credits to reset everything else.
If it is a credentials error: gcloud auth application-default login"
    fi

    case "$(kv account "$lookup")" in
      none)
        credits_note="nothing to reset: no staging account for $EMAIL"
        ;;
      ambiguous)
        die "More than one staging account has the email $EMAIL. Refusing to guess which to reset:
$lookup"
        ;;
      "")
        die "The credits lookup gave an answer this script does not understand:
$lookup"
        ;;
      *)
        credits_account="$(kv account "$lookup")"
        credits_note="staging account $EMAIL: $(kv balanceCents "$lookup")¢ and $(kv records "$lookup") usage and purchase records, deleted. Signing in again recreates it with a new user's credit."
        ;;
    esac
  fi
fi

# ---- the plan ---------------------------------------------------------------

printf 'Reset TeleKey to a first install\n\n'

if $running; then
  printf '  App          quit TeleKey first (it is running)\n'
fi
printf '  Permissions  reset Accessibility, Microphone and Input Monitoring for %s\n' "$BUNDLE_ID"
printf '  Credits      %s\n' "$credits_note"

if [[ ${#keychain_present[@]} -gt 0 ]]; then
  printf '  Keychain     remove:'
  for item in "${keychain_present[@]}"; do
    read -r service account <<<"$item"
    printf ' %s/%s' "$service" "$account"
  done
  printf '\n'
else
  printf '  Keychain     nothing stored\n'
fi
if $openai_key_present; then
  printf '               WARNING: that includes your stored OpenAI key. Copy it somewhere first\n'
  printf '               if you have no other copy: it cannot be recovered afterwards.\n'
fi

$prefs_present && printf '  Preferences  delete the %s defaults\n' "$BUNDLE_ID"

if [[ ${#present[@]} -gt 0 ]]; then
  printf '  Files        delete %d:\n' "${#present[@]}"
  for target in "${present[@]}"; do
    printf '                 %s\n' "$(tilde "$target")"
  done
else
  printf '  Files        nothing left to delete\n'
fi
printf '\n'

if $DRY_RUN; then
  printf 'Dry run: nothing was changed.\n'
  exit 0
fi

if ! $ASSUME_YES; then
  [[ -t 0 ]] || die "Not running in a terminal, so there is no one to confirm. Re-run with --yes to go ahead without asking."
  read -r -p "This cannot be undone. Type y to go ahead: " answer
  if [[ "$answer" != y && "$answer" != Y ]]; then
    printf 'Nothing was changed.\n'
    exit 0
  fi
  printf '\n'
fi

# ---- do it ------------------------------------------------------------------

# Every step is safe to repeat, so an interrupted run is finished by running
# it again. Say so, rather than stopping in silence.
trap 'printf "\n\nInterrupted part-way. Everything here is safe to repeat: run\n  ./scripts/reset-to-first-run.sh --dry-run\nto see what is left, then run it again to finish.\n" >&2; exit 130' INT TERM

failures=()

# 1. Quit. Only ask a running app to quit: asking one that is not running
#    would launch it first.
if pgrep -x TeleKey >/dev/null 2>&1; then
  printf 'Quitting TeleKey\n'
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -x TeleKey >/dev/null 2>&1 || break
    sleep 0.5
  done
  pgrep -x TeleKey >/dev/null 2>&1 &&
    die "TeleKey did not quit. Quit it from the menu bar icon and run this again. Nothing has been deleted yet."
fi

# 2. Permissions, while the app is still installed for tccutil to find.
for service in "${PERMISSIONS[@]}"; do
  name="$(permission_name "$service")"
  if output="$(tccutil reset "$service" "$BUNDLE_ID" 2>&1)"; then
    printf 'Reset %s\n' "$name"
  else
    failures+=("$name permission: ${output:-tccutil failed}. Remove TeleKey by hand in System Settings > Privacy & Security > $name.")
  fi
done

# 3. Credits.
if [[ -n "$credits_account" ]]; then
  if output="$(cd "$ROOT/functions" && node scripts/reset-staging-user.cjs --email "$EMAIL" 2>&1)" &&
    [[ "$(kv deleted "$output")" == yes ]]; then
    printf 'Reset the staging account for %s\n' "$EMAIL"
  else
    failures+=("staging credits: ${output:-no output}. Retry with: cd functions && node scripts/reset-staging-user.cjs --email $EMAIL")
  fi
fi

# 4. Keychain.
for item in "${keychain_present[@]+"${keychain_present[@]}"}"; do
  read -r service account <<<"$item"
  if security delete-generic-password -s "$service" -a "$account" >/dev/null 2>&1; then
    printf 'Removed Keychain item %s/%s\n' "$service" "$account"
  else
    failures+=("Keychain item $service/$account could not be removed. Delete it in Keychain Access.")
  fi
done

# 5. Preferences, through defaults rather than rm, so cfprefsd does not write
#    its cached copy straight back.
if $prefs_present; then
  if defaults delete "$BUNDLE_ID" >/dev/null 2>&1; then
    printf 'Deleted the %s preferences\n' "$BUNDLE_ID"
  else
    failures+=("preferences for $BUNDLE_ID could not be deleted: defaults delete $BUNDLE_ID")
  fi
fi

# 6. Files.
for target in "${present[@]+"${present[@]}"}"; do
  assert_removable "$target"
  if rm -rf -- "$target"; then
    printf 'Deleted %s\n' "$(tilde "$target")"
  else
    failures+=("could not delete $(tilde "$target")")
  fi
done

# ---- check it took ----------------------------------------------------------

for target in "${TARGETS[@]}"; do
  if [[ -e "$target" || -L "$target" ]]; then
    failures+=("still present afterwards: $(tilde "$target")")
  fi
done
for item in "${KEYCHAIN_ITEMS[@]}"; do
  read -r service account <<<"$item"
  if security find-generic-password -s "$service" -a "$account" >/dev/null 2>&1; then
    failures+=("Keychain item still present afterwards: $service/$account")
  fi
done
if pgrep -x TeleKey >/dev/null 2>&1; then
  failures+=("TeleKey is running again, perhaps relaunched by something else")
fi

printf '\n'
if [[ ${#failures[@]} -gt 0 ]]; then
  printf 'Done, with %d problem(s):\n' "${#failures[@]}"
  for failure in "${failures[@]}"; do
    printf '  - %s\n' "$failure"
  done
  exit 1
fi

printf 'Done. This Mac now looks like it has never had TeleKey.\n'
if [[ -n "$credits_account" ]]; then
  printf 'Sign in as %s after installing: you will get a new user'\''s credit.\n' "$EMAIL"
fi

if $REINSTALL; then
  printf '\nReinstalling with ./scripts/run.sh\n\n'
  exec "$ROOT/scripts/run.sh"
fi
printf 'Next: ./scripts/run.sh to build, install and launch it fresh.\n'
