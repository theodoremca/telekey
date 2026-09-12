// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Subcommands are terminal-only helpers; with no arguments this is the app.
    let command = std::env::args().nth(1);

    let result = match command.as_deref() {
        Some("set-api-key") => telekey_lib::cli::set_api_key(),
        Some("clear-api-key") => telekey_lib::cli::clear_api_key(),
        Some("check") => telekey_lib::cli::check(),
        Some(other) => {
            eprintln!("unknown command '{other}'");
            eprintln!("usage: telekey [set-api-key | clear-api-key | check]");
            std::process::exit(2);
        }
        None => return telekey_lib::run(),
    };

    if let Err(err) = result {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}
