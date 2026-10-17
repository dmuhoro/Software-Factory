const { scale } = require('./units');
const { tag } = require('./label');
const { wrap } = require('./format');
/** Renders a raw count through the whole pipeline. */
function render(n) {
  return wrap(tag(scale(n)));
}
module.exports = { render };
