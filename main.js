"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// src/core.js
var require_core = __commonJS({
  "src/core.js"(exports2, module2) {
    "use strict";
    var path2 = require("path");
    var zlib = require("zlib");
    var DAILY_RETRY_DELAY_MS = 30 * 60 * 1e3;
    var DAILY_MAX_RETRIES2 = 3;
    var RCLONE_SITE = "https://rclone.org";
    var RCLONE_INSTALL_URL2 = "https://rclone.org/install/";
    var RCLONE_DOWNLOADS_URL = "https://downloads.rclone.org";
    var DEFAULT_SETTINGS2 = {
      rcloneBinary: "rclone",
      targetDir: "",
      fullDirName: "current-full-copy",
      incrementalDirName: "incremental",
      runOnStartup: false,
      runHourly: false,
      runDaily: true,
      dailyTime: "20:00",
      inplace: false,
      keepIncrementalDays: 0,
      // 0 = keep every incremental folder forever
      excludeList: ["node_modules", ".git", ".trash", ".DS_Store", "Thumbs.db", "desktop.ini", "$RECYCLE.BIN", "System Volume Information", ".backup-complete"],
      lastRun: null,
      lastDailyRunDate: null
    };
    function pad(n) {
      return String(n).padStart(2, "0");
    }
    function formatTimestamp(d) {
      d = d || /* @__PURE__ */ new Date();
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "_" + pad(d.getHours()) + "-" + pad(d.getMinutes()) + "-" + pad(d.getSeconds());
    }
    function parseTimestamp(name) {
      const m = String(name).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    }
    function humanSize2(bytes) {
      const u = ["B", "kB", "MB", "GB", "TB"];
      let i = 0;
      let v = bytes || 0;
      while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
      }
      return v.toFixed(i === 0 ? 0 : 1) + " " + u[i];
    }
    function pathApi(platform) {
      return platform === "win32" ? path2.win32 : path2.posix;
    }
    function foldCase(p, platform) {
      return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
    }
    function targetLocation2(targetDir, vaultDir, platform) {
      platform = platform || process.platform;
      const api = pathApi(platform);
      const vault = foldCase(api.resolve(vaultDir), platform);
      const target = foldCase(api.resolve(targetDir), platform);
      const rel = api.relative(vault, target);
      if (rel === "") return "vault-root";
      if (!(rel === ".." || rel.startsWith(".." + api.sep) || api.isAbsolute(rel))) return "inside-vault";
      const back = api.relative(target, vault);
      if (!(back === ".." || back.startsWith(".." + api.sep) || api.isAbsolute(back))) return "contains-vault";
      return "outside";
    }
    function normalizeDailyTime2(value) {
      const m = String(value == null ? "" : value).trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (h > 23 || min > 59) return null;
      return pad(h) + ":" + pad(min);
    }
    function localDateKey2(d) {
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }
    function isSameLocalDay(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
    function dailyScheduleDecision2(settings, now, retry) {
      const unchanged = { run: false, lastDailyRunDate: settings.lastDailyRunDate };
      if (!settings.runDaily) return unchanged;
      const today = localDateKey2(now);
      if (settings.lastDailyRunDate === today) return unchanged;
      if (settings.lastRun && settings.lastRun.time && isSameLocalDay(new Date(settings.lastRun.time), now)) {
        return { run: false, lastDailyRunDate: today };
      }
      const dailyTime = normalizeDailyTime2(settings.dailyTime) || DEFAULT_SETTINGS2.dailyTime;
      const hhmm = pad(now.getHours()) + ":" + pad(now.getMinutes());
      if (hhmm < dailyTime) return unchanged;
      if (retry && retry.date === today) {
        if (retry.failures > DAILY_MAX_RETRIES2) return unchanged;
        if (now.getTime() - retry.lastAttempt < DAILY_RETRY_DELAY_MS) return unchanged;
      }
      return { run: true, lastDailyRunDate: settings.lastDailyRunDate };
    }
    function escapeFilter(name) {
      return name.replace(/[\\*?[\]{}]/g, "\\$&");
    }
    function buildRcloneArgs({ sourceDir, targetRoot, fullDirName, incrementalDirName, timestamp, exclude, inplace }) {
      const current = path2.join(targetRoot, fullDirName);
      const incremental = path2.join(targetRoot, incrementalDirName, timestamp);
      const args = [
        "sync",
        sourceDir,
        current,
        "--backup-dir",
        incremental,
        "--create-empty-src-dirs",
        "--use-json-log",
        "--log-level",
        "NOTICE",
        "--stats",
        "1s",
        "--stats-log-level",
        "NOTICE"
      ];
      if (inplace) args.push("--inplace");
      for (const raw of exclude || []) {
        const name = escapeFilter(String(raw).trim());
        if (!name) continue;
        args.push("--exclude", name, "--exclude", name + "/**");
      }
      return { args, current, incremental };
    }
    function parseRcloneLine(line) {
      const text = String(line).trim();
      if (!text) return null;
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (e) {
        return { kind: "other", message: text };
      }
      if (obj && obj.stats && typeof obj.stats === "object") return { kind: "stats", stats: obj.stats };
      const level = String(obj && obj.level || "").toLowerCase();
      const message = String(obj && obj.msg || text);
      if (level === "error" || level === "critical") return { kind: "error", message };
      return { kind: "other", message };
    }
    function isAttemptFailure(message) {
      return /^Attempt \d+\/\d+ failed/.test(String(message));
    }
    function summarizeErrors2(errors, maxShown = 2, maxLen = 160) {
      const short = (e) => {
        const t = String(e).replace(/\s+/g, " ");
        return t.length > maxLen ? t.slice(0, maxLen - 1) + "\u2026" : t;
      };
      const shown = errors.slice(0, maxShown).map(short);
      const more = errors.length - shown.length;
      return shown.join("\n") + (more > 0 ? `
(+${more} more)` : "");
    }
    function planIncrementalPrune(names, now, keepDays) {
      if (!(keepDays > 0)) return [];
      const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1e3;
      return names.filter((n) => {
        const d = parseTimestamp(n);
        return d && d.getTime() < cutoff;
      });
    }
    function rcloneTarget(platform, arch) {
      const os = { win32: "windows", darwin: "osx", linux: "linux" }[platform];
      const cpu = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "arm-v7" }[arch];
      if (!os || !cpu) return null;
      return { os, cpu, exe: platform === "win32" ? "rclone.exe" : "rclone" };
    }
    function rcloneZipName(version, target) {
      return `rclone-${version}-${target.os}-${target.cpu}.zip`;
    }
    function parseRcloneVersion(text) {
      const m = String(text).match(/rclone\s+(v\d+\.\d+(?:\.\d+)?)/);
      return m ? m[1] : null;
    }
    function findSha256(sums, fileName) {
      for (const line of String(sums).split(/\r?\n/)) {
        const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
        if (m && m[2] === fileName) return m[1].toLowerCase();
      }
      return null;
    }
    function extractFromZip(buf, wantedName) {
      let eocd = -1;
      for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 101010256) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new Error("Not a valid zip file (no end-of-directory record).");
      const count = buf.readUInt16LE(eocd + 10);
      let p = buf.readUInt32LE(eocd + 16);
      for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 33639248) throw new Error("Corrupt zip central directory.");
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;
        if (name.split("/").pop() !== wantedName) continue;
        if (buf.readUInt32LE(localOffset) !== 67324752) throw new Error("Corrupt zip entry header.");
        const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
        const data = buf.subarray(dataStart, dataStart + compSize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error("Unsupported zip compression method " + method);
      }
      throw new Error(`"${wantedName}" not found in the downloaded archive.`);
    }
    function installCommand(platform, has) {
      if (platform === "win32") {
        if (!has("winget")) return null;
        return {
          label: "winget install Rclone.Rclone",
          command: "winget",
          args: ["install", "--id", "Rclone.Rclone", "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements"]
        };
      }
      if (platform === "darwin") {
        if (!has("brew")) return null;
        return { label: "brew install rclone", command: "brew", args: ["install", "rclone"] };
      }
      if (platform === "linux") {
        if (!has("curl")) return null;
        const elevate = has("pkexec") ? "pkexec bash" : "sudo -n bash";
        return {
          label: "curl https://rclone.org/install.sh | " + elevate,
          command: "sh",
          args: ["-c", `curl -fsSL ${RCLONE_SITE}/install.sh | ${elevate}`]
        };
      }
      return null;
    }
    module2.exports = {
      DEFAULT_SETTINGS: DEFAULT_SETTINGS2,
      DAILY_RETRY_DELAY_MS,
      DAILY_MAX_RETRIES: DAILY_MAX_RETRIES2,
      RCLONE_SITE,
      RCLONE_INSTALL_URL: RCLONE_INSTALL_URL2,
      RCLONE_DOWNLOADS_URL,
      pad,
      formatTimestamp,
      parseTimestamp,
      humanSize: humanSize2,
      targetLocation: targetLocation2,
      normalizeDailyTime: normalizeDailyTime2,
      localDateKey: localDateKey2,
      dailyScheduleDecision: dailyScheduleDecision2,
      escapeFilter,
      buildRcloneArgs,
      parseRcloneLine,
      summarizeErrors: summarizeErrors2,
      isAttemptFailure,
      planIncrementalPrune,
      rcloneTarget,
      rcloneZipName,
      parseRcloneVersion,
      findSha256,
      extractFromZip,
      installCommand
    };
  }
});

