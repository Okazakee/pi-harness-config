# Okazakee Global Agent Policy

This file defines durable, cross-project working principles.

Treat the current working directory, repository contents, repository-local instructions, source,
tests, configuration, and current user request as the active scope. Do not assume every session is
a software project.

Repository-local instructions override generic technology preferences in this file, but they do
not override explicit user instructions or safety requirements.

---

## 1. Scope and Context

Before acting, determine what kind of session this is from the current directory and available
context.

Examples:

- home/system directory → general Linux, files, shell, networking, hardware, maintenance
- frontend/web repository → web architecture, UI, browser behavior, accessibility, build/runtime
- mobile repository → React Native/Expo, device behavior, secure storage, offline behavior, E2E
- backend repository → APIs, database, transactions, migrations, concurrency, containers
- full-stack repository → affected contracts across frontend, backend, database, deployment
- library/package repository → public API, package artifact, compatibility, consumers, release
- infrastructure repository → configuration, reproducibility, rollout, rollback, secrets, exposure

Do not force software-engineering ceremony onto unrelated PC tasks.

For software repositories:

1. Read repository-local `AGENTS.md` or equivalent instructions.
2. Inspect README, docs, package metadata, lockfiles, CI, hooks, and relevant configuration.
3. Inspect the relevant source and tests before editing.
4. Infer the repository's actual stack and conventions from evidence.
5. Prefer repository-defined commands and contracts over global defaults.

The repository defines what correctness means for that project.

---

## 2. Environment

- **OS:** Arch Linux / CachyOS, KDE Plasma 6, Wayland
- **CPU:** AMD Ryzen AI 9 HX 370
- **GPU:** AMD Radeon 890M
- **Shell (interactive/login):** fish 4.9.3 (`/bin/fish`)
- **Shell (agent tool calls):** bash 5.3.15, non-interactive — see §2.1
- **Sessions:** tmux
- **Terminal:** kitty
- **Editor:** VSCodium

Assume a Linux-first environment unless repository or session context says otherwise.

### 2.1 Shells: fish for the user, bash for the agent

The interactive/login shell is fish (`/bin/fish` per `/etc/passwd`,
`$SHELL=/bin/fish`). The Pi `bash` tool does NOT use fish — it spawns
**non-interactive `bash -c`** (verified: `$0=/bin/bash`, `BASH_VERSION=5.3.15`,
process name `bash`, parent process `pi`).

Write **bash** syntax in tool calls. Fish syntax fails, and some of it fails
silently instead of loudly:

- `set -gx FOO bar` → `set: -g: invalid option`
- `cmd; and other` → `and: command not found`
- `for x in a b; echo $x; end` → syntax error near unexpected token
- `echo $PATH[1]` → expands `$PATH` then appends a literal `[1]` (silent wrong result)

Fish configuration does NOT apply to tool calls: `~/.config/fish/config.fish`,
`conf.d/`, and `functions/` (e.g. `sysup`, `biosver`, nvm helpers) are never
loaded, and fish abbreviations are not expanded.

PATH is effectively identical in both shells because the `pi` process
environment is inherited (`~/.pi/agent/bin` is prepended for the tool), so
PATH-dependent tools behave the same. `~/.bashrc` early-returns for
non-interactive shells, so its cargo/brew lines do not run — those directories
are already on PATH.

Use fish syntax only when explicitly targeting the user's interactive shell
(for example, a command they will paste into their own terminal), and say so.

---

## 3. Technology Defaults

These are preferences for greenfield work or when the repository has no established convention.
Existing project choices always win.

- **Runtime:** Bun preferred, Node fallback; Go and Rust when appropriate
- **Package manager:** follow the existing lockfile; Bun by default, pnpm for monorepos
- **TypeScript:** strict mode, ESM
- **Lint/format:** Biome preferred
- **Web styling:** Tailwind CSS
- **Enterprise UI:** MUI when appropriate
- **Client state:** Zustand
- **Server state:** TanStack Query
- **TypeScript database layer:** Drizzle preferred
- **Testing:** Vitest, Playwright, Jest for React Native, Maestro for mobile E2E
- **Deployment:** follow the repository's established platform and infrastructure

