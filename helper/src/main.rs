// oma-cast-files: a small stdin/stdout sidecar around fff-search 0.11.0.
//
// One JSON request per line in, one JSON response per line out. The launcher
// owns the process. See docs/file-search-plan.md for the protocol and the
// reasons this is a sidecar instead of a library linked into the shell.

use fff_search::{
    FFFMode, FilePicker, FilePickerOptions, FrecencyTracker, FuzzySearchOptions, PaginationArgs,
    QueryParser, SharedFilePicker, SharedFrecency,
};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, BufRead, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

const PROTOCOL: u32 = 1;
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_QUERY: usize = 512;
const MAX_LINE: usize = 64 * 1024;
const MAX_LIMIT: u64 = 100;

type Res<T> = Result<T, String>;

struct Args {
    root: String,
    frecency_db: PathBuf,
    runtime: PathBuf,
    watch: bool,
    follow_symlinks: bool,
}

fn parse_args() -> Res<Args> {
    let mut root = None;
    let mut frecency_db = None;
    let mut runtime = None;
    let mut watch = true;
    let mut follow_symlinks = false;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--root" => root = it.next(),
            "--frecency-db" => frecency_db = it.next(),
            "--runtime-dir" => runtime = it.next(),
            "--no-watch" => watch = false,
            "--follow-symlinks" => follow_symlinks = true,
            "-h" | "--help" => {
                return Err(
                    "usage: oma-cast-files --root <dir> --frecency-db <dir> [--runtime-dir <dir>] [--no-watch] [--follow-symlinks]"
                        .into(),
                )
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(Args {
        root: root.ok_or("missing --root")?,
        frecency_db: PathBuf::from(frecency_db.ok_or("missing --frecency-db")?),
        runtime: PathBuf::from(runtime.unwrap_or_else(|| "/tmp".into())),
        watch,
        follow_symlinks,
    })
}

fn expand_tilde(value: &str, home: Option<&Path>) -> String {
    if value == "~" {
        return home
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| value.into());
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = home {
            return format!("{}/{}", home.to_string_lossy(), rest);
        }
    }
    value.to_string()
}

fn is_reserved(path: &Path) -> bool {
    const RESERVED: [&str; 8] = [
        "/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/usr", "/var",
    ];
    path == Path::new("/") || RESERVED.iter().any(|p| path.starts_with(p))
}

fn validate_root(input: &str, frecency_db: &Path) -> Res<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let expanded = expand_tilde(input.trim(), home.as_deref());
    if expanded.is_empty() {
        return Err("empty root".into());
    }
    let canonical = fs::canonicalize(&expanded).map_err(|e| format!("root {expanded}: {e}"))?;
    let meta =
        fs::metadata(&canonical).map_err(|e| format!("root {}: {e}", canonical.display()))?;
    if !meta.is_dir() {
        return Err(format!("root {} is not a directory", canonical.display()));
    }
    // Refuse roots owned by another user (e.g. /proc, /tmp, other homes).
    let uid = unsafe { libc::geteuid() };
    if meta.uid() != uid {
        return Err(format!(
            "root {} is not owned by this user",
            canonical.display()
        ));
    }
    if is_reserved(&canonical) {
        return Err(format!("refusing to index {}", canonical.display()));
    }
    let db_parent = frecency_db.parent().unwrap_or(frecency_db);
    if canonical.starts_with(db_parent) {
        return Err("refusing to index the app's own data directory".into());
    }
    Ok(canonical)
}

fn acquire_lock(runtime: &Path) -> Res<fs::File> {
    fs::create_dir_all(runtime).map_err(|e| format!("runtime dir {}: {e}", runtime.display()))?;
    let path = runtime.join("files.lock");
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|e| format!("lock {}: {e}", path.display()))?;
    // Non-blocking exclusive lock: a second shell session must not share the
    // same LMDB/index.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        return Err("another oma-cast session is already indexing files".into());
    }
    Ok(file)
}

fn secure_db(path: &Path) {
    let _ = fs::create_dir_all(path);
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let _ = fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o600));
        }
    }
}

fn rss_mb() -> u64 {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.starts_with("VmRSS:"))
                .and_then(|line| line.split_whitespace().nth(1)?.parse::<u64>().ok())
        })
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

fn hidden_component(relative: &str) -> bool {
    relative
        .split('/')
        .any(|part| part.starts_with('.') && part != "." && part != "..")
}

fn secret_name(relative: &str) -> bool {
    let parts: Vec<&str> = relative.split('/').collect();
    let name = *parts.last().unwrap_or(&"");
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        ".env" | ".netrc" | ".npmrc" | ".pypirc" | ".git-credentials" | "id_rsa" | "id_ed25519"
    ) {
        return true;
    }
    if lower.starts_with(".env.") || lower.ends_with(".pem") || lower.ends_with(".key") {
        return true;
    }
    parts.windows(2).any(|pair| {
        (pair[0] == ".ssh" && matches!(pair[1], "id_rsa" | "id_ed25519"))
            || (pair[0] == ".aws" && pair[1] == "credentials")
    }) || parts.contains(&".ssh")
}

