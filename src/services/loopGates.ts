import { execFileSync } from 'node:child_process';
import { GATE_IDS, type GateId } from './gateIds';
import { DoctrineService } from './doctrineService';
import { DoctrineIsolationService, type IsolationManifest } from './doctrineIsolationService';
import { ResourceGovernorService } from './resourceGovernorService';
import type { GroundTruthProof } from './groundTruthService';
import { stageAndScanSecrets } from './commitService';
import { detectVerificationProfile } from './verificationProfileService';
import { isGitRepository } from '../utils/pathGuard';
import type { GateResult, LoopRunRecord, LoopStage, UnitRecord } from './loopTypes';
import type { WorkUnit } from './taskDocumentService';

/**
 * The gate registry: doctrine's hook ids, bound to code that actually checks something.
 *
 * A hook id with no implementation is a stage that claims to be guarded and is not, which is the
 * failure mode this whole layer exists to prevent. Two defences:
 *
 *  - `assertRegistryComplete()` requires an implementation for every id in `gateIds.ts`, and the
 *    loop calls it before it does any work.
 *  - `doctrineService.load()` refuses a rule or a hook naming an id that is not in that list, so
 *    the doctrine cannot describe a gate nobody can write.
 *
 * Gates do not throw for a refusal. They return `{passed:false, detail}` and the caller decides
 * whether the stage stops — so a refusal always reaches the run record with its reason.
 */

export interface GateContext {
  stage: LoopStage;
  timing: 'before' | 'after';
  repo: string;
  isolation: IsolationManifest;
  run: LoopRunRecord;
  unit?: UnitRecord;
  proof?: GroundTruthProof;
  /** Model assignments from the task document, if the run has them. */
  taskOverrides?: Record<string, string>;
  /** The plan's units, required by `plan-is-executable`. */
  units?: WorkUnit[];
  /** Commits created inside the current unit, required by `one-commit-per-unit`. */
  commitsInUnit?: number;
  /** Provider ids registered for the run's tenant, required by `model-assignment`. */
  tenantProviders?: Set<string>;
  /** Roles this run actually calls. Every role must resolve; only these must be provisioned. */
  usedRoles?: string[];
}

export interface GateOutcome {
  passed: boolean;
  detail: string;
}

type GateFn = (ctx: GateContext) => GateOutcome;

function git(repo: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: (out ?? '').trim() };
  } catch (error: any) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    return { code: typeof error.status === 'number' ? error.status : 1, out };
  }
}

const REGISTRY: Record<GateId, GateFn> = {
  'doctrine-integrity': (ctx) => {
    const verification = DoctrineService.verifyManifest();
    const reasons = [...verification.mismatches.map((file) => `changed:${file}`), ...verification.missing.map((file) => `missing:${file}`), ...verification.unexpected.map((file) => `unhashed:${file}`)];
    return verification.ok
      ? { passed: true, detail: `manifest verified, digest ${ctx.run.doctrineDigest.slice(0, 19)}…` }
      : { passed: false, detail: `doctrine manifest drift: ${reasons.join(', ')}` };
  },

  'doctrine-isolation': (ctx) => {
    const verification = DoctrineIsolationService.verify(ctx.isolation);
    return verification.ok
      ? { passed: true, detail: `${ctx.isolation.quarantine.length} instruction file(s) still match their quarantine hashes` }
      : { passed: false, detail: verification.reasons.join('; ') };
  },

  'resource-admission': () => {
    const admission = ResourceGovernorService.admit(1);
    return admission.admitted
      ? { passed: true, detail: `free=${admission.freeMemMb}MB load/cpu=${admission.loadAvgPerCpu} cpus=${admission.cpus} cap=${admission.maxParallel}` }
      : { passed: false, detail: admission.reasons.join('; ') };
  },

  'plan-is-executable': (ctx) => {
    if (!isGitRepository(ctx.repo)) return { passed: false, detail: `not a git repository: ${ctx.repo}` };
    const units = ctx.units ?? [];
    if (!units.length) return { passed: false, detail: 'the plan contains no work units' };
    const ids = new Set<string>();
    for (const unit of units) {
      if (ids.has(unit.id)) return { passed: false, detail: `duplicate unit id ${unit.id}` };
      ids.add(unit.id);
      if (!unit.criteria.length) return { passed: false, detail: `unit ${unit.id} has no acceptance criterion` };
      if (unit.criteria.length > 10) return { passed: false, detail: `unit ${unit.id} carries ${unit.criteria.length} criteria` };
      for (const dep of unit.dependsOn) {
        if (!ids.has(dep) && !units.some((item) => item.id === dep)) return { passed: false, detail: `unit ${unit.id} depends on unknown unit ${dep}` };
      }
    }
    const profile = detectVerificationProfile(ctx.repo);
    const unverifiable = units.filter((unit) => !(unit.verify ?? '').trim() && profile.steps.length === 0);
    if (unverifiable.length) return { passed: false, detail: `no verification command available for: ${unverifiable.map((unit) => unit.id).join(', ')}` };
    return { passed: true, detail: `${units.length} unit(s), verification via ${profile.id}` };
  },

  'model-assignment': (ctx) => {
    try {
      // Every declared role must resolve to a well-formed `<providerId>/<model>` — that is the
      // refusal this gate exists for. Registration is only required for the roles this run will
      // actually call: a planner nobody dials must still be assigned, not provisioned.
      const assignments = DoctrineService.allAssignments(ctx.taskOverrides);
      const used = new Set(ctx.usedRoles ?? ['implementer']);
      const registered = ctx.tenantProviders ?? new Set<string>();
      const missing = assignments.filter((assignment) => used.has(assignment.role) && !registered.has(assignment.providerId));
      if (missing.length) return { passed: false, detail: `provider not registered for: ${missing.map((item) => `${item.role}=${item.providerId}`).join(', ')}` };
      const called = assignments.filter((assignment) => used.has(assignment.role));
      return { passed: true, detail: `${assignments.length} role(s) resolved; this run calls ${called.map((item) => `${item.role}=${item.providerId}/${item.model}(${item.source})`).join('; ')}` };
    } catch (error) {
      return { passed: false, detail: (error as Error).message };
    }
  },

  'claimed-files-exist': (ctx) => {
    const proof = ctx.proof;
    if (!proof) return { passed: false, detail: 'no proof was produced for this stage' };
    if (!proof.claimedFiles.length) return { passed: false, detail: 'the implementer claimed no files, so there is nothing to review' };
    const failed = proof.checks.filter((check) => check.id.startsWith('diff:claimed:') && !check.passed);
    if (failed.length) return { passed: false, detail: failed.map((check) => `${check.id}: ${check.outputTail ?? ''}`).join('; ') };
    if (!proof.observedFiles.length) return { passed: false, detail: 'the working tree is identical to HEAD: no change was made' };
    return { passed: true, detail: `${proof.claimedFiles.length} claimed file(s), all observed to differ from HEAD` };
  },

  'ground-truth': (ctx) => {
    const proof = ctx.proof;
    if (!proof) return { passed: false, detail: 'no proof was produced for this stage' };
    const commands = proof.checks.filter((check) => check.kind === 'command');
    const failed = proof.checks.filter((check) => !check.passed);
    if (!commands.length) return { passed: false, detail: 'no command was executed, so nothing is verified (narration is not evidence)' };
    if (!proof.passed) return { passed: false, detail: failed.map((check) => `${check.id} exit ${check.exitCode}`).join('; ') };
    return { passed: true, detail: `${commands.length} command(s) exited 0; ${proof.rejectedNarration.length} narration claim(s) discarded` };
  },

  'attempt-cap': (ctx) => {
    const cap = ctx.run.attemptCap;
    const attempt = ctx.run.units.find((unit) => unit.unitId === ctx.unit?.unitId)?.attempts.length ?? 0;
    if (attempt > cap) return { passed: false, detail: `unit ${ctx.unit?.unitId} has used ${attempt} attempts; the cap is ${cap}` };
    return { passed: true, detail: `attempt ${attempt} of ${cap}` };
  },

  'secret-scan': (ctx) => {
    try {
      const { files } = stageAndScanSecrets(ctx.repo, DoctrineService.load().loop.commit.refusePathPatterns);
      return files.length
        ? { passed: true, detail: `${files.length} staged path(s) scanned against ${DoctrineService.load().loop.commit.refusePathPatterns.length} credential patterns; none matched` }
        : { passed: true, detail: 'nothing staged: no content to scan' };
    } catch (error) {
      return { passed: false, detail: (error as Error).message };
    }
  },

  'clean-tree': (ctx) => {
    const status = git(ctx.repo, ['status', '--porcelain']);
    if (status.code !== 0) return { passed: false, detail: `git status failed: ${status.out.slice(-200)}` };
    return status.out === ''
      ? { passed: true, detail: 'the working tree is clean' }
      : { passed: false, detail: `left behind: ${status.out.split('\n').slice(0, 10).join(', ')}` };
  },

  'verified-commit-message': (ctx) => {
    const message = git(ctx.repo, ['log', '-1', '--format=%B']);
    if (message.code !== 0 || !message.out) return { passed: false, detail: `no commit to read: ${message.out.slice(-200)}` };
    const missing: string[] = [];
    if (!/^Verified:/m.test(message.out)) missing.push('Verified: statement');
    if (!/^Proof: sha256:/m.test(message.out)) missing.push('Proof: digest');
    if (DoctrineService.load().loop.commit.requireProvenanceFooter && !/^AI-Assisted:/m.test(message.out)) missing.push('AI-Assisted: footer');
    return missing.length
      ? { passed: false, detail: `HEAD message is missing ${missing.join(', ')}` }
      : { passed: true, detail: `HEAD ${message.out.slice(0, 12)}… carries the verified statement and the provenance footer` };
  },

  'one-commit-per-unit': (ctx) => {
    const count = ctx.commitsInUnit ?? 0;
    return count === 1
      ? { passed: true, detail: 'exactly one commit for this unit' }
      : { passed: false, detail: `${count} commits created for unit ${ctx.unit?.unitId}; doctrine requires exactly one` };
  },

  'evidence-is-machine-derived': (ctx) => {
    const proof = ctx.proof;
    if (!proof) {
      // Auditing evidence only matters when the report claims some. A run that verified nothing
      // says so, and a run that carries commits without their proof is the dishonest case.
      return ctx.run.commits.length === 0
        ? { passed: true, detail: `the report claims no evidence: 0 commits, ${ctx.run.units.filter((unit) => unit.status === 'stuck').length} unit(s) recorded STUCK` }
        : { passed: false, detail: `${ctx.run.commits.length} commit(s) are reported with no machine-derived proof attached` };
    }
    if (!proof.checks.length) return { passed: false, detail: 'the proof contains no checks' };
    const malformed = proof.checks.filter((check) => typeof check.exitCode !== 'number' || !check.startedAt || !check.completedAt);
    if (malformed.length) return { passed: false, detail: `${malformed.length} check(s) carry no exit code or timing` };
    // Narration is recorded, never folded into a check: assert the two sets are disjoint.
    const narrationFolded = proof.checks.filter((check) => check.id.startsWith('narration'));
    if (narrationFolded.length) return { passed: false, detail: 'a narration claim was recorded as a check' };
    return { passed: true, detail: `${proof.checks.length} check(s) with exit codes; ${proof.rejectedNarration.length} narration claim(s) excluded from the evidence` };
  },
};

