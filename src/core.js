'use strict';

const path = require('path');
const zlib = require('zlib');

const DAILY_RETRY_DELAY_MS = 30 * 60 * 1000;
const DAILY_MAX_RETRIES = 3;
const RCLONE_SITE = 'https://rclone.org';
const RCLONE_INSTALL_URL = 'https://rclone.org/install/';
const RCLONE_DOWNLOADS_URL = 'https://downloads.rclone.org';

const DEFAULT_SETTINGS = {
  rcloneBinary: 'rclone',
  targetDir: '',
  fullDirName: 'current',
  incrementalDirName: 'incremental',
  runOnStartup: false,
  runHourly: false,
  runDaily: true,
  dailyTime: '20:00',
  keepIncrementalDays: 0, // 0 = keep every incremental folder forever
  excludeList: ['node_modules', '.git', '.trash', '.DS_Store', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information'],
  lastRun: null,
  lastDailyRunDate: null,
};

function pad(n) { return String(n).padStart(2, '0'); }

/** Filesystem-safe timestamp: YYYY-MM-DD_HH-mm-ss */
function formatTimestamp(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
}

function parseTimestamp(name) {
  const m = String(name).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function humanSize(bytes) {
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

// --- paths ---------------------------------------------------------------

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function foldCase(p, platform) {
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}

/**
 * Where the backup target sits relative to the vault:
 *   'outside'      -- anywhere outside the vault (the only accepted case)
 *   'vault-root'   -- the vault folder itself
 *   'inside-vault' -- somewhere below the vault folder (rclone would copy the backup into itself)
 *   'contains-vault' -- the vault sits inside the target (the mirror would overwrite the vault)
 */
function targetLocation(targetDir, vaultDir, platform) {
  platform = platform || process.platform;
  const api = pathApi(platform);
  const vault = foldCase(api.resolve(vaultDir), platform);
  const target = foldCase(api.resolve(targetDir), platform);
  const rel = api.relative(vault, target);
  if (rel === '') return 'vault-root';
  if (!(rel === '..' || rel.startsWith('..' + api.sep) || api.isAbsolute(rel))) return 'inside-vault';
  const back = api.relative(target, vault);
  if (!(back === '..' || back.startsWith('..' + api.sep) || api.isAbsolute(back))) return 'contains-vault';
  return 'outside';
}

/** "9:05" -> "09:05"; null when it isn't a real time of day. */
function normalizeDailyTime(value) {
  const m = String(value == null ? '' : value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return pad(h) + ':' + pad(min);
}

// --- scheduling ----------------------------------------------------------

function localDateKey(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Decides whether the daily schedule should fire "now" (pure; see the
 * simple-backup plugin this was modelled on). Catches up after the configured
 * time, counts any successful backup of the day, and retries failed ones.
 */
function dailyScheduleDecision(settings, now, retry) {
  const unchanged = { run: false, lastDailyRunDate: settings.lastDailyRunDate };
  if (!settings.runDaily) return unchanged;

  const today = localDateKey(now);
  if (settings.lastDailyRunDate === today) return unchanged;

  if (settings.lastRun && settings.lastRun.time && isSameLocalDay(new Date(settings.lastRun.time), now)) {
    return { run: false, lastDailyRunDate: today };
  }

  const dailyTime = normalizeDailyTime(settings.dailyTime) || DEFAULT_SETTINGS.dailyTime;
  const hhmm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  if (hhmm < dailyTime) return unchanged;

  if (retry && retry.date === today) {
    if (retry.failures > DAILY_MAX_RETRIES) return unchanged;
    if (now.getTime() - retry.lastAttempt < DAILY_RETRY_DELAY_MS) return unchanged;
  }

  return { run: true, lastDailyRunDate: settings.lastDailyRunDate };
}

// --- rclone command line -------------------------------------------------

/** Escapes rclone filter glob characters so a plain file name matches literally. */
function escapeFilter(name) {
  return name.replace(/[\\*?[\]{}]/g, '\\$&');
}

/**
 * Arguments for `rclone sync <vault> <root>/<full> --backup-dir <root>/<incr>/<stamp>`:
 * the mirror stays 1:1 with the vault, and whatever a run overwrites or
 * deletes in the mirror is moved into a timestamped incremental folder.
 */
function buildRcloneArgs({ sourceDir, targetRoot, fullDirName, incrementalDirName, timestamp, exclude }) {
  const current = path.join(targetRoot, fullDirName);
  const incremental = path.join(targetRoot, incrementalDirName, timestamp);
  const args = [
    'sync', sourceDir, current,
    '--backup-dir', incremental,
    '--create-empty-src-dirs',
    '--use-json-log',
    '--log-level', 'NOTICE',
    '--stats', '1s',
    '--stats-log-level', 'NOTICE',
  ];
  for (const raw of exclude || []) {
    const name = escapeFilter(String(raw).trim());
    if (!name) continue;
    args.push('--exclude', name, '--exclude', name + '/**');
  }
  return { args, current, incremental };
}

/**
 * Interprets one stderr line of `rclone --use-json-log`:
 *   { kind: 'stats', stats }  -- periodic transfer statistics
 *   { kind: 'error', message }
 *   { kind: 'other', message }
 */
function parseRcloneLine(line) {
  const text = String(line).trim();
  if (!text) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { kind: 'other', message: text };
  }
  if (obj && obj.stats && typeof obj.stats === 'object') return { kind: 'stats', stats: obj.stats };
  const level = String((obj && obj.level) || '').toLowerCase();
  const message = String((obj && obj.msg) || text);
  if (level === 'error' || level === 'critical') return { kind: 'error', message };
  return { kind: 'other', message };
}

function summarizeErrors(errors, maxShown = 2, maxLen = 160) {
  const short = (e) => {
    const t = String(e).replace(/\s+/g, ' ');
    return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t;
  };
  const shown = errors.slice(0, maxShown).map(short);
  const more = errors.length - shown.length;
  return shown.join('\n') + (more > 0 ? `\n(+${more} more)` : '');
}

/** Names of incremental folders older than keepDays (never touches names that aren't timestamps). */
function planIncrementalPrune(names, now, keepDays) {
  if (!(keepDays > 0)) return [];
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  return names.filter((n) => {
    const d = parseTimestamp(n);
    return d && d.getTime() < cutoff;
  });
}

// --- rclone installation -------------------------------------------------

/** Release-asset name pieces for this machine, or null if rclone has no build for it. */
function rcloneTarget(platform, arch) {
  const os = { win32: 'windows', darwin: 'osx', linux: 'linux' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm-v7' }[arch];
  if (!os || !cpu) return null;
  return { os, cpu, exe: platform === 'win32' ? 'rclone.exe' : 'rclone' };
}

function rcloneZipName(version, target) {
  return `rclone-${version}-${target.os}-${target.cpu}.zip`;
}

/** "rclone v1.75.1\n- os/version…" -> "v1.75.1" */
function parseRcloneVersion(text) {
  const m = String(text).match(/rclone\s+(v\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/** Looks up `<hash>  <name>` in the contents of an rclone SHA256SUMS file. */
function findSha256(sums, fileName) {
  for (const line of String(sums).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
    if (m && m[2] === fileName) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Extracts the single entry whose base name is `wantedName` from a zip held in
 * memory (rclone zips contain one folder with the binary, docs and man pages).
 * Supports stored and deflated entries, which is all rclone releases use.
 */
function extractFromZip(buf, wantedName) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip file (no end-of-directory record).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.split('/').pop() !== wantedName) continue;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt zip entry header.');
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error('Unsupported zip compression method ' + method);
  }
  throw new Error(`"${wantedName}" not found in the downloaded archive.`);
}

/**
 * The package-manager installer to try on this platform, as a spawn()
 * recipe, or null where there is none. `has(cmd)` says whether a command exists.
 */
function installCommand(platform, has) {
  if (platform === 'win32') {
    if (!has('winget')) return null;
    return {
      label: 'winget install Rclone.Rclone',
      command: 'winget',
      args: ['install', '--id', 'Rclone.Rclone', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'],
    };
  }
  if (platform === 'darwin') {
    if (!has('brew')) return null;
    return { label: 'brew install rclone', command: 'brew', args: ['install', 'rclone'] };
  }
  if (platform === 'linux') {
    if (!has('curl')) return null;
    // Obsidian has no terminal to type a sudo password into: pkexec shows a graphical prompt.
    const elevate = has('pkexec') ? 'pkexec bash' : 'sudo -n bash';
    return {
      label: 'curl https://rclone.org/install.sh | ' + elevate,
      command: 'sh',
      args: ['-c', `curl -fsSL ${RCLONE_SITE}/install.sh | ${elevate}`],
    };
  }
  return null;
}

module.exports = {
  DEFAULT_SETTINGS,
  DAILY_RETRY_DELAY_MS,
  DAILY_MAX_RETRIES,
  RCLONE_SITE,
  RCLONE_INSTALL_URL,
  RCLONE_DOWNLOADS_URL,
  pad,
  formatTimestamp,
  parseTimestamp,
  humanSize,
  targetLocation,
  normalizeDailyTime,
  localDateKey,
  dailyScheduleDecision,
  escapeFilter,
  buildRcloneArgs,
  parseRcloneLine,
  summarizeErrors,
  planIncrementalPrune,
  rcloneTarget,
  rcloneZipName,
  parseRcloneVersion,
  findSha256,
  extractFromZip,
  installCommand,
};