fn visible(relative: &str, is_git: bool) -> bool {
    if secret_name(relative) {
        return false;
    }
    is_git || !hidden_component(relative)
}

struct Helper {
    args: Args,
    root: PathBuf,
    is_home: bool,
    picker: SharedFilePicker,
    frecency: SharedFrecency,
    init_error: String,
    _lock: Option<fs::File>,
}

impl Helper {
    fn new(args: Args) -> Self {
        // The frecency DB stores absolute paths; keep it owner-only even if
        // the user's umask is permissive.
        unsafe {
            libc::umask(0o077);
        }

        let mut helper = Self {
            args,
            root: PathBuf::new(),
            is_home: false,
            picker: SharedFilePicker::default(),
            frecency: SharedFrecency::default(),
            init_error: String::new(),
            _lock: None,
        };

        helper._lock = match acquire_lock(&helper.args.runtime) {
            Ok(file) => Some(file),
            Err(error) => {
                helper.init_error = error;
                return helper;
            }
        };

        let root = helper.args.root.clone();
        if let Err(error) = helper.init_picker(&root) {
            helper.init_error = error;
        }
        helper
    }

    fn init_picker(&mut self, root: &str) -> Res<()> {
        let canonical = validate_root(root, &self.args.frecency_db)?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .and_then(|p| fs::canonicalize(p).ok());
        let is_home = home.as_deref() == Some(canonical.as_path());

        if let Some(parent) = self.args.frecency_db.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("db dir {}: {e}", parent.display()))?;
        }
        if self.frecency.read().map_err(|e| e.to_string())?.is_none() {
            let tracker = FrecencyTracker::open(&self.args.frecency_db)
                .map_err(|e| format!("frecency db: {e}"))?;
            self.frecency.init(tracker).map_err(|e| e.to_string())?;
        }
        secure_db(&self.args.frecency_db);

        FilePicker::new_with_shared_state(
            self.picker.clone(),
            self.frecency.clone(),
            FilePickerOptions {
                base_path: canonical.to_string_lossy().to_string(),
                mode: FFFMode::Neovim,
                watch: self.args.watch,
                enable_mmap_cache: false,
                enable_content_indexing: false,
                follow_symlinks: self.args.follow_symlinks,
                enable_home_dir_scanning: is_home,
                ..Default::default()
            },
        )
        .map_err(|e| format!("picker {}: {e}", canonical.display()))?;

        self.root = canonical;
        self.is_home = is_home;
        self.init_error.clear();
        Ok(())
    }

    fn status(&self) -> Value {
        let mut indexed = 0usize;
        let mut scanned = 0usize;
        let mut scanning = false;
        let mut watcher = false;
        let mut has_picker = false;

        if let Ok(guard) = self.picker.read() {
            if let Some(picker) = guard.as_ref() {
                has_picker = true;
                let progress = picker.get_scan_progress();
                indexed = picker.live_file_count();
                scanned = progress.scanned_files_count;
                scanning = progress.is_scanning;
                watcher = progress.is_watcher_ready;
            }
        }

        let frecency = self
            .frecency
            .read()
            .map(|guard| guard.is_some())
            .unwrap_or(false);

        let state = if !self.init_error.is_empty() || !has_picker {
            "error"
        } else if scanning {
            "scanning"
        } else {
            "ready"
        };

        json!({
            "state": state,
            "root": self.root.to_string_lossy(),
            "homeRoot": self.is_home,
            "indexedFiles": indexed,
            "scannedFiles": scanned,
            "isScanning": scanning,
            "watcherReady": watcher,
            "frecency": if frecency { "ok" } else { "degraded" },
            "rssMb": rss_mb(),
            "error": self.init_error,
        })
    }

    fn search(&self, query: &str, limit: u64) -> Res<Value> {
        let query = query.trim();
        if query.is_empty() {
            return Err("empty query".into());
        }
        if query.len() > MAX_QUERY {
            return Err("query too long".into());
        }
        let limit = limit.clamp(1, MAX_LIMIT) as usize;

        let guard = self.picker.read().map_err(|e| e.to_string())?;
        let picker = guard.as_ref().ok_or_else(|| {
            if self.init_error.is_empty() {
                "picker is not initialized".to_string()
            } else {
                self.init_error.clone()
            }
        })?;

        let parsed = QueryParser::default().parse(query);
        let result = picker.fuzzy_search(
            &parsed,
            None,
            FuzzySearchOptions {
                pagination: PaginationArgs { offset: 0, limit },
                max_threads: 0,
                ..Default::default()
            },
        );

        let is_git = picker.has_git_repo();
        let mut items = Vec::new();
        for item in result.items.iter() {
            let relative = item.relative_path(picker);
            if !visible(&relative, is_git) {
                continue;
            }
            let absolute = self.root.join(&relative);
            let Ok(meta) = fs::metadata(&absolute) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            items.push(json!({
                "path": absolute.to_string_lossy(),
                "name": item.file_name(picker),
                "relativePath": relative,
            }));
            if items.len() >= limit {
                break;
            }
        }

        if items.is_empty() && (query.starts_with('~') || query.starts_with('/')) {
            if let Some(row) = path_fallback(query) {
                items.push(row);
            }
        }

        Ok(json!({
            "query": query,
            "items": items,
            "totalMatched": result.total_matched,
            "totalFiles": result.total_files,
            "isScanning": picker.get_scan_progress().is_scanning,
        }))
    }

    fn track(&self, path: &str) -> Res<Value> {
        let canonical = fs::canonicalize(path).map_err(|e| format!("path {path}: {e}"))?;
        if !canonical.starts_with(&self.root) {
            return Ok(json!({"ok": true, "tracked": false}));
        }
        let relative = canonical
            .strip_prefix(&self.root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let is_git = self
            .picker
            .read()
            .map(|guard| guard.as_ref().is_some_and(|p| p.has_git_repo()))
            .unwrap_or(false);
        if !visible(&relative, is_git) || !canonical.is_file() {
            return Ok(json!({"ok": true, "tracked": false}));
        }

        {
            let guard = self.frecency.read().map_err(|e| e.to_string())?;
            let tracker = guard.as_ref().ok_or("frecency is not available")?;
            tracker
                .track_access(&canonical)
                .map_err(|e| format!("track access: {e}"))?;
        }
        {
            let frecency = self.frecency.read().map_err(|e| e.to_string())?;
            let tracker = frecency.as_ref().ok_or("frecency is not available")?;
            let mut picker = self.picker.write().map_err(|e| e.to_string())?;
            if let Some(picker) = picker.as_mut() {
                picker
                    .update_single_file_frecency(&canonical, tracker)
                    .map_err(|e| format!("update frecency: {e}"))?;
            }
        }
        Ok(json!({"ok": true, "tracked": true}))
    }

    fn reindex(&mut self, root: &str) -> Res<Value> {
        if self._lock.is_none() {
            return Err("file search is disabled for this session (lock held elsewhere)".into());
        }
        self.init_picker(root)?;
        Ok(json!({"ok": true, "root": self.root.to_string_lossy()}))
    }

    fn reset_ranking(&self) -> Res<Value> {
        if self._lock.is_none() {
            return Err("file search is disabled for this session (lock held elsewhere)".into());
        }
        self.frecency
            .destroy()
            .map_err(|e| format!("reset frecency: {e}"))?;
        let tracker = FrecencyTracker::open(&self.args.frecency_db)
            .map_err(|e| format!("reopen frecency: {e}"))?;
        self.frecency.init(tracker).map_err(|e| e.to_string())?;
        secure_db(&self.args.frecency_db);
        self.picker
            .trigger_full_rescan_async(&self.frecency)
            .map_err(|e| format!("rescan: {e}"))?;
        Ok(json!({"ok": true}))
    }
}

