/** Scales a raw count. The factor is the fixture's single source of truth for scaling. */
const FACTOR = 11;
function scale(n) {
  return n * FACTOR;
}
module.exports = { scale };
