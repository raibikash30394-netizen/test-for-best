'use strict';
const C = {
  reset: '\x1b[0m', bright: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m', blue: '\x1b[34m', gray: '\x1b[90m',
};
function stamp() { return new Date().toISOString().substring(11, 23); }
const log = {
  info: m => console.log(`${C.gray}${stamp()}${C.reset} ${C.cyan}ℹ${C.reset} ${m}`),
  ok: m => console.log(`${C.gray}${stamp()}${C.reset} ${C.green}✓ ${m}${C.reset}`),
  warn: m => console.log(`${C.gray}${stamp()}${C.reset} ${C.yellow}⚠ ${m}${C.reset}`),
  err: m => console.log(`${C.gray}${stamp()}${C.reset} ${C.red}✗ ${m}${C.reset}`),
  bold: m => console.log(`${C.gray}${stamp()}${C.reset} ${C.bright}${C.magenta}${m}${C.reset}`),
  plain: m => console.log(m),
};
module.exports = { log, C };
