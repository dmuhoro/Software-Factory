const assert = require('node:assert/strict');
const { render } = require('./lib/index');
assert.strictEqual(render(3), "#30:30!");
console.log('ok');
