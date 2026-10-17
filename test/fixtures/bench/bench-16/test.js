const assert = require('node:assert/strict');
const { render } = require('./lib/index');
assert.strictEqual(render(6), "#60:60!");
console.log('ok');
