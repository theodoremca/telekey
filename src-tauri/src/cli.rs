//! Terminal helpers for setup and diagnostics.
//!
//! The API key is read from stdin rather than an argument so it never appears in
//! `ps`, shell history, or a log line. It goes straight to the Keychain.

use std::io::{BufRead, Write};

use anyhow::{bail, Context, Result};

use crate::inject::accessibility_granted;
use crate::settings::{self, Settings};

/// Read a key from stdin and store it in the Keychain.
pub fn set_api_key() -> Result<()> {
    print!("Paste your OpenAI API key (input is not echoed to any log): ");
    std::io::stdout().flush().ok();

    let mut key = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut key)
        .context("could not read from stdin")?;

    let key = key.trim();
    if key.is_empty() {
        bail!("no key entered");
    }
    if !key.starts_with("sk-") {
        bail!("that does not look like an OpenAI API key (expected it to start with 'sk-')");
    }

    settings::store_api_key(key)?;
    println!("Saved to the Keychain. TeleKey will pick it up on the next dictation.");
    Ok(())
}

pub fn clear_api_key() -> Result<()> {
    settings::clear_api_key()?;
    println!("API key removed from the Keychain.");
    Ok(())
}

/// Print what is and is not set up. Never prints the key itself.
pub fn check() -> Result<()> {
    let dir = settings::config_dir()?;
    let loaded = Settings::load(&dir);

    println!("TeleKey setup check");
    println!("--------------------");

    match &loaded {
        Ok(settings) => {
            println!("  settings file    {}", dir.join("settings.json").display());
            println!("  shortcut         {}", settings.shortcut);
            println!("  languages        {}", settings.languages.join(", "));
            println!("  vocabulary       {} term(s)", settings.keywords().len());
            println!("  polish pass      {}", on_off(settings.polish_enabled));
        }
        Err(err) => println!("  settings         UNREADABLE: {err:#}"),
    }

    let resolved = settings::resolve_api_key().unwrap_or(None);
    let key_set = resolved.is_some();
    match &resolved {
        // The source, never the key itself.
        Some((_, source)) => println!("  API key          yes  (from {source})"),
        None => println!("  API key          NO"),
    }

    let hosted = crate::session::status();
    match (&hosted.signed_in, &hosted.email) {
        (true, Some(email)) => println!("  hosted account   yes  ({email})"),
        (true, None) => println!("  hosted account   yes"),
        (false, _) => println!("  hosted account   no"),
    }

    println!("  accessibility    {}", yes_no(accessibility_granted()));
    println!("  signature        {}", describe_signing());
    println!("  input device     {}", describe_input_device());

    let ready = (key_set || hosted.signed_in) && accessibility_granted() && loaded.is_ok();
    println!();
    if ready {
        println!("Ready to dictate.");
    } else {
        println!("Not ready yet:");
        if !key_set && !hosted.signed_in {
            println!("  - run `{} set-api-key`", invocation());
            println!("    (or sign in from Settings, or set OPENAI_API_KEY in .env)");
        }
        if !accessibility_granted() {
            println!(
                "  - grant Accessibility in System Settings › Privacy & Security › Accessibility"
            );
        }
        if let Some(advice) = crate::signing::current().advice() {
            println!("  - {advice}");
        }
    }

    Ok(())
}

/// How to invoke this binary from the user's current directory.
///
/// The binary is not on `PATH` during development, so printing a bare
/// `telekey` sends people to `command not found`.
fn invocation() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return "telekey".to_string();
    };

    match std::env::current_dir() {
        Ok(cwd) => match exe.strip_prefix(&cwd) {
            Ok(relative) => format!("./{}", relative.display()),
            Err(_) => exe.display().to_string(),
        },
        Err(_) => exe.display().to_string(),
    }
}

fn describe_signing() -> String {
    use crate::signing::Signing;

    match crate::signing::current() {
        Signing::Stable => "stable (permissions survive rebuilds)".to_string(),
        Signing::Unstable => {
            "AD-HOC — permissions reset on rebuild, run ./scripts/dev-sign.sh".to_string()
        }
        Signing::Unknown => "unknown (not running from an app bundle)".to_string(),
    }
}

fn describe_input_device() -> String {
    match crate::input_device::current() {
        Some(device) => format!("{} ({})", device.name, device.id),
        None => "NONE FOUND".to_string(),
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "NO"
    }
}

fn on_off(value: bool) -> &'static str {
    if value {
        "on"
    } else {
        "off"
    }
}
