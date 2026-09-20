# Repository Context Index and Compounding Quality Model

Software Factory now distills reusable context from five connected repositories instead of copying entire codebases into every task. The imported records are durable, searchable, tenant-safe, and attached to future implementation plans.

## Imported context

| Repository | Reusable context | Quality score |
|---|---|---:|
| **Hermes-Forge** | Local-first AI, AST-driven context, cancellation, approval membrane, privacy boundary, local model routing | 76 |
| **Forge** | Planner/reviewer separation, evaluation-driven change, sandbox execution, SOP-driven operations | 72 |
| **Portable-UI-Engine** | Framework-agnostic components, Shadow DOM isolation, JSON contracts, defensive parsing, design tokens | 68 |
| **ShrinkMedia** | Offline/connected profiles, device verification, evidence logs, ADR governance, failure surfacing, backup operations | 88 |
| **Forge.ai** | Product-builder intake, authenticated project workspace, interactive preview surface | 34 |

The current imported-context baseline is **67.6/100**. This is a capability baseline for the reusable operating system, not a claim that every repository or product is production-ready.

## Quality rubric

Every launch can record a score across five dimensions. Verification contributes 25 points, security and privacy contributes 20, evidence contributes 20, operability contributes 15, and product discipline contributes 20. A score is valid only when backed by the corresponding evidence kinds. The factory records the baseline, launch score, absolute score, and percentage change.

The target is not an arbitrary promise that every launch improves by exactly 20 percent. The operating target is that each product inherits the previous best practices and that the measured score trends upward. Relative improvement is calculated as `(launch score - baseline score) / baseline score * 100`. Against the current 67.6 baseline, a 20 percent improvement requires at least **81.1/100**.

## How context compounds

A future implementation plan searches the indexed repository contexts using the job title, problem, and audience. It inherits relevant patterns and adds quality gates for type or compile checks, tests, security and tenant-boundary review, and evidence before delivery. A founder can search the index directly through `/api/context/search?q=...` and inspect launch history through `/api/context/quality`.

This is the first compounding loop: a product that uses ShrinkMedia's evidence discipline, Hermes-Forge's privacy and approval boundaries, Forge's evaluation model, and Portable-UI-Engine's contract discipline starts with a stronger plan than a blank project. After delivery, its measured quality snapshot becomes another operational signal for the next product.

## Explicit boundaries

The index stores distilled context, not credentials or unreviewed source-code dumps. Imported scores are engineering baselines derived from repository evidence and must be recalibrated when a repository changes. AI retrieval is not yet enabled; deterministic keyword retrieval is the safe first adapter. Semantic retrieval, knowledge graphs, and automated context extraction can be added after more launches produce a trustworthy corpus.
