# File search

oma-cast file search is backed by [`fff-search` 0.11.0](https://github.com/dmtrKovalenko/fff)
in a small Rust sidecar, `oma-cast-files`. It indexes file **names** under one
root and answers searches over stdin/stdout. The launcher never blocks on it.

```
LauncherWindow ──sync──→ RootSearch (apps, Omarchy, commands)
       │
       └──async──→ Files.qml ──NDJSON──→ oma-cast-files
                                           └─ fff-search (index + watcher)
                                              └─ LMDB access frecency
```

## Why a sidecar

The plugin is plain QML + JS inside `omarchy-shell`; FFF is Rust. The Node SDK
needs a Node runtime and only exposes `trackQuery` (not access frecency); the MCP
server is agent-text oriented; the C API lacks access frecency. A thin
out-of-process helper keeps the index warm, is fail-open, and does not link
native code into the shell.

The helper is a child of the shell, speaks one JSON object per line, and exits on
stdin EOF. It is not sandboxed; treat a memory-safety bug in FFF/libgit2/LMDB as
user-level code execution and keep the pinned version current.

## Settings

`settings.json` → `files`:

```jsonc
{
  "enabled": true,              // new installs; false when upgrading a v1 doc
  "root": "~",                  // one root (FFF limitation)
  "includeInRootSearch": true,
  "followSymlinks": false
}
```

The v2 migration uses the `Migrate` context: `ctx.from === 0` means a fresh
document, so new installs get file search on and existing settings stay off.
Change that one condition to make it opt-in everywhere.

```sh
oma-cast files build            # cargo build + atomic install
oma-cast files status           # cached state; never starts the indexer
oma-cast files enable|disable
oma-cast files root [<path>]
oma-cast files reindex
oma-cast files reset-ranking
oma-cast files retry            # after building a missing helper
```

`oma-cast install` builds the helper for a **new** install (announced; cargo
required). Existing installs print the opt-in command. If the build is missing
or fails, the launcher still works; the first failed file query shows a one-time
toast and `doctor` explains.

## Behaviour

- **Root Files section:** at most 3 rows, only for queries of 3+ characters. It is
  suppressed when the top app/command is already an exact/prefix match, or when
  the top file name/path is not a plausible match. `Show All Files` opens the
  50-row `Search Files` view.
- **Actions:** Open, Open in Editor (text files), Reveal in Files, Copy Path,
  Copy Name. Files never get aliases/favorites/disable.
- **Frecency:** FFF's access LMDB only. Opening a file calls `track_access` and
  updates the in-memory score. No query-history database, so query text is not
  persisted.
- **Privacy:** hidden path components are filtered when the root is not a git
  repo; a secret-name deny list always hides `.env`, `.ssh`, keys, etc. `.ignore`
  files (gitignore syntax) exclude noisy directories. LMDB is `0600`/`0700`.
  There is no content index, no network and no telemetry.
- **Failure:** a missing, crashed or wedged helper never takes apps/commands
  down. The service restarts with backoff, kills a stuck process (SIGTERM →
  SIGKILL), and reports status. A `flock` disables a second shell session.

## Build, test, measure

```sh
cargo build --release --locked --manifest-path helper/Cargo.toml
cargo test --locked --manifest-path helper/Cargo.toml
node --test tests/
tests/smoke.sh
```

Helper: Rust 1.85+ (edition 2024), `fff-search = "=0.11.0"`. First build compiles
vendored libgit2/LMDB and needs network. AUR packaging can ship the binary at
`/usr/lib/oma-cast/oma-cast-files`; the launcher also looks in
`~/.local/lib/oma-cast/` and honours `OMA_CAST_FILES_BIN`.

Measured on a 20,662-file home (Omarchy 4, Quickshell 0.3.2): ~30 ms cold scan,
0–2 ms queries, ~16–35 MB RSS with the watcher. Toggle latency stayed under
70 ms in smoke tests.

## Known limits / deferred

- Hidden dotfiles are invisible at a non-git root. Upstreaming an
  `include_hidden` option (walker + watcher) is the clean fix; a git root includes
  dotfiles with the secret deny list.
- One root; scopes and a settings UI for ignore patterns are deferred.
- Previews/Quick Look, content search, folder rows, Open With and Move to Trash
  are later work.
- Non-UTF-8 names are dropped because FFF's relative path is lossy.
