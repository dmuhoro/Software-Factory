# ADR-006: The repository is the knowledge base, served to AI reviewers over MCP

- **Status**: Accepted
- **Date**: 2026-09-29
- **Resolves**: the integration and knowledge-accumulation requirement raised for release 4.8.0
- **Supersedes**: nothing

## Context

The requirement was to connect Software Factory to CodeRabbit and to other engineering
tooling, and to keep one central, durable record of the work rather than a record scattered
across tools.

Two facts were established from primary sources before anything was built.

**CodeRabbit is an MCP client, not a server.** Its own documentation is explicit:
"CodeRabbit acts as the MCP client -- it ingests data from your connected MCP servers, not the
other way around" (`docs.coderabbit.ai/knowledge-base/mcp-context`). MCP therefore does not
provide a channel by which this repository calls CodeRabbit. It provides a channel by which
CodeRabbit reads this repository. The direction was assumed to be the opposite of what it is,
and the plan was inverted accordingly.

**This repository already has a drift problem.** When the NC-5 egress wildcard was fixed in
`31bddc3`, the constitution continued to assert that `0.0.0.0/0` was present — six commits
after it was removed. The `docs/FOUNDER_OPERATING_PLAYBOOK.md` still documented Bun commands
after npm had become canonical in `7af6238`. Three of four non-conformance resolutions in
Wave 3 and Wave 5 were never reconciled in the same change that resolved them, which is the
same lapse the constitution already records for NC-1, NC-6 and NC-7.

That second fact decided the architecture. The obvious implementation was to mirror the
documentation into Confluence, Notion or a wiki and point the integrations at that. A second
copy of a record that already drifts is not a fix for the drift. It gives the drift somewhere
else to happen, where no gate is watching.

## Decision

The Git repository is the single canonical record. External tools integrate *against* it;
they do not become sources of truth.

**1. `scripts/kb-mcp-server.mjs` serves the repository over MCP, on stdio.**

Four tools: `search_knowledge`, `get_document`, `list_documents`, `get_governing_rules`.
33 documents are indexed: the constitution, 5 ADRs, the operating contracts, 15 sprint
records, and the CI workflows.

The server returns committed text and never paraphrases. Every `get_document` response
carries a `SOURCE:` line naming the file it came from. A knowledge tool that summarises an
ADR is a knowledge tool that can misstate an ADR, and the entire value of this one is that a
review comment can cite a rule which actually exists.

**2. It is read-only, and the limits are proven rather than asserted.**

Paths are resolved against the repository root and re-checked for containment *after*
normalisation, because normalisation is what turns `a/../../etc/passwd` into a path escape.
`.env` and the tenant ledger are refused outright rather than filtered by pattern: a knowledge
server that will read a credential on request is a credential-disclosure tool wearing a
documentation costume. `--self-test` exercises six attack paths, and CI runs it.

**3. `scripts/generate-dashboard.mjs` generates the status view from Git.**

No figure is typed by hand. Delivery history comes from `git log`, versions from the five
version sites, governance from the constitution's own tables, and the verification table comes
from actually running the gates at generation time. A hand-maintained status document is
wrong within two weeks and still looks authoritative, which is the failure this replaces.

**4. The dashboard reports what it cannot measure, and names an owner.**

Live Gemini and Appwrite behaviour, production volume, the deployed image digest, and findings
from the unconnected integrations are listed as unavailable with the reason and the owner.
An honest blank is worth more than a plausible number, because a reader cannot distinguish a
plausible number from a measurement.

**5. The dashboard asserts its own coverage.**

Any `verify*` script in `scripts/` not represented in the table is reported as unrepresented.
This is not decorative: the first version omitted the Kubernetes manifest gate, and when the
NC-5 wildcard was reintroduced as a negative control, the dashboard printed a clean
verification table. Adding the coverage assertion surfaced four further omitted harnesses
immediately.

**6. External integrations are adapters, gated on their own credentials.**

`coderabbit`, `sonarqube`, `snyk`, `datadog-metrics` in `.github/workflows/integrations.yml`.
Each is conditioned on a single secret so a fork PR is not failed for a credential the
contributor cannot have. `scripts/verify-integrations.sh` audits the shape of that workflow
because its runtime behaviour is unobservable without the secrets.

## Consequences

**Reviews can cite the constitution.** CodeRabbit is configured to treat `docs/CONSTITUTION.md`
and `docs/adr/` as binding: a change contradicting an ADR needs a new ADR, a new gate is not
evidence unless it was shown to fail without its fix, and a resolved non-conformance whose
behaviour the diff changes makes that entry false. This is the specific gap that let an
unbuildable production image and an allow-all egress policy ship through every release.

**Nothing is connected yet.** Each integration needs a credential absent from this
environment, and until one is added the job reports skipped. The dashboard lists them as
unmeasured with their owners. This is stated plainly because the alternative — describing
integrations as connected — is the specific class of false claim the constitution exists to
prevent.

**A rendered egress policy is a snapshot, not a durable control.** `render-egress-policy.sh`
resolves the two real hostnames at deploy time. DNS answers change, and a NetworkPolicy
cannot filter by SNI, so the durable answer is an egress proxy or service mesh. Recorded as
an open item, not claimed as done.

**NC-2 remains open and unscheduled.** The TypeScript service is single-writer by design, not
by accident. Nothing here changes that.

## Alternatives rejected

**Mirror the docs into Confluence/Notion and point integrations there.** Rejected: it creates a
second copy of a record already known to drift, with no reconciliation. The drift does not
shrink; it moves somewhere no gate is watching.

**Build an MCP client that calls CodeRabbit.** Rejected: CodeRabbit is not an MCP server. The
capability does not exist, and building against a capability that does not exist produces an
integration that looks real and does nothing.

**Let CodeRabbit reach the repository over the network.** Rejected in favour of stdio: a
process serving a fixed document set over stdio exposes no port, holds no credential, and needs
no inbound firewall rule. If a network endpoint is ever needed, CodeRabbit's reverse-tunnel
connector is the documented path for a server on a private network.

**Hand-maintain a status document.** Rejected: it drifts within two weeks and cannot report a
regression, as demonstrated above.