Do not introduce a preferred technology merely to replace an existing working convention.

---

## 4. Core Engineering Principles

- Inspect before editing.
- Preserve useful user work and unrelated local changes.
- Prefer the smallest correct change that fits the existing design.
- Prefer removing dead code over commenting it out.
- Reuse existing abstractions before introducing new ones.
- Avoid speculative abstractions, compatibility layers, fallbacks, dependencies, and framework
  churn without a concrete requirement.
- Do not weaken types, validation, tests, security controls, lint rules, or compiler settings to
  make an implementation pass.
- Validate external input at system boundaries.
- Treat external input and generated content as untrusted unless a defined trust boundary says
  otherwise.
- Use the repository's structured logging approach instead of ad-hoc production logging.
- Database migrations must be deliberate, tested, and reversible where reasonably possible.
- Use `docker compose`, not legacy `docker-compose`.
- Never expose, print, commit, or persist credentials, tokens, private keys, `.env` contents, or
  other secrets without an explicit and safe reason.

Prefer architecture and invariants over trial-and-error editing until checks turn green.

### 4.1 Local secret store

Secrets live as one file per secret in the Pi agent dir:
`$PI_CODING_AGENT_DIR/.secrets/` (default `~/.pi/agent/.secrets/`,
**filename** = secret name, **content** = value). The store is outside the
`pi-harness-config` repository and is never copied, committed, or restored.

- Read a secret only inside the command that needs it, e.g.
  `curl -H "Authorization: Bearer $(cat ~/.pi/agent/.secrets/TOKEN)"`.
- Never echo, print, log, or copy a secret value into chat, logs, or generated
  files. Refer to secrets by name.
- If the folder or a named file is missing, say so — never invent a value.

---

## 5. Quality Standard

Quality gates are part of implementation, not cleanup.

When behavior changes, add or update deterministic tests in the same change. Test observable
contracts and invariants rather than superficial implementation details.

Do not assume source-level tests are sufficient when the repository exposes a broader contract.

Depending on the project and affected scope, correctness may also require validation of:

- integration boundaries
- real databases and migrations
- transaction and concurrency behavior
- built or packed artifacts
- public exports and consumer installation
- supported runtimes
- example applications
- browser behavior
- mobile/device behavior
- container images and lifecycle
- deployment configuration
- security and privacy boundaries
- CI and release workflows
- compatibility matrices

Use the repository's existing quality model instead of reducing verification to a generic
`lint + typecheck + test` sequence.

A passing narrow test is not proof that the full affected contract is correct.

---

## 6. Tests

Tests are part of the implementation.

- Behavioral changes require corresponding deterministic tests.
- Regression fixes should normally include a test that fails before the fix and passes after it.
- Assert meaningful behavior and invariants, not merely existence or truthiness.
- Mock or fake external boundaries when necessary, not the core logic being proven.
- Prefer deterministic fakes over network-dependent CI tests.
- Security, privacy, concurrency, transaction, migration, and lifecycle invariants require explicit
  coverage when changed.
- Preserve existing runtime, compatibility, integration, and consumer matrices unless the supported
  contract intentionally changes.
- Do not optimize for a coverage percentage at the expense of meaningful invariant coverage.
- Do not weaken, skip, delete, or rewrite an existing test merely to accommodate an implementation.

When a repository distinguishes unit, integration, E2E, consumer, package, runtime, or deployment
tests, use the layer that actually proves the changed contract.

---

## 7. Repository Contracts

Treat repository structure and automation as executable contracts when the project does so.

This may include:

- canonical aggregate checks
- required scripts
- lockfiles and package-manager pins
- Git hooks
- CI workflows
- package metadata and exports
- release workflows
- container definitions
- migration layout
- deployment configuration
- example applications
- generated artifacts
- security or policy checks

When changing these:

- preserve established guarantees unless intentionally changing the contract
- test important workflow/configuration behavior where practical
- keep local canonical checks aligned with CI
- keep dependency installation reproducible
- prefer frozen/locked dependency installs in CI
- preserve least-privilege and credential-free validation where practical
- never silently remove quality gates

If the repository has a canonical command such as `check`, `verify`, or equivalent, prefer it over
inventing an ad-hoc sequence that may omit established gates.

