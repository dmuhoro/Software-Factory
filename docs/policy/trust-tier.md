# Trust‑tier policy

## Tiers and promotion criteria

| Tier | When promotion is granted | Required evidence |
|------|--------------------------|-------------------|
| **1 – Scratch repo** | The loop has been run on a **temporary, isolated repository** (e.g. `mktemp -d` + `git init`). No real data, no credentials, no external impact. | *Loop exit 0, all gates passed, no model credentials leaked, sandbox test passed.* |
| **2 – Real low‑stakes repo** | The loop has been run on a **real repository that contains genuine bugs or feature work, but is not used for client‑facing paid contracts** (e.g. a personal project, a fork, a demo repo). | *Loop exit 0, at least one verified commit fixing a real issue, sandbox‑hardening test passed, live observability stream observed, no credential exfiltration.* |
| **3 – Personal paid work** | The loop has been run on a **repository that Daniel owns and uses for his own freelance / contract work**, and the output has been reviewed and approved by Daniel. | *Loop exit 0, verified commits per week ≥ N (configured per‑project), live observability confirmed, sandbox‑hardening test passed, no secret leakage, Daniel’s written sign‑off.* |
| **4 – Client paid work** | The loop has been run on a **client‑owned repository** that requires compliance, audit‑ready logging, and formal sign‑off. | *All Tier 3 evidence **plus** audit‑ready JSONL event stream, third‑party credential‑management review, legal sign‑off, and a signed “ready‑to‑bill” document from the client.* |

## How tiers are recorded

* Each sprint’s markdown (`sprints/sprint‑XX‑trustworthy‑unattended‑loop.md`) contains a **progress checklist** with a check‑mark (☑︎) for every tier that has been **explicitly promoted** during that sprint.
* The promotion decision is **recorded in the sprint write‑up** (commit SHA, reviewer verdict, sandbox‑test report, observability log excerpt).
* The policy document lives under `docs/policy/trust-tier.md` and is **version‑controlled** like any other source file; changes require a PR and sign‑off from the Chief Architect.

## Promoting a tier

1. **Run the required deliverables** (see the sprint checklist).  
2. **Collect evidence** (exit codes, commit SHAs, sandbox‑test logs, observability stream excerpts).  
3. **Add a line** to the sprint markdown under the appropriate tier, e.g. `- [x] Tier 2 – real low‑stakes repo – **done** (commit abc1234, sandbox test passed).`  
4. **Commit the markdown change** and push; the new tier becomes the effective baseline for the next sprint.

---

*This policy becomes the standing rule for every future sprint; no future sprint may downgrade a tier or claim a higher tier without the evidence listed above.*