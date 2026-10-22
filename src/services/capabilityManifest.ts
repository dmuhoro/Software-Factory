/**
 * The capability manifest: one machine-readable statement of what this factory can actually do.
 *
 * The Constitution's second part exists because it is easy to describe a capability the code does
 * not provide — a dashboard that reports fabricated health, a guard the loop never calls, a feature
 * in the changelog that is a simulation. A claim that cannot name the command that demonstrates it
 * is a claim nobody has checked.
 *
 * So every capability is one record, and a `live` capability MUST name the command or route that
 * proves it. `validateCapabilityManifest` refuses a live claim with no proof, and refuses a
 * `blocked` capability with no named owner — because a blocked thing without an owner is an
 * engineering backlog disguised as someone else's problem. The manifest is read-only and
 * deterministic: no clock, no I/O, no model.
 */

type CapabilityStatus = 'live' | 'planned' | 'blocked';

export interface CapabilityEntry {
  id: string;
  title: string;
  status: CapabilityStatus;
  /** One sentence, honest about what the capability does and does not do. */
  summary: string;
  /**
   * The named command or HTTP route that demonstrates the capability. **Required for `live`.**
   * For a `planned` capability it is the proof that must be produced before it may become live.
   */
  proves?: string;
  /** For a `blocked` capability, the owner who must unblock it. **Required for `blocked`.** */
  owner?: string;
}

export type CapabilityManifestErrorCode =
  | 'CAPABILITY_WITHOUT_PROOF'
  | 'CAPABILITY_WITHOUT_OWNER'
  | 'CAPABILITY_DUPLICATE_ID'
  | 'CAPABILITY_INVALID'
  | 'CAPABILITY_UNKNOWN_STATUS';

export class CapabilityManifestError extends Error {
  public readonly code: CapabilityManifestErrorCode;
  constructor(code: CapabilityManifestErrorCode, detail: string) {
    super(`${code}:${detail}`);
    this.name = 'CapabilityManifestError';
    this.code = code;
  }
}

const STATUSES: readonly CapabilityStatus[] = ['live', 'planned', 'blocked'];

/**
 * The declared capabilities. Every `live` entry names the command that demonstrates it; every
 * `blocked` entry names its owner. This list is the single source the API route, the test, and the
 * public evidence page all read from, so they cannot drift from each other.
 */
