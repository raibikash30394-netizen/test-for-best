'use strict';
// Local unit tests for the pure engine (no SAP needed).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planBatches, buildUnits, batchRows, unitKey } = require('../lib/batching');
const { CaptchaStore, hashOf } = require('../lib/captcha-store');
const tu = require('../lib/timeutil');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  - ' + name); }
  catch (e) { fail++; console.log('  FAIL- ' + name + '\n        ' + e.message); }
}

// helpers to build matched rows
function single(id, spi, bid = 100) {
  return { item: { SapOrderId: id, Posnr: '1', Spi: spi, ClubId: '' }, bidAmount: bid };
}
function club(clubId, n, spi, bid = 100) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ item: { SapOrderId: clubId + '-' + i, Posnr: String(i), Spi: spi, ClubId: clubId }, bidAmount: bid });
  }
  return rows;
}

console.log('\n== Batching / Priority Engine ==');

test('3 singles -> one batch of 3', () => {
  const b = planBatches([single('a', '10'), single('b', '11'), single('c', '12')]);
  assert.equal(b.length, 1);
  assert.equal(batchRows(b[0]).length, 3);
});

test('4 singles -> [3,1]', () => {
  const b = planBatches([single('a'), single('b'), single('c'), single('d')]);
  assert.deepEqual(b.map(x => batchRows(x).length), [3, 1]);
});

test('club-of-3 gets its own batch', () => {
  const b = planBatches([...club('C1', 3, '10')]);
  assert.equal(b.length, 1);
  assert.equal(batchRows(b[0]).length, 3);
  assert.equal(b[0][0].isClub, true);
});

test('club-of-2 tops up with one leftover single (batch of 3)', () => {
  // 1 single remainder + club-2 => single-first leaves 1 leftover, club2 tops up
  const b = planBatches([single('s1'), ...club('C1', 2, '10')]);
  assert.equal(b.length, 1);
  const rows = batchRows(b[0]);
  assert.equal(rows.length, 3);
});

test('two different club-2 never merge together', () => {
  const b = planBatches([...club('C1', 2, '10'), ...club('C2', 2, '11')]);
  // each club-2 alone (2+2>3)
  assert.equal(b.length, 2);
  b.forEach(batch => assert.equal(batch.length, 1));
});

test('1164 unit is placed in the FIRST batch', () => {
  const rows = [single('n1', '10'), single('n2', '11'), single('n3', '12'), single('vip', '1164')];
  const b = planBatches(rows);
  const firstIds = batchRows(b[0]).map(r => r.item.SapOrderId);
  assert.ok(firstIds.includes('vip'), 'vip(1164) must be in first batch, got ' + JSON.stringify(firstIds));
});

test('1164 club group is atomic and prioritized', () => {
  const rows = [single('n1', '10'), single('n2', '11'), ...club('VIP', 3, '1164')];
  const b = planBatches(rows);
  // first batch should be the 1164 club-of-3 (own batch)
  assert.equal(batchRows(b[0]).length, 3);
  assert.equal(b[0][0].rows[0].item.Spi, '1164');
});

test('multiple 1164 units all come before non-1164', () => {
  const rows = [single('n1', '10'), single('v1', '1164'), single('v2', '1164'), single('v3', '1164'), single('v4', '1164')];
  const b = planBatches(rows);
  // first batch = 3x 1164
  const first = batchRows(b[0]).map(r => r.item.Spi);
  assert.deepEqual(first, ['1164', '1164', '1164']);
});

test('single-first: singles come before non-priority clubs', () => {
  const rows = [...club('C1', 3, '10'), single('s1'), single('s2'), single('s3')];
  const b = planBatches(rows);
  // batch 0 should be the 3 singles, batch 1 the club-3
  assert.deepEqual(batchRows(b[0]).map(r => r.item.SapOrderId).sort(), ['s1', 's2', 's3']);
});

test('no batch ever exceeds 3 rows', () => {
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push(single('s' + i, i === 0 ? '1164' : '10'));
  rows.push(...club('CA', 2, '10'));
  rows.push(...club('CB', 3, '1164'));
  const b = planBatches(rows);
  b.forEach(batch => assert.ok(batchRows(batch).length <= 3));
});

test('club with single physical row treated as single', () => {
  const u = buildUnits([...club('SOLO', 1, '10')]);
  assert.equal(u[0].isClub, false);
});

console.log('\n== Captcha Store (no time-bomb, pool-only) ==');

test('load + lookup hit/miss', () => {
  const store = new CaptchaStore(path.resolve(__dirname, '../data.json'));
  const n = store.load();
  assert.ok(n === 162, 'expected 162 pool entries, got ' + n);
  const miss = store.lookup('not-a-real-image-string');
  assert.equal(miss.result, null);
  assert.equal(miss.fromPool, false);
});

test('lookup is deterministic (no random Redo) across dates', () => {
  // simulate: same base64 -> same hash -> same result every time, 500x
  const store = new CaptchaStore(path.join(os.tmpdir(), 'nope.json'));
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const h = hashOf(b64);
  store.map.set(h, 'ABCD');
  for (let i = 0; i < 500; i++) {
    const r = store.lookup(b64);
    assert.equal(r.result, 'ABCD');
  }
});

test('add + deferred flush writes to disk', () => {
  const f = path.join(os.tmpdir(), 'cap-' + Date.now() + '.json');
  const store = new CaptchaStore(f);
  store.add('h1', 'RES1', 'x.png');
  assert.equal(store.stats().pending, 1);
  const n = store.flush();
  assert.equal(n, 1);
  const arr = JSON.parse(fs.readFileSync(f, 'utf-8'));
  assert.equal(arr[0].result, 'RES1');
  fs.unlinkSync(f);
});

console.log('\n== Time / Window Math (GMT vs IST) ==');

test('parseSapDate + parseSapTime', () => {
  assert.equal(tu.parseSapDate('/Date(1467981296000)/'), 1467981296000);
  assert.equal(tu.parseSapTime('PT10H45M0S'), (10 * 3600 + 45 * 60) * 1000);
});

test('nextWindowStartUtc lands on IST :15 or :45', () => {
  // pick an arbitrary now, compute next window, verify IST minutes
  const now = Date.UTC(2026, 5, 15, 9, 3, 0); // 09:03 UTC = 14:33 IST -> next :45 IST
  const start = tu.nextWindowStartUtc(now, [15, 45]);
  const istMin = new Date(start + 330 * 60000).getUTCMinutes();
  assert.ok(istMin === 15 || istMin === 45, 'IST min was ' + istMin);
  assert.ok(start > now);
});

test('nextWindowStartUtc rolls to next hour after :45', () => {
  const now = Date.UTC(2026, 5, 15, 10, 20, 0); // 15:50 IST -> next :15 next hour IST
  const start = tu.nextWindowStartUtc(now, [15, 45]);
  const d = new Date(start + 330 * 60000);
  assert.equal(d.getUTCMinutes(), 15);
});

test('offsetFromHttpDate computes drift', () => {
  const localNow = Date.UTC(2026, 5, 15, 10, 0, 0);
  const off = tu.offsetFromHttpDate('Mon, 15 Jun 2026 10:00:05 GMT', localNow);
  assert.equal(off, 5000);
});

test('resolveWindow prefers plantConf slot times', () => {
  const plant = { BiddingDate: '/Date(1750000000000)/', SlotStartTime: 'PT10H15M0S', SlotEndTime: 'PT10H30M0S' };
  const w = tu.resolveWindow(plant, null, 0, [15, 45]);
  assert.equal(w.source, 'plantConf');
  assert.equal(w.start, 1750000000000 + (10 * 3600 + 15 * 60) * 1000);
});

console.log('\n──────────────────────────────');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('──────────────────────────────\n');
process.exit(fail ? 1 : 0);
