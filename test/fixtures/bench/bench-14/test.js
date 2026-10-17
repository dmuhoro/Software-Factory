const assert = require('node:assert/strict');
const { render } = require('./lib/index');
assert.strictEqual(render(4), "#40:40!");
console.log('ok');
