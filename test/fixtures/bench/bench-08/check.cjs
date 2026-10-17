const fs = require('node:fs');
const expected = "bench-token-08";
const ok = fs.existsSync('bench.txt') && fs.readFileSync('bench.txt', 'utf8').includes(expected);
if (!ok) { console.error('bench.txt missing or wrong content, expected ' + expected); process.exit(1); }
console.log('ok');
