'use strict';
require('dotenv').config();

function bool(v, def) {
  if (v == null) return def;
  return String(v).toLowerCase() === 'true';
}
function int(v, def) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}
function mins(v, def) {
  if (!v) return def;
  return String(v).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

const CONFIG = {
  // SAP connection
  BASE_URL: process.env.BASE_URL,
  USER_ID: process.env.USER_ID,
  PASSWORD: process.env.PASSWORD,
  PLANT: process.env.PLANT,

  // CSV
  CSV_FILE: process.env.CSV_FILE || './files/input2.csv',
  DELETE_CSV_FILE: process.env.DELETE_CSV_FILE || './files/delete.csv',
  RANK_CSV_FILE: process.env.RANK_CSV_FILE || './files/rank_records.csv',
  AUTO_UPDATE_CSV_BIDS: bool(process.env.AUTO_UPDATE_CSV_BIDS, false), // amount is a HARD limit from CSV — never auto-change it

  // Captcha
  CAPTCHA_DATA_FILE: process.env.CAPTCHA_DATA_FILE || './data.json',
  CAPTCHA_API_FALLBACK: bool(process.env.CAPTCHA_API_FALLBACK, false),

  // Batching / priority
  MAX_ROWS_PER_BATCH: int(process.env.MAX_ROWS_PER_BATCH, 3), // SAP hard limit = 3
  MAX_PARALLEL_BATCHES: int(process.env.MAX_PARALLEL_BATCHES, 1), // safe default: sequential-pipeline

  // Timing (all ms unless noted)
  PREWARM_LEAD_MS: int(process.env.PREWARM_LEAD_MS, 90000), // start warming this early
  SUBMIT_LEAD_MS: int(process.env.SUBMIT_LEAD_MS, 500),     // (legacy) begin captcha poll this early
  CAPTCHA_PREFETCH_MS: int(process.env.CAPTCHA_PREFETCH_MS, 0), // fetch captcha this many ms BEFORE open; 0 = fetch at T=0 (SAP rejects pre-window captchas)
  CAPTCHA_POLL_MS: int(process.env.CAPTCHA_POLL_MS, 10),    // poll interval while window opens
  CAPTCHA_MAX_RETRY: int(process.env.CAPTCHA_MAX_RETRY, 3),  // max captcha refetch/retries per batch before backing off
  RETRY_GAP_MS: int(process.env.RETRY_GAP_MS, 20),          // tight adaptive retry gap
  ORDER_POLL_MS_CLOSED: int(process.env.ORDER_POLL_MS_CLOSED, 5000), // fetch new orders while window CLOSED
  ORDER_POLL_MS_OPEN: int(process.env.ORDER_POLL_MS_OPEN, 600),      // fetch new orders while window OPEN
  WINDOW_MINUTES: mins(process.env.WINDOW_MINUTES, [15, 45]),
  WINDOW_SOURCE: process.env.WINDOW_SOURCE || 'computed', // 'computed' (IST :15/:45) | 'plantConf'
  WINDOW_DURATION_MIN: int(process.env.WINDOW_DURATION_MIN, 10),

  // Modes
  DRY_RUN: bool(process.env.DRY_RUN, false),
  LOOP_CONTINUOUS: bool(process.env.LOOP_CONTINUOUS, true),
};

module.exports = CONFIG;