export const CAPABILITIES: readonly CapabilityEntry[] = [
  {
    id: 'unattended-loop',
    title: 'Unattended execution loop',
    status: 'live',
    summary: 'Runs a parsed task document unit by unit against a real git repository, committing only what a verification command and a two-axis review accept.',
    proves: 'npm run verify:loop',
  },
  {
    id: 'interactive-intake',
    title: 'Interactive intake (grill session)',
    status: 'live',
    summary: 'A durable, tenant-scoped human-in-the-loop intake: the factory asks one clarifying question at a time under a hard cap the model cannot raise, the operator answers, and a task document is drafted only through the same parse-or-refuse path as the one-shot goal bridge. A restart mid-session resumes from the ledger; a foreign session id is a miss, never a leak.',
    proves: 'npm test -- test/grill-session.test.ts',
  },
  {
    id: 'failure-classification',
    title: 'Durable failure classification',
    status: 'live',
    summary: 'Every failed attempt is classified (security | verification | review | model | environment | policy | unknown) at the moment of failure and persisted so a count survives resume.',
    proves: 'npm test -- test/loop-failure-class.test.ts',
  },
  {
    id: 'unrelated-writes-guard',
    title: 'Unrelated-writes guard (shadow)',
    status: 'live',
    summary: 'Observes a file that changed without being claimed and records it; enforcement is off by default so the sensor can be measured before it can refuse.',
    proves: 'npm test -- test/unrelated-writes.test.ts',
  },
  {
    id: 'learning-digest',
    title: 'Bounded learning digest',
    status: 'live',
    summary: 'A deterministic, size-bounded, tenant-scoped summary of recorded runs. It advises nothing on its own; injection into prompts is off by default.',
    proves: 'GET /api/loop/learning-digest',
  },
  {
    id: 'single-egress-door',
    title: 'One model-egress door',
    status: 'live',
    summary: 'Every vendor model SDK client is constructed in one module that resolves the key and validates the endpoint through the egress guard first (ADR-011).',
    proves: 'npm test -- test/egress-confinement.test.ts',
  },
  {
    id: 'tenant-isolation',
    title: 'Tenant-scoped control plane',
    status: 'live',
    summary: 'Every loop route authenticates the caller and binds it to one tenant; a claim for another tenant is refused before any work starts.',
    proves: 'npm test -- test/loop-control-plane.test.ts',
  },
  {
    id: 'readiness',
    title: 'Fail-closed readiness',
    status: 'live',
    summary: 'Startup refuses (exit 75) when the data directory cannot be written and fsynced, when free space is below the floor, or when another process holds the single-writer lock.',
    proves: 'GET /api/factory/health',
  },
  {
    id: 'capability-manifest',
    title: 'Capability manifest',
    status: 'live',
    summary: 'This list. A read-only declaration of capabilities in which every live entry names the command that proves it.',
    proves: 'GET /api/factory/capabilities',
  },
  {
    id: 'skills-registry',
    title: 'Declarative skills registry',
    status: 'live',
    summary: 'Loads SKILL.md-style capability definitions from a governed directory, validates them strictly, and exposes the installed set plus any file it refused.',
    proves: 'GET /api/factory/skills',
  },
  {
    id: 'skills-bridge',
    title: 'Vendored, hash-pinned advisory skills',
    status: 'live',
    summary: 'A skill may be shown to a role only when its bytes match a recorded pin and the doctrine flag is on; an unpinned or modified skill is refused, injection OFF is a byte-identical prompt, and a skill cannot alter a rule, a gate, or a model assignment. Wired roles: drafter, implementer, reviewer, plus implementer-stuck (the diagnosing-bugs skill from a unit\'s second attempt).',
    proves: 'npm test -- test/skills-bridge.test.ts',
  },
  {
    id: 'external-skill-adoption',
    title: 'Adopting external skill content',
    status: 'live',
    summary: 'Eight skills from the public MIT Pocock repository are vendored at a pinned commit, stripped to the markdown they reference, licensed, and pinned by sha256 in skills-lock.json; the skills stay advisory and injection stays OFF (ADR-013).',
    proves: 'npx tsx scripts/vendor-skill.ts --check',
  },
  {
    id: 'skills-adoption-evidence',
    title: 'Measured effect of the skills',
    status: 'blocked',
    summary: 'The bench (`npm run bench:skills`) runs the fixture tasks in `test/fixtures/bench/` on and off and applies the pre-registered adoption rule — a paired, per-fixture comparison decided by an exact sign test at α = 0.05 plus a ≥ 10 percentage-point first-attempt gain and no rise in STUCK or refusals, with the MDE reported. A stub dry pass is refused as evidence (`BENCH_STUB_NOT_EVIDENCE`) and a real, paired run needs a model — none is reachable here (hosted is the operator blocker, and the local Ollama daemon is not running in the agent shell). No numbers are claimed.',
    owner: 'harness: engineering; model run: operator',
  },
  {
    id: 'hosted-frontier-model',
    title: 'Hosted frontier model',
    status: 'blocked',
    summary: 'A hosted model call needs an allowlisted secret ref, a permitted host, and spend.',
    owner: 'operator',
  },
  {
    id: 'pr-config-preflight',
    title: 'Pull-request configuration preflight (opens nothing)',
    status: 'live',
    summary: 'Checks the allowlisted secret reference, the permitted host, the owner/name scope and the no-merge rule without opening a pull request; a green run with an invalid token proves no socket was opened.',
    proves: 'npm run verify:pr-config',
  },
  {
    id: 'live-github-pull-request',
    title: 'Live GitHub pull request',
    status: 'blocked',
    summary: 'Opening a real pull request needs an operator-appointed allowlisted token and an egress permit; only refusal-before-socket and the loopback path are proven.',
    owner: 'operator',
  },
  {
    id: 'sandbox-in-shipped-image',
    title: 'Sandboxed execution in the shipped image',
    status: 'live',
    summary: 'The image the loop runs in (./Dockerfile) installs bubblewrap, and `npm run verify:image node` proves the container can create a sandbox as the unprivileged `factory` user under the flags the host must grant (--cap-add SYS_ADMIN, seccomp/apparmor unconfined). A host that forbids user namespaces still fails closed at the sandbox boundary (ADR-010, ADR-014 §5).',
    proves: 'npm run verify:image node',
  },
  {
    id: 'external-cloud-runtime',
    title: 'External cloud runtime',
    status: 'blocked',
    summary: 'cloudroom-core / cloudroom.dev are a different repository and a hosted product; any live use needs that project\'s credentials and trust boundary.',
    owner: 'operator',
  },
  {
    id: 'preview-plane',
    title: 'Preview plane',
    status: 'live',
    summary: 'After each commit, builds the target repo in an ephemeral worktree, runs its dev server on an ephemeral port, and proxies it through an iframe/screenshot endpoint with commit → preview mapping. Additive only — does not change the loop, doctrine, or any gate.',
    proves: 'npm run verify:preview-plane',
  },
  {
    id: 'bug-detective',
    title: 'AI bug detective (advisory, bounded, fail-closed)',
    status: 'live',
    summary: 'Flags errors in the product, assigns a root-cause hypothesis and file:line pointers, and recommends a remediation. Advisory only — never writes to a target tree; any fix still runs VERIFY → REVIEW → COMMIT through L2 gates.',
    proves: 'npm test -- test/bug-detective.test.ts',
  },
  {
    id: 'dual-language-reporting',
    title: 'Dual-language reporting (technical + founder/CEO)',
    status: 'live',
    summary: 'Every durable record renders in both technical vocabulary (proof digests, gate results, failure classes, commit SHAs) and founder/CEO vocabulary (plain-language status, decisions needed, outcomes). No figure appears without a named reproducing command.',
    proves: 'npm test -- test/dual-language-report.test.ts',
  },
  {
    id: 'tool-agnostic-interface',
    title: 'Tool-agnostic IDE/CLI boundary',
    status: 'live',
    summary: 'The doctrine, gates, and evidence boundary live outside Cursor/Cline/any IDE. Editors are clients of the boundary, not authors of it; the same run record is consumable by the built-in panel, a CLI, or an IDE extension. The boundary answers a per-file knowledge-graph query and a repository-scoped symbol query, renders both vocabularies, and compresses a payload for a model or a frontend. It reads; it never writes.',
    proves: 'npm run verify:tool-agnostic-boundary',
  },
  {
    id: 'ast-structural-verification',
    title: 'AST structural verification gate (Layer 2)',
    status: 'live',
    summary: 'The loop parses the files a unit changed into knowledge graphs and refuses a provable structural defect — a call to a name that is defined nowhere in the repository. Definitions are resolved against the import closure, so an import of an unchanged module is not a defect. Advisory findings (a forward reference to a file a later unit will create, an unused import) are reported without refusing the stage.',
    proves: 'npm test -- test/ast-structural-gate.test.ts',
  },
  {
    id: 'cross-run-memory',
    title: 'Cross-run memory (Layer 3)',
    status: 'live',
    summary: 'What earlier runs of the factory learned about a unit: which attempts failed, in which class, and what verified. The loop writes a memory when an attempt fails and when a unit commits, reads the tenant\'s memory back before the next attempt, and names the memory ids it wrote and read on the run record. A memory stores the factory\'s own summary, never a target repository\'s content.',
    proves: 'npm test -- test/cross-run-memory.test.ts',
  },
  {
    id: 'security-audit',
    title: 'Machine-readable security audit (Layer 5)',
    status: 'live',
    summary: 'Ten rules over parsed source — hardcoded credentials, dynamic code execution, command injection, disabled TLS verification, the "none" token algorithm, and more — each finding carrying a file, a line, a severity, a remediation, a confidence, and the evidence that produced it. Secret values are masked, so a finding can never carry a credential into the ledger.',
    proves: 'npm test -- test/security-audit.test.ts',
  },
  {
    id: 'model-call-cost',
    title: 'Model call tracing with token, latency and cost (Layer 6)',
    status: 'live',
    summary: 'Every model call is traced with the sanctioned door it left through, the tokens the provider reported (or this service\'s honest estimate), the latency, and the cost — the cost only when the operator declared a price for that model. An unpriced model has an unknown cost, counted separately, never a zero cost.',
    proves: 'npm test -- test/llm-tracing.test.ts',
  },
  {
    id: 'context-compression',
    title: 'Model context compression (Layer 7)',
    status: 'live',
    summary: 'The logs, refusals and diffs that go to a model are reduced before they leave, with every evidence marker — file:line, exit code, error code — protected and restored byte for byte. Source code is never compressed: the implementer must reproduce a file exactly. The run record carries what the compression saved.',
    proves: 'npm test -- test/context-compression.test.ts',
  },
  {
    id: 'observability-dashboards',
    title: 'Dashboards, alerts, on-call',
    status: 'blocked',
    summary: 'The /metrics endpoint exists; paging, dashboards, and on-call routing do not. Names the operator who must unblock it.',
    owner: 'operator',
  },
  {
    id: 'post-deployment-observation',
    title: 'Post-deployment health check and rollback',
    status: 'blocked',
    summary: 'A release must have a health check and rollback target; observation and automated rollback are not yet wired.',
    owner: 'operator',
  },
  {
    id: 'container-executor',
    title: 'Container / microVM executor for untrusted code',
    status: 'blocked',
    summary: 'Replaces the restricted local execution adapter with a container or microVM boundary. Roadmap item 1.',
    owner: 'operator',
  },
  {
    id: 'hosted-deployment',
    title: 'Hosted deployment target with isolated secret injection',
    status: 'blocked',
    summary: 'Connects one hosted deployment target with isolated secret injection. Roadmap item 2.',
    owner: 'operator',
  },
  {
    id: 'external-idp',
    title: 'External identity provider / interactive login',
    status: 'blocked',
    summary: 'Anyone holding a tenant id and its secret has full tenant access; no interactive login or IdP exists yet.',
    owner: 'operator',
  },
  {
    id: 'horizontal-scale',
    title: 'Horizontal scale via shared store',
    status: 'blocked',
    summary: 'Single-writer JSON ledger means exactly one replica; shared store required (NC-2, ADR-015, Proposed).',
    owner: 'engineering',
  },
  {
    id: 'founder-jobs-dry-runs',
    title: 'Founder jobs and client-like dry runs with evidence packs',
    status: 'blocked',
    summary: 'Five founder jobs and three client-like dry runs with evidence packs. Roadmap item 4.',
    owner: 'operator',
  },
  {
    id: 'cycle-time-metrics',
    title: 'Cycle time, defect rate, repair rate, recovery time, product outcomes',
    status: 'blocked',
    summary: 'Measures product outcomes across launches. Roadmap item 5.',
    owner: 'operator',
  },
];

