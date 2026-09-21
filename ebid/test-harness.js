#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────
//  Captcha "bug" test harness — empirically prove the strategy.
//
//  SAFE BY DESIGN: submits with an EMPTY order list (NavEBiddingTrackHis=[]),
//  so SAP validates the captcha value WITHOUT placing any real bid.
//    - type "I" (captcha issue)  => captcha REJECTED
//    - type "N"/"S"              => captcha ACCEPTED (no rows to change)
//
//  TEST A (timing):  fetch+solve captcha at T-1000/-300/-200/-100ms, then after
//                    the window opens submit each one -> is a PRE-window captcha
//                    accepted? (also submits a fresh post-open captcha as control)
//  TEST B (reuse):   solve ONE captcha, submit it N times WITHOUT refetching ->
//                    does SAP accept the same static value repeatedly?
//
//  Run:  TEST=A node test-harness.js
//        TEST=B node test-harness.js
//        TEST=both node test-harness.js
// ─────────────────────────────────────────────────────────────────────────
const cfg = require('./lib/config');
const { log } = require('./lib/log');
const { SapClient } = require('./lib/sap');
const { CaptchaStore } = require('./lib/captcha-store');
const solver = require('./lib/solver');
const tu = require('./lib/timeutil');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const which = (process.env.TEST || 'both').toLowerCase();
const N_REUSE = parseInt(process.env.REUSE_COUNT || '4', 10);
const report = [];

// Submit a captcha value with an EMPTY track list (safe probe). Returns type.
async function probe(sap, captchaValue, label) {
  const res = await sap.submit([], captchaValue, false); // [] rows => no bids placed
  const verdict = res.type === 'I' ? 'REJECTED' : (res.type === 'N' || res.type === 'S') ? 'ACCEPTED' : 'OTHER(' + res.type + ')';
  log[verdict === 'ACCEPTED' ? 'ok' : verdict === 'REJECTED' ? 'warn' : 'info'](`${label}: ${verdict} ${res.message ? '— ' + res.message : ''}`);
  report.push({ label, type: res.type, verdict, message: res.message });
  return res.type;
}

async function testA(sap, store, win) {
  log.bold('\n=== TEST A: pre-window captcha timing ===');
  const offsets = [1000, 300, 200, 100]; // ms BEFORE start
  const captured = [];
  for (const off of offsets) {
    while (sap.serverNow() < win.start - off) await sleep(5);
    const img = await sap.fetchCaptcha(true);
    if (!img) { log.warn(`T-${off}ms: SAP returned no captcha (not open yet)`); captured.push({ off, solved: null }); continue; }
    const s = await solver.solve(img, store, cfg, log);
    log.info(`T-${off}ms: captcha fetched, solved=${s ? '"' + s.result + '"' : 'MISS'}`);
    captured.push({ off, solved: s ? s.result : null });
  }
  // wait for open
  while (sap.serverNow() < win.start) await sleep(5);
  log.bold('Window OPEN — submitting captured pre-window captchas (empty track, safe)');
  for (const c of captured) {
    if (!c.solved) { log.warn(`T-${c.off}ms: skipped (no solve)`); continue; }
    await sap.refreshCsrf();
    await probe(sap, c.solved, `pre-window T-${c.off}ms`);
  }
  // control: fresh post-open captcha
  const img = await sap.fetchCaptcha(true);
  const s = img ? await solver.solve(img, store, cfg, log) : null;
  if (s) { await sap.refreshCsrf(); await probe(sap, s.result, 'control fresh post-open'); }
}

async function testB(sap, store, win) {
  log.bold('\n=== TEST B: static captcha reuse ===');
  while (sap.serverNow() < win.start) await sleep(5);
  const img = await sap.fetchCaptcha(true);
  const s = img ? await solver.solve(img, store, cfg, log) : null;
  if (!s) { log.err('Could not solve a captcha to reuse'); return; }
  log.info(`Reusing solved value "${s.result}" ${N_REUSE}x WITHOUT refetching`);
  for (let i = 1; i <= N_REUSE; i++) {
    await sap.refreshCsrf();
    await probe(sap, s.result, `reuse #${i}`);
    await sleep(cfg.RETRY_GAP_MS);
  }
}

async function main() {
  log.bold('CAPTCHA TEST HARNESS (safe: empty-track probes, no real bids)');
  const store = new CaptchaStore(cfg.CAPTCHA_DATA_FILE);
  log.ok(`Captcha pool: ${store.load()} entries`);
  const sap = new SapClient(cfg, log);
  if (!await sap.login()) return log.err('login failed');
  if (!await sap.fetchOrders()) return log.err('fetchOrders failed');
  if (!sap.plantConf) return log.warn('No active slot to test against. Try during/near a real slot.');

  const win = tu.resolveWindow(sap.plantConf, sap.orderListData.NavBidCurrDtDm, sap.clockOffset, cfg.WINDOW_MINUTES);
  const now = sap.serverNow();
  log.info(`Slot window: opens in ${tu.fmtCountdown(win.start - now)}, closes in ${tu.fmtCountdown(win.end - now)} [${win.source}]`);
  if (now >= win.end) return log.warn('Window already closed. Run nearer a slot.');

  if (which === 'a' || which === 'both') await testA(sap, store, win);
  if (which === 'b' || which === 'both') await testB(sap, store, win);

  console.log('\n' + '═'.repeat(50));
  log.bold('HARNESS REPORT');
  console.log('═'.repeat(50));
  for (const r of report) console.log(`  ${r.verdict.padEnd(10)} ${r.label}  ${r.message || ''}`);
  console.log('═'.repeat(50));
  log.info('Interpretation:');
  log.info('  Test A: if pre-window captchas show ACCEPTED, you can pre-solve before T=0.');
  log.info('  Test B: if reuse #2+ show ACCEPTED, a static captcha can be reused across batches.');
  process.exit(0);
}

main().catch(e => { log.err('Harness fatal: ' + e.message); process.exit(1); });
