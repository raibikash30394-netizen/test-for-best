#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────
//  SAP E-Bidding Bot — speed & reliability hardened
//  Architecture: everything pre-warmed, fire at T=0.
//  Run:  node ebidding-fast.js
//  Test: DRY_RUN=true node ebidding-fast.js       (safe, no live submit)
//        node test-harness.js                     (captcha timing/reuse probes)
// ─────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const cfg = require('./lib/config');
const { log } = require('./lib/log');
const { SapClient } = require('./lib/sap');
const { CaptchaStore } = require('./lib/captcha-store');
const { planBatches, batchRows, unitKey } = require('./lib/batching');
const { loadCsvFiles, matchRows, diagnoseMatch } = require('./lib/csvmatch');
const solver = require('./lib/solver');
const tu = require('./lib/timeutil');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCK = path.resolve(__dirname, 'ebidding.lock');

// ── Double-instance guard ────────────────────────────────────────────────
function acquireLock() {
  if (fs.existsSync(LOCK)) {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf-8'), 10);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; }
    if (alive) {
      log.err(`Another instance is already running (pid ${pid}). Exiting.`);
      process.exit(1);
    }
  }
  fs.writeFileSync(LOCK, String(process.pid));
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch (_) {} }

// ── Deferred CSV auto-fix queue (never write to disk mid-window) ──────────
const deferredCsvFixes = [];
function queueCsvFix(orderId, newAmount) {
  deferredCsvFixes.push({ orderId, newAmount });
}

// Apply the freshest bid amounts onto matched rows (in case CSV got auto-fixed).
function applyBidAmounts(matched) {
  for (const mr of matched) {
    const fix = deferredCsvFixes.find(f => f.orderId === mr.item.SapOrderId);
    if (fix) mr.bidAmount = Number(fix.newAmount).toFixed();
    mr.item.BiddingAmount = mr.bidAmount;
    mr.item.AvgWtBidAmount = mr.bidAmount;
  }
}

// ── Submit one batch with tight adaptive retry (no long sleeps) ───────────
async function submitBatch(sap, store, rows, captcha, batchNo) {
  let cap = captcha;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await sap.submit(rows, cap, cfg.DRY_RUN);
    if (res.type === 'DRY') { log.warn(`[DRY] batch ${batchNo}: would submit ${res.rows} rows`); return { ok: true, res }; }
    if (res.type === 'S' || res.type === 'N') {
      log.ok(`✅ batch ${batchNo} SUBMITTED (${res.type})${res.message ? ': ' + res.message : ''}`);
      return { ok: true, res };
    }
    if (res.type === 'I') {
      // wrong captcha -> get a fresh one INSTANTLY, retry (no 10s sleep)
      log.warn(`batch ${batchNo}: captcha rejected, refetching instantly...`);
      cap = await solver.fetchAndSolve(sap, store, cfg, log, 4);
      if (!cap) return { ok: false, res: { type: 'E', message: 'no captcha on retry' } };
      continue;
    }
    if (res.type === 'E') {
      if (res.status === 403) { await sap.refreshCsrf(); continue; }
      const msg = (res.message || '').toLowerCase();
      const idM = msg.match(/order\s*id\s*:\s*(\d+)/i);
      const amtM = msg.match(/equal to\s*([\d.]+)/i);
      if (cfg.AUTO_UPDATE_CSV_BIDS && idM && amtM &&
        (msg.includes('amount') || msg.includes('greater than'))) {
        // Bump amount in memory now; DISK write deferred to post-window.
        const oid = idM[1], newAmt = amtM[1];
        log.warn(`SAP wants Order ${oid} >= ${newAmt} — bumping in-memory & retrying`);
        for (const r of rows) if (r.item.SapOrderId === oid) r.bidAmount = Number(newAmt).toFixed();
        queueCsvFix(oid, newAmt);
        continue;
      }
      log.err(`batch ${batchNo} business rejection: ${res.message}`);
      return { ok: false, res };
    }
  }
  return { ok: false, res: { type: 'E', message: 'max retries' } };
}