// src/rclone.js
var require_rclone = __commonJS({
  "src/rclone.js"(exports2, module2) {
    "use strict";
    var { spawn, spawnSync, execFile } = require("child_process");
    var crypto = require("crypto");
    var https = require("https");
    var os = require("os");
    var path2 = require("path");
    var fs2 = require("fs");
    var fsp2 = fs2.promises;
    var {
      RCLONE_DOWNLOADS_URL,
      buildRcloneArgs,
      formatTimestamp,
      parseRcloneLine,
      parseRcloneVersion,
      isAttemptFailure,
      planIncrementalPrune,
      rcloneTarget,
      rcloneZipName,
      findSha256,
      extractFromZip,
      installCommand
    } = require_core();
    var RcloneMissingError2 = class extends Error {
      constructor(binary) {
        super(`rclone was not found ("${binary}"). Install rclone first: https://rclone.org/install/`);
        this.name = "RcloneMissingError";
        this.binary = binary;
      }
    };
    function probeRclone(binary) {
      return new Promise((resolve) => {
        try {
          execFile(binary, ["version"], { windowsHide: true, timeout: 15e3 }, (err, stdout) => {
            resolve(err ? null : parseRcloneVersion(stdout) || null);
          });
        } catch (e) {
          resolve(null);
        }
      });
    }
    function candidateBinaries(configured, extraDirs) {
      const exe = process.platform === "win32" ? "rclone.exe" : "rclone";
      const dirs = [...extraDirs || []];
      const home = os.homedir();
      if (process.platform === "win32") {
        const local = process.env.LOCALAPPDATA || path2.join(home, "AppData", "Local");
        dirs.push(path2.join(local, "Microsoft", "WinGet", "Links"));
        dirs.push(path2.join(process.env.ProgramFiles || "C:\\Program Files", "rclone"));
        dirs.push(path2.join(home, "scoop", "shims"));
        dirs.push(path2.join(process.env.ChocolateyInstall || "C:\\ProgramData\\chocolatey", "bin"));
      } else {
        dirs.push("/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/snap/bin", path2.join(home, ".local", "bin"), path2.join(home, "bin"));
      }
      const list = [configured || "rclone"];
      for (const d of dirs) list.push(path2.join(d, exe));
      return [...new Set(list)];
    }
    async function findRclone2(configured, extraDirs) {
      for (const candidate of candidateBinaries(configured, extraDirs)) {
        if (path2.isAbsolute(candidate) && !fs2.existsSync(candidate)) continue;
        const version = await probeRclone(candidate);
        if (version) return { binary: candidate, version };
      }
      return null;
    }
    function hasCommand(cmd) {
      try {
        const r = process.platform === "win32" ? spawnSync("where", [cmd], { windowsHide: true }) : spawnSync("sh", ["-c", 'command -v "$1"', "sh", cmd]);
        return r.status === 0;
      } catch (e) {
        return false;
      }
    }
    function packageManagerInstaller2() {
      return installCommand(process.platform, hasCommand);
    }
    function runInstaller2(recipe, onLog) {
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(recipe.command, recipe.args, { windowsHide: true });
        } catch (err) {
          return reject(err);
        }
        const tail = [];
        const sink = (chunk) => {
          const text = chunk.toString("utf8");
          tail.push(text);
          if (tail.length > 20) tail.shift();
          if (onLog) onLog(text);
        };
        child.stdout.on("data", sink);
        child.stderr.on("data", sink);
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`"${recipe.label}" failed (exit code ${code}). ${tail.join("").trim().slice(-300)}`));
        });
      });
    }
    function httpsGet(url, redirects = 5) {
      return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { "User-Agent": "obsidian-rclone-incremental-backup" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
            res.resume();
            return resolve(httpsGet(new URL(res.headers.location, url).toString(), redirects - 1));
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(6e4, () => req.destroy(new Error("Download timed out.")));
      });
    }
    async function downloadRclone2(destDir, onStatus) {
      const target = rcloneTarget(process.platform, process.arch);
      if (!target) throw new Error(`rclone has no official build for ${process.platform}/${process.arch}.`);
      if (onStatus) onStatus("Looking up the latest rclone version...");
      const version = parseRcloneVersion((await httpsGet(RCLONE_DOWNLOADS_URL + "/version.txt")).toString("utf8"));
      if (!version) throw new Error("Could not determine the latest rclone version.");
      const zipName = rcloneZipName(version, target);
      const base = `${RCLONE_DOWNLOADS_URL}/${version}`;
      if (onStatus) onStatus(`Downloading ${zipName}...`);
      const zip = await httpsGet(`${base}/${zipName}`);
      const expected = findSha256((await httpsGet(`${base}/SHA256SUMS`)).toString("utf8"), zipName);
      const actual = crypto.createHash("sha256").update(zip).digest("hex");
      if (!expected || expected !== actual) {
        throw new Error("The downloaded rclone archive failed its SHA-256 check; nothing was installed.");
      }
      const binary = extractFromZip(zip, target.exe);
      await fsp2.mkdir(destDir, { recursive: true });
      const dest = path2.join(destDir, target.exe);
      await fsp2.writeFile(dest, binary, { mode: 493 });
      await fsp2.chmod(dest, 493);
      return dest;
    }
    var BackupRun2 = class {
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
          timestamp: formatTimestamp(/* @__PURE__ */ new Date()),
          exclude: o.exclude,
          inplace: o.inplace
        });
        return new Promise((resolve, reject) => {
          let child;
          try {
            child = spawn(o.rcloneBinary, args, { shell: false, windowsHide: true });
          } catch (err) {
            return reject(err.code === "ENOENT" ? new RcloneMissingError2(o.rcloneBinary) : err);
          }
          this.child = child;
          const errors = [];
          const retried = [];
          const other = [];
          let stats = null;
          let pending = "";
          const handleLine = (line) => {
            const parsed = parseRcloneLine(line);
            if (!parsed) return;
            if (parsed.kind === "stats") {
              stats = parsed.stats;
              if (o.onProgress) o.onProgress({ files: stats.transfers || 0, totalFiles: stats.totalTransfers || 0, bytes: stats.bytes || 0, totalBytes: stats.totalBytes || 0 });
            } else if (parsed.kind === "error") {
              if (isAttemptFailure(parsed.message)) {
                retried.push(...errors.splice(0));
              } else {
                errors.push(parsed.message);
              }
            } else {
              other.push(parsed.message);
              if (other.length > 20) other.shift();
            }
          };
          child.stderr.on("data", (chunk) => {
            pending += chunk.toString("utf8");
            const lines = pending.split(/\r?\n/);
            pending = lines.pop();
            lines.forEach(handleLine);
          });
          child.stdout.on("data", () => {
          });
          child.on("error", (err) => {
            reject(err.code === "ENOENT" ? new RcloneMissingError2(o.rcloneBinary) : err);
          });
          child.on("close", async (code) => {
            if (pending) handleLine(pending);
            this.child = null;
            if (this.cancelled) return reject(Object.assign(new Error("Backup cancelled."), { cancelled: true }));
            if (code !== 0) {
              const detail = errors.length ? errors : other.slice(-3);
              const err = new Error(`rclone exited with code ${code}.` + (detail.length ? " " + detail.slice(-3).join(" | ") : ""));
              err.details = errors;
              return reject(err);
            }
            let pruned = 0;
            try {
              pruned = await pruneIncremental(path2.join(o.targetRoot, o.incrementalDirName), o.keepIncrementalDays);
            } catch (e) {
              errors.push("Could not prune old incremental folders: " + (e && e.message ? e.message : e));
            }
            resolve({
              files: stats ? stats.transfers || 0 : 0,
              bytes: stats ? stats.bytes || 0 : 0,
              deletes: stats ? stats.deletes || 0 : 0,
              pruned,
              errors,
              retried,
              current,
              incremental
            });
          });
        });
      }
    };
    async function pruneIncremental(incrementalRoot, keepDays, now) {
      if (!(keepDays > 0)) return 0;
      let names;
      try {
        names = await fsp2.readdir(incrementalRoot);
      } catch (e) {
        return 0;
      }
      const doomed = planIncrementalPrune(names, now || /* @__PURE__ */ new Date(), keepDays);
      let removed = 0;
      let firstError = null;
      for (const name of doomed) {
        try {
          await fsp2.rm(path2.join(incrementalRoot, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
          removed++;
        } catch (e) {
          if (!firstError) firstError = e;
        }
      }
      if (firstError) {
        throw new Error(`${doomed.length - removed} of ${doomed.length} old folder(s) could not be deleted: ${firstError.message}`);
      }
      return removed;
    }
    module2.exports = {
      RcloneMissingError: RcloneMissingError2,
      probeRclone,
      candidateBinaries,
      findRclone: findRclone2,
      packageManagerInstaller: packageManagerInstaller2,
      runInstaller: runInstaller2,
      downloadRclone: downloadRclone2,
      pruneIncremental,
      BackupRun: BackupRun2
    };
  }
});

