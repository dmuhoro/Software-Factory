# Task: bench-01 single-file write

## Goal
Write bench.txt so it contains the token bench-token-01.

## Constraints
- No new dependencies
- Touch only bench.txt

## Models
models.implementer: __MODEL__
models.reviewer: __MODEL__

## Milestones
### M1: Write the token
type: feat
verify: node check.cjs
- [ ] bench.txt exists and contains bench-token-01