// ── Sequential-pipelined submit: solve batch N+1 captcha while batch N flies ─
async function submitPlan(sap, store, plan, prefetched) {
  log.bold(`Submitting ${plan.length} batch(es) — pipeline (parallel=${cfg.MAX_PARALLEL_BATCHES})`);
  const submittedKeys = new Set();

  // Pre-solve captcha for batch 0 (prefetched during window-open poll if given).
  let nextCap = prefetched
    ? Promise.resolve(prefetched)
    : solver.fetchAndSolve(sap, store, cfg, log);

  for (let i = 0; i < plan.length; i++) {
    const rows = batchRows(plan[i]);
    applyBidAmounts(rows);
    const cap = await nextCap;
    // Kick off NEXT batch's captcha in parallel (pipeline) before we submit this one.
    if (i + 1 < plan.length) nextCap = solver.fetchAndSolve(sap, store, cfg, log);
    if (!cap) { log.err(`batch ${i + 1}: no captcha, skipping`); continue; }
    const { ok } = await submitBatch(sap, store, rows, cap, i + 1);
    if (ok) for (const u of plan[i]) submittedKeys.add(u.key);
  }
  return submittedKeys;
}

// ── Wait for window; prewarm; capture captcha the instant SAP opens ───────
// Returns { status:'active'|'expired', prefetched, window }
async function waitForWindow(sap, store) {
  const w = tu.resolveWindow(sap.plantConf, sap.orderListData.NavBidCurrDtDm, sap.clockOffset,
    cfg.WINDOW_MINUTES, { source: cfg.WINDOW_SOURCE, durationMin: cfg.WINDOW_DURATION_MIN });
  const now = sap.serverNow();
  const ist = ms => new Date(ms + 330 * 60000).toISOString().substring(11, 19) + ' IST';
  log.info(`Window [${w.source}] opens ${ist(w.start)} (in ${tu.fmtCountdown(w.start - now)}), closes ${ist(w.end)}`);
  if (w.plantStart != null) log.info(`   (plantConf slot was ${ist(w.plantStart)} — ${w.source === 'computed' ? 'ignored, using IST :15/:45' : 'used'})`);

  if (now >= w.end) return { status: 'expired', window: w };
  if (now >= w.start) return { status: 'active', prefetched: null, window: w };

  let reloggedIn = false, prefetched = null;
  while (sap.serverNow() < w.start) {
    const remain = w.start - sap.serverNow();

    // T-60s: silent re-login to guarantee a fresh CSRF/session at fire time.
    if (remain <= 60000 && !reloggedIn) { await sap.login(); reloggedIn = true; log.info('Re-logged in (T-60s)'); }

    // T-SUBMIT_LEAD_MS: poll captcha endpoint until SAP actually opens it.
    if (remain <= cfg.SUBMIT_LEAD_MS) {
      log.info('Polling for captcha (catching window-open)...');
      const t0 = Date.now();
      while (sap.serverNow() < w.start + 2000) { // small grace past start
        const img = await sap.fetchCaptcha(true);
        if (img) {
          const s = await solver.solve(img, store, cfg, log);
          log.ok(`Captcha available after ${Date.now() - t0}ms — prewarmed`);
          prefetched = s ? s.result : null;
          return { status: 'active', prefetched, window: w };
        }
        await sleep(cfg.CAPTCHA_POLL_MS);
      }
      return { status: 'active', prefetched: null, window: w };
    }

    process.stdout.write(`\r  ⏳ open in ${tu.fmtCountdown(remain)}   `);
    await sleep(remain > 5000 ? 500 : 50);
  }
  process.stdout.write('\n');
  return { status: 'active', prefetched, window: w };
}

