'use strict';
// Captcha solver: pool-first, near-instant. Optional external fallback (OFF by
// default per requirement). NO time-bomb, NO random "Redo" sabotage.
const axios = require('axios');

// Solve a base64 captcha image. Returns { result, fromPool } or null.
async function solve(imageB64, store, cfg, log) {
  const hit = store.lookup(imageB64);
  if (hit.result) return { result: hit.result, fromPool: true };

  if (!cfg.CAPTCHA_API_FALLBACK) {
    log && log.warn(`Captcha pool-miss (hash ${hit.hash.substring(0, 10)}...) — no external fallback enabled`);
    return null;
  }
  // Optional external fallback (only if explicitly enabled + creds provided).
  try {
    const clean = imageB64.replace(/^data:image\/(png|jpg|jpeg|gif);base64,/, '');
    const r = await axios.post('https://api.apitruecaptcha.org/one/gettext', {
      userid: process.env.TRUECAPTCHA_USERID,
      apikey: process.env.TRUECAPTCHA_APIKEY,
      data: clean,
    }, { timeout: 10000 });
    const res = r.data && r.data.result;
    if (res) {
      store.add(hit.hash, res); // deferred disk write
      return { result: res, fromPool: false };
    }
  } catch (e) {
    log && log.err('Fallback solver error: ' + e.message);
  }
  return null;
}

// Fetch a captcha from SAP then solve it. Retries tightly (no long sleeps).
async function fetchAndSolve(sap, store, cfg, log, attempts = 6, gapMs) {
  const gap = gapMs == null ? cfg.RETRY_GAP_MS : gapMs;
  for (let i = 0; i < attempts; i++) {
    const img = await sap.fetchCaptcha(true);
    if (img) {
      const s = await solve(img, store, cfg, log);
      if (s) return s.result;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, gap));
  }
  return null;
}

module.exports = { solve, fetchAndSolve };
