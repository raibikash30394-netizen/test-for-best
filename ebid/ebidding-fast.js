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
  let captchaTries = 0;
  for (let attempt = 1; attempt <= cfg.CAPTCHA_MAX_RETRY + 2; attempt++) {
    const res = await sap.submit(rows, cap, cfg.DRY_RUN);
    if (res.type === 'DRY') { log.warn(`[DRY] batch ${batchNo}: would submit ${res.rows} rows`); return { ok: true, res }; }
    if (res.type === 'S' || res.type === 'N') {
      log.ok(`✅ batch ${batchNo} SUBMITTED (${res.type})${res.message ? ': ' + res.message : ''}`);
      return { ok: true, res };
    }
    const msg = (res.message || '').toLowerCase();

    // TIE = your bid IS saved (covers "Same amount…" and "Same Avg amount…").
    if (msg.includes('amount has been bid by other vendor')) {
      log.ok(`✅ batch ${batchNo} SAVED (tie: same amount as other vendor(s) — fastest wins)`);
      return { ok: true, res };
    }

    // POLLING: any captcha-not-accepted response (wrong value, validation failed,
    // or the transient "Contact Administrator" lock) => fetch a FRESH captcha and
    // re-submit. The first captcha at open is often rejected; a fresh one moments
    // later works, so we keep polling until SAP accepts.
    const hardLock = msg.includes('contact administrator');
    const captchaNotAccepted = res.type === 'I' || hardLock ||
      msg.includes('captcha validation failed') || msg.includes('wrong captcha') || msg.includes('worng captcha');
    if (captchaNotAccepted) {
      captchaTries++;
      if (captchaTries > cfg.CAPTCHA_MAX_RETRY) {
        log.err(`batch ${batchNo}: captcha not accepted after ${cfg.CAPTCHA_MAX_RETRY} polls — will retry next window poll`);
        return { ok: false, res, retryable: true };
      }
      const gap = hardLock ? Math.max(cfg.RETRY_GAP_MS, 1200) : cfg.RETRY_GAP_MS;
      log.warn(`batch ${batchNo}: captcha not accepted (poll ${captchaTries}/${cfg.CAPTCHA_MAX_RETRY})${hardLock ? ' [lock, waiting]' : ''} — re-polling fresh captcha...`);
      await sleep(gap);
      cap = await solver.fetchAndSolve(sap, store, cfg, log, 3);
      if (!cap) return { ok: false, res: { type: 'E', message: 'no captcha on retry' }, retryable: true };
      continue;
    }

    if (res.type === 'E') {
      if (res.status === 403) { await sap.refreshCsrf(); continue; }
      // Terminal business rule (e.g. "Reduce your bid by minimum Rs X"). We do NOT
      // change the CSV amount (hard limit), so this order can't be saved this
      // window — mark terminal so the watch-loop stops retrying it.
      log.err(`batch ${batchNo} business rejection (skipping this window): ${res.message}`);
      return { ok: false, res, retryable: false };
    }
  }
  return { ok: false, res: { type: 'E', message: 'max retries' }, retryable: true };
}

// ── SEQUENTIAL submit: SAP binds ONE captcha per session, so batch N+1's captcha
// is fetched only AFTER batch N is fully submitted.
async function submitPlan(sap, store, plan, prefetched, submittedKeys, failedKeys) {
  submittedKeys = submittedKeys || new Set();
  failedKeys = failedKeys || new Set();
  log.bold(`Submitting ${plan.length} batch(es) — sequential (one fresh captcha per batch)`);

  for (let i = 0; i < plan.length; i++) {
    const rows = batchRows(plan[i]);
    applyBidAmounts(rows);
    // Fetch + solve THIS batch's captcha now — never overlaps another batch.
    const cap = (i === 0 && prefetched) ? prefetched : await solver.fetchAndSolve(sap, store, cfg, log);
    if (!cap) { log.err(`batch ${i + 1}: no captcha (pool-miss) — skipping, will retry next poll`); continue; }
    const r = await submitBatch(sap, store, rows, cap, i + 1);
    if (r.ok) for (const u of plan[i]) submittedKeys.add(u.key);
    else if (r.retryable === false) for (const u of plan[i]) failedKeys.add(u.key); // terminal: don't retry this window
  }
  return submittedKeys;
}

// ── Log which matching orders exist (priority-tagged) ─────────────────────
function logMatched(matched, submittedKeys, plan, openWindow) {
  submittedKeys = submittedKeys || new Set();
  if (!matched.length) return;
  const pend = matched.filter(m => !submittedKeys.has(unitKey(m.item))).length;
  log.bold(`📋 ${matched.length} matching order(s)${openWindow ? ' [WINDOW OPEN]' : ' [ready]'} — ${pend} pending, ${matched.length - pend} saved`);
  for (const m of matched) {
    const it = m.item;
    const done = submittedKeys.has(unitKey(it));
    const vip = String(it.Spi).trim() === '1164';
    const grp = it.ClubId ? `club ${it.ClubId}` : 'single';
    log[done ? 'ok' : 'info'](`   ${done ? '✔ saved ' : '• ready '}${vip ? '⭐1164 ' : '      '}${it.SapOrderId} | ${it.DestCityDesc} / SPI ${it.Spi} | ${grp} | bid ${m.bidAmount}`);
  }
  if (plan) log.info(`   → ${plan.length} batch(es) planned (order: 1164 → singles → clubs)`);
}