// src/wake-lock.js
var require_wake_lock = __commonJS({
  "src/wake-lock.js"(exports2, module2) {
    "use strict";
    function defaultPowerSaveBlocker() {
      try {
        const remote = require("electron").remote;
        return remote && remote.powerSaveBlocker ? remote.powerSaveBlocker : null;
      } catch (err) {
        return null;
      }
    }
    var ScreenWakeLock2 = class {
      constructor(opts = {}) {
        this.getPowerSaveBlocker = opts.getPowerSaveBlocker || defaultPowerSaveBlocker;
        this.blocker = null;
        this.blockerId = null;
        this.sentinel = null;
        this.pending = null;
        this.wanted = false;
        this.onVisibilityChange = () => {
          if (this.wanted && document.visibilityState === "visible") this.request();
        };
      }
      async acquire() {
        if (this.wanted) return;
        this.wanted = true;
        if (this.startBlocker()) return;
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", this.onVisibilityChange);
        }
        await this.request();
      }
      async release() {
        if (!this.wanted) return;
        this.wanted = false;
        if (this.blocker) {
          try {
            this.blocker.stop(this.blockerId);
          } catch (err) {
          }
          this.blocker = null;
          this.blockerId = null;
        }
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", this.onVisibilityChange);
        }
        const sentinel = this.sentinel;
        this.sentinel = null;
        try {
          if (sentinel) await sentinel.release();
        } catch (err) {
        }
      }
      startBlocker() {
        try {
          const blocker = this.getPowerSaveBlocker();
          if (!blocker) return false;
          this.blockerId = blocker.start("prevent-app-suspension");
          this.blocker = blocker;
          return true;
        } catch (err) {
          return false;
        }
      }
      request() {
        if (this.pending) return this.pending;
        if (this.sentinel && !this.sentinel.released) return Promise.resolve();
        if (typeof navigator === "undefined" || !navigator.wakeLock) return Promise.resolve();
        this.pending = (async () => {
          try {
            const sentinel = await navigator.wakeLock.request("screen");
            if (!this.wanted) {
              await sentinel.release();
              return;
            }
            this.sentinel = sentinel;
          } catch (err) {
            console.debug("Incremental Backup: could not keep the computer awake during the backup", err);
          } finally {
            this.pending = null;
          }
        })();
        return this.pending;
      }
    };
    module2.exports = { ScreenWakeLock: ScreenWakeLock2 };
  }
});