/**
 * Validates a manifest. Throws `CapabilityManifestError` on the first violation. Pure: it reads
 * only its argument, so the same list always yields the same verdict.
 */
export function validateCapabilityManifest(entries: readonly CapabilityEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.title !== 'string' || !entry.title || typeof entry.summary !== 'string' || !entry.summary) {
      throw new CapabilityManifestError('CAPABILITY_INVALID', 'every capability needs a non-empty id, title and summary');
    }
    if (!STATUSES.includes(entry.status)) {
      throw new CapabilityManifestError('CAPABILITY_UNKNOWN_STATUS', `${entry.id} has status '${String(entry.status)}'`);
    }
    if (seen.has(entry.id)) {
      throw new CapabilityManifestError('CAPABILITY_DUPLICATE_ID', `'${entry.id}' is declared more than once`);
    }
    seen.add(entry.id);
    if (entry.status === 'live' && !(entry.proves && entry.proves.trim())) {
      throw new CapabilityManifestError('CAPABILITY_WITHOUT_PROOF', `live capability '${entry.id}' names no command or route that demonstrates it`);
    }
    if (entry.status === 'blocked' && !(entry.owner && entry.owner.trim())) {
      throw new CapabilityManifestError('CAPABILITY_WITHOUT_OWNER', `blocked capability '${entry.id}' names no owner`);
    }
  }
}

/** The built, validated manifest — the exact list every consumer reads. */
export function buildCapabilityManifest(): CapabilityEntry[] {
  validateCapabilityManifest(CAPABILITIES);
  return CAPABILITIES.map((entry) => ({ ...entry }));
}