// ── Phase A: pre-window monitor. Keep fetching orders while the window is
// CLOSED, match + build the batch plan ready, log matches. Near open, poll the
// captcha endpoint to catch the exact moment SAP opens and prewarm batch-1.
async function preWindowMonitor(sap, store, csv, w) {
  const ist = ms => new Date(ms + 330 * 60000).toISOString().substring(11, 19);
  const lead = cfg.CAPTCHA_PREFETCH_MS;   // 0 = don't prewarm; fetch captcha at T=0 (recommended)
  const spin = Math.max(lead, 2500);       // stop heavy order-fetch this early; just spin to hit T=0 exactly
  let reloggedIn = false, prefetched = null, lastSig = null;
  let lastMatched = matchRows(csv.csvData, csv.deleteList, sap.bidRows);
  log.info(`Monitoring for orders while window is CLOSED... (captcha prefetch: ${lead ? lead + 'ms before open' : 'OFF — fetch at T=0'})`);
  while (sap.serverNow() < w.start) {
    const remain = w.start - sap.serverNow();
    if (remain <= 60000 && !reloggedIn) { process.stdout.write('\n'); await sap.login(); reloggedIn = true; log.info('Re-logged in (T-60s), session warm'); }

    // Prewarm captcha at the configured lead (only if enabled). NOTE: SAP has
    // been observed to REJECT pre-window captchas — keep lead=0 unless testing.
    if (lead > 0 && remain <= lead && !prefetched) {
      const img = await sap.fetchCaptcha(true);
      if (img) {
        const s = await solver.solve(img, store, cfg, log);
        prefetched = s ? s.result : null;
        process.stdout.write('\n');
        log.ok(`Captcha prefetched at T-${remain}ms${prefetched ? ' -> "' + prefetched + '"' : ' (pool-miss)'}`);
        // Hand off NOW so the submit loop can fire at T - SUBMIT_LEAD_MS (early).
        if (prefetched) return { prefetched, matched: lastMatched };
      }
    }

    // In the final `spin` window, poll tightly (no order fetch) so we exit exactly at T=0.
    if (remain <= spin) { await sleep(cfg.CAPTCHA_POLL_MS); continue; }

    // Otherwise: fetch fresh orders, match, keep plan ready, log on change.
    await sap.fetchOrders();
    lastMatched = matchRows(csv.csvData, csv.deleteList, sap.bidRows);
    const sig = lastMatched.map(m => m.item.SapOrderId).sort().join(',');
    if (sig !== lastSig) {
      process.stdout.write('\n');
      const plan = planBatches(lastMatched, cfg.MAX_ROWS_PER_BATCH);
      if (lastMatched.length) logMatched(lastMatched, new Set(), plan, false);
      else { log.warn('No matching orders yet — diagnostics:'); diagnoseMatch(csv.csvData, csv.deleteList, sap.bidRows, log); }
      lastSig = sig;
    }
    process.stdout.write(`\r  ⏳ window opens ${ist(w.start)} IST (in ${tu.fmtCountdown(remain)}) | ${lastMatched.length} match ready   `);
    const wait = Math.min(cfg.ORDER_POLL_MS_CLOSED, remain - spin);
    await sleep(Math.max(50, wait));
  }
  process.stdout.write('\n');
  return { prefetched, matched: lastMatched };
}

