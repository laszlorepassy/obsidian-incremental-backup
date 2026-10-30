# High-Performance Incremental Obsidian Backup with Rclone and Node.js/TypeScript

This guide provides an end-to-end technical implementation for performing incremental, non-blocking backups of large Obsidian vaults (10–100+ GB) using `rclone` with the `--backup-dir` strategy, wrapped in a modular TypeScript/Node.js architecture ready for direct Obsidian plugin integration.

---

## Architecture Overview

Standard zip-based or pure JavaScript snapshot plugins fail on multi-gigabyte vaults due to V8 heap memory constraints (`JavaScript heap out of memory`) and high CPU costs from re-compressing already-compressed media (PDFs, images, audio). 

This solution delegates the heavy filesystem synchronization to native `rclone`, invoked as an asynchronous subprocess via Node.js (`child_process.spawn`).

```text
P:\Laszlo-Archive\Obsidian\Személyes-backup\
│
├── current/                        <-- Always contains the 1:1 up-to-date, ready-to-open vault
│   ├── .obsidian/
│   ├── Attachments/
│   │   └── diagram.png
│   └── Notes/
│       └── Astronomy.md
│
└── incremental/                    <-- Contains only files that were modified or deleted
    ├── 2026-10-30_14-30-00/
    │   └── Notes/
    │       └── Astronomy.md        <-- The previous version before modification
    └── 2026-11-02_09-15-22/
        └── Attachments/
            └── old_asset.pdf       <-- A file that was deleted from the vault
```

### Key Advantages
* **Instant Usability:** `current/` is a plain, uncompressed, unencrypted directory that can be opened as an Obsidian vault at any time without a restore process.
* **Storage Efficiency:** Identical files are neither re-read nor rewritten. Only modified and deleted files are moved into timestamped subdirectories inside `incremental/`.
* **Zero UI Freezing:** Standard stream events prevent UI thread locking inside Obsidian during multi-gigabyte scans.

---

## 1. Core Service Implementation (`src/services/RcloneService.ts`)

This service builds CLI arguments, validates local and remote storage paths, and streams subprocess execution metrics.

```typescript
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface RcloneBackupConfig {
    rcloneBinary?: string;       // Path to rclone executable (defaults to 'rclone')
    sourceVaultPath: string;     // Absolute path to the local vault
    backupRootPath: string;      // Absolute path to backup destination
    fullDirName?: string;        // Defaults to 'current'
    incrementalDirName?: string; // Defaults to 'incremental'
}

export interface BackupProgressCallbacks {
    onLog?: (message: string) => void;
    onError?: (error: string) => void;
    onFinish?: (exitCode: number) => void;
}

export class RcloneService {
    private config: Required<RcloneBackupConfig>;

    constructor(config: RcloneBackupConfig) {
        this.config = {
            rcloneBinary: config.rcloneBinary || 'rclone',
            sourceVaultPath: path.normalize(config.sourceVaultPath),
            backupRootPath: path.normalize(config.backupRootPath),
            fullDirName: config.fullDirName || 'current',
            incrementalDirName: config.incrementalDirName || 'incremental'
        };
    }

    /**
     * Generates a filesystem-safe timestamp: YYYY-MM-DD_HH-mm-ss
     */
    private getFormattedTimestamp(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        const year = now.getFullYear();
        const month = pad(now.getMonth() + 1);
        const day = pad(now.getDate());
        const hours = pad(now.getHours());
        const minutes = pad(now.getMinutes());
        const seconds = pad(now.getSeconds());

        return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
    }

    /**
     * Validates source vault existence and backup target mount access
     */
    public validatePaths(): { valid: boolean; error?: string } {
        if (!fs.existsSync(this.config.sourceVaultPath)) {
            return {
                valid: false,
                error: `Source vault path does not exist: "${this.config.sourceVaultPath}"`
            };
        }

        const targetRoot = path.parse(this.config.backupRootPath).root;
        if (targetRoot && !fs.existsSync(targetRoot)) {
            return {
                valid: false,
                error: `Target volume or root is not accessible: "${targetRoot}"`
            };
        }

        return { valid: true };
    }

    /**
     * Executes the rclone synchronization pipeline
     */
    public runBackup(callbacks?: BackupProgressCallbacks): Promise<number> {
        return new Promise((resolve, reject) => {
            const validation = this.validatePaths();
            if (!validation.valid) {
                const err = new Error(validation.error);
                callbacks?.onError?.(validation.error!);
                return reject(err);
            }

            const currentPath = path.join(this.config.backupRootPath, this.config.fullDirName);
            const incrementalPath = path.join(
                this.config.backupRootPath,
                this.config.incrementalDirName,
                this.getFormattedTimestamp()
            );

            const args = [
                'sync',
                this.config.sourceVaultPath,
                currentPath,
                '--backup-dir', incrementalPath,
                '--fast-list',
                '-v',
                '--stats', '5s'
            ];

            callbacks?.onLog?.(
                `[RcloneService] Starting backup\n` +
                `Source: ${this.config.sourceVaultPath}\n` +
                `Mirror: ${currentPath}\n` +
                `Delta:  ${incrementalPath}\n`
            );

            let process: ChildProcessWithoutNullStreams;

            try {
                process = spawn(this.config.rcloneBinary, args, {
                    shell: false,
                    windowsHide: true
                });
            } catch (err: any) {
                callbacks?.onError?.(`Failed to spawn rclone: ${err.message}`);
                return reject(err);
            }

            process.stdout.on('data', (chunk: Buffer) => {
                callbacks?.onLog?.(chunk.toString('utf-8'));
            });

            process.stderr.on('data', (chunk: Buffer) => {
                callbacks?.onLog?.(chunk.toString('utf-8'));
            });

            process.on('error', (err: any) => {
                if (err.code === 'ENOENT') {
                    callbacks?.onError?.(
                        `Rclone binary not found at "${this.config.rcloneBinary}". Ensure it is installed and in your PATH.`
                    );
                } else {
                    callbacks?.onError?.(`Subprocess execution error: ${err.message}`);
                }
                reject(err);
            });

            process.on('close', (code: number) => {
                callbacks?.onFinish?.(code);
                if (code === 0) {
                    resolve(code);
                } else {
                    reject(new Error(`Rclone exited with failure code ${code}`));
                }
            });
        });
    }
}
```

