# Task: Executive audit of Software Factory, StashMind, and EasyTutor

## Goal
Produce one executive audit that (1) verifies every claim made about the three products with executed commands, (2) states where each product stands today, (3) gives a plan and strategy to move forward, and (4) assesses launch readiness and real-world usability. Nothing is narrated; every figure comes from a command output or a committed artifact.

## Constraints
- Every claim must come from an executed command exit code/output or a committed artifact; narration is never evidence
- No secret may be read, printed, or committed (no `.env`, keys, tokens, service-account JSON)
- Work on a branch named `audit/three-product-audit`; open a PR; do not merge to main
- No change in behaviour for existing users of any repo
- Software Factory's doctrine is not edited
- Test counts may only go up; no check is weakened, skipped, or deleted

## Models
models.planner: frontier/claude-sonnet-4-5
models.implementer: local/qwen2.5-coder:14b
models.reviewer: frontier/claude-sonnet-4-5
models.reporter: local/qwen2.5-coder:14b

## Verification
npm run verify

## Milestones
### A1: Snapshot Software Factory state
independent: true
split: milestone
verify: npm run verify
- [ ] Software Factory working tree state recorded
  - check: git status --porcelain
- [ ] Commit SHA, branch, tags recorded
  - check: git log --oneline -1 && git tag | tail -3
- [ ] Capability manifest regenerated and matches README table
  - check: npm run render:readme && git diff --exit-code README.md
- [ ] Loop gates green
  - check: npm run verify:loop

### A2: Snapshot StashMind state
depends: A1
split: milestone
verify: npm run typecheck
- [ ] StashMind clone fetched to a clean worktree
  - check: git -C /tmp/opencode/audit/stashmind fetch --tags && git -C /tmp/opencode/audit/stashmind status --porcelain
- [ ] Commit SHA, branch, tags recorded (incl. v1.0.0-rc1 presence)
  - check: git -C /tmp/opencode/audit/stashmind log --oneline -1 && git -C /tmp/opencode/audit/stashmind tag | tail -3
- [ ] Gates green (typecheck, test count)
  - check: git -C /tmp/opencode/audit/stashmind npm run typecheck && git -C /tmp/opencode/audit/stashmind npm run test 2>&1 | grep "Tests "
- [ ] M0/M1 stabilization commits present on main
  - check: git -C /tmp/opencode/audit/stashmind log --oneline --grep="stabilization-readme\|architecture-M1-adrs" | head -5

### A3: Snapshot EasyTutor state
depends: A1
split: milestone
verify: npm run typecheck
- [ ] EasyTutor clone fetched to a clean worktree
  - check: git -C /tmp/opencode/audit/easytutor fetch --tags && git -C /tmp/opencode/audit/easytutor status --porcelain
- [ ] Commit SHA, branch, tags recorded (incl. v1.0.1 presence)
  - check: git -C /tmp/opencode/audit/easytutor log --oneline -1 && git -C /tmp/opencode/audit/easytutor tag | tail -3
- [ ] Gates green (typecheck, lint, test count)
  - check: git -C /tmp/opencode/audit/easytutor npm run typecheck && git -C /tmp/opencode/audit/easytutor npm run lint 2>&1 | grep "problems" && git -C /tmp/opencode/audit/easytutor npm test 2>&1 | grep "Tests "
- [ ] M0/M1 stabilization commits present on main
  - check: git -C /tmp/opencode/audit/easytutor log --oneline --grep="stabilization-readme\|architecture-M1-adrs" | head -5

### A4: StashMind live smoke tests
depends: A2
split: milestone
verify: true
- [ ] StashMind health endpoint returns 200
  - check: curl -s -o /dev/null -w '%{http_code}' https://stashmind-nu.vercel.app/api/v1/health
- [ ] StashMind rejects unauthenticated /me with 401
  - check: curl -s -o /dev/null -w '%{http_code}' https://stashmind-nu.vercel.app/api/v1/me
- [ ] StashMind rejects unauthenticated lesson create with 401
  - check: curl -s -o /dev/null -w '%{http_code}' -X POST https://stashmind-nu.vercel.app/api/v1/lessons -H 'Content-Type: application/json' -d '{}'
- [ ] HSTS present on StashMind host
  - check: curl -sI https://stashmind-nu.vercel.app/ | grep -i strict-transport

### A5: EasyTutor live smoke tests
depends: A3
split: milestone
verify: true
- [ ] EasyTutor home returns 200
  - check: curl -s -o /dev/null -w '%{http_code}' https://easytutor-ten.vercel.app/
- [ ] HSTS present on EasyTutor host
  - check: curl -sI https://easytutor-ten.vercel.app/ | grep -i strict-transport

### A6: Live lesson-from-PDF timing (blocked unless credentials exist)
depends: A4, A5
split: milestone
verify: true
- [ ] Live lesson-from-PDF timing attempted or blocked with reason recorded
  - check: test -f runs/audit-three-product/LIVE-PDF-TIME.md || echo "BLOCKED: needs real user session + PDF"

### A7: Re-audit all VERIFIED claims from the M0 run
depends: A1, A2, A3
split: milestone
verify: npm run verify
- [ ] M0 report claims re-executed against fresh clones
  - check: test -f runs/audit-three-product/RE-AUDIT.md
- [ ] Zero false VERIFIED statuses confirmed
  - check: grep -c "false VERIFIED" runs/audit-three-product/RE-AUDIT.md | grep -q "^0$"
- [ ] Blocker register accurate (S0/S1 findings, human gates H2-H6)
  - check: test -f runs/audit-three-product/SCORECARD.md

### A8: Publish the executive audit report
depends: A7
split: milestone
verify: npm run verify
- [ ] Audit report written with three-product status table
  - check: test -f runs/audit-three-product/EXECUTIVE-AUDIT.md
- [ ] Plan and strategy forward documented with owners
  - check: test -f runs/audit-three-product/PLAN-FORWARD.md
- [ ] Launch readiness and real-world usability assessed
  - check: test -f runs/audit-three-product/LAUNCH-READINESS.md
- [ ] Real-time work-management view described (API + panel)
  - check: test -f runs/audit-three-product/REALTIME-VIEW.md
