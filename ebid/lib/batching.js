'use strict';
// Batching & Priority Engine (strict rules)
//
// Unit = single (size 1) OR club group (same ClubId, atomic, size 2 or 3).
// Priority order:
//   1) 1164-SPI units first (single OR club)
//   2) then remaining singles (single-first)
//   3) then remaining club groups (size 2 before size 3, so a leftover
//      single can top-up a club-of-2 into a dense batch of 3)
// Packing: hard max 3 rows/batch. Two DIFFERENT club groups never mix
//   (guaranteed automatically: 2+2>3, 2+3>3, 3+x>3), club-of-3 => own batch.
//
// A single greedy pass over the priority-ordered units yields all rules
// (including group-of-2 + single top-up) optimally.

const MAX_ROWS = 3;
const PRIORITY_SPI = '1164';

function normSpi(v) {
  return (v == null ? '' : String(v)).trim();
}

function unitKey(row) {
  const club = row.ClubId ? String(row.ClubId).trim() : '';
  if (club) return 'CLUB:' + club;
  return 'ROW:' + [row.SapOrderId || '', row.Posnr || ''].join(':');
}

// Build units from matched rows. Each matched row: { item, bidAmount }
// Rows with the same club id merge into one atomic unit.
function buildUnits(matchedRows) {
  const byKey = new Map();
  const order = [];
  for (const mr of matchedRows) {
    const key = unitKey(mr.item);
    if (!byKey.has(key)) {
      const isClub = key.startsWith('CLUB:');
      const u = { key, isClub, rows: [], is1164: false };
      byKey.set(key, u);
      order.push(u);
    }
    const u = byKey.get(key);
    u.rows.push(mr);
    if (normSpi(mr.item.Spi) === PRIORITY_SPI) u.is1164 = true;
  }
  for (const u of order) {
    u.size = u.rows.length;
    // A "club" with a single physical row is treated as a single unit.
    if (u.isClub && u.size === 1) u.isClub = false;
  }
  return order;
}

// Priority-ordered unit list for packing.
function orderUnits(units) {
  const p1164 = units.filter(u => u.is1164);
  const singles = units.filter(u => !u.is1164 && !u.isClub);
  const clubs = units.filter(u => !u.is1164 && u.isClub);

  // Within priority: singles before clubs (denser first batch).
  const pSingles = p1164.filter(u => !u.isClub);
  const pClubs = p1164.filter(u => u.isClub);
  // Clubs: size 2 before size 3 so a leftover single tops up a club-of-2.
  clubs.sort((a, b) => a.size - b.size);
  pClubs.sort((a, b) => a.size - b.size);

  return [...pSingles, ...pClubs, ...singles, ...clubs];
}

// Greedy pack ordered units into batches of <= MAX_ROWS rows.
function packGreedy(ordered, max = MAX_ROWS) {
  const batches = [];
  let cur = [];
  let count = 0;
  for (const u of ordered) {
    if (count > 0 && count + u.size > max) {
      batches.push(cur);
      cur = [];
      count = 0;
    }
    cur.push(u);
    count += u.size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// Public: full plan. Returns array of batches; each batch is array of units.
function planBatches(matchedRows, max = MAX_ROWS) {
  const units = buildUnits(matchedRows);
  const ordered = orderUnits(units);
  return packGreedy(ordered, max);
}

// Flatten a batch to its row items (for building the SAP payload).
function batchRows(batch) {
  const out = [];
  for (const u of batch) for (const r of u.rows) out.push(r);
  return out;
}

module.exports = {
  MAX_ROWS, PRIORITY_SPI, unitKey, buildUnits, orderUnits,
  packGreedy, planBatches, batchRows, normSpi,
};
