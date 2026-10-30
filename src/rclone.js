'use strict';

const { spawn, spawnSync, execFile } = require('child_process');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const {
  RCLONE_DOWNLOADS_URL, buildRcloneArgs, formatTimestamp, parseRcloneLine, parseRcloneVersion, isAttemptFailure,
  planIncrementalPrune, rcloneTarget, rcloneZipName, findSha256, extractFromZip, installCommand,
} = require('./core');

class RcloneMissingError extends Error {
  constructor(binary) {
    super(`rclone was not found ("${binary}"). Install rclone first: https://rclone.org/install/`);
    this.name = 'RcloneMissingError';
    this.binary = binary;
  }
}

/** Runs `<binary> version`; resolves to the version string ("v1.75.1") or null when it can't be run. */
function probeRclone(binary) {
  return new Promise((resolve) => {
    try {
      execFile(binary, ['version'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        resolve(err ? null : (parseRcloneVersion(stdout) || null));
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/** Places rclone is commonly installed but which Obsidian's PATH may not contain (yet). */
function candidateBinaries(configured, extraDirs) {
  const exe = process.platform === 'win32' ? 'rclone.exe' : 'rclone';
  const dirs = [...(extraDirs || [])];
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    dirs.push(path.join(local, 'Microsoft', 'WinGet', 'Links'));
    dirs.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'rclone'));
    dirs.push(path.join(home, 'scoop', 'shims'));
    dirs.push(path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin'));
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin', path.join(home, '.local', 'bin'), path.join(home, 'bin'));
  }
  const list = [configured || 'rclone'];
  for (const d of dirs) list.push(path.join(d, exe));
  return [...new Set(list)];
}

/**
 * Finds a working rclone: the configured binary first, then well-known install
 * locations (and the plugin's own bin/ folder). Resolves to
 * { binary, version } or null.
 */
async function findRclone(configured, extraDirs) {
  for (const candidate of candidateBinaries(configured, extraDirs)) {
    // Absolute candidates that don't exist are skipped without spawning.
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    const version = await probeRclone(candidate);
    if (version) return { binary: candidate, version };
  }
  return null;
}

function hasCommand(cmd) {
  // `where`/`command -v` rather than stat()ing PATH: winget is an app-execution alias, which stat can't see.
  try {
    const r = process.platform === 'win32'
      ? spawnSync('where', [cmd], { windowsHide: true })
      : spawnSync('sh', ['-c', 'command -v "$1"', 'sh', cmd]);
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

/** The installer recipe for this platform (see core.installCommand), or null. */
function packageManagerInstaller() {
  return installCommand(process.platform, hasCommand);
}

/** Runs a recipe from packageManagerInstaller(); resolves when it exits 0. */
function runInstaller(recipe, onLog) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(recipe.command, recipe.args, { windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    const tail = [];
    const sink = (chunk) => {
      const text = chunk.toString('utf8');
      tail.push(text);
      if (tail.length > 20) tail.shift();
      if (onLog) onLog(text);
    };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"${recipe.label}" failed (exit code ${code}). ${tail.join('').trim().slice(-300)}`));
    });
  });
}

function httpsGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'obsidian-rclone-incremental-backup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpsGet(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Download timed out.')));
  });
}

/**
 * Downloads the official rclone release for this machine from
 * downloads.rclone.org, checks it against the published SHA256SUMS, and puts the
 * binary into destDir. Resolves to the binary's path.
 */
async function downloadRclone(destDir, onStatus) {
  const target = rcloneTarget(process.platform, process.arch);
  if (!target) throw new Error(`rclone has no official build for ${process.platform}/${process.arch}.`);

  if (onStatus) onStatus('Looking up the latest rclone version...');
  const version = parseRcloneVersion((await httpsGet(RCLONE_DOWNLOADS_URL + '/version.txt')).toString('utf8'));
  if (!version) throw new Error('Could not determine the latest rclone version.');

  const zipName = rcloneZipName(version, target);
  const base = `${RCLONE_DOWNLOADS_URL}/${version}`;
  if (onStatus) onStatus(`Downloading ${zipName}...`);
  const zip = await httpsGet(`${base}/${zipName}`);

  const expected = findSha256((await httpsGet(`${base}/SHA256SUMS`)).toString('utf8'), zipName);
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (!expected || expected !== actual) {
    throw new Error('The downloaded rclone archive failed its SHA-256 check; nothing was installed.');
  }

  const binary = extractFromZip(zip, target.exe);
  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, target.exe);
  await fsp.writeFile(dest, binary, { mode: 0o755 });
  await fsp.chmod(dest, 0o755);
  return dest;
}

/**
 * One rclone run: mirrors sourceDir into <targetRoot>/<fullDirName> and moves
 * whatever it overwrites or deletes into <targetRoot>/<incrementalDirName>/<timestamp>.
 */
class BackupRun {
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    if (this.child) this.child.kill();
  }

  /** Resolves to { files, bytes, deletes, errors: string[], incremental }. */
  run() {
    const o = this.opts;
    const { args, current, incremental } = buildRcloneArgs({
      sourceDir: o.sourceDir,
      targetRoot: o.targetRoot,
      fullDirName: o.fullDirName,
      incrementalDirName: o.incrementalDirName,
      timestamp: formatTimestamp(new Date()),
      exclude: o.exclude,
      inplace: o.inplace,
    });

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(o.rcloneBinary, args, { shell: false, windowsHide: true });
      } catch (err) {
        return reject(err.code === 'ENOENT' ? new RcloneMissingError(o.rcloneBinary) : err);
      }
      this.child = child;

      const errors = [];
      const retried = []; // errors of attempts rclone later recovered from by retrying
      const other = [];
      let stats = null;
      let pending = '';
      const handleLine = (line) => {
        const parsed = parseRcloneLine(line);
        if (!parsed) return;
        if (parsed.kind === 'stats') {
          stats = parsed.stats;
          if (o.onProgress) o.onProgress({ files: stats.transfers || 0, totalFiles: stats.totalTransfers || 0, bytes: stats.bytes || 0, totalBytes: stats.totalBytes || 0 });
        } else if (parsed.kind === 'error') {
          if (isAttemptFailure(parsed.message)) {
            // rclone retries the whole run; what failed in this round only matters if the last round fails too.
            retried.push(...errors.splice(0));
          } else {
            errors.push(parsed.message);
          }
        } else {
          other.push(parsed.message);
          if (other.length > 20) other.shift();
        }
      };

      child.stderr.on('data', (chunk) => {
        pending += chunk.toString('utf8');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        lines.forEach(handleLine);
      });
      child.stdout.on('data', () => { /* rclone sync prints nothing useful to stdout */ });

      child.on('error', (err) => {
        reject(err.code === 'ENOENT' ? new RcloneMissingError(o.rcloneBinary) : err);
      });
      child.on('close', async (code) => {
        if (pending) handleLine(pending);
        this.child = null;
        if (this.cancelled) return reject(Object.assign(new Error('Backup cancelled.'), { cancelled: true }));
        if (code !== 0) {
          const detail = errors.length ? errors : other.slice(-3);
          const err = new Error(`rclone exited with code ${code}.` + (detail.length ? ' ' + detail.slice(-3).join(' | ') : ''));
          err.details = errors;
          return reject(err);
        }
        let pruned = 0;
        try {
          pruned = await pruneIncremental(path.join(o.targetRoot, o.incrementalDirName), o.keepIncrementalDays);
        } catch (e) {
          errors.push('Could not prune old incremental folders: ' + (e && e.message ? e.message : e));
        }
        resolve({
          files: stats ? stats.transfers || 0 : 0,
          bytes: stats ? stats.bytes || 0 : 0,
          deletes: stats ? stats.deletes || 0 : 0,
          pruned,
          errors,
          retried,
          current,
          incremental,
        });
      });
    });
  }
}

/** Deletes incremental folders older than keepDays; returns how many were removed. */
async function pruneIncremental(incrementalRoot, keepDays, now) {
  if (!(keepDays > 0)) return 0;
  let names;
  try {
    names = await fsp.readdir(incrementalRoot);
  } catch (e) {
    return 0;
  }
  const doomed = planIncrementalPrune(names, now || new Date(), keepDays);
  for (const name of doomed) {
    await fsp.rm(path.join(incrementalRoot, name), { recursive: true, force: true });
  }
  return doomed.length;
}

module.exports = {
  RcloneMissingError,
  probeRclone,
  candidateBinaries,
  findRclone,
  packageManagerInstaller,
  runInstaller,
  downloadRclone,
  pruneIncremental,
  BackupRun,
};