---

## 2. Standalone Node.js Runner (`run-standalone.js`)

Test and verify your backup setup from the command line outside of Obsidian before compiling the plugin.

```javascript
const { RcloneService } = require('./src/services/RcloneService');

const service = new RcloneService({
    rcloneBinary: 'rclone',
    sourceVaultPath: 'C:\\Users\\laszlo\\Documents\\Jegyzeteim',
    backupRootPath: 'P:\\Laszlo-Archive\\Obsidian\\Személyes-backup',
    fullDirName: 'current',
    incrementalDirName: 'incremental'
});

console.log('Initiating test backup run...');

service.runBackup({
    onLog: (msg) => process.stdout.write(msg),
    onError: (err) => console.error('\n[ERROR]', err),
    onFinish: (code) => console.log(`\nProcess completed with exit code: ${code}`)
})
.then(() => {
    console.log('[SUCCESS] Vault successfully synchronized.');
})
.catch((err) => {
    console.error('[FAILURE]', err.message);
    process.exit(1);
});
```

Execute using:
```bash
node run-standalone.js
```

---

## 3. Obsidian Plugin Integration (`src/main.ts`)

This file implements the Obsidian lifecycle hooks: adding a Ribbon icon, registering a Command Palette action, rendering progress notices, and dynamically fetching the vault root path via `FileSystemAdapter`.

