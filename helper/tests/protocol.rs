// Integration tests for the sidecar. Each test gets its own fixture and its
// own LMDB/runtime dirs, so they can run in parallel.

use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};
use tempfile::TempDir;

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    _state: TempDir,
}

impl Sidecar {
    fn start(root: &Path, watch: bool) -> Self {
        Self::try_start(root, watch).unwrap_or_else(|error| panic!("sidecar start: {error}"))
    }

    fn try_start(root: &Path, watch: bool) -> Result<Self, String> {
        let state = TempDir::new().map_err(|e| e.to_string())?;
        let db = state.path().join("db");
        let runtime = state.path().join("run");
        let mut command = Command::new(env!("CARGO_BIN_EXE_oma-cast-files"));
        command
            .arg("--root")
            .arg(root)
            .arg("--frecency-db")
            .arg(&db)
            .arg("--runtime-dir")
            .arg(&runtime)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if !watch {
            command.arg("--no-watch");
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut sidecar = Self {
            child,
            stdin,
            stdout,
            _state: state,
        };
        sidecar.wait_ready()?;
        Ok(sidecar)
    }

    fn request(&mut self, value: Value) -> Value {
        writeln!(self.stdin, "{value}").expect("write request");
        self.stdin.flush().expect("flush request");
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read response");
        assert!(!line.is_empty(), "sidecar closed stdout");
        serde_json::from_str(&line).expect("response json")
    }

    fn status(&mut self) -> Value {
        self.request(json!({"id": 1, "method": "status"}))["result"].clone()
    }

    fn wait_ready(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = self.status();
            match status["state"].as_str() {
                Some("ready") => return Ok(()),
                Some("error") => return Err(status["error"].as_str().unwrap_or("error").into()),
                _ => {}
            }
            if Instant::now() > deadline {
                return Err(format!("scan did not finish: {status}"));
            }
            sleep(Duration::from_millis(20));
        }
    }

    fn search(&mut self, query: &str) -> Value {
        self.request(json!({"id": 2, "method": "search", "params": {"query": query, "limit": 50}}))
            ["result"]
            .clone()
    }

    fn paths(&mut self, query: &str) -> Vec<PathBuf> {
        let result = self.search(query);
        result["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["path"].as_str())
                    .map(PathBuf::from)
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, "{}", json!({"id": 99, "method": "shutdown"}));
        let _ = self.stdin.flush();
        let _ = self.child.wait();
    }
}

fn fixture() -> TempDir {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::create_dir_all(root.join("node_modules")).unwrap();
    fs::create_dir_all(root.join(".hidden")).unwrap();
    fs::write(root.join("README.md"), "# readme\n").unwrap();
    fs::write(root.join("src/app.ts"), "export const app = 1\n").unwrap();
    fs::write(root.join("src/util.ts"), "export const util = 1\n").unwrap();
    fs::write(root.join("docs/guide.md"), "# guide\n").unwrap();
    fs::write(root.join("image.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    fs::write(root.join("node_modules/ignored.js"), "ignored\n").unwrap();
    fs::write(root.join(".hidden/secret.txt"), "secret\n").unwrap();
    fs::write(root.join(".env"), "TOKEN=secret\n").unwrap();
    dir
}

fn names(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
        .collect()
}

#[test]
fn searches_names_and_respects_initial_ignores() {
    let dir = fixture();
    let mut sidecar = Sidecar::start(dir.path(), false);

    let readme = sidecar.paths("readme");
    assert_eq!(names(&readme), vec!["README.md"]);

    let ts = sidecar.paths("*.ts");
    assert!(names(&ts).contains(&"app.ts".to_string()));
    assert!(names(&ts).contains(&"util.ts".to_string()));

    let ignored = sidecar.paths("ignored");
    assert!(
        !ignored
            .iter()
            .any(|p| p.to_string_lossy().contains("node_modules")),
        "node_modules leaked: {ignored:?}"
    );
    let secret = sidecar.paths("secret");
    assert!(
        !secret.iter().any(|p| p.ends_with("secret.txt")),
        "hidden file leaked: {secret:?}"
    );
    let env = sidecar.paths(".env");
    assert!(
        !env.iter().any(|p| p.ends_with(".env")),
        ".env leaked: {env:?}"
    );

    let status = sidecar.status();
    assert_eq!(status["state"], "ready");
    assert!(status["indexedFiles"].as_u64().unwrap() >= 5);
}

#[test]
fn track_records_access_and_privacy_filters_hold() {
    let dir = fixture();
    let mut sidecar = Sidecar::start(dir.path(), false);
    let app = dir.path().join("src/app.ts");

    let tracked = sidecar.request(json!({"id": 3, "method": "track", "params": {"path": app}}));
    assert_eq!(tracked["result"]["tracked"], true);

    let hidden = dir.path().join(".hidden/secret.txt");
    let rejected = sidecar.request(json!({"id": 4, "method": "track", "params": {"path": hidden}}));
    assert_eq!(rejected["result"]["tracked"], false);

    let outside_dir = TempDir::new().unwrap();
    let outside = outside_dir.path().join("outside.txt");
    fs::write(&outside, "x").unwrap();
    let rejected =
        sidecar.request(json!({"id": 5, "method": "track", "params": {"path": outside}}));
    assert_eq!(rejected["result"]["tracked"], false);
}

#[test]
fn ignore_file_excludes_a_subtree() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("keep")).unwrap();
    fs::create_dir_all(root.join("data")).unwrap();
    fs::write(root.join("keep/a.txt"), "a\n").unwrap();
    fs::write(root.join("data/x.txt"), "x\n").unwrap();
    fs::write(root.join(".ignore"), "data/\n").unwrap();

    let mut sidecar = Sidecar::start(root, false);
    assert!(sidecar
        .paths("a.txt")
        .iter()
        .any(|p| p.ends_with("keep/a.txt")));
    assert!(!sidecar
        .paths("x.txt")
        .iter()
        .any(|p| p.ends_with("data/x.txt")));
}

