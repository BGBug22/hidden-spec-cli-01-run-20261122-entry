# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/BGBug22/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/BGBug22/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

Built for the make.fun bounty: https://make.fun/c/hidden-spec-cli-01-run-20261122

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON — and `mend` reads all four to one written
specification (`SPEC.md` in the kit), finds the lines an edit names even when the model drifted
their whitespace or indentation, and changes every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the patch file; when absent or `-`, the patch is read from standard input.
- `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`, `json`); `auto`
  (the default) detects it.
- `--check` does everything but write: same output and exit code, no file changed.
- `--strict` matches lines exactly (tier 0 only).

Matching happens at the first of three tiers where the old lines occur: exact, ignoring
trailing spaces and tabs, then ignoring leading and trailing spaces and tabs. A unified hunk
takes the occurrence nearest its (possibly wrong) line number; a SEARCH/REPLACE block needs
exactly one occurrence; a V4A chunk walks a cursor with anchors.

## Exit codes

- `0` — the tree is written; one line per changed path (`A`/`D`/`M`, `R old -> new` for a
  move), then `ok: <n> files`.
- `1` — some edits failed; one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. Nothing is written.
- `2` — usage, unreadable patch, undetected format, or unparsable patch; exactly one
  `error: ...` line.

## Run the practice checks

```
node check.ts <practice.json>
```

Node 22, standard library only. No dependencies, no network, deterministic.

## Repository

https://github.com/BGBug22/hidden-spec-cli-01-run-20261122-entry
