# Repository integrity

## TUI renderer patch

Pi's bundled renderer hardcodes a literal fence line above and below every code
block and scrolls one line per mouse-wheel event (kitty's system default is 5).
[`pi/patch-pi-renderer.py`](../pi/patch-pi-renderer.py) removes the fence lines
and raises the wheel scroll to 5 lines. It locates the bundle chunk and the
`pi-tui` markdown module **by signature** — Pi renames hashed chunk files on
every release — is idempotent, and fails loudly when a pattern is unprovable
instead of silently skipping.

A Pi update replaces the release directory, so the patch must be re-applied.
`scripts/install-renderer-guard.sh` installs and enables a `systemd --user`
path unit (`systemd/pi-renderer-patch.{path,service}`) that watches
`~/.pi/agent/install/current-version` and re-runs the patch script whenever the
managed version changes:

```bash
scripts/install-renderer-guard.sh              # install + enable
scripts/install-renderer-guard.sh --uninstall  # remove
```

`restore.sh` applies the patch and installs the guard as part of its
best-effort post-restore steps (skippable with `--no-patch`). On machines
without a systemd user manager (for example macOS), run
`python3 ~/.pi/agent/patch-pi-renderer.py` after each update instead.

## Repository integrity: hooks, checks and CI

Three layers, none of which replaces another:

```text
pre-commit                    fast local prevention      repository invariants + staged secret scan
pre-push                      stronger local prevention  scanner self-test + full history scan + integration tests
required GitHub CI + ruleset  remote publication gate    the same checks in a clean environment
```

Hooks are tracked in `.githooks/` and are not active until you point Git at
them:

```bash
scripts/install-hooks.sh          # sets core.hooksPath=.githooks (local config only)
```

`restore.sh` applies the same local configuration automatically when it
restores into a directory containing `.git/`, and skips it (without failing)
for a plain snapshot.

Hooks are **feedback, not authority**: they can be bypassed with `--no-verify`.
`.github/workflows/verify.yml` is the independent layer and runs the same
checks on a clean runner, with every action pinned to an exact commit SHA.
CI also installs the exact TruffleHog version pinned in `deps/tools.lock.json`
and verifies its checksum before use.

Individual checks can be run directly:

```bash
scripts/check-repo.sh              # deterministic, offline repository contract
scripts/check-secret-scanner.sh    # prove the scanner still detects a canary
scripts/check-secrets.sh --staged  # scan exactly the staged blobs
scripts/check-secrets.sh --history # scan the full Git history
scripts/test-backup-restore.sh     # isolated backup/restore round-trip
scripts/test-renderer-patch.sh     # isolated renderer-patch fixtures
scripts/test-obscura-restore.sh    # Obscura lock + checksum logic
scripts/test-cwd-switch.sh         # /cd extension unit + wiring tests
scripts/test-statusline.sh         # provider-usage parsers + footer rendering
scripts/test-todo.sh               # /todo extension unit + wiring tests
scripts/test-versions.sh           # version drift and preflight logic
```

The repository contract also enforces the dependency pin invariant: every
`npm:` entry in `pi/settings.json` must carry an exact version, every `git:`
entry an exact 40-hex commit, and every GitHub URL an exact commit ref. Pi
extensions execute with the user's permissions, so a declared source that
floats would let a restore resolve to whatever upstream published; the
contract fails instead of allowing that. The backup preflight enforces the
same invariant against the live settings before any file is copied, so a
floating declaration fails fast rather than after the repository is modified.

`scripts/test-todo.sh` additionally runs one optional smoke test against the
installed Pi loader when a `pi` binary is on `PATH`: it copies the extension
entrypoint and its helper directory into an isolated temporary
`HOME`/`PI_CODING_AGENT_DIR`, loads them in headless RPC mode with no provider
request, and asserts discovery succeeds. On a runner without Pi (for example
CI) that single test is reported as skipped, never as a silent pass; the
deterministic structural and unit checks always run and cover the same
discovery contract.

`main` is protected by the active repository ruleset `Protect main`: changes
must arrive through a pull request, the `repository contract` check from
`.github/workflows/verify.yml` must pass tested against the current base,
force-pushes are rejected, deletion is blocked, and no bypass actors are
configured. `--no-verify` can bypass the local hooks, but it cannot publish
directly to protected `main`.

## Local LSP diagnostics

Pi's LSP tools come from the `@narumitw/pi-lsp` package. Routing is resolved
per tool call from `ctx.cwd`: a trusted project's `.pi/pi-lsp.json` wins, then
the backed-up user file `~/.pi/agent/pi-lsp.json`, then the package's built-in
catalog. Language servers start only for the matching call and shut down
afterward, so selection is dynamic per project; a custom file replaces the
entire built-in server map rather than merging with it.

`pi/pi-lsp.json` declares the servers installed on this machine — `biome`,
`typescript`, `rust-analyzer`, `clangd` — with `.ts`/`.tsx` routed to **both**
Biome and the TypeScript server so lint and type diagnostics are complementary.

Two machine-tooling pitfalls this configuration works around:

- The global `typescript` package here is the **native 7.x port, which ships no
  `tsserver`**, so `typescript-language-server` cannot find a valid TypeScript
  installation. The fallback install at `~/.local/share/pi-lsp-typescript`
  pins a JS-based `typescript@5.9.3`, and `pi-lsp.json` points `tsserver.path`
  at its `lib/tsserver.js`. Projects with their own `node_modules/typescript`
  still take precedence. Recreate the fallback with:

  ```bash
  mkdir -p ~/.local/share/pi-lsp-typescript
  cd ~/.local/share/pi-lsp-typescript && bun add typescript@5.9.3
  ```

- The formatter/linter package is **`@biomejs/biome`**, not the unrelated npm
  package `biome` (an environment-variable manager). The wrong package exits
  successfully before LSP initialization, producing “server exited before
  response 1 (code 0)”. With Bun: `bun add -g @biomejs/biome`.

Both fallbacks are external machine tooling, not Pi configuration or a CI
requirement; `pi/pi-lsp.json` itself is backed up with the rest of
`~/.pi/agent`.

## Secret scanning

`.gitignore` and the backup allowlist are the primary structural defenses.
Secret scanning is an additional, independent layer, not a replacement:

- `scripts/check-secrets.sh --staged` scans exactly the blobs about to be
  committed, copied into an isolated temporary tree. Untracked files,
  `.secrets/`, and the live working tree are never scanned. It runs with
  `--no-verification`, so it has no network dependency and stays fast enough
  for every commit.
- `scripts/check-secrets.sh --history` scans every commit in the repository
  (with credential verification enabled).
- `scripts/check-secret-scanner.sh` proves the scanner still detects a
  credential canary generated at runtime. A clean scan from a scanner that
  silently stopped detecting means nothing, so this runs before the history
  scan in both pre-push and CI.

Findings are printed with a field allowlist; **raw secret values are never
printed**. The scanner version is pinned in `deps/tools.lock.json`; a missing
or mismatched scanner is a hard failure, never a silent skip. Install it with
`scripts/install-trufflehog.sh`.

A scanner cannot prove the complete absence of secrets. Treat a clean result
as one signal among several, and keep the structural defenses narrow.
