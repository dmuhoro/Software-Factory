const assert = require('node:assert/strict');
const { render } = require('./lib/index');
assert.strictEqual(render(5), "#50:50!");
console.log('ok');
