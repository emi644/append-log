import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppendLog } from '../src/index.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appendlog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('append and iterate a single record', () => {
  const log = new AppendLog(dir);
  log.append(new Uint8Array([1, 2, 3]));
  log.close();

  const log2 = new AppendLog(dir);
  const records = [...log2.iterate()];
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], new Uint8Array([1, 2, 3]));
  log2.close();
});

test('append multiple records and iterate in order', () => {
  const log = new AppendLog(dir);
  log.append(new Uint8Array([10]));
  log.append(new Uint8Array([20, 21]));
  log.append(new Uint8Array([30, 31, 32]));
  log.close();

  const log2 = new AppendLog(dir);
  const records = [...log2.iterate()];
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], new Uint8Array([10]));
  assert.deepEqual(records[1], new Uint8Array([20, 21]));
  assert.deepEqual(records[2], new Uint8Array([30, 31, 32]));
  log2.close();
});

test('append returns byte offset of the record', () => {
  const log = new AppendLog(dir);
  const off0 = log.append(new Uint8Array([1, 2]));
  const off1 = log.append(new Uint8Array([3]));
  const off2 = log.append(new Uint8Array([4, 5, 6]));
  log.close();

  // Each record has a 4-byte length prefix.
  assert.equal(off0, 0);
  assert.equal(off1, 6);  // 4 + 2
  assert.equal(off2, 11); // 6 + 4 + 1
});

test('iterate over empty log yields nothing', () => {
  const log = new AppendLog(dir);
  log.close();

  const log2 = new AppendLog(dir);
  const records = [...log2.iterate()];
  assert.equal(records.length, 0);
  log2.close();
});

test('empty record (zero bytes) is preserved', () => {
  const log = new AppendLog(dir);
  log.append(new Uint8Array([]));
  log.append(new Uint8Array([42]));
  log.close();

  const log2 = new AppendLog(dir);
  const records = [...log2.iterate()];
  assert.equal(records.length, 2);
  assert.equal(records[0].length, 0);
  assert.deepEqual(records[1], new Uint8Array([42]));
  log2.close();
});

test('partial trailing record is skipped during iteration', () => {
  const log = new AppendLog(dir);
  log.append(new Uint8Array([1, 2, 3]));
  log.append(new Uint8Array([4, 5, 6]));
  log.close();

  // Simulate a crash mid-append: append a length prefix claiming 100 bytes,
  // but write only 3 bytes of body.
  const filePath = join(dir, 'log.bin');
  const existing = readFileSync(filePath);
  const partial = Buffer.alloc(7);
  partial.writeUInt32BE(100, 0); // claims 100-byte body
  partial[4] = 0xAA;
  partial[5] = 0xBB;
  partial[6] = 0xCC;             // only 3 bytes of the 100
  writeFileSync(filePath, Buffer.concat([existing, partial]));

  const log2 = new AppendLog(dir);
  const records = [...log2.iterate()];
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], new Uint8Array([1, 2, 3]));
  assert.deepEqual(records[1], new Uint8Array([4, 5, 6]));
  log2.close();
});

test('partial trailing header (fewer than 4 bytes) is skipped', () => {
  const log = new AppendLog(dir);
  log.append(new Uint8Array([1, 2]));
  log.close();

  const filePath = join(dir, 'log.bin');
  const existing = readFileSync(filePath);
  writeFileSync(filePath, Buffer.concat([existing, Buffer.from([0x00, 0x01])]));

  const log2 = new AppendLog(dir);
  const records = [...log2.iterate()];
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], new Uint8Array([1, 2]));
  log2.close();
});

test('records survive close and reopen', () => {
  const log = new AppendLog(dir);
  log.append(new Uint8Array([100]));
  log.close();

  const log2 = new AppendLog(dir);
  log2.append(new Uint8Array([200]));
  log2.close();

  const log3 = new AppendLog(dir);
  const records = [...log3.iterate()];
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], new Uint8Array([100]));
  assert.deepEqual(records[1], new Uint8Array([200]));
  log3.close();
});

test('custom filename option is respected', () => {
  const log = new AppendLog(dir, { filename: 'wal.bin' });
  log.append(new Uint8Array([7]));
  log.close();

  const log2 = new AppendLog(dir, { filename: 'wal.bin' });
  const records = [...log2.iterate()];
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], new Uint8Array([7]));
  log2.close();
});

test('close is idempotent', () => {
  const log = new AppendLog(dir);
  log.close();
  log.close(); // must not throw
});

test('constructor throws on empty dir', () => {
  assert.throws(() => new AppendLog(''), TypeError);
});

test('append throws on non-Uint8Array', () => {
  const log = new AppendLog(dir);
  assert.throws(() => log.append('not bytes'), TypeError);
  assert.throws(() => log.append([1, 2, 3]), TypeError);
  log.close();
});

test('large record round-trips correctly', () => {
  const payload = new Uint8Array(10000);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xFF;

  const log = new AppendLog(dir);
  log.append(payload);
  log.close();

  const log2 = new AppendLog(dir);
  const records = [...log2.iterate()];
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], payload);
  log2.close();
});

test('caller mutating buffer after append does not corrupt log', () => {
  const data = new Uint8Array([1, 2, 3]);
  const log = new AppendLog(dir);
  log.append(data);
  data[0] = 99; // mutate after append
  log.close();

  const log2 = new AppendLog(dir);
  const records = [...log2.iterate()];
  assert.deepEqual(records[0], new Uint8Array([1, 2, 3]));
  log2.close();
});
