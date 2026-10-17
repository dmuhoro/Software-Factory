# Task: bench-14 multi-file pipeline

## Goal
Make `node check.cjs` pass. The pipeline in `lib/` renders a raw count, and it currently
renders the wrong string: `render(4)` must equal "#40:40!".
The three leaf modules (`lib/units.js`, `lib/label.js`, `lib/format.js`) each carry a constant
that does not match the goal; correct them so the composed result is right.

## Constraints
- No new dependencies (node built-ins only)
- Do not change test.js or check.cjs; fix the implementation
- Keep the module boundaries: the scaling stays in units.js, the prefix in label.js, the suffix in format.js

## Models
models.implementer: __MODEL__
models.reviewer: __MODEL__

## Milestones
### M1: Render the count correctly
type: feat
verify: node check.cjs
- [ ] node check.cjs passes
- [ ] render(4) equals "#40:40!"
