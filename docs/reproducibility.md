# Reproducibility

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