export function assertRegistryComplete(): void {
  for (const id of GATE_IDS) {
    if (!REGISTRY[id]) throw new Error(`GATE_NOT_IMPLEMENTED:${id}`);
  }
}

/** Is this id blocking for this run? A rule that declares `blocking: false` is advisory. */
function blockingFor(id: string): boolean {
  const rule = DoctrineService.rules().find((item) => item.enforcement === id);
  return rule ? rule.blocking : true;
}

export function runGate(id: string, ctx: GateContext): GateResult {
  const fn = REGISTRY[id as GateId];
  const outcome = fn ? fn(ctx) : { passed: false, detail: `no implementation for gate ${id}` };
  return {
    id,
    stage: ctx.stage,
    timing: ctx.timing,
    passed: outcome.passed,
    blocking: fn ? blockingFor(id) : true,
    detail: outcome.detail,
    checkedAt: new Date().toISOString(),
  };
}

export interface StageGateOutcome {
  stage: LoopStage;
  timing: 'before' | 'after';
  results: GateResult[];
  ok: boolean;
  refusals: GateResult[];
}

/** Runs every hook id doctrine declares for this stage and timing. */
export function runStageGates(stage: LoopStage, timing: 'before' | 'after', ctx: Omit<GateContext, 'stage' | 'timing'>): StageGateOutcome {
  const hooks = DoctrineService.stageHooks(stage)[timing];
  const results = hooks.map((id) => runGate(id, { ...ctx, stage, timing }));
  const refusals = results.filter((result) => !result.passed && result.blocking);
  return { stage, timing, results, ok: refusals.length === 0, refusals };
}

/** Runs the hooks and throws a single refusal naming every gate that failed. */
export function assertStageGates(stage: LoopStage, timing: 'before' | 'after', ctx: Omit<GateContext, 'stage' | 'timing'>): GateResult[] {
  const outcome = runStageGates(stage, timing, ctx);
  if (!outcome.ok) {
    const detail = outcome.refusals.map((item) => `${item.id}: ${item.detail}`).join(' | ');
    throw new Error(`GATE_REFUSED:${stage}:${outcome.refusals.map((item) => item.id).join(',')}:${detail}`);
  }
  return outcome.results;
}

export function registeredGateIds(): GateId[] {
  return GATE_IDS.filter((id) => Boolean(REGISTRY[id]));
}

