'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal } = require('obsidian');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const {
  DEFAULT_SETTINGS, RCLONE_INSTALL_URL, humanSize, summarizeErrors, dailyScheduleDecision, localDateKey,
  normalizeDailyTime, targetLocation, DAILY_MAX_RETRIES,
} = require('./core');
const {
  RcloneMissingError, findRclone, packageManagerInstaller, runInstaller, downloadRclone, BackupRun,
} = require('./rclone');
const { ScreenWakeLock } = require('./wake-lock');

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

class IncrementalBackupPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.isRunning = false;
    this.currentRun = null;
    this.activeNotice = null;
    this.dailyRetry = null; // { date, failures, lastAttempt } for today's failed daily backups
    this.wakeLock = new ScreenWakeLock();
    this.register(() => this.wakeLock.release());
    this.register(() => { if (this.currentRun) this.currentRun.cancel(); });

    this.addRibbonIcon('archive', 'Incremental backup now', () => {
      this.runBackup({ trigger: 'manual' });
    });

    this.addCommand({
      id: 'run-backup-now',
      name: 'Run incremental backup now',
      callback: () => this.runBackup({ trigger: 'manual' }),
    });

    this.addCommand({
      id: 'cancel-backup',
      name: 'Cancel running backup',
      callback: () => {
        if (this.currentRun) this.currentRun.cancel();
        else new Notice('No backup is running.');
      },
    });

    this.addCommand({
      id: 'check-rclone',
      name: 'Check / install rclone',
      callback: () => this.ensureRclone({ interactive: true }),
    });

    this.addSettingTab(new IncrementalBackupSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.runOnStartup) {
        this.runBackup({ trigger: 'startup' });
      }
    });

    this.registerInterval(window.setInterval(() => {
      if (this.settings.runHourly) {
        this.runBackup({ trigger: 'hourly' });
      }
    }, 60 * 60 * 1000));

    this.registerInterval(window.setInterval(() => {
      this.checkDailySchedule();
    }, 60 * 1000));
  }

  async checkDailySchedule() {
    const now = new Date();
    const decision = dailyScheduleDecision(this.settings, now, this.dailyRetry);
    if (decision.lastDailyRunDate !== this.settings.lastDailyRunDate) {
      this.settings.lastDailyRunDate = decision.lastDailyRunDate;
      await this.saveSettings();
    }
    if (!decision.run) return;

    const today = localDateKey(now);
    const outcome = await this.runBackup({ trigger: 'daily' });
    if (outcome === 'ok' || outcome === 'misconfigured') {
      // Retrying won't fix a settings problem; its notice shows once a day, not every half hour.
      this.settings.lastDailyRunDate = today;
      await this.saveSettings();
    } else if (outcome === 'failed') {
      const failures = this.dailyRetry && this.dailyRetry.date === today ? this.dailyRetry.failures : 0;
      this.dailyRetry = { date: today, failures: failures + 1, lastAttempt: Date.now() };
    }
  }

  /** A message about where the target folder is, or null if it's fine. */
  targetProblem(targetDir) {
    const basePath = this.getVaultBasePath();
    if (!basePath || !targetDir) return null;
    switch (targetLocation(targetDir, basePath)) {
      case 'vault-root':
        return 'The target directory cannot be the vault itself — pick a folder outside the vault.';
      case 'inside-vault':
        return 'The target directory is inside the vault, so the backup would be copied into itself. Pick a folder outside the vault.';
      case 'contains-vault':
        return 'The vault is inside the target directory; the mirror folder could overwrite your vault. Pick a different folder.';
      default:
        return null;
    }
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === 'function') {
      return adapter.getBasePath();
    }
    return null;
  }

  getPluginDir() {
    const base = this.getVaultBasePath();
    if (!base) return null;
    return path.join(base, this.app.vault.configDir, 'plugins', this.manifest.id);
  }

  getLogFilePath() {
    const dir = this.getPluginDir();
    return dir ? path.join(dir, 'backup-errors.log') : null;
  }

  /** Folder where "download rclone" puts its copy (found automatically afterwards). */
  getLocalBinDir() {
    const dir = this.getPluginDir();
    return dir ? path.join(dir, 'bin') : null;
  }

  /**
   * Resolves to { binary, version } for a working rclone, or null when there is none.
   * With `interactive`, a missing rclone opens the install helper.
   */
  async ensureRclone({ interactive } = {}) {
    const localBin = this.getLocalBinDir();
    const found = await findRclone(this.settings.rcloneBinary, localBin ? [localBin] : []);
    if (found) {
      if (found.binary !== this.settings.rcloneBinary) {
        this.settings.rcloneBinary = found.binary;
        await this.saveSettings();
      }
      if (interactive) new Notice(`rclone ${found.version} is installed (${found.binary}).`);
      return found;
    }
    new Notice(
      `rclone is not installed (looked for "${this.settings.rcloneBinary}"). `
      + `The backup needs it — install it from ${RCLONE_INSTALL_URL} or use the install helper.`,
      10000
    );
    if (interactive) new RcloneInstallModal(this.app, this).open();
    return null;
  }

  async pickDirectory() {
    let remote;
    try {
      remote = require('electron').remote;
    } catch (err) {
      remote = null;
    }

    if (!remote || !remote.dialog) {
      new Notice('The folder picker is not available on this Obsidian/Electron version — enter the path manually.');
      return null;
    }

    try {
      const result = await remote.dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Backup target directory',
        defaultPath: this.settings.targetDir || undefined,
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    } catch (err) {
      new Notice('Error opening the folder picker: ' + errMessage(err));
      return null;
    }
  }

  /** Resolves to 'ok', 'failed', 'busy' (another backup is running) or 'misconfigured'. */
  async runBackup({ trigger } = {}) {
    if (this.isRunning) {
      if (trigger === 'manual') new Notice('A backup is already in progress.');
      return 'busy';
    }

    const basePath = this.getVaultBasePath();
    if (!basePath) {
      new Notice('Error: could not determine the vault path (this plugin only works in desktop Obsidian).');
      return 'misconfigured';
    }

    const targetDir = (this.settings.targetDir || '').trim();
    if (!targetDir) {
      new Notice('Error: no backup target directory set. Open the plugin settings.');
      return 'misconfigured';
    }
    const problem = this.targetProblem(targetDir);
    if (problem) {
      new Notice('Error: ' + problem);
      return 'misconfigured';
    }

    this.isRunning = true;
    // Claimed before the first await so a second trigger can't slip in while rclone is being looked up.
    let rclone;
    try {
      rclone = await this.ensureRclone({ interactive: trigger === 'manual' });
    } catch (err) {
      this.isRunning = false;
      new Notice('Error: ' + errMessage(err));
      return 'failed';
    }
    if (!rclone) {
      this.isRunning = false;
      return 'misconfigured';
    }

    const logFilePath = this.getLogFilePath();
    this.activeNotice = new Notice('Backup: scanning files...', 0);

    let lastUpdate = 0;
    const run = new BackupRun({
      rcloneBinary: rclone.binary,
      sourceDir: basePath,
      targetRoot: targetDir,
      fullDirName: this.settings.fullDirName,
      incrementalDirName: this.settings.incrementalDirName,
      exclude: this.settings.excludeList,
      keepIncrementalDays: this.settings.keepIncrementalDays,
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastUpdate > 400 && this.activeNotice) {
          lastUpdate = now;
          const files = p.totalFiles ? `${p.files}/${p.totalFiles} files` : `${p.files} files`;
          const size = p.totalBytes ? `${humanSize(p.bytes)} / ${humanSize(p.totalBytes)}` : humanSize(p.bytes);
          this.activeNotice.setMessage(`Backing up: ${files}, ${size}`);
        }
      },
    });
    this.currentRun = run;

    this.wakeLock.acquire();
    let result;
    try {
      result = await run.run();
      if (this.activeNotice) {
        // Stays up (created with duration 0) until clicked away, so an unattended run can still be confirmed.
        this.activeNotice.setMessage(
          result.errors.length
            ? `Backup finished with ${result.errors.length} error(s):\n${summarizeErrors(result.errors)}\nDetails: backup-errors.log`
            : result.files || result.deletes
              ? `Backup finished: ${result.files} changed file(s), ${humanSize(result.bytes)}`
              : 'Backup finished: nothing had changed'
        );
        this.activeNotice = null;
      }
      if (result.errors.length) await this.appendLog(logFilePath, result.errors.join('\n'));
    } catch (err) {
      const message = errMessage(err);
      if (!err.cancelled) console.error('Incremental Backup error:', err);
      if (this.activeNotice) {
        this.activeNotice.setMessage(err instanceof RcloneMissingError || err.cancelled ? message : 'Backup error: ' + message);
        this.activeNotice = null;
      }
      if (!err.cancelled) await this.appendLog(logFilePath, message);
      return err.cancelled ? 'busy' : 'failed';
    } finally {
      this.isRunning = false;
      this.currentRun = null;
      this.wakeLock.release();
    }

    this.settings.lastRun = {
      time: Date.now(),
      trigger,
      files: result.files,
      bytes: result.bytes,
      errors: result.errors.length,
      deleted: result.deletes,
      pruned: result.pruned,
    };
    try {
      await this.saveSettings();
    } catch (err) {
      console.error('Incremental Backup: could not save settings', err);
    }
    return 'ok';
  }

  async appendLog(logFilePath, message) {
    if (!logFilePath) return;
    try {
      await fsp.mkdir(path.dirname(logFilePath), { recursive: true });
      await fsp.appendFile(logFilePath, `=== ${new Date().toISOString()} ===\n${message}\n\n`, 'utf8');
    } catch (e) { /* best effort */ }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.dailyTime = normalizeDailyTime(this.settings.dailyTime) || DEFAULT_SETTINGS.dailyTime;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/** Shown when rclone is missing: install it, download it, or open the rclone website. */
class RcloneInstallModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'rclone is required' });
    contentEl.createEl('p', {
      text: 'Rclone Incremental Backup uses rclone to copy the vault, and rclone was not found on this computer. Pick one way to get it:',
    });

    const installer = packageManagerInstaller();
    this.statusEl = contentEl.createEl('p', { cls: 'setting-item-description' });

    new Setting(contentEl)
      .setName(installer ? `Install with the package manager` : 'Install with the package manager')
      .setDesc(installer ? `Runs: ${installer.label}` : 'No supported package manager (winget / brew / curl) was found on this system.')
      .addButton((btn) => {
        btn.setButtonText('Install').setCta().onClick(() => this.install(installer));
        if (!installer) btn.setDisabled(true);
      });

    new Setting(contentEl)
      .setName('Download rclone into the plugin folder')
      .setDesc('Fetches the official release from downloads.rclone.org, verifies its SHA-256 checksum and keeps it next to the plugin. No admin rights needed.')
      .addButton((btn) => btn.setButtonText('Download').onClick(() => this.download()));

    new Setting(contentEl)
      .setName('Open the rclone website')
      .setDesc(RCLONE_INSTALL_URL)
      .addButton((btn) => btn.setButtonText('Open').onClick(() => window.open(RCLONE_INSTALL_URL, '_blank')));
  }

  setStatus(text) {
    this.statusEl.setText(text);
  }

  async finish() {
    const found = await findRclone(this.plugin.settings.rcloneBinary, [this.plugin.getLocalBinDir()].filter(Boolean));
    if (!found) {
      this.setStatus('Installed, but rclone still cannot be started from here. Restart Obsidian (so it picks up the new PATH) or set the path in the plugin settings.');
      return;
    }
    this.plugin.settings.rcloneBinary = found.binary;
    await this.plugin.saveSettings();
    new Notice(`rclone ${found.version} is ready (${found.binary}).`);
    this.close();
  }

  async install(installer) {
    this.setStatus(`Running: ${installer.label} ... (this can take a minute)`);
    try {
      await runInstaller(installer);
      await this.finish();
    } catch (err) {
      this.setStatus(`${errMessage(err)} — try the download option or the rclone website instead.`);
    }
  }

  async download() {
    const dir = this.plugin.getLocalBinDir();
    if (!dir) {
      this.setStatus('Cannot locate the plugin folder (desktop Obsidian only).');
      return;
    }
    try {
      await downloadRclone(dir, (text) => this.setStatus(text));
      await this.finish();
    } catch (err) {
      this.setStatus(`${errMessage(err)} — try the rclone website instead.`);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class IncrementalBackupSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    containerEl.createEl('h2', { text: 'Rclone Incremental Backup settings' });

    const rcloneStatus = containerEl.createEl('p', { cls: 'setting-item-description' });
    const refreshRcloneStatus = async () => {
      const localBin = this.plugin.getLocalBinDir();
      const found = await findRclone(s.rcloneBinary, localBin ? [localBin] : []);
      rcloneStatus.setText(found ? `rclone ${found.version} found (${found.binary}).` : 'rclone was NOT found — backups will fail until it is installed.');
      rcloneStatus.style.color = found ? '' : 'var(--text-error)';
    };

    new Setting(containerEl)
      .setName('rclone executable')
      .setDesc('Path to the rclone binary, or "rclone" if it is on your PATH.')
      .addText((text) => {
        text
          .setPlaceholder('rclone')
          .setValue(s.rcloneBinary)
          .onChange(async (value) => {
            s.rcloneBinary = value.trim() || 'rclone';
            await this.plugin.saveSettings();
            refreshRcloneStatus();
          });
        text.inputEl.style.width = '100%';
      })
      .addButton((btn) => btn
        .setButtonText('Check / install')
        .onClick(async () => {
          await this.plugin.ensureRclone({ interactive: true });
          this.display();
        }));
    refreshRcloneStatus();

    new Setting(containerEl)
      .setName('Target directory')
      .setDesc('The folder that receives the mirror and the incremental history (full path, outside the vault).')
      .addText((text) => {
        text
          .setPlaceholder('e.g. D:\\Backups\\Obsidian')
          .setValue(s.targetDir)
          .onChange(async (value) => {
            s.targetDir = value.trim();
            await this.plugin.saveSettings();
            updateTargetWarning();
          });
        text.inputEl.style.width = '100%';
      })
      .addButton((btn) => btn
        .setButtonText('Browse…')
        .onClick(async () => {
          const dir = await this.plugin.pickDirectory();
          if (dir) {
            s.targetDir = dir;
            await this.plugin.saveSettings();
            this.display();
          }
        }));

    const targetWarningEl = containerEl.createEl('p', { cls: 'setting-item-description' });
    targetWarningEl.style.color = 'var(--text-warning)';
    const updateTargetWarning = () => {
      const warning = this.plugin.targetProblem(s.targetDir);
      targetWarningEl.setText(warning || '');
      targetWarningEl.style.display = warning ? '' : 'none';
    };
    updateTargetWarning();

    new Setting(containerEl)
      .setName('Mirror folder name')
      .setDesc('Subfolder of the target holding the always up-to-date 1:1 copy of the vault.')
      .addText((text) => text
        .setValue(s.fullDirName)
        .onChange(async (v) => { s.fullDirName = v.trim() || DEFAULT_SETTINGS.fullDirName; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Incremental folder name')
      .setDesc('Subfolder where each run archives the previous versions of changed files and the files deleted from the vault, in timestamped folders.')
      .addText((text) => text
        .setValue(s.incrementalDirName)
        .onChange(async (v) => { s.incrementalDirName = v.trim() || DEFAULT_SETTINGS.incrementalDirName; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Run on startup')
      .setDesc('Automatically run a backup when Obsidian opens this vault.')
      .addToggle((t) => t
        .setValue(s.runOnStartup)
        .onChange(async (v) => { s.runOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Run hourly')
      .setDesc('Automatically run a backup once per hour.')
      .addToggle((t) => t
        .setValue(s.runHourly)
        .onChange(async (v) => { s.runHourly = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Run daily')
      .setDesc(`Run a backup once a day at the given time (HH:MM, local time). If it fails, e.g. because the target drive isn't connected, it is retried every 30 minutes, up to ${DAILY_MAX_RETRIES} times.`)
      .addToggle((t) => t
        .setValue(s.runDaily)
        .onChange(async (v) => { s.runDaily = v; await this.plugin.saveSettings(); }))
      .addText((text) => text
        .setPlaceholder('20:00')
        .setValue(s.dailyTime)
        .onChange(async (v) => {
          const time = normalizeDailyTime(v);
          text.inputEl.style.borderColor = time ? '' : 'var(--text-error)';
          if (time) {
            s.dailyTime = time;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Delete incremental folders older than (days)')
      .setDesc('0 keeps the whole history forever. Only timestamp-named folders inside the incremental folder are ever deleted.')
      .addText((text) => text
        .setValue(String(s.keepIncrementalDays))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          s.keepIncrementalDays = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Excluded files/folders')
      .setDesc('Comma-separated names (e.g. node_modules, .git, .trash). Matched at any depth.')
      .addTextArea((ta) => ta
        .setValue(s.excludeList.join(', '))
        .onChange(async (v) => {
          s.excludeList = v.split(',').map((x) => x.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Run backup now')
      .addButton((btn) => btn
        .setButtonText('Run backup')
        .setCta()
        .onClick(() => this.plugin.runBackup({ trigger: 'manual' })));

    if (s.lastRun) {
      const lr = s.lastRun;
      const parts = [`${lr.files} changed file(s)`];
      parts.push(lr.errors ? `${lr.errors} errors` : 'no errors');
      if (lr.pruned) parts.push(`${lr.pruned} old incremental folder(s) deleted`);
      containerEl.createEl('p', {
        text: `Last backup (${lr.trigger}): ${new Date(lr.time).toLocaleString()} — ${parts.join(', ')}`,
        cls: 'setting-item-description',
      });
    }
  }
}

module.exports = IncrementalBackupPlugin;
