# Rclone Incremental Backup

An Obsidian plugin that backs up a vault incrementally with [rclone](https://rclone.org), built for large vaults (10–100+ GB). It is modelled on [Simple Backup](https://github.com/laszlorepassy/obsidian-simple-backup) — same schedule, progress notice and wake-lock — but the copying is done by `rclone sync --backup-dir`, as described in [docs/rclone-backup-guide.md](docs/rclone-backup-guide.md).

**rclone is required.** If it is not found, the plugin raises an error and offers to install it (see below).

## How it works

```text
<target>/
├── current-full-copy/                      <- always a 1:1, ready-to-open copy of the vault
└── incremental/
    ├── 2026-10-30_14-30-00/      <- previous versions of files changed in that run,
    │   └── Notes/Astronomy.md       and files deleted from the vault
    └── 2026-11-02_09-15-22/
```

Each run executes `rclone sync <vault> <target>/current-full-copy --backup-dir <target>/incremental/<timestamp>`. Unchanged files are neither re-read nor rewritten; anything a run overwrites or deletes in `current-full-copy/` is moved into that run's timestamped folder instead of being lost. A run that changes nothing creates no folder. rclone runs as a separate process, so Obsidian's UI never freezes and large media is not re-compressed.

## Features

- Ribbon icon and commands: **Run incremental backup now**, **Cancel running backup**, **Check / install rclone**.
- Triggers: on startup, hourly, daily at a set time (a failed daily run is retried every 30 minutes, up to 3 times).
- Live progress notice (files and bytes, from rclone's own statistics).
- Keeps the computer awake while a backup runs.
- Exclusion list (matched at any depth), optional "delete incremental folders older than N days" (off by default).
- Refuses a target that is the vault, inside it, or contains it.
- Only errors are logged, to `backup-errors.log` in the plugin folder.

## Installing rclone

The plugin looks for rclone at the configured path, then on `PATH`, then in the usual install locations (e.g. winget's link folder, `/usr/local/bin`, Homebrew) and in its own `bin/` folder. If none works, a backup stops with an error and the **rclone is required** dialog offers:

| Option | What it does |
| --- | --- |
| Install with the package manager | Windows: `winget install Rclone.Rclone`. macOS: `brew install rclone`. Linux: the official `curl https://rclone.org/install.sh \| pkexec bash` (graphical password prompt; `sudo -n` if there is no `pkexec`). |
| Download into the plugin folder | Fetches the official release for your OS/CPU from `downloads.rclone.org`, checks its SHA-256 against the published `SHA256SUMS`, and unpacks the binary to `<vault>/.obsidian/plugins/rclone-incremental-backup/bin/`. No admin rights needed. |
| Open the rclone website | Opens <https://rclone.org/install/> for a manual install. |

Scheduled (unattended) backups never open the dialog; they show the error notice.

## Restoring

- **One file:** open `incremental/<timestamp>/` created right after the change or deletion and copy the file back.
- **Whole vault, latest state:** open `current-full-copy/` as a vault ("Open folder as vault").
- **An earlier state:** `rclone copy "<target>/incremental/<timestamp>" "<vault>" -v`, newest folder last. See the guide.

## Development

```bash
npm install
npm run build   # bundles src/ into main.js
npm test        # includes an end-to-end test that runs real rclone when it is installed
```

Release with `npm run release` after bumping the version in `manifest.json`, `package.json` and `versions.json`.

## License

MIT