fn path_fallback(query: &str) -> Option<Value> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let expanded = expand_tilde(query.trim(), home.as_deref());
    let canonical = fs::canonicalize(expanded).ok()?;
    if !canonical.is_file() {
        return None;
    }
    Some(json!({
        "path": canonical.to_string_lossy(),
        "name": canonical.file_name()?.to_string_lossy(),
    }))
}

fn request_id(value: &Value) -> u64 {
    value.get("id").and_then(Value::as_u64).unwrap_or(0)
}

fn handle(helper: &mut Helper, request: &Value) -> Res<Value> {
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or("missing method")?;
    let params = request.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "hello" => Ok(json!({"protocol": PROTOCOL, "version": VERSION})),
        "status" => Ok(helper.status()),
        "search" => {
            let query = params
                .get("query")
                .and_then(Value::as_str)
                .ok_or("missing query")?;
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(50);
            helper.search(query, limit)
        }
        "track" => {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or("missing path")?;
            helper.track(path)
        }
        "reindex" => {
            let root = params
                .get("root")
                .and_then(Value::as_str)
                .ok_or("missing root")?;
            helper.reindex(root)
        }
        "reset" => helper.reset_ranking(),
        "shutdown" => Ok(json!({"ok": true})),
        other => Err(format!("unknown method {other}")),
    }
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(error) => {
            eprintln!("oma-cast-files: {error}");
            std::process::exit(2);
        }
    };

    let mut helper = Helper::new(args);
    if !helper.init_error.is_empty() {
        eprintln!("oma-cast-files: {}", helper.init_error);
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.len() > MAX_LINE {
            let response = json!({"id": 0, "error": "request too large"});
            let _ = writeln!(stdout, "{response}");
            let _ = stdout.flush();
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let response = json!({"id": 0, "error": format!("invalid json: {error}")});
                let _ = writeln!(stdout, "{response}");
                let _ = stdout.flush();
                continue;
            }
        };

        let id = request_id(&request);
        let shutdown = request.get("method").and_then(Value::as_str) == Some("shutdown");
        let response = match handle(&mut helper, &request) {
            Ok(result) => json!({"id": id, "result": result}),
            Err(error) => json!({"id": id, "error": error}),
        };
        if writeln!(stdout, "{response}").is_err() {
            break;
        }
        let _ = stdout.flush();
        if shutdown {
            break;
        }
    }

    // Keep the lock alive until the loop ends, then let it drop.
    let _ = helper._lock.take();
}