#[test]
fn watcher_added_hidden_files_are_not_returned() {
    let dir = fixture();
    let mut sidecar = Sidecar::start(dir.path(), true);
    for _ in 0..250 {
        if sidecar.status()["watcherReady"] == true {
            break;
        }
        sleep(Duration::from_millis(20));
    }

    fs::write(dir.path().join(".bash_history"), "secret command\n").unwrap();
    fs::write(dir.path().join("docs/.env"), "TOKEN=secret\n").unwrap();
    sleep(Duration::from_millis(500));

    assert!(!sidecar
        .paths("bash_history")
        .iter()
        .any(|p| p.ends_with(".bash_history")));
    let env = sidecar.paths(".env");
    assert!(
        !env.iter().any(|p| p.ends_with(".env")),
        ".env leaked after watcher: {env:?}"
    );
}

#[test]
fn invalid_root_reports_an_error_instead_of_crashing() {
    let state = TempDir::new().unwrap();
    let db = state.path().join("db");
    let runtime = state.path().join("run");
    let mut child = Command::new(env!("CARGO_BIN_EXE_oma-cast-files"))
        .arg("--root")
        .arg("/proc")
        .arg("--frecency-db")
        .arg(&db)
        .arg("--runtime-dir")
        .arg(&runtime)
        .arg("--no-watch")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{}", json!({"id": 1, "method": "status"})).unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["result"]["state"], "error");
    assert!(!value["result"]["error"].as_str().unwrap().is_empty());
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn unknown_methods_and_bad_json_are_errors() {
    let dir = fixture();
    let mut sidecar = Sidecar::start(dir.path(), false);
    let response = sidecar.request(json!({"id": 7, "method": "nope"}));
    assert!(response["error"].is_string());

    writeln!(sidecar.stdin, "not json").unwrap();
    sidecar.stdin.flush().unwrap();
    let mut line = String::new();
    sidecar.stdout.read_line(&mut line).unwrap();
    let value: Value = serde_json::from_str(&line).unwrap();
    assert!(value["error"].is_string());
}

#[test]
fn non_utf8_names_are_dropped() {
    let dir = fixture();
    let name = OsString::from_vec(b"bad-\xff.txt".to_vec());
    fs::write(dir.path().join(&name), "x\n").unwrap();
    let mut sidecar = Sidecar::start(dir.path(), false);
    let bad = sidecar.paths("bad");
    assert!(
        !bad.iter().any(|p| p.to_string_lossy().contains("bad-")),
        "non-utf8 leaked: {bad:?}"
    );
}

#[test]
fn reindex_switches_roots_and_reset_keeps_working() {
    let first = fixture();
    let second = TempDir::new().unwrap();
    fs::write(second.path().join("other.txt"), "other\n").unwrap();

    let mut sidecar = Sidecar::start(first.path(), false);
    assert!(sidecar
        .paths("readme")
        .iter()
        .any(|p| p.ends_with("README.md")));

    let response = sidecar.request(json!({
        "id": 8,
        "method": "reindex",
        "params": {"root": second.path()}
    }));
    assert_eq!(response["result"]["ok"], true);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if sidecar
            .paths("other")
            .iter()
            .any(|p| p.ends_with("other.txt"))
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "reindex did not index the new root"
        );
        sleep(Duration::from_millis(50));
    }
    assert!(sidecar.paths("readme").is_empty());

    let response = sidecar.request(json!({"id": 9, "method": "reset"}));
    assert_eq!(response["result"]["ok"], true);
    assert_eq!(sidecar.status()["frecency"], "ok");
}
