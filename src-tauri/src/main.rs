// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Subcommands are terminal-only helpers; with no arguments this is the app.
    let command = std::env::args().nth(1);

    let result = match command.as_deref() {
        Some("set-api-key") => telekey_lib::cli::set_api_key(),
        Some("clear-api-key") => telekey_lib::cli::clear_api_key(),
        Some("check") => telekey_lib::cli::check(),
        Some("instant-check") => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            let compare = args.iter().any(|arg| arg == "--compare");
            let path = args.iter().find(|arg| !arg.starts_with("--")).map(String::as_str);
            telekey_lib::cli::instant_check(path, compare)
        }
        // Windows/Linux deliver `telekey://auth?…` as argv[1] when the app is
        // launched from a deep link. That is not a CLI command.
        Some(other) if other.starts_with("telekey:") => return telekey_lib::run(),
        Some(other) => {
            eprintln!("unknown command '{other}'");
            eprintln!(
                "usage: telekey [set-api-key | clear-api-key | check | instant-check <file.wav> [--compare]]"
            );
            std::process::exit(2);
        }
        None => return telekey_lib::run(),
    };

    if let Err(err) = result {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}
