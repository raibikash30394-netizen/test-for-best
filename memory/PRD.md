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
- ✅ Engine + captcha store + time math: 19/19 unit tests pass.
- ✅ Daemon boots, loads pool/CSV, wiring validated; SAP calls identical to original.
- ⏳ Live e2e NOT verifiable from this container (WAF 406 blocks non-Mumbai IP).
  Must be run/verified on the user's AWS Mumbai box or the promised real test window.

## Backlog / next
- P1: Run `TEST=A`/`TEST=B` harness on real window → decide pre-solve & static-reuse.
- P2: If Test B confirms concurrency-safe, raise MAX_PARALLEL_BATCHES.
- P2: Persist CSV bid auto-fixes to disk (currently in-memory + logged).
- P3 (optional): small React+FastAPI live status/log dashboard.
- P3: replace NODE_TLS_REJECT_UNAUTHORIZED=0 with a proper CA cert.
