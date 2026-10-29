// Vendored matcher also exposes filesystem-search APIs unused by this adapter.
#[allow(dead_code)]
mod backend;
mod engine;
mod protocol;

use std::io::{self, BufWriter};
use std::process::ExitCode;

fn main() -> ExitCode {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    match protocol::run(stdin.lock(), &mut output) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("oma-cast-search: {error}");
            ExitCode::FAILURE
        }
    }
}
