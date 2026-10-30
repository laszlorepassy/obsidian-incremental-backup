'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findRclone, pruneIncremental, BackupRun, RcloneMissingError } = require('../src/rclone');

test('findRclone with a bogus binary only finds rclone in standard install places', async () => {
  const found = await findRclone(path.join(os.tmpdir(), 'definitely-not-rclone-xyz'), []);
  if (found) assert.match(found.version, /^v\d/);
});

test('BackupRun rejects with RcloneMissingError when the binary is absent', async () => {
  const run = new BackupRun({
    rcloneBinary: path.join(os.tmpdir(), 'definitely-not-rclone-xyz'),
    sourceDir: os.tmpdir(), targetRoot: path.join(os.tmpdir(), 'x'), fullDirName: 'current', incrementalDirName: 'incremental',
  });
  await assert.rejects(run.run(), (e) => e instanceof RcloneMissingError);
});

test('pruneIncremental deletes only old timestamp folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incr-'));
  try {
    for (const n of ['2020-01-01_00-00-00', '2999-01-01_00-00-00', 'keep-me']) fs.mkdirSync(path.join(root, n));
    assert.equal(await pruneIncremental(root, 30), 1);
    assert.deepEqual(fs.readdirSync(root).sort(), ['2999-01-01_00-00-00', 'keep-me']);
    assert.equal(await pruneIncremental(root, 0), 0);
    assert.equal(await pruneIncremental(path.join(root, 'nope'), 30), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Real rclone, if present: mirror + incremental history end to end.
test('end-to-end: second run archives changed and deleted files', async (t) => {
  const { findRclone: find } = require('../src/rclone');
  const rc = await find('rclone', []);
  if (!rc) return t.skip('rclone not installed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const vault = path.join(root, 'vault');
  const bak = path.join(root, 'bak');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(vault, '.git'));
  fs.writeFileSync(path.join(vault, 'Notes', 'a.md'), 'v1');
  fs.writeFileSync(path.join(vault, 'gone.md'), 'bye');
  fs.writeFileSync(path.join(vault, '.git', 'x'), 'ignored');
  const opts = { rcloneBinary: rc.binary, sourceDir: vault, targetRoot: bak, fullDirName: 'current', incrementalDirName: 'incremental', exclude: ['.git'] };
  try {
    const first = await new BackupRun(opts).run();
    assert.ok(first.files >= 2);
    assert.equal(fs.readFileSync(path.join(bak, 'current', 'Notes', 'a.md'), 'utf8'), 'v1');
    assert.ok(!fs.existsSync(path.join(bak, 'current', '.git')));

    fs.writeFileSync(path.join(vault, 'Notes', 'a.md'), 'version two');
    fs.rmSync(path.join(vault, 'gone.md'));
    await new Promise((r) => setTimeout(r, 1100)); // distinct timestamp folder
    await new BackupRun(opts).run();

    assert.equal(fs.readFileSync(path.join(bak, 'current', 'Notes', 'a.md'), 'utf8'), 'version two');
    assert.ok(!fs.existsSync(path.join(bak, 'current', 'gone.md')));
    const stamps = fs.readdirSync(path.join(bak, 'incremental'));
    assert.equal(stamps.length, 1);
    assert.equal(fs.readFileSync(path.join(bak, 'incremental', stamps[0], 'Notes', 'a.md'), 'utf8'), 'v1');
    assert.equal(fs.readFileSync(path.join(bak, 'incremental', stamps[0], 'gone.md'), 'utf8'), 'bye');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