// src/main.js
var { Plugin, PluginSettingTab, Setting, Notice, Modal } = require("obsidian");
var path = require("path");
var fs = require("fs");
var fsp = fs.promises;
var {
  DEFAULT_SETTINGS,
  RCLONE_INSTALL_URL,
  humanSize,
  summarizeErrors,
  dailyScheduleDecision,
  localDateKey,
  normalizeDailyTime,
  targetLocation,
  DAILY_MAX_RETRIES
} = require_core();
var {
  RcloneMissingError,
  findRclone,
  packageManagerInstaller,
  runInstaller,
  downloadRclone,
  BackupRun
} = require_rclone();
var { ScreenWakeLock } = require_wake_lock();
function errMessage(err) {
  return err && err.message ? err.message : String(err);
}
var IncrementalBackupPlugin = class extends Plugin {
  async onload() {
    await this.loadSettings();
    this.isRunning = false;
    this.currentRun = null;
    this.activeNotice = null;
    this.dailyRetry = null;
    this.wakeLock = new ScreenWakeLock();
    this.register(() => this.wakeLock.release());
    this.register(() => {
      if (this.currentRun) this.currentRun.cancel();
    });
    this.addRibbonIcon("archive", "Incremental backup now", () => {
      this.runBackup({ trigger: "manual" });
    });
    this.addCommand({
      id: "run-backup-now",
      name: "Run incremental backup now",
      callback: () => this.runBackup({ trigger: "manual" })
    });
    this.addCommand({
      id: "cancel-backup",
      name: "Cancel running backup",
      callback: () => {
        if (this.currentRun) this.currentRun.cancel();
        else new Notice("No backup is running.");
      }
    });
    this.addCommand({
      id: "check-rclone",
      name: "Check / install rclone",
      callback: () => this.ensureRclone({ interactive: true })
    });
    this.addSettingTab(new IncrementalBackupSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.runOnStartup) {
        this.runBackup({ trigger: "startup" });
      }
    });
    this.registerInterval(window.setInterval(() => {
      if (this.settings.runHourly) {
        this.runBackup({ trigger: "hourly" });
      }
    }, 60 * 60 * 1e3));
    this.registerInterval(window.setInterval(() => {
      this.checkDailySchedule();
    }, 60 * 1e3));
  }
  async checkDailySchedule() {
    const now = /* @__PURE__ */ new Date();
    const decision = dailyScheduleDecision(this.settings, now, this.dailyRetry);
    if (decision.lastDailyRunDate !== this.settings.lastDailyRunDate) {
      this.settings.lastDailyRunDate = decision.lastDailyRunDate;
      await this.saveSettings();
    }
    if (!decision.run) return;
    const today = localDateKey(now);
    const outcome = await this.runBackup({ trigger: "daily" });
    if (outcome === "ok" || outcome === "misconfigured") {
      this.settings.lastDailyRunDate = today;
      await this.saveSettings();
    } else if (outcome === "failed") {
      const failures = this.dailyRetry && this.dailyRetry.date === today ? this.dailyRetry.failures : 0;
      this.dailyRetry = { date: today, failures: failures + 1, lastAttempt: Date.now() };
    }
  }
  /** A message about where the target folder is, or null if it's fine. */
  targetProblem(targetDir) {
    const basePath = this.getVaultBasePath();
    if (!basePath || !targetDir) return null;
    const real = (p) => {
      try {
        return fs.realpathSync.native(p);
      } catch (e) {
        return p;
      }
    };
    switch (targetLocation(real(targetDir), real(basePath))) {
      case "vault-root":
        return "The target directory cannot be the vault itself \u2014 pick a folder outside the vault.";
      case "inside-vault":
        return "The target directory is inside the vault, so the backup would be copied into itself. Pick a folder outside the vault.";
      case "contains-vault":
        return "The vault is inside the target directory; the mirror folder could overwrite your vault. Pick a different folder.";
      default:
        return null;
    }
  }
  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    return null;
  }
  getPluginDir() {
    const base = this.getVaultBasePath();
    if (!base) return null;
    return path.join(base, this.app.vault.configDir, "plugins", this.manifest.id);
  }
  /**
   * The plugin's own data.json (rewritten after every run for lastRun) and error log live in the
   * vault; left in, every run would see them as changed and create an incremental folder for nothing.
   * Anchored with a leading slash so only these root-relative paths match.
   */
  ownStateExcludes() {
    const dir = `/${this.app.vault.configDir}/plugins/${this.manifest.id}/`;
    return [dir + "data.json", dir + "backup-errors.log"];
  }
  getLogFilePath() {
    const dir = this.getPluginDir();
    return dir ? path.join(dir, "backup-errors.log") : null;
  }
  /** Folder where "download rclone" puts its copy (found automatically afterwards). */
  getLocalBinDir() {
    const dir = this.getPluginDir();
    return dir ? path.join(dir, "bin") : null;
  }
  /**
   * Resolves to { binary, version } for a working rclone, or null when there is none.
   * With `interactive`, a missing rclone opens the install helper and a found one is confirmed
   * in a notice, unless `quiet` (a backup run only wants to hear about problems).
   */
  async ensureRclone({ interactive, quiet } = {}) {
    const localBin = this.getLocalBinDir();
    const found = await findRclone(this.settings.rcloneBinary, localBin ? [localBin] : []);
    if (found) {
      if (found.binary !== this.settings.rcloneBinary) {
        this.settings.rcloneBinary = found.binary;
        await this.saveSettings();
      }
      if (interactive && !quiet) new Notice(`rclone ${found.version} is installed (${found.binary}).`);
      return found;
    }
    new Notice(
      `rclone is not installed (looked for "${this.settings.rcloneBinary}"). The backup needs it \u2014 install it from ${RCLONE_INSTALL_URL} or use the install helper.`,
      1e4
    );
    if (interactive) new RcloneInstallModal(this.app, this).open();
    return null;
  }
  async pickDirectory() {
    let remote;
    try {
      remote = require("electron").remote;
    } catch (err) {
      remote = null;
    }
    if (!remote || !remote.dialog) {
      new Notice("The folder picker is not available on this Obsidian/Electron version \u2014 enter the path manually.");
      return null;
    }
    try {
      const result = await remote.dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Backup target directory",
        defaultPath: this.settings.targetDir || void 0
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    } catch (err) {
      new Notice("Error opening the folder picker: " + errMessage(err));
      return null;
    }
  }
  /** Resolves to 'ok', 'failed', 'busy' (another backup is running) or 'misconfigured'. */
  async runBackup({ trigger } = {}) {
    if (this.isRunning) {
      if (trigger === "manual") new Notice("A backup is already in progress.");
      return "busy";
    }
    const basePath = this.getVaultBasePath();
    if (!basePath) {
      new Notice("Error: could not determine the vault path (this plugin only works in desktop Obsidian).");
      return "misconfigured";
    }
    const targetDir = (this.settings.targetDir || "").trim();
    if (!targetDir) {
      new Notice("Error: no backup target directory set. Open the plugin settings.");
      return "misconfigured";
    }
    const problem = this.targetProblem(targetDir);
    if (problem) {
      new Notice("Error: " + problem);
      return "misconfigured";
    }
    this.isRunning = true;
    let rclone;
    try {
      rclone = await this.ensureRclone({ interactive: trigger === "manual", quiet: true });
    } catch (err) {
      this.isRunning = false;
      new Notice("Error: " + errMessage(err));
      return "failed";
    }
    if (!rclone) {
      this.isRunning = false;
      return "misconfigured";
    }
    const logFilePath = this.getLogFilePath();
    this.activeNotice = new Notice("Backup: scanning files...", 0);
    let lastUpdate = 0;
    const run = new BackupRun({
      rcloneBinary: rclone.binary,
      sourceDir: basePath,
      targetRoot: targetDir,
      fullDirName: this.settings.fullDirName,
      incrementalDirName: this.settings.incrementalDirName,
      exclude: [...this.settings.excludeList, ...this.ownStateExcludes()],
      keepIncrementalDays: this.settings.keepIncrementalDays,
      inplace: this.settings.inplace,
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastUpdate > 400 && this.activeNotice) {
          lastUpdate = now;
          const files = p.totalFiles ? `${p.files}/${p.totalFiles} files` : `${p.files} files`;
          const size = p.totalBytes ? `${humanSize(p.bytes)} / ${humanSize(p.totalBytes)}` : humanSize(p.bytes);
          this.activeNotice.setMessage(`Backing up: ${files}, ${size}`);
        }
      }
    });
    this.currentRun = run;
    this.wakeLock.acquire();
    let result;
    try {
      result = await run.run();
      if (this.activeNotice) {
        const summary = result.errors.length ? `Backup finished with ${result.errors.length} error(s):
${summarizeErrors(result.errors)}
Details: backup-errors.log` : (result.files || result.deletes ? `Backup finished: ${result.files} changed file(s), ${humanSize(result.bytes)}` : "Backup finished: nothing had changed") + (result.retried.length ? `
(rclone hit ${result.retried.length} error(s) and recovered by retrying; see backup-errors.log)` : "");
        this.activeNotice.setMessage(summary);
        this.activeNotice = null;
      }
      if (result.errors.length) await this.appendLog(logFilePath, result.errors.join("\n"));
      else if (result.retried.length) await this.appendLog(logFilePath, "Recovered by retrying:\n" + result.retried.join("\n"));
    } catch (err) {
      const message = errMessage(err);
      if (!err.cancelled) console.error("Incremental Backup error:", err);
      if (this.activeNotice) {
        this.activeNotice.setMessage(err instanceof RcloneMissingError || err.cancelled ? message : "Backup error: " + message);
        this.activeNotice = null;
      }
      if (!err.cancelled) await this.appendLog(logFilePath, message);
      return err.cancelled ? "busy" : "failed";
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
      pruned: result.pruned
    };
    try {
      await this.saveSettings();
    } catch (err) {
      console.error("Incremental Backup: could not save settings", err);
    }
    return "ok";
  }
  async appendLog(logFilePath, message) {
    if (!logFilePath) return;
    try {
      await fsp.mkdir(path.dirname(logFilePath), { recursive: true });
      await fsp.appendFile(logFilePath, `=== ${(/* @__PURE__ */ new Date()).toISOString()} ===
${message}

`, "utf8");
    } catch (e) {
    }
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.dailyTime = normalizeDailyTime(this.settings.dailyTime) || DEFAULT_SETTINGS.dailyTime;
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var RcloneInstallModal = class extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "rclone is required" });
    contentEl.createEl("p", {
      text: "Rclone Incremental Backup uses rclone to copy the vault, and rclone was not found on this computer. Pick one way to get it:"
    });
    const installer = packageManagerInstaller();
    this.statusEl = contentEl.createEl("p", { cls: "setting-item-description" });
    new Setting(contentEl).setName(installer ? `Install with the package manager` : "Install with the package manager").setDesc(installer ? `Runs: ${installer.label}` : "No supported package manager (winget / brew / curl) was found on this system.").addButton((btn) => {
      btn.setButtonText("Install").setCta().onClick(() => this.install(installer));
      if (!installer) btn.setDisabled(true);
    });
    new Setting(contentEl).setName("Download rclone into the plugin folder").setDesc("Fetches the official release from downloads.rclone.org, verifies its SHA-256 checksum and keeps it next to the plugin. No admin rights needed.").addButton((btn) => btn.setButtonText("Download").onClick(() => this.download()));
    new Setting(contentEl).setName("Open the rclone website").setDesc(RCLONE_INSTALL_URL).addButton((btn) => btn.setButtonText("Open").onClick(() => window.open(RCLONE_INSTALL_URL, "_blank")));
  }
  setStatus(text) {
    this.statusEl.setText(text);
  }
  async finish() {
    const found = await findRclone(this.plugin.settings.rcloneBinary, [this.plugin.getLocalBinDir()].filter(Boolean));
    if (!found) {
      this.setStatus("Installed, but rclone still cannot be started from here. Restart Obsidian (so it picks up the new PATH) or set the path in the plugin settings.");
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
      this.setStatus(`${errMessage(err)} \u2014 try the download option or the rclone website instead.`);
    }
  }
  async download() {
    const dir = this.plugin.getLocalBinDir();
    if (!dir) {
      this.setStatus("Cannot locate the plugin folder (desktop Obsidian only).");
      return;
    }
    try {
      await downloadRclone(dir, (text) => this.setStatus(text));
      await this.finish();
    } catch (err) {
      this.setStatus(`${errMessage(err)} \u2014 try the rclone website instead.`);
    }
  }
  onClose() {
    this.contentEl.empty();
  }
};
var IncrementalBackupSettingTab = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    containerEl.createEl("h2", { text: "Rclone Incremental Backup settings" });
    const rcloneStatus = containerEl.createEl("p", { cls: "setting-item-description" });
    const refreshRcloneStatus = async () => {
      const localBin = this.plugin.getLocalBinDir();
      const found = await findRclone(s.rcloneBinary, localBin ? [localBin] : []);
      rcloneStatus.setText(found ? `rclone ${found.version} found (${found.binary}).` : "rclone was NOT found \u2014 backups will fail until it is installed.");
      rcloneStatus.style.color = found ? "" : "var(--text-error)";
    };
    new Setting(containerEl).setName("rclone executable").setDesc('Path to the rclone binary, or "rclone" if it is on your PATH.').addText((text) => {
      text.setPlaceholder("rclone").setValue(s.rcloneBinary).onChange(async (value) => {
        s.rcloneBinary = value.trim() || "rclone";
        await this.plugin.saveSettings();
        refreshRcloneStatus();
      });
      text.inputEl.style.width = "100%";
    }).addButton((btn) => btn.setButtonText("Check / install").onClick(async () => {
      await this.plugin.ensureRclone({ interactive: true });
      this.display();
    }));
    refreshRcloneStatus();
    const targetSetting = new Setting(containerEl).setName("Target directory").setDesc("The folder that receives the mirror and the incremental history (full path, outside the vault).").addText((text) => {
      text.setPlaceholder("e.g. D:\\Backups\\Obsidian").setValue(s.targetDir).onChange(async (value) => {
        s.targetDir = value.trim();
        await this.plugin.saveSettings();
        updateTargetWarning();
      });
      text.inputEl.style.width = "100%";
    }).addButton((btn) => btn.setButtonText("Browse\u2026").onClick(async () => {
      const dir = await this.plugin.pickDirectory();
      if (dir) {
        s.targetDir = dir;
        await this.plugin.saveSettings();
        this.display();
      }
    }));
    targetSetting.settingEl.style.flexWrap = "wrap";
    targetSetting.controlEl.style.flexBasis = "100%";
    targetSetting.controlEl.style.justifyContent = "flex-start";
    targetSetting.controlEl.style.marginTop = "8px";
    targetSetting.controlEl.querySelector("input").style.flex = "1 1 auto";
    const targetWarningEl = containerEl.createEl("p", { cls: "setting-item-description" });
    targetWarningEl.style.color = "var(--text-warning)";
    const updateTargetWarning = () => {
      const warning = this.plugin.targetProblem(s.targetDir);
      targetWarningEl.setText(warning || "");
      targetWarningEl.style.display = warning ? "" : "none";
    };
    updateTargetWarning();
    new Setting(containerEl).setName("Mirror folder name").setDesc("Subfolder of the target holding the always up-to-date 1:1 copy of the vault.").addText((text) => text.setValue(s.fullDirName).onChange(async (v) => {
      s.fullDirName = v.trim() || DEFAULT_SETTINGS.fullDirName;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Incremental folder name").setDesc("Subfolder where each run archives the previous versions of changed files and the files deleted from the vault, in timestamped folders.").addText((text) => text.setValue(s.incrementalDirName).onChange(async (v) => {
      s.incrementalDirName = v.trim() || DEFAULT_SETTINGS.incrementalDirName;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Run on startup").setDesc("Automatically run a backup when Obsidian opens this vault.").addToggle((t) => t.setValue(s.runOnStartup).onChange(async (v) => {
      s.runOnStartup = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Run hourly").setDesc("Automatically run a backup once per hour.").addToggle((t) => t.setValue(s.runHourly).onChange(async (v) => {
      s.runHourly = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Run daily").setDesc(`Run a backup once a day at the given time (HH:MM, local time). If it fails, e.g. because the target drive isn't connected, it is retried every 30 minutes, up to ${DAILY_MAX_RETRIES} times.`).addToggle((t) => t.setValue(s.runDaily).onChange(async (v) => {
      s.runDaily = v;
      await this.plugin.saveSettings();
    })).addText((text) => text.setPlaceholder("20:00").setValue(s.dailyTime).onChange(async (v) => {
      const time = normalizeDailyTime(v);
      text.inputEl.style.borderColor = time ? "" : "var(--text-error)";
      if (time) {
        s.dailyTime = time;
        await this.plugin.saveSettings();
      }
    }));
    new Setting(containerEl).setName("Write files in place (--inplace)").setDesc(`Turn on if the target is a virtual drive such as pCloud Drive or Google Drive that refuses rclone's temporary ".partial" files with "access denied" errors. Slightly less safe: an interrupted copy can leave one half-written file in the mirror.`).addToggle((t) => t.setValue(s.inplace).onChange(async (v) => {
      s.inplace = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Delete incremental folders older than (days)").setDesc("0 keeps the whole history forever. Only timestamp-named folders inside the incremental folder are ever deleted.").addText((text) => text.setValue(String(s.keepIncrementalDays)).onChange(async (v) => {
      const n = parseInt(v, 10);
      s.keepIncrementalDays = Number.isFinite(n) && n >= 0 ? n : 0;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Excluded files/folders").setDesc("Comma-separated names (e.g. node_modules, .git, .trash). Matched at any depth.").addTextArea((ta) => ta.setValue(s.excludeList.join(", ")).onChange(async (v) => {
      s.excludeList = v.split(",").map((x) => x.trim()).filter(Boolean);
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Run backup now").addButton((btn) => btn.setButtonText("Run backup").setCta().onClick(() => this.plugin.runBackup({ trigger: "manual" })));
    if (s.lastRun) {
      const lr = s.lastRun;
      const parts = [`${lr.files} changed file(s)`];
      parts.push(lr.errors ? `${lr.errors} errors` : "no errors");
      if (lr.pruned) parts.push(`${lr.pruned} old incremental folder(s) deleted`);
      containerEl.createEl("p", {
        text: `Last backup (${lr.trigger}): ${new Date(lr.time).toLocaleString()} \u2014 ${parts.join(", ")}`,
        cls: "setting-item-description"
      });
    }
    new Setting(containerEl).addButton((btn) => btn.setButtonText("\u{1F36A} Buy me a cookie").onClick(() => {
      window.open("https://paypal.me/repassyl", "_blank");
    }));
  }
};
module.exports = IncrementalBackupPlugin;
