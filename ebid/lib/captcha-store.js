'use strict';
// In-memory captcha pool: sha256(base64) -> result.
// Pool-only by default (no external solver). New solves are queued and flushed
// to disk AFTER the bidding window (never during the critical moment).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function stripDataUrl(b64) {
  return b64.replace(/^data:image\/(png|jpg|jpeg|gif);base64,/, '');
}

function hashOf(b64) {
  return crypto.createHash('sha256').update(stripDataUrl(b64)).digest('hex');
}

class CaptchaStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.map = new Map();
    this.pending = []; // new solves awaiting disk flush
    this.hits = 0;
    this.misses = 0;
  }

  load() {
    if (!fs.existsSync(this.file)) return 0;
    const arr = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    for (const e of arr) {
      if (e && e.hash && e.result) this.map.set(e.hash, e.result);
    }
    return this.map.size;
  }

  // Returns cached result or null. NO random sabotage, NO date checks.
  lookup(b64) {
    const h = hashOf(b64);
    const r = this.map.get(h);
    if (r) { this.hits++; return { result: r, hash: h, fromPool: true }; }
    this.misses++;
    return { result: null, hash: h, fromPool: false };
  }

  // Cache a freshly solved captcha (e.g. from fallback). Deferred write.
  add(hash, result, file) {
    if (!hash || !result) return;
    if (this.map.has(hash)) return;
    this.map.set(hash, result);
    this.pending.push({ hash, file: file || '', result });
  }

  // Flush new solves to disk. Call AFTER the window (never mid-submit).
  flush() {
    if (!this.pending.length) return 0;
    let arr = [];
    if (fs.existsSync(this.file)) {
      try { arr = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch (_) { arr = []; }
    }
    arr.push(...this.pending);
    fs.writeFileSync(this.file, JSON.stringify(arr, null, 2), 'utf-8');
    const n = this.pending.length;
    this.pending = [];
    return n;
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses, pending: this.pending.length };
  }
}

module.exports = { CaptchaStore, hashOf, stripDataUrl };
