'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const core = require('../src/core');

test('formatTimestamp / parseTimestamp round-trip', () => {
  const d = new Date(2026, 9, 30, 14, 5, 9);
  assert.equal(core.formatTimestamp(d), '2026-10-30_14-05-09');
  assert.equal(core.parseTimestamp('2026-10-30_14-05-09').getTime(), d.getTime());
  assert.equal(core.parseTimestamp('current'), null);
});

test('buildRcloneArgs follows the --backup-dir layout from the guide', () => {
  const { args, current, incremental } = core.buildRcloneArgs({
    sourceDir: '/vault', targetRoot: '/bak', fullDirName: 'current', incrementalDirName: 'incremental',
    timestamp: '2026-10-30_14-30-00', exclude: ['.git', ' ', 'we*ird'],
  });
  assert.equal(args[0], 'sync');
  assert.equal(args[1], '/vault');
  assert.equal(args[2], current);
  assert.equal(args[args.indexOf('--backup-dir') + 1], incremental);
  assert.match(current.replace(/\\/g, '/'), /\/bak\/current$/);
  assert.match(incremental.replace(/\\/g, '/'), /\/bak\/incremental\/2026-10-30_14-30-00$/);
  assert.ok(args.includes('--use-json-log'));
  assert.ok(args.includes('.git/**'));
  assert.ok(args.includes('we\\*ird'));
  assert.equal(args.filter((a) => a === '--exclude').length, 4); // blank entry skipped
});

test('parseRcloneLine understands stats, errors and plain text', () => {
  const stats = core.parseRcloneLine('{"level":"notice","msg":"x","stats":{"bytes":10,"transfers":2}}');
  assert.equal(stats.kind, 'stats');
  assert.equal(stats.stats.bytes, 10);
  assert.deepEqual(core.parseRcloneLine('{"level":"error","msg":"boom"}'), { kind: 'error', message: 'boom' });
  assert.equal(core.parseRcloneLine('not json').kind, 'other');
  assert.equal(core.parseRcloneLine('  '), null);
});

test('targetLocation refuses targets that overlap the vault', () => {
  assert.equal(core.targetLocation('D:\\Backups', 'C:\\Vault', 'win32'), 'outside');
  assert.equal(core.targetLocation('c:\\vault', 'C:\\Vault', 'win32'), 'vault-root');
  assert.equal(core.targetLocation('C:\\Vault\\bak', 'C:\\Vault', 'win32'), 'inside-vault');
  assert.equal(core.targetLocation('C:\\', 'C:\\Vault', 'win32'), 'contains-vault');
  assert.equal(core.targetLocation('/mnt/bak', '/home/u/vault', 'linux'), 'outside');
});

test('planIncrementalPrune only picks old timestamp folders', () => {
  const now = new Date(2026, 9, 30, 12, 0, 0);
  const names = ['2026-01-01_00-00-00', '2026-10-29_00-00-00', 'notes', 'current'];
  assert.deepEqual(core.planIncrementalPrune(names, now, 30), ['2026-01-01_00-00-00']);
  assert.deepEqual(core.planIncrementalPrune(names, now, 0), []);
});

test('rclone release helpers', () => {
  assert.deepEqual(core.rcloneTarget('win32', 'x64'), { os: 'windows', cpu: 'amd64', exe: 'rclone.exe' });
  assert.equal(core.rcloneTarget('freebsd', 'x64'), null);
  assert.equal(core.rcloneZipName('v1.75.1', core.rcloneTarget('linux', 'arm64')), 'rclone-v1.75.1-linux-arm64.zip');
  assert.equal(core.parseRcloneVersion('rclone v1.75.1\n- os/version: x'), 'v1.75.1');
  assert.equal(core.parseRcloneVersion('nope'), null);
  const h = 'a'.repeat(64);
  assert.equal(core.findSha256(`${h}  rclone-v1-linux-amd64.zip\n${'b'.repeat(64)}  other.zip`, 'rclone-v1-linux-amd64.zip'), h);
  assert.equal(core.findSha256(h + '  x.zip', 'y.zip'), null);
});

test('installCommand picks the platform installer, or none', () => {
  const all = () => true;
  const none = () => false;
  assert.equal(core.installCommand('win32', all).command, 'winget');
  assert.equal(core.installCommand('win32', none), null);
  assert.equal(core.installCommand('darwin', all).command, 'brew');
  assert.match(core.installCommand('linux', all).args[1], /rclone\.org\/install\.sh \| pkexec bash/);
  assert.match(core.installCommand('linux', (c) => c === 'curl').args[1], /sudo -n bash/);
  assert.equal(core.installCommand('linux', none), null);
});

// Minimal zip writer for the extraction test.
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const nameBuf = Buffer.from(name);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, body);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('extractFromZip pulls the binary out of stored and deflated entries', () => {
  const payload = Buffer.from('MZ-fake-binary'.repeat(100));
  const zip = makeZip([
    { name: 'rclone-v1/README.txt', data: Buffer.from('hi'), deflate: false },
    { name: 'rclone-v1/rclone.exe', data: payload, deflate: true },
  ]);
  assert.deepEqual(core.extractFromZip(zip, 'rclone.exe'), payload);
  const stored = makeZip([{ name: 'a/rclone', data: payload, deflate: false }]);
  assert.deepEqual(core.extractFromZip(stored, 'rclone'), payload);
  assert.throws(() => core.extractFromZip(zip, 'missing'), /not found/);
  assert.throws(() => core.extractFromZip(Buffer.from('garbage'), 'rclone'), /Not a valid zip/);
});
