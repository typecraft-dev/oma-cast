# Matcher provenance

The matcher comes from [Flea](https://github.com/thisisgm/flea), base commit `7c866397b` with
flea-search's pre-release `wk2` and `H` changes (diff SHA-256
`942bbf17235ff91e7758ff3ff28d77a6c22924616d96ec343afe45b6d069ad14`).
The hashes below identify the exact upstream file contents used for this snapshot.

| Source file | Source SHA-256 |
| --- | --- |
| `searchmatch.rs` | `1416164b21d32cfaee769582de04885a3d64e0d5180447a53977969f898b9158` |
| `searchascii.rs` | `a923431abd51f8ed93ad463a895fe1db518771b07b1b196cc6fcfb7b987b8c4c` |
| `searchtypo.rs` | `9edefcf793c1f02e6513c776e59103d4f84e41e6c46d198c591395a5b781470e` |
| `searchbits.rs` | `b7842ff21afbe14065556b82760b4c4185798cb1c8d41e01ed4f7d4896c2b027` |

`searchascii.rs`, `searchtypo.rs`, and `searchbits.rs` are byte-for-byte copies.
The only change to `searchmatch.rs` is removal of this trailing module reference,
including its preceding blank line, because the snapshot does not include
`searchmatch_tests.rs`:

```rust
#[cfg(test)]
#[path = "searchmatch_tests.rs"]
pub(crate) mod tests;
```

`src/backend/mod.rs` retains the original module hierarchy, including the
`crate::backend::searchtypo` reference. Unused filesystem-search APIs are allowed
at the adapter's module boundary so the vendored files need no warning edits.
The helper's own tests live in `src/engine.rs`, `src/protocol.rs`, and
`tests/protocol.rs`.

## License

The vendored source is MIT licensed, copyright (c) 2026 GM. The original MIT
license and notice are retained verbatim in `LICENSE`, SHA-256
`d2a2191fc6fa3fb43cd6dfe0a7b156ded8f4a5e23c498ef1111788c37ec4f0c4`.

## Adapter contract

`oma-cast-search` uses synchronous NDJSON on stdin and stdout. Each response is
flushed before reading another request. A write, flush, or input I/O failure ends
the process with failure. Unknown object properties are accepted. Requests must
contain exactly one of `entries` or `query` and an unsigned 64-bit integer `id`.
Optional entry fields may be omitted; present nulls and wrong types are rejected.
Errors include `id` when a complete JSON object contains a valid unsigned ID.
Invalid JSON and oversized drained lines have no recoverable ID. Every rejected
request preserves the previously loaded catalog. A successful empty load counts
as loaded; any search before the first successful load fails.

The caller applies `Ranker.transliterate` to every input string and query once.
The helper performs no transliteration, normalization, trimming, or path search.
Each score comes directly from `Matcher::name_bytes`. Hits retain loaded entry
order and contain explicit numeric or null `title`, `alternate`, `subtitle`, and
`keyword` scores. Entries with no surviving channel are omitted. Alternate and
keyword channels take their maximum score. A subtitle equal to the title after
Unicode lowercasing is not scored separately. Nonempty subtitles contribute both
`title + " " + subtitle` and `subtitle + " " + title` to keywords, even when the
subtitle duplicates the title. Bundle IDs contribute only to queries containing
a literal period. Empty queries return `hits: []` for legacy UI suggestions.

All channels drop shadow typo scores `<= SHADOW_TYPO` (`992000`). Default
`medium` and `low` use the same upstream matching rules. `high` also drops scores
`< NAME - HIT_SPAN` (`1900000`), retaining all name subsequences and stronger
matches. Upstream name DP scores are bounded by `2000000 +/- 100000`; exact,
prefix, and word scores are `5000000`, `4000000`, and `3500000`. Upstream listed
typo scores are `999000` or `998000`: one edit from four alphanumeric query
characters, two from eight, and no edits when the query starts with a
non-alphanumeric character. Digits and punctuation remain literal.

Limits are inclusive: 20000 entries per load, 1024 supplied text fields per
entry, 16384 UTF-8 bytes per supplied text field, 256 Unicode scalar values per
query, and 8 MiB per wire line excluding LF. The field count includes the title,
each present subtitle and bundle ID (including empty strings), and every
alternate-title and keyword array item. Generated keyword combinations are not
supplied fields. CR in CRLF counts toward the wire limit. `BufRead::take` limits
line reads to 8 MiB plus one detection byte; oversized lines drain through LF or
EOF using the existing reader buffer, without growing the line allocation.
The last line may omit LF.

## Build and verification

Dependencies are `serde` (derive) and `serde_json`; edition is 2021 and release
LTO is enabled. `Cargo.lock` records dependency resolution from the build host.
Run `cargo test --locked` and `cargo build --release --locked`. The integration tests execute the built binary and
cover protocol recovery, reload atomicity, channel scores, optional fields,
reordered fields, Unicode, long requests, and each input limit. Unit tests also
cover matcher tiers, shadow removal, sensitivity, and write/flush failure.