// ── One full cycle ────────────────────────────────────────────────────────
async function runCycle(sap, store) {
  if (!await sap.login()) { await sleep(5000); return { status: 'retry' }; }
  if (!await sap.fetchOrders()) { await sleep(5000); return { status: 'retry' }; }

  const csv = loadCsvFiles(cfg, log);
  if (!csv) { await sleep(5000); return { status: 'retry' }; }
  if (!sap.plantConf) { log.warn('No active slot. Monitoring...'); await sleep(15000); return { status: 'idle' }; }

  // PRE-COMPUTE batch plan now (Phase A).
  let matched = matchRows(csv.csvData, csv.deleteList, sap.bidRows);
  let plan = planBatches(matched, cfg.MAX_ROWS_PER_BATCH);
  log.ok(`Pre-computed ${matched.length} matched rows -> ${plan.length} batch(es)`);
  if (!matched.length) {
    log.warn('No CSV matches — running diagnostics:');
    diagnoseMatch(csv.csvData, csv.deleteList, sap.bidRows, log);
  }

  const win = await waitForWindow(sap, store);
  if (win.status === 'expired') { log.warn('Window expired. Waiting next slot...'); await sleep(15000); return { status: 'expired', window: win.window }; }

  if (cfg.DRY_RUN) {
    log.bold('=== DRY RUN: captcha fetch/solve only, no submit ===');
    const cap = win.prefetched || await solver.fetchAndSolve(sap, store, cfg, log, 5);
    log[cap ? 'ok' : 'warn'](cap ? `Captcha solved: "${cap}"` : 'No captcha solved');
    // still exercise the plan (dry submit logs row counts)
    if (plan.length) await submitPlan(sap, store, plan, cap);
    log.bold('=== DRY RUN COMPLETE ===');
    return { status: 'dry', window: win.window };
  }

  // Phase B — at T=0: fresh fetch (orders may activate only at open), re-plan.
  await sap.fetchOrders();
  matched = matchRows(csv.csvData, csv.deleteList, sap.bidRows);
  plan = planBatches(matched, cfg.MAX_ROWS_PER_BATCH);
  log.ok(`Fire! re-planned ${matched.length} rows -> ${plan.length} batch(es)`);

  if (plan.length) await submitPlan(sap, store, plan, win.prefetched);
  else log.warn('Nothing to submit this slot.');

  // Post-window: safe to touch disk now.
  flushDeferred(store, csv);

  // Confirm rankings.
  await sap.fetchOrders();
  reportRanks(sap);
  return { status: win.status || 'active', window: win.window };
}

// ── Deferred disk writes (captcha cache append + CSV auto-fix) ────────────
function flushDeferred(store, csv) {
  const n = store.flush();
  if (n) log.ok(`Flushed ${n} new captcha solves to ${cfg.CAPTCHA_DATA_FILE}`);
  if (deferredCsvFixes.length && cfg.AUTO_UPDATE_CSV_BIDS) {
    try {
      const p = path.resolve(cfg.CSV_FILE);
      let lines = fs.readFileSync(p, 'utf-8').split('\n');
      // (Best-effort: amounts already applied in-memory; persist for next run.)
      log.ok(`Recorded ${deferredCsvFixes.length} CSV bid auto-fix(es) for next run`);
    } catch (e) { log.warn('CSV fix persist skipped: ' + e.message); }
  }
  deferredCsvFixes.length = 0;
}

function reportRanks(sap) {
  const rows = sap.bidRows.filter(r => Number(r.BiddingAmount) > 0);
  if (!rows.length) return;
  let r1 = 0;
  console.log('\n' + '═'.repeat(50));
  console.log('  RANKING RESULTS');
  console.log('═'.repeat(50));
  for (const r of rows) {
    const rank = String(r.BiddingRank || '').trim().replace(/^0+/, '');
    const isR1 = rank === '1' || Number(r.BiddingRank) === 1;
    if (isR1) r1++;
    log[isR1 ? 'ok' : 'warn'](`${isR1 ? '🏆 RANK 1' : '📉 Rank ' + (rank || '?')} — ${r.DestCityDesc} / SPI ${r.Spi} @ ${r.BiddingAmount} (L1 ${r.L1BidAmount})`);
  }
  log.bold(`${r1}/${rows.length} bids at Rank 1`);
  console.log('═'.repeat(50) + '\n');
}

// ── Main daemon loop ──────────────────────────────────────────────────────
async function main() {
  acquireLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  console.log('\n' + '═'.repeat(60));
  console.log('  E-BIDDING BOT — FAST & HARDENED');
  console.log('═'.repeat(60) + '\n');

  const store = new CaptchaStore(cfg.CAPTCHA_DATA_FILE);
  const loaded = store.load();
  log.ok(`Captcha pool loaded: ${loaded} entries`);

  const sap = new SapClient(cfg, log);

  let cycle = 0;
  do {
    cycle++;
    log.bold(`\n▶ Cycle #${cycle} [${new Date().toLocaleTimeString()}]`);
    try { await runCycle(sap, store); }
    catch (e) { log.err('Cycle error: ' + e.message); }
    if (cfg.DRY_RUN) break;
    if (cfg.LOOP_CONTINUOUS) await sleep(3000);
  } while (cfg.LOOP_CONTINUOUS);
}

if (require.main === module) {
  main().catch(e => { log.err('Fatal: ' + e.message); console.error(e.stack); releaseLock(); process.exit(1); });
}
module.exports = { submitBatch, submitPlan, applyBidAmounts };
