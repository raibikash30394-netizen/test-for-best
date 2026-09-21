'use strict';
// CSV parsing + matching bidRows to CSV bid amounts + delete-list filtering.
const fs = require('fs');
const path = require('path');

function csvToJson(text) {
  const lines = text.split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = lines[i].replace(/\r/g, '').split(',');
    const row = {};
    for (let c = 0; c < headers.length; c++) row[headers[c]] = (cells[c] || '').trim();
    out.push(row);
  }
  return out;
}

function loadCsvFiles(cfg, log) {
  const csvPath = path.resolve(cfg.CSV_FILE);
  if (!fs.existsSync(csvPath)) {
    log && log.err('CSV file not found: ' + csvPath);
    return null;
  }
  const csvData = csvToJson(fs.readFileSync(csvPath, 'utf-8'));
  log && log.ok(`Loaded ${csvData.length} rows from ${path.basename(csvPath)}`);

  let deleteList = [];
  const delPath = path.resolve(cfg.DELETE_CSV_FILE);
  if (fs.existsSync(delPath)) {
    deleteList = csvToJson(fs.readFileSync(delPath, 'utf-8'))
      .map(r => r.Customer).filter(Boolean);
    log && log.ok(`Loaded ${deleteList.length} delete-list entries`);
  }
  return { csvData, deleteList };
}

function csvBid(csvRow) {
  return Number(csvRow['BIDING AMMOUNT'] || csvRow['BIDING AMOUNT'] || 0).toFixed();
}

// Returns matched rows: [{ item: bidRow, bidAmount }]
// Match key: City Code Descriptio == DestCityDesc AND Special Process Indi == Spi
// Skips rows whose KunagName1 is in the delete list.
function matchRows(csvData, deleteList, bidRows) {
  const matched = [];
  for (const row of bidRows) {
    const kunag = (row.KunagName1 || '').trim();
    if (deleteList.includes(kunag)) continue;
    const city = (row.DestCityDesc || '').trim();
    const spi = (row.Spi || '').trim();
    const csvRow = csvData.find(c =>
      (c['City Code Descriptio'] || '') === city &&
      (c['Special Process Indi'] || '') === spi
    );
    if (!csvRow) continue;
    matched.push({ item: row, bidAmount: csvBid(csvRow) });
  }
  return matched;
}

module.exports = { csvToJson, loadCsvFiles, matchRows, csvBid };
