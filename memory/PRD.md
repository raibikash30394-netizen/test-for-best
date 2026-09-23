# PRD — SAP E-Bidding Bot: Speed & Reliability Hardening

## Problem
Optimize the existing obfuscated Node.js bot (`ebidding-secure.js`) that auto-submits
bids into SAP e-bidding windows (IST :15 & :45 hourly, SAP time is GMT). Goals: faster
order fetch+submit, reliable fire at window-open, near-instant captcha via a 162-image
pool, strict batching/priority rules, submit before 14 vendors.

## Environment / facts
- Runs from AWS Mumbai (ap-south-1); SAP host behind AppTrana WAF (IP-whitelisted).
- SAP OData service: `ZVC_TRANSPORTER_SRV`. Basic auth + CSRF token.
- Hard limit: max 3 rows/batch. Captcha demanded fresh per batch; 162 fixed pool
  (sha256(base64) → result). 1164 SPI = absolute top priority.

## User decisions (locked)
- Group-of-2 club unit: **top-up with a leftover single** (batch of 3).
- **Sequential-pipeline** default (MAX_PARALLEL_BATCHES=1).
- Test harness verified on a **real window**.
- **No external captcha solver** — pool-only.
- Max speed priority.

## Key discovery
- Deobfuscated the script; found a deliberate **time-bomb**: after 2026-07-23 the cached
  captcha returns "Redo" 40% at random (sabotage) → removed. Also the old code always
  called the paid TrueCaptcha API even on pool hits → removed.

## Architecture (implemented)
- `lib/config.js` env + new knobs; `lib/log.js` logger.
- `lib/sap.js` SAP client (keep-alive + cookie agent, clock-sync from Date header,
  login/csrf, fetchOrders, fetchCaptcha, submit). Endpoints/payloads preserved.
- `lib/captcha-store.js` in-memory Map, deterministic lookup, deferred disk flush.
- `lib/batching.js` priority/packing engine (1164-first, single-first, club-atomic,
  club-2 top-up, 3-row cap).
- `lib/csvmatch.js` CSV parse + match (City/SPI) + delete-list.
- `lib/timeutil.js` SAP date/time parse, clock offset, IST↔UTC window math.
- `lib/solver.js` pool-first solve + optional fallback (off).
- `ebidding-fast.js` orchestrator: prewarm → wait/poll window-open → fresh fetch &
  re-plan at T=0 → sequential-pipelined submit with tight retry → deferred flush →
  rank report. Double-instance lockfile.
- `test-harness.js` safe captcha probes (Test A timing, Test B reuse; empty-track).
- `test/test-engine.js` 19 offline unit tests.

## Status (2026-06)
- ✅ Engine + captcha store + time math: 20/20 unit tests pass.
- ✅ Submit path (mock SAP): 6/6 tests — SEQUENTIAL captcha verified.
- ✅ Daemon boots, loads pool/CSV, wiring validated; SAP calls identical to original.
- ✅ LIVE VERIFIED on user's Mumbai box: window timing correct (IST :15/:45), T=0 instant
  fire ~372ms, priority (1164-first) correct, multiple orders saved across a window.

## Live-tested findings & fixes (from user's real windows)
- Captcha "bug" PROVEN: SAP REJECTS pre-window (prefetched) captchas — only the
  captcha issued after open is valid. Added `CAPTCHA_PREFETCH_MS` (default 0 = fetch
  fresh at T=0); user can experiment with 200/300/500.
- Window timing bug: old code trusted plantConf slot (gave 22:15 UTC vs 22:15 IST).
  Now computes IST :15/:45 -> UTC (WINDOW_SOURCE=computed default).
- Captcha clobber bug: parallel pipeline fetched batch N+1's captcha while batch N was
  submitting -> SAP (one captcha per session) rejected -> "Captcha Validation Failed.
  Please Contact Administrator." Fixed: submitPlan is now STRICTLY SEQUENTIAL.
  Added CAPTCHA_MAX_RETRY (3) + hard-lock backoff (no retry storm).
- Continuous polling: fetch+match+plan while window CLOSED; keep fetching for NEW/late
  orders while OPEN and submit them immediately. Pre-window heavy fetch stops ~2.5s
  before open so instant-fire hits true T=0.

## Backlog / next
- DONE: tie messages ("Same amount"/"Same Avg amount") = SAVED (no resubmit).
- DONE: terminal business rejections ("Reduce your bid by Rs X") = skip for the window
  (failedKeys) — no more infinite retry loop.
- DONE: "Wrong Captcha Value" = instant retry (not hard-lock); only "Contact Administrator"
  backs off. CAPTCHA_PREFETCH_MS default 50 (proven), SUBMIT_LEAD_MS repurposed as
  early-fire lead (default 0).
- P2: SAP sub-second clock sync (HTTP Date header is 1s-resolution; 50ms prefetch already
  compensates empirically).
- P3 (optional): React+FastAPI live status/log dashboard.
- P3: replace NODE_TLS_REJECT_UNAUTHORIZED=0 with a proper CA cert.