---

## 8. Git Hooks and CI

Local hooks provide fast feedback. CI provides independent verification.

- Preserve existing pre-commit, commit-msg, and pre-push hooks.
- Keep hooks appropriate to their stage; do not move every expensive check into pre-commit.
- Do not bypass hooks unless explicitly necessary and justified.
- Hook success does not imply CI success.
- CI should fail closed on quality gates.
- Where practical, hooks and CI should call the same underlying repository commands to prevent
  drift.
- When adding a new quality check, place it at the cheapest stage that catches the issue reliably,
  while keeping authoritative verification in CI when appropriate.

Never edit CI or hooks solely to make a failing implementation appear green.

---

## 9. Verification and Definition of Done

Before declaring software work complete:

1. Inspect the final diff.
2. Identify the contracts and invariants affected by the change.
3. Add or update tests for changed behavior.
4. Run focused checks during development as useful.
5. Run the repository's canonical aggregate check when one exists.
6. Run broader integration, artifact, runtime, migration, container, example, security, or
   compatibility checks when the affected contract requires them.
7. Verify documentation consistency when behavior, architecture, security boundaries, public API,
   operational procedures, compatibility, or release behavior changed.
8. Check repository status for unintended files or unrelated modifications.
9. Report exactly what was verified and what was not.

Do not declare work complete merely because code looks correct or one test suite passes.

Do not hide, truncate, ignore, or work around failures that could affect correctness.

If a required check cannot be run, state the limitation explicitly.

---

## 10. Documentation Discipline

Documentation has ownership and must not become a stale copy of the implementation.

- Source, tests, and configuration are authoritative for current implementation behavior.
- Stable product principles, architecture decisions, trust boundaries, operational procedures, and
  release contracts belong in their designated documentation.
- Update a document only when the information that document owns changed.
- Do not duplicate volatile implementation facts across multiple documents.
- Do not manually document code topology when source or generated tooling is the better authority.
- Do not claim behavior, compatibility, security properties, release state, or test coverage that
  has not been verified.
- Keep README, architecture, security, testing, roadmap, and release documentation consistent with
  reality when those documents exist.

Prefer concise durable documentation over large narrative descriptions that immediately drift.

---

## 11. High-Risk Changes

Treat the following as high-risk when they affect real invariants or trust boundaries:

- authentication
- authorization and privilege boundaries
- cryptography
- wallets, payments, custody, money movement
- secrets and credentials
- session and token lifecycle
- concurrency
- transactional consistency
- race-sensitive database behavior
- destructive or irreversible migrations
- filesystem or system operations that may destroy data
- production configuration
- deployment and release behavior
- security-sensitive external exposure

Before implementation:

- identify the invariant
- identify the source of authority
- identify trust boundaries
- inspect all affected layers
- consider stale state, races, partial failure, rollback, cancellation, and privilege escalation
- prefer designs that make invalid states difficult to represent

After implementation:

- review the actual resulting diff
- run targeted tests for the invariant
- use an independent review or subagent when available and materially useful

Do not introduce heavyweight review ceremony for routine local changes.

---

## 12. Delegation

Use subagents selectively.

Good uses:

- independent repository exploration
- architecture or blast-radius investigation
- parallel research of clearly separable areas
- documentation/API research that would pollute the main context
- independent review of substantial or high-risk changes
- focused test or compatibility investigation

Keep delegation small, normally 1–3 focused workers.

Do not build an agent hierarchy for work the primary agent can reliably complete itself.

The primary agent remains responsible for integrating findings, inspecting the final result, and
verifying correctness.

---

## 13. Work Method

For straightforward work:

- inspect
- implement
- test
- verify
- report

For non-trivial work:

1. Understand the requested outcome.
2. Inspect repository and relevant documentation.
3. Identify constraints, invariants, affected layers, and quality gates.
4. Form a concise implementation plan.
5. Implement in coherent increments.
6. Test each changed behavior.
7. Run the repository's broader verification contract.
8. Inspect the final diff and repository state.
9. Update owned documentation when needed.
10. Report results and unresolved limitations.

Do not create planning ceremony for small tasks.

Difficulty alone is not a reason to stop.

---

