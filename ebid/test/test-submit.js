'use strict';
// Mock-based tests for the submit path (no SAP/network). Proves:
//  1) captcha for batch N+1 is fetched only AFTER batch N is submitted (sequential)
//  2) hard captcha lock ("Contact Administrator") backs off without hammering
//  3) type 'I' rejects retry up to CAPTCHA_MAX_RETRY then give up
const assert = require('assert');
const { submitPlan, submitBatch } = require('../ebidding-fast.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  - ' + name); }
  catch (e) { fail++; console.log('  FAIL- ' + name + '\n        ' + e.message); }
}

const store = { lookup: () => ({ result: 'ABCDE', hash: 'h', fromPool: true }), add() {} };
function unit(id) { return { key: 'u' + id, rows: [{ item: { SapOrderId: id, ClubId: '', Freight: 1, ClubFreight: 1, BiddingRank: '1' }, bidAmount: '100' }] }; }

function makeSap(events, submitBehavior) {
  let n = 0;
  return {
    clockOffset: 0, serverNow: () => Date.now(),
    plantConf: { Plant: '6924', BiddingDate: '/Date(0)/', SlotNumber: '1' },
    async fetchCaptcha() { events.push('fetch'); return 'IMGDATA'; },
    async submit() { events.push('submit'); await new Promise(r => setTimeout(r, 20)); return submitBehavior(++n); },
    async refreshCsrf() { return true; },
  };
}

(async () => {
  console.log('\n== Submit path (mock SAP) ==');

  await test('captcha is SEQUENTIAL: fetch1, submit1, fetch2, submit2 (no clobber)', async () => {
    const events = [];
    const sap = makeSap(events, () => ({ type: 'S', message: 'ok' }));
    const plan = [[unit('1')], [unit('2')]];
    await submitPlan(sap, store, plan, null, new Set());
    assert.deepEqual(events, ['fetch', 'submit', 'fetch', 'submit'],
      'expected strict sequential order, got ' + JSON.stringify(events));
  });

  await test('batch2 captcha fetched only AFTER batch1 submit completes', async () => {
    const events = [];
    const sap = makeSap(events, () => ({ type: 'S' }));
    const plan = [[unit('1')], [unit('2')]];
    await submitPlan(sap, store, plan, null, new Set());
    // second 'fetch' index must be greater than first 'submit' index
    const firstSubmit = events.indexOf('submit');
    const secondFetch = events.indexOf('fetch', firstSubmit);
    assert.ok(secondFetch > firstSubmit, 'batch2 fetch happened before batch1 submit (clobber bug!)');
  });

  await test('prefetched captcha for batch1 skips its fetch', async () => {
    const events = [];
    const sap = makeSap(events, () => ({ type: 'S' }));
    await submitPlan(sap, store, [[unit('1')]], 'PREWARMED', new Set());
    assert.deepEqual(events, ['submit'], 'batch1 should NOT fetch when prefetched, got ' + JSON.stringify(events));
  });

  await test('hard captcha lock backs off (only ONE submit, no hammer)', async () => {
    const events = [];
    const sap = makeSap(events, () => ({ type: 'E', message: 'Captcha Validation Failed. Please Contact Administrator.' }));
    const r = await submitBatch(sap, store, [{ item: { SapOrderId: '1' }, bidAmount: '100' }], 'CAP', 1);
    assert.equal(r.ok, false);
    assert.equal(events.filter(e => e === 'submit').length, 1, 'must NOT hammer on lock, got ' + JSON.stringify(events));
  });

  await test('type I rejects retry up to CAPTCHA_MAX_RETRY then give up', async () => {
    const events = [];
    const sap = makeSap(events, () => ({ type: 'I', message: 'wrong captcha' }));
    const r = await submitBatch(sap, store, [{ item: { SapOrderId: '1' }, bidAmount: '100' }], 'CAP', 1);
    assert.equal(r.ok, false);
    // 1 initial + up to CAPTCHA_MAX_RETRY(3) more = 4 submits max
    const submits = events.filter(e => e === 'submit').length;
    assert.ok(submits >= 2 && submits <= 5, 'bounded retries expected, got ' + submits);
  });

  await test('successful submit marks unit key in submittedKeys', async () => {
    const sap = makeSap([], () => ({ type: 'S' }));
    const keys = new Set();
    await submitPlan(sap, store, [[unit('1')], [unit('2')]], null, keys);
    assert.ok(keys.has('u1') && keys.has('u2'));
  });

  await test('"Same amount bid by other vendor" is treated as SAVED (no resubmit)', async () => {
    const events = [];
    const sap = makeSap(events, () => ({ type: 'E', message: 'Same amount has been bid by other vendor for order  id : 5577213868 and posnr: 11' }));
    const r = await submitBatch(sap, store, [{ item: { SapOrderId: '1' }, bidAmount: '100' }], 'CAP', 1);
    assert.equal(r.ok, true, 'tie notice must be success');
    assert.equal(events.filter(e => e === 'submit').length, 1, 'must NOT resubmit on tie, got ' + JSON.stringify(events));
  });

  console.log('\n──────────────────────────────');
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('──────────────────────────────\n');
  process.exit(fail ? 1 : 0);
})();