```typescript
import { Plugin, Platform, FileSystemAdapter, Notice, PluginSettingTab, App, Setting } from 'obsidian';
import { RcloneService } from './services/RcloneService';

interface RclonePluginSettings {
    rcloneBinary: string;
    backupRootPath: string;
    fullDirName: string;
    incrementalDirName: string;
}

const DEFAULT_SETTINGS: RclonePluginSettings = {
    rcloneBinary: 'rclone',
    backupRootPath: 'P:\\Laszlo-Archive\\Obsidian\\Személyes-backup',
    fullDirName: 'current',
    incrementalDirName: 'incremental'
};

export default class RcloneBackupPlugin extends Plugin {
    settings: RclonePluginSettings;

    async onload() {
        await this.loadSettings();

        // Left sidebar ribbon icon
        this.addRibbonIcon('archive', 'Run Rclone Incremental Backup', () => {
            this.executeBackup();
        });

        // Command Palette command (Ctrl/Cmd + P)
        this.addCommand({
            id: 'trigger-rclone-backup',
            name: 'Run Incremental Backup Now',
            callback: () => this.executeBackup()
        });

        this.addSettingTab(new RcloneSettingTab(this.app, this));
    }

    async executeBackup() {
        if (!Platform.isDesktopApp) {
            new Notice('Rclone backup is only supported on Desktop (Electron) environments.');
            return;
        }

        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            new Notice('Unable to resolve native filesystem adapter for current vault.');
            return;
        }

        const currentVaultPath = adapter.getBasePath();

        const service = new RcloneService({
            rcloneBinary: this.settings.rcloneBinary,
            sourceVaultPath: currentVaultPath,
            backupRootPath: this.settings.backupRootPath,
            fullDirName: this.settings.fullDirName,
            incrementalDirName: this.settings.incrementalDirName
        });

        const activeNotice = new Notice('Starting incremental vault backup...', 0);

        try {
            await service.runBackup({
                onLog: (line) => {
                    // Streamed into developer console (Ctrl + Shift + I)
                    console.log('[Rclone-Backup]', line);
                },
                onError: (err) => {
                    new Notice(`Backup error: ${err}`, 8000);
                }
            });

            activeNotice.hide();
            new Notice('Incremental backup completed successfully!', 5000);

        } catch (error: any) {
            activeNotice.hide();
            new Notice(`Backup failed: ${error.message}`, 8000);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class RcloneSettingTab extends PluginSettingTab {
    plugin: RcloneBackupPlugin;

    constructor(app: App, plugin: RcloneBackupPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Rclone Incremental Backup Settings' });

        new Setting(containerEl)
            .setName('Rclone Executable Path')
            .setDesc('Absolute path to the rclone binary (or "rclone" if in system PATH)')
            .addText(text => text
                .setPlaceholder('rclone')
                .setValue(this.plugin.settings.rcloneBinary)
                .onChange(async (val) => {
                    this.plugin.settings.rcloneBinary = val.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Backup Target Root')
            .setDesc('Directory where the current mirror and incremental changes are stored')
            .addText(text => text
                .setPlaceholder('P:\\Backups\\Obsidian')
                .setValue(this.plugin.settings.backupRootPath)
                .onChange(async (val) => {
                    this.plugin.settings.backupRootPath = val.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Full Mirror Directory Name')
            .setDesc('Subdirectory name for the 1:1 up-to-date vault mirror')
            .addText(text => text
                .setValue(this.plugin.settings.fullDirName)
                .onChange(async (val) => {
                    this.plugin.settings.fullDirName = val.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Incremental Directory Name')
            .setDesc('Subdirectory name where historical changes are archived')
            .addText(text => text
                .setValue(this.plugin.settings.incrementalDirName)
                .onChange(async (val) => {
                    this.plugin.settings.incrementalDirName = val.trim();
                    await this.plugin.saveSettings();
                }));
    }
}
```

---

## 4. Operational Guide: How to Restore

Because this implementation avoids proprietary archives or locked chunk databases, restoring files requires no external software.

### Case A: Recovering a Deleted or Accidentally Overwritten File
1. Open Windows File Explorer or macOS Finder.
2. Navigate to your backup destination: `P:\Laszlo-Archive\Obsidian\Személyes-backup\incremental\`.
3. Open the timestamped directory created immediately after the modification or deletion took place.
4. Locate your file maintaining its original relative path structure (e.g., `Notes\Astronomy.md`).
5. Copy and paste it directly back into your live Obsidian vault.

### Case B: Disaster Recovery (Total Vault Reversion)
If your active vault is completely lost or corrupted, you have immediate access to your data without running an extraction command:
* **Current State:** Point Obsidian to `P:\Laszlo-Archive\Obsidian\Személyes-backup\current\` using the **"Open folder as vault"** option. You can resume working immediately.
* **Rolling back to an earlier date:** If you need the vault reconstructed to a specific prior date, synchronize `current` backwards against intermediate `incremental` directories using `rclone copy`:
  ```bash
  rclone copy "P:\Laszlo-Archive\Obsidian\Személyes-backup\incremental\2026-10-30_14-30-00" "C:\Users\laszlo\Documents\Jegyzeteim" -v
  ```