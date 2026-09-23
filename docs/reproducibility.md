# Reproducibility

## Pi extension and git-source pins

`pi/settings.json` is the authoritative pin declaration for Pi's dependency
graph: every `npm:` entry carries an exact version and every `git:` entry an
exact commit. `scripts/check-repo.sh` fails when any declared source is not
exactly pinned.

Pi treats versioned npm specifications as fixed. `pi update --extensions`
never moves them, and a missing or mismatched install is reconciled to the
pinned version when Pi resolves extension packages — any session start, or an
explicit `pi update --extensions` for missing packages. Pinned git refs are
checked out from the configured commit, and `pi update --extensions`
re-fetches them, so a deliberately changed pin is applied without ever
following an upstream branch.

`pi/versions.json` remains a historical inventory, not an installation lock
file, but with the declarations pinned it mirrors the declared graph instead
of drifting away from it.

### Updating a package pin

1. Edit the exact version or commit in `~/.pi/agent/settings.json`.
2. Run `pi update --extensions` (reconciles pinned git refs); a changed npm
   pin is installed the next time Pi resolves extensions.
3. Run the backup; the version preflight blocks until the installed graph
   matches the pins again.

## Reproducibility (pinned dependencies)

Obscura is **version pinned, asset pinned, and SHA-256 verified before
extraction**. There are no floating `releases/latest` executable downloads
anywhere in the restore path.

`deps/obscura.lock.json` is the authoritative declaration:

```text
repository + version (vX.Y.Z) + asset name + sha256, per supported platform
(linux-x86_64, linux-aarch64, macos-x86_64, macos-aarch64)
```

`restore.sh` detects the platform, reads the matching lock entry, downloads
`releases/download/<VERSION>/<ASSET>`, hashes it locally, and only then
extracts and installs. A checksum mismatch, an unusable lock, or an
unsupported platform prints an explicit `ERROR`, installs nothing, and makes
`restore.sh` exit non-zero. There is no fallback to `latest`, to an
unverified asset, or to a build from `main`.

If an existing `obscura` binary reports a different version than the lock, the
locked release is reinstalled. The installed executable is never hashed
against the archive digest — those are different artifacts.

### Updating Obscura

Updating the pin is an explicit, reviewed operation. It never runs during
restore, backup, commit, push or CI:

```bash
python3 scripts/update-obscura-lock.py --check    # report only
python3 scripts/update-obscura-lock.py --write    # rewrite the lock
```

The tool reads structured GitHub release metadata (no HTML scraping), requires
all four supported assets to expose SHA-256 digest metadata, refuses draft or
prerelease builds unless `--include-prerelease` is passed, and fails on a
missing asset or an ambiguous duplicate. The resulting lock diff is a normal
repository change: review it and commit it deliberately.