// ── Phase B: at T=0 FIRE the pre-computed plan INSTANTLY (no fetch first, so we
// beat the 14 vendors), then keep fetching for NEW/late orders and submit them.
async function windowSubmitLoop(sap, store, csv, w, prefetched, preMatched) {
  const submittedKeys = new Set();
  const failedKeys = new Set(); // terminal business rejections — skip for this window

  // ⚡ INSTANT FIRE at T=0 (or SUBMIT_LEAD_MS early if captcha already prewarmed).
  if (preMatched && preMatched.length) {
    // Fire early only when we hold a prewarmed captcha; else wait for exact open.
    const fireAt = prefetched ? w.start - cfg.SUBMIT_LEAD_MS : w.start;
    while (sap.serverNow() < fireAt) await sleep(1);
    const plan = planBatches(preMatched, cfg.MAX_ROWS_PER_BATCH);
    const capMode = prefetched ? `prefetched captcha, fire ${cfg.SUBMIT_LEAD_MS}ms early` : 'fetch captcha now (fresh at open)';
    log.bold(`⚡ T=0 INSTANT FIRE — ${preMatched.length} pre-matched order(s), ${plan.length} batch(es) [${capMode}]`);
    logMatched(preMatched, submittedKeys, plan, true);
    await submitPlan(sap, store, plan, prefetched, submittedKeys, failedKeys);
  } else {
    log.info('No pre-matched orders — will fetch at open.');
  }

  // Watch for new/late orders for the rest of the window.
  let lastSig = null;
  while (sap.serverNow() < w.end) {
    if (!await sap.fetchOrders()) { await sleep(cfg.ORDER_POLL_MS_OPEN); continue; }
    const matched = matchRows(csv.csvData, csv.deleteList, sap.bidRows);
    const pending = matched.filter(m => {
      const k = unitKey(m.item);
      return !submittedKeys.has(k) && !failedKeys.has(k);
    });

    const sig = matched.map(m => m.item.SapOrderId).sort().join(',') + '|' + submittedKeys.size + '|' + failedKeys.size;
    if (sig !== lastSig) { logMatched(matched, submittedKeys, null, true); lastSig = sig; }

    if (pending.length) {
      const plan = planBatches(pending, cfg.MAX_ROWS_PER_BATCH);
      log.bold(`⚡ ${pending.length} new/pending order(s) -> submitting ${plan.length} batch(es) now`);
      await submitPlan(sap, store, plan, null, submittedKeys, failedKeys);
    } else {
      const left = w.end - sap.serverNow();
      const skip = failedKeys.size ? `, ${failedKeys.size} skipped` : '';
      process.stdout.write(`\r  🟢 window OPEN — watching for new orders (${tu.fmtCountdown(left)} left${skip})   `);
    }
    await sleep(cfg.ORDER_POLL_MS_OPEN);
  }
  process.stdout.write('\n');
  return submittedKeys;
}

// ── One full cycle ────────────────────────────────────────────────────────
async function runCycle(sap, store) {
  if (!await sap.login()) { await sleep(5000); return { status: 'retry' }; }
  if (!await sap.fetchOrders()) { await sleep(5000); return { status: 'retry' }; }
  const csv = loadCsvFiles(cfg, log);
  if (!csv) { await sleep(5000); return { status: 'retry' }; }

  const w = tu.resolveWindow(sap.plantConf, sap.orderListData.NavBidCurrDtDm, sap.clockOffset,
    cfg.WINDOW_MINUTES, { source: cfg.WINDOW_SOURCE, durationMin: cfg.WINDOW_DURATION_MIN });
  const ist = ms => new Date(ms + 330 * 60000).toISOString().substring(11, 19);
  const now = sap.serverNow();
  log.info(`Next window [${w.source}] opens ${ist(w.start)} IST (in ${tu.fmtCountdown(w.start - now)}), closes ${ist(w.end)} IST`);
  if (w.plantStart != null && w.source === 'computed') log.info(`   (plantConf reported ${ist(w.plantStart)} IST — ignored, using IST :15/:45)`);

  // Initial match snapshot.
  const matched0 = matchRows(csv.csvData, csv.deleteList, sap.bidRows);
  if (matched0.length) logMatched(matched0, new Set(), planBatches(matched0, cfg.MAX_ROWS_PER_BATCH), false);
  else { log.warn('No CSV matches yet — diagnostics:'); diagnoseMatch(csv.csvData, csv.deleteList, sap.bidRows, log); }

  if (cfg.DRY_RUN) {
    log.bold('=== DRY RUN: captcha fetch/solve only, no submit ===');
    const cap = await solver.fetchAndSolve(sap, store, cfg, log, 5);
    log[cap ? 'ok' : 'warn'](cap ? `Captcha solved: "${cap}"` : 'No captcha solved (pool-miss or window closed)');
    if (matched0.length) await submitPlan(sap, store, planBatches(matched0, cfg.MAX_ROWS_PER_BATCH), cap, new Set());
    log.bold('=== DRY RUN COMPLETE ===');
    return { status: 'dry', window: w };
  }

  if (now >= w.end) { log.warn('Window already closed. Waiting for next slot...'); await sleep(2000); return { status: 'expired', window: w }; }

  // Phase A — pre-window: keep polling for orders, build plan ready.
  let prefetched = null, preMatched = matched0;
  if (sap.serverNow() < w.start) {
    const pre = await preWindowMonitor(sap, store, csv, w);
    prefetched = pre.prefetched;
    preMatched = pre.matched;
  }

  // Phase B — window OPEN: INSTANT fire at T=0, then watch for late orders.
  log.bold('🚀 WINDOW OPEN — instant fire + watching for new orders');
  const submitted = await windowSubmitLoop(sap, store, csv, w, prefetched, preMatched);
  log.bold(`Window done — ${submitted.size} order-unit(s) submitted this slot`);

  flushDeferred(store, csv);
  if (await sap.fetchOrders()) reportRanks(sap);
  return { status: 'active', window: w };
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
