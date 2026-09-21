'use strict';
// Time / clock-sync / window math (SAP time is GMT/UTC).
// India has no DST; IST = UTC + 5:30 (330 minutes).

const IST_OFFSET_MIN = 330;

// "/Date(1467981296000)/" -> epoch ms
function parseSapDate(s) {
  if (!s) return null;
  const m = String(s).match(/\/Date\((\d+)\)\//);
  return m ? parseInt(m[1], 10) : null;
}

// "PT10H45M0S" -> ms since midnight
function parseSapTime(s) {
  if (!s) return 0;
  const m = String(s).match(/PT(\d+)H(\d+)M(\d+)S/);
  if (!m) return 0;
  return (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])) * 1000;
}

// Combine SAP date + time-of-day into epoch ms (UTC).
function sapDateTime(dateStr, timeStr) {
  const d = parseSapDate(dateStr);
  if (d === null) return null;
  return d + parseSapTime(timeStr);
}

// Clock offset from an HTTP `Date` response header (RFC 1123, GMT).
// offset added to Date.now() gives estimated SAP server time.
function offsetFromHttpDate(dateHeader, localNowMs) {
  if (!dateHeader) return 0;
  const sap = Date.parse(dateHeader);
  if (isNaN(sap)) return 0;
  return sap - (localNowMs == null ? Date.now() : localNowMs);
}

function serverNow(offsetMs) {
  return Date.now() + (offsetMs || 0);
}

// Next bidding-window START (epoch ms, UTC) given IST minute marks.
// e.g. minutes=[15,45] -> next :15 or :45 IST boundary strictly after nowMs.
function nextWindowStartUtc(nowMs, minutes = [15, 45]) {
  const mins = [...minutes].sort((a, b) => a - b);
  const istNow = nowMs + IST_OFFSET_MIN * 60000;
  const d = new Date(istNow); // read IST fields via UTC getters
  const baseHour = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0
  );
  const curMin = d.getUTCMinutes();
  const curSec = d.getUTCSeconds();
  let istTarget = null;
  for (const m of mins) {
    if (m > curMin || (m === curMin && curSec === 0 && false)) { // strictly after
      istTarget = baseHour + m * 60000;
      break;
    }
  }
  if (istTarget === null) {
    // roll to next hour, first mark
    istTarget = baseHour + 3600000 + mins[0] * 60000;
  }
  // convert IST epoch back to UTC epoch
  return istTarget - IST_OFFSET_MIN * 60000;
}

// Resolve the active/next slot window. Prefer SAP-provided plantConf slot
// times (authoritative). Fall back to computed IST :15/:45.
function resolveWindow(plantConf, currDtDm, offsetMs, windowMinutes) {
  let start = null, end = null, source = 'plantConf';
  if (plantConf) {
    start = sapDateTime(plantConf.BiddingDate, plantConf.SlotStartTime);
    end = sapDateTime(plantConf.BiddingDate, plantConf.SlotEndTime);
  }
  if (start === null || end === null) {
    source = 'computed';
    const now = serverNow(offsetMs);
    start = nextWindowStartUtc(now, windowMinutes);
    end = start + 15 * 60000; // assume 15-min window if not given
  }
  return { start, end, source };
}

function fmtCountdown(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = ms % 1000;
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}.${p(cs, 3)}`;
}

module.exports = {
  IST_OFFSET_MIN, parseSapDate, parseSapTime, sapDateTime,
  offsetFromHttpDate, serverNow, nextWindowStartUtc, resolveWindow, fmtCountdown,
};
