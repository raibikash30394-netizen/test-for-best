# SAP E-Bidding Bot — Fast & Reliability Hardened

Refactor of the original obfuscated `ebidding-secure.js` into a clean, fast,
pre-warmed pipeline. Core stays **Node.js** (axios + tough-cookie). Same SAP
endpoints & payloads — so live bids keep working — with the speed/correctness
fixes below.

## ⚠️ Critical finding: a hidden time-bomb in the old script
The original `checkLocalCaptchaCache()` had this (deobfuscated):

```js
if (new Date() >= new Date("2026-07-23")) {
  Math.random() < 0.4 ? resolve("Redo")      // <-- fails 40% of the time
                      : resolve(cachedResult);
}
```

After **23 July 2026** the cached captcha would randomly return `"Redo"` **40%
of the time**, forcing captcha "failures" for no reason. This is almost
certainly the "bug" you suspected. **It is completely removed** in the new
code — captcha lookups are now deterministic (`lib/captcha-store.js`). Also
removed: the old code fired the paid TrueCaptcha API on *every* solve (even on
pool hits). It's now **pool-only** (external fallback OFF by default).

## What makes it fast (Phase A pre-warm → Phase B fire at T=0)
- **Keep-alive + cookie agent** (`HttpsCookieAgent`) → TLS handshake reused for
  the whole run.
- **Clock-sync from SAP** `Date` response header → exact server time, next
  window computed in UTC (IST = UTC+5:30, no DST).
- **Batch plan pre-computed** before the window; re-fetched & re-planned once at
  T=0 (orders often activate only when the window opens — this is the old
  "window bug").
- **Captcha pipeline**: batch N+1's captcha is fetched+solved *while* batch N is
  in flight. Pool hit = ~0 ms.
- **Tight adaptive retry** (default 20 ms) instead of the old 10–15 s sleeps.
  Wrong captcha → new captcha instantly.
- **Deferred disk I/O**: new captcha solves + CSV bid auto-fixes are written
  **after** the window, never during the critical moment.

## Batching & priority engine (`lib/batching.js`, strict rules)
1. Each order → a **unit**: single = size 1; club-group (same `ClubId`) = atomic
   unit of 2 or 3. Two different club groups never share a batch.
2. Priority order: **1164-SPI units first** (single or club) → then remaining
   **singles** (single-first) → then remaining **club groups**.
3. 3-row hard limit. Club-of-3 → own batch. **Club-of-2 tops up with one
   leftover single** → dense batch of 3 (your chosen option → fewer captchas).
4. Leftover 1–2 singles → partial batch allowed.

Fully unit-tested (`npm test`, 19 cases) with no SAP needed.

## Captcha test harness (`test-harness.js`, SAFE)
Submits with an **empty order list** so SAP validates the captcha **without
placing any real bid**:
- `TEST=A` — fetch+solve at T-1000/-300/-200/-100 ms, submit after open →
  is a *pre-window* captcha accepted?
- `TEST=B` — solve one captcha, resubmit it N times without refetching →
  does SAP accept a *static reused* value?
Run near/inside a real slot from your Mumbai box.

## Commands
```bash
npm install
npm test                 # engine unit tests (offline)
npm run dry              # DRY_RUN: login+fetch+solve, NO submit
npm start                # live daemon
TEST=A npm run harness   # captcha timing probe
TEST=B npm run harness   # captcha reuse probe
```

## New `.env` knobs (see `.env.example`)
`PREWARM_LEAD_MS`, `SUBMIT_LEAD_MS`, `CAPTCHA_POLL_MS`, `RETRY_GAP_MS`,
`WINDOW_MINUTES=15,45`, `MAX_ROWS_PER_BATCH=3`, `MAX_PARALLEL_BATCHES=1`
(safe sequential-pipeline), `CAPTCHA_API_FALLBACK=false`, `CAPTCHA_DATA_FILE`.

## Notes / flags
- **Must run from your whitelisted AWS Mumbai IP.** The SAP host sits behind an
  AppTrana WAF that returns HTTP 406 ("suspicious behavior") for non-whitelisted
  IPs — so it can't be reached from a generic cloud IP (that's why live tests
  must run on your box / the real test window).
- `MAX_PARALLEL_BATCHES=1` (sequential-pipeline) is the safe default. Only raise
  it after Test B confirms SAP tolerates concurrent submits / token reuse.
- Security: `NODE_TLS_REJECT_UNAUTHORIZED=0` is kept from the original
  (self-signed cert) — ideally install a proper CA cert. Credentials live in
  `.env` (plain) — keep that file protected in production.
- The `Freight`/`ClubFreight` mapping in the submit payload is intentionally the
  **same** as the original working script — do not "fix" it.

Original obfuscated script kept as `ebidding-secure.js` (backup).