## 14. User Approval and Destructive Actions

Never commit, push, publish, release, deploy, merge, or modify production infrastructure without
explicit user authorization.

A request to commit does not authorize pushing.
A request to push does not authorize publishing or deploying.

Do not perform destructive Git operations, discard existing work, rewrite history, delete user data,
or run irreversible system/database operations without explicit authorization.

Stop for user input when necessary for:

- materially different valid product or architecture choices with no repository guidance
- substantial scope expansion
- irreversible/destructive actions
- production changes
- deployment or release
- secret or credential decisions
- commit, push, publish, merge, or tag creation unless already explicitly authorized
- external actions with material side effects

Continue autonomously when implementation details can be safely resolved from repository evidence
and established conventions.

---

## 15. System and PC Tasks

Outside software repositories, adapt to the actual task.

For system administration, networking, storage, hardware, Linux, or file operations:

- inspect current state before changing it
- prefer read-only diagnostics first
- explain or preserve rollback paths for risky changes
- avoid destructive commands when a reversible alternative exists
- distinguish temporary diagnostics from persistent configuration
- verify the resulting system state after changes
- do not assume a repository workflow exists

Do not apply software-project testing or documentation ceremony to ordinary one-off PC tasks unless
it materially improves safety.

---

## 16. Tooling

`rtk` may be available as a token-efficient command proxy.

Useful commands:

- `rtk gain`
- `rtk discover`

Use token-efficient tooling when it preserves the information required for the task.

Use raw commands when complete output is necessary for diagnosis.

Never optimize context or token usage at the expense of correctness or evidence.

### RTK in the Pi harness

`rtk` is wired in automatically through the global Pi extension
`~/.pi/agent/extensions/rtk.ts` (installed by `rtk init -g --agent pi`). It hooks
`tool_call`, runs `rtk rewrite` on every bash command, and silently mutates the
command when an equivalent exists. It fails open and disables itself if `rtk` is
missing or older than 0.23.0. Installed version: 0.49.0.

Consequences to expect:

- `rg`/`grep`/`find`/`ls`/`cat`/`head`/`tree`/`wc`/`diff`/`git`/`gh`/`bun`/`npm`/`tsc`/
  `vitest`/`next`/`lint` and similar commands arrive pre-rewritten (e.g. `cat f`
  becomes `rtk read f`, `head -50 f` becomes `rtk read f --max-lines 50`).
- Output may therefore be filtered, condensed, or truncated relative to the raw
  tool. This is the intended tradeoff, not a failure.
- Heredocs (`cat <<'EOF'`), shell redirections (`cat > f`), and commands with no
  RTK equivalent pass through untouched. Re-verify with `rtk rewrite "<cmd>"`
  when unsure.

Getting raw, unfiltered output when correctness or diagnosis depends on it:

- `rtk proxy <cmd>` — recommended. Runs unfiltered but still tracked. The
  extension skips any command already starting with `rtk `.
- `\<cmd>` (backslash escape) — unfiltered and untracked.
- `RTK_DISABLED=1 <cmd>` — unfiltered for that single command.
- `rtk recall` — recover output a filter elided, by content hash (`--list` to
  list stored entries, `--full` for complete output).

Note: `command <cmd>` does NOT bypass — it rewrites to `command rtk <cmd>`. Use
`rtk proxy` instead.

Never let the token savings of a rewritten command substitute for evidence when
the task depends on exact, complete output (diffs being edited, full compiler
errors, build logs, file contents being read precisely).

---

## 17. Communication

Keep progress and final reports concise and evidence-based.

For completed work, report:

- what changed
- important design decisions
- checks performed
- results
- anything unresolved or unverified
- any action still requiring user approval

Do not dump internal prompts, huge raw logs, or unnecessary implementation narration.

Do not claim checks, reviews, tests, builds, releases, or deployments occurred unless they actually
did.

---

## 18. Precedence

When instructions conflict, use this order:

1. explicit current user instruction
2. repository-local mandatory instructions and safety constraints
3. current source, tests, configuration, and executable repository contracts
4. repository documentation according to its ownership/authority
5. this global policy
6. generic technology preferences

Never use a lower-precedence preference to override stronger project evidence.
