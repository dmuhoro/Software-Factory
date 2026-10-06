import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGateId } from './gateIds';

/**
 * Anchor for finding this repository's own `doctrine/` directory.
 *
 * It is derived from *this module's* location, never from the process working directory:
 * a run whose cwd is the target repository must not be able to make the factory load the
 * target's `doctrine/` instead of ours. Under `tsx` the module is ESM and `__dirname` is
 * absent; after `esbuild --bundle --format=cjs` it is CJS and `import.meta.url` is empty.
 * Both are handled here, once.
 */
const MODULE_DIR: string = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

/**
 * Doctrine loader.
 *
 * The doctrine is Software Factory's own configuration for unattended execution. It is loaded
 * from a root that a target repository cannot reach, validated strictly, and pinned by a
 * content manifest so that a file edited mid-run halts the run instead of silently changing the
 * rules under it.
 *
 * Fail-closed is the design rule throughout: an unknown key, a missing gate, a malformed
 * assignment, or a manifest mismatch is a refusal, never a default.
 */

export interface AttemptConfig { maxPerUnit: number }
export interface UnitConfig { maxAcceptanceCriteriaPerMilestone: number; oneCommitPerUnit: boolean }
export interface HardStopConfig { maxWallClockMinutes: number; maxTotalAttempts: number; maxCommits: number; doctrineIntegrity: boolean; resourceExhaustion: boolean }
export interface CommitConfig { requireGroundTruth: boolean; requireVerifiedStatement: boolean; requireProvenanceFooter: boolean; subjectMaxLength: number; refusePathPatterns: string[] }
/** How the driver is permitted to run units. `sequential` is what the loop does today. */
export type ExecutionMode = 'sequential' | 'worktree-parallel';
export interface ConcurrencyConfig { maxParallelDefault: number; maxParallelCeiling: number; minFreeMemMb: number; maxLoadAvgPerCpu: number; execution: ExecutionMode }
export interface VerificationConfig { requireCleanTreeAfterCommit: boolean; requireNonEmptyDiff: boolean; acceptNarratedEvidence: boolean; timeoutMs: number }
export interface LoopConfig {
  version: number;
  stages: string[];
  attempt: AttemptConfig;
  unit: UnitConfig;
  hardStop: HardStopConfig;
  commit: CommitConfig;
  concurrency: ConcurrencyConfig;
  verification: VerificationConfig;
}

export type ModelTier = 'cheap' | 'frontier';
export interface TierDefinition { purpose: string; default: string }
export interface RoleDefinition { tier: ModelTier }
export interface ModelsConfig {
  version: number;
  tiers: Record<ModelTier, TierDefinition>;
  roles: Record<string, RoleDefinition>;
  overrides: { envByRole: string; envByTier: string; taskDocumentPath: string };
  assignmentFormat: string;
  requiredRoles: string[];
}
export interface Rule { id: string; statement: string; enforcement: string; stages: string[]; blocking: boolean }
export interface RulesConfig { version: number; rules: Rule[] }
export interface StageHooks { before: string[]; after: string[] }
export interface HooksConfig { version: number; stages: Record<string, StageHooks> }

export interface ModelAssignment {
  role: string;
  tier: ModelTier;
  providerId: string;
  model: string;
  /** Where the value came from, so a report can state it without guessing. */
  source: 'role-env' | 'tier-env' | 'doctrine' | 'task-document';
}

export interface LoadedDoctrine {
  root: string;
  digest: string;
  loop: LoopConfig;
  models: ModelsConfig;
  rules: RulesConfig;
  hooks: HooksConfig;
}


const MANIFEST = 'manifest.json';
const JSON_FILES = ['loop.json', 'agents/models.json', 'rules/rules.json', 'hooks/hooks.json'] as const;
const DOCUMENTED_FILES = ['README.md', 'DOCTRINE.md', 'loop.json', 'agents/models.json', 'rules/rules.json', 'hooks/hooks.json', 'manifest.json'] as const;

function doctrineError(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail}` : code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) throw doctrineError('DOCTRINE_FILE_MISSING', path.basename(file));
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw doctrineError('DOCTRINE_FILE_UNPARSEABLE', `${path.basename(file)}: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) throw doctrineError('DOCTRINE_FILE_INVALID', `${path.basename(file)} must be an object`);
  return parsed;
}

/** Rejects anything not explicitly permitted. An unknown key is a typo, not a feature. */
function requireKeys(file: string, obj: Record<string, unknown>, allowed: string[], required: string[]): void {
  for (const key of Object.keys(obj)) {
    if (key === '$comment') continue;
    if (!allowed.includes(key)) throw doctrineError('DOCTRINE_UNKNOWN_KEY', `${file}:${key}`);
  }
  for (const key of required) {
    if (!(key in obj)) throw doctrineError('DOCTRINE_MISSING_KEY', `${file}:${key}`);
  }
}

function reqNumber(file: string, obj: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:${key} must be a number`);
  if (value < min || value > max) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:${key} must be within [${min}, ${max}]`);
  return value;
}

function reqBoolean(file: string, obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:${key} must be a boolean`);
  return value;
}

function executionRaw(obj: Record<string, unknown>): Record<string, unknown> {
  const value = obj.execution;
  if (typeof value !== 'string' || !value.trim()) throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json:concurrency:execution must be a non-empty string');
  return { execution: value };
}

function reqString(file: string, obj: Record<string, unknown>, key: string, max = 500): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value.trim()) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:${key} must be a non-empty string`);
  if (value.length > max) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:${key} exceeds ${max} chars`);
  return value;
}

function reqStringArray(file: string, obj: Record<string, unknown>, key: string, min: number, max: number): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:${key} must be an array of non-empty strings`);
  }
  if (value.length < min || value.length > max) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:${key} must have ${min}..${max} entries`);
  return value as string[];
}

export function parseLoopConfig(raw: Record<string, unknown>): LoopConfig {
  const file = 'loop.json';
  requireKeys(file, raw, ['version', 'stages', 'attempt', 'unit', 'hardStop', 'commit', 'concurrency', 'verification'], ['version', 'stages', 'attempt', 'unit', 'hardStop', 'commit', 'concurrency', 'verification']);
  const version = reqNumber(file, raw, 'version', 1, 1_000_000);
  const stages = reqStringArray(file, raw, 'stages', 2, 10);
  if (stages.join(',') !== 'plan,implement,verify,review,commit,report') {
    throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json:stages must be exactly plan,implement,verify,review,commit,report');
  }

  const attempt = raw.attempt; if (!isPlainObject(attempt)) throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json:attempt');
  requireKeys('loop.json:attempt', attempt, ['maxPerUnit'], ['maxPerUnit']);
  const maxPerUnit = reqNumber('loop.json:attempt', attempt, 'maxPerUnit', 1, 10);

  const unit = raw.unit; if (!isPlainObject(unit)) throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json:unit');
  requireKeys('loop.json:unit', unit, ['maxAcceptanceCriteriaPerMilestone', 'oneCommitPerUnit'], ['maxAcceptanceCriteriaPerMilestone', 'oneCommitPerUnit']);
  const maxCriteria = reqNumber('loop.json:unit', unit, 'maxAcceptanceCriteriaPerMilestone', 1, 50);
  const oneCommit = reqBoolean('loop.json:unit', unit, 'oneCommitPerUnit');

  const hardStop = raw.hardStop; if (!isPlainObject(hardStop)) throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json:hardStop');
  requireKeys('loop.json:hardStop', hardStop, ['maxWallClockMinutes', 'maxTotalAttempts', 'maxCommits', 'doctrineIntegrity', 'resourceExhaustion'], ['maxWallClockMinutes', 'maxTotalAttempts', 'maxCommits', 'doctrineIntegrity', 'resourceExhaustion']);

  const commit = raw.commit; if (!isPlainObject(commit)) throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json:commit');
  requireKeys('loop.json:commit', commit, ['requireGroundTruth', 'requireVerifiedStatement', 'requireProvenanceFooter', 'subjectMaxLength', 'refusePathPatterns'], ['requireGroundTruth', 'requireVerifiedStatement', 'requireProvenanceFooter', 'subjectMaxLength', 'refusePathPatterns']);
  const refusePathPatterns = reqStringArray('loop.json:commit', commit, 'refusePathPatterns', 1, 200);

  const concurrency = raw.concurrency; if (!isPlainObject(concurrency)) throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json:concurrency');
  requireKeys('loop.json:concurrency', concurrency, ['maxParallelDefault', 'maxParallelCeiling', 'minFreeMemMb', 'maxLoadAvgPerCpu', 'execution'], ['maxParallelDefault', 'maxParallelCeiling', 'minFreeMemMb', 'maxLoadAvgPerCpu', 'execution']);
  const execution = reqString('loop.json:concurrency', executionRaw(concurrency), 'execution', 40) as ExecutionMode;
  if (execution !== 'sequential' && execution !== 'worktree-parallel') {
    throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json:concurrency:execution must be sequential or worktree-parallel');
  }

  const verification = raw.verification; if (!isPlainObject(verification)) throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json:verification');
  requireKeys('loop.json:verification', verification, ['requireCleanTreeAfterCommit', 'requireNonEmptyDiff', 'acceptNarratedEvidence', 'timeoutMs'], ['requireCleanTreeAfterCommit', 'requireNonEmptyDiff', 'acceptNarratedEvidence', 'timeoutMs']);

  const config: LoopConfig = {
    version,
    stages,
    attempt: { maxPerUnit },
    unit: { maxAcceptanceCriteriaPerMilestone: maxCriteria, oneCommitPerUnit: oneCommit },
    hardStop: {
      maxWallClockMinutes: reqNumber('loop.json:hardStop', hardStop, 'maxWallClockMinutes', 1, 100_000),
      maxTotalAttempts: reqNumber('loop.json:hardStop', hardStop, 'maxTotalAttempts', 1, 100_000),
      maxCommits: reqNumber('loop.json:hardStop', hardStop, 'maxCommits', 1, 100_000),
      doctrineIntegrity: reqBoolean('loop.json:hardStop', hardStop, 'doctrineIntegrity'),
      resourceExhaustion: reqBoolean('loop.json:hardStop', hardStop, 'resourceExhaustion'),
    },
    commit: {
      requireGroundTruth: reqBoolean('loop.json:commit', commit, 'requireGroundTruth'),
      requireVerifiedStatement: reqBoolean('loop.json:commit', commit, 'requireVerifiedStatement'),
      requireProvenanceFooter: reqBoolean('loop.json:commit', commit, 'requireProvenanceFooter'),
      subjectMaxLength: reqNumber('loop.json:commit', commit, 'subjectMaxLength', 20, 200),
      refusePathPatterns,
    },
    concurrency: {
      execution,
      maxParallelDefault: reqNumber('loop.json:concurrency', concurrency, 'maxParallelDefault', 1, 64),
      maxParallelCeiling: reqNumber('loop.json:concurrency', concurrency, 'maxParallelCeiling', 1, 64),
      minFreeMemMb: reqNumber('loop.json:concurrency', concurrency, 'minFreeMemMb', 0, 1_000_000),
      maxLoadAvgPerCpu: reqNumber('loop.json:concurrency', concurrency, 'maxLoadAvgPerCpu', 0.1, 1000),
    },
    verification: {
      requireCleanTreeAfterCommit: reqBoolean('loop.json:verification', verification, 'requireCleanTreeAfterCommit'),
      requireNonEmptyDiff: reqBoolean('loop.json:verification', verification, 'requireNonEmptyDiff'),
      acceptNarratedEvidence: reqBoolean('loop.json:verification', verification, 'acceptNarratedEvidence'),
      timeoutMs: reqNumber('loop.json:verification', verification, 'timeoutMs', 1_000, 600_000),
    },
  };
  if (config.concurrency.maxParallelCeiling < config.concurrency.maxParallelDefault) {
    throw doctrineError('DOCTRINE_INVALID_VALUE', 'loop.json: ceiling must be >= default');
  }
  return config;
}

export function parseModelsConfig(raw: Record<string, unknown>): ModelsConfig {
  const file = 'agents/models.json';
  requireKeys(file, raw, ['version', 'tiers', 'roles', 'overrides', 'assignmentFormat', 'requiredRoles'], ['version', 'tiers', 'roles', 'overrides', 'assignmentFormat', 'requiredRoles']);
  const version = reqNumber(file, raw, 'version', 1, 1_000_000);
  const tiersRaw = raw.tiers; if (!isPlainObject(tiersRaw)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:tiers`);
  const tiers = {} as Record<ModelTier, TierDefinition>;
  for (const tier of ['cheap', 'frontier'] as const) {
    const entry = tiersRaw[tier];
    if (!isPlainObject(entry)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:tiers.${tier}`);
    requireKeys(`${file}:tiers.${tier}`, entry, ['purpose', 'default'], ['purpose', 'default']);
    const assignment = reqString(`${file}:tiers.${tier}`, entry, 'default', 260);
    assertAssignmentShape(assignment, `${file}:tiers.${tier}.default`);
    tiers[tier] = { purpose: reqString(`${file}:tiers.${tier}`, entry, 'purpose', 500), default: assignment };
  }
  for (const key of Object.keys(tiersRaw)) {
    if (key !== 'cheap' && key !== 'frontier') throw doctrineError('DOCTRINE_UNKNOWN_KEY', `${file}:tiers.${key}`);
  }

  const rolesRaw = raw.roles; if (!isPlainObject(rolesRaw)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:roles`);
  const roles: Record<string, RoleDefinition> = {};
  for (const [role, definition] of Object.entries(rolesRaw)) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(role)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:roles key "${role}" must be lowercase kebab`);
    if (!isPlainObject(definition)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:roles.${role}`);
    requireKeys(`${file}:roles.${role}`, definition, ['tier'], ['tier']);
    const tier = definition.tier;
    if (tier !== 'cheap' && tier !== 'frontier') throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:roles.${role}.tier must be cheap or frontier`);
    roles[role] = { tier };
  }

  const overrides = raw.overrides; if (!isPlainObject(overrides)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:overrides`);
  requireKeys(`${file}:overrides`, overrides, ['envByRole', 'envByTier', 'taskDocumentPath'], ['envByRole', 'envByTier', 'taskDocumentPath']);
  const requiredRoles = reqStringArray(file, raw, 'requiredRoles', 1, 100);
  for (const role of requiredRoles) if (!roles[role]) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:requiredRoles names unknown role ${role}`);

  const assignmentFormat = reqString(file, raw, 'assignmentFormat', 64);
  if (assignmentFormat !== '<providerId>/<model>') throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:assignmentFormat must be <providerId>/<model>`);

  return {
    version,
    tiers,
    roles,
    overrides: {
      envByRole: reqString(`${file}:overrides`, overrides, 'envByRole', 120),
      envByTier: reqString(`${file}:overrides`, overrides, 'envByTier', 120),
      taskDocumentPath: reqString(`${file}:overrides`, overrides, 'taskDocumentPath', 120),
    },
    assignmentFormat,
    requiredRoles,
  };
}

export function parseRulesConfig(raw: Record<string, unknown>): RulesConfig {
  const file = 'rules/rules.json';
  requireKeys(file, raw, ['version', 'rules'], ['version', 'rules']);
  const version = reqNumber(file, raw, 'version', 1, 1_000_000);
  const rulesRaw = raw.rules;
  if (!Array.isArray(rulesRaw) || rulesRaw.length === 0) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:rules must be a non-empty array`);
  const rules: Rule[] = rulesRaw.map((entry, index) => {
    if (!isPlainObject(entry)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:rules[${index}]`);
    requireKeys(`${file}:rules[${index}]`, entry, ['id', 'statement', 'enforcement', 'stages', 'blocking'], ['id', 'statement', 'enforcement', 'stages', 'blocking']);
    return {
      id: reqString(`${file}:rules[${index}]`, entry, 'id', 64),
      statement: reqString(`${file}:rules[${index}]`, entry, 'statement', 600),
      enforcement: reqString(`${file}:rules[${index}]`, entry, 'enforcement', 64),
      stages: reqStringArray(`${file}:rules[${index}]`, entry, 'stages', 1, 5),
      blocking: reqBoolean(`${file}:rules[${index}]`, entry, 'blocking'),
    };
  });
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}: duplicate rule ${rule.id}`);
    ids.add(rule.id);
  }
  return { version, rules };
}

export function parseHooksConfig(raw: Record<string, unknown>): HooksConfig {
  const file = 'hooks/hooks.json';
  requireKeys(file, raw, ['version', 'stages'], ['version', 'stages']);
  const version = reqNumber(file, raw, 'version', 1, 1_000_000);
  const stagesRaw = raw.stages;
  if (!isPlainObject(stagesRaw)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:stages`);
  const stages: Record<string, StageHooks> = {};
  for (const [stage, entry] of Object.entries(stagesRaw)) {
    if (!isPlainObject(entry)) throw doctrineError('DOCTRINE_INVALID_VALUE', `${file}:stages.${stage}`);
    requireKeys(`${file}:stages.${stage}`, entry, ['before', 'after'], ['before', 'after']);
    stages[stage] = {
      before: reqStringArray(`${file}:stages.${stage}`, entry, 'before', 0, 20),
      after: reqStringArray(`${file}:stages.${stage}`, entry, 'after', 0, 20),
    };
  }
  return { version, stages };
}

/** `providerId/model` — provider may not be empty, model may contain `/` and `:`. */
export function assertAssignmentShape(value: string, where: string): { providerId: string; model: string } {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) throw doctrineError('MODEL_ASSIGNMENT_INVALID', where);
  const providerId = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(providerId)) throw doctrineError('MODEL_ASSIGNMENT_INVALID', `${where}: provider "${providerId}"`);
  if (model.length > 128 || !model.trim()) throw doctrineError('MODEL_ASSIGNMENT_INVALID', `${where}: model`);
  if (/\s/.test(model)) throw doctrineError('MODEL_ASSIGNMENT_INVALID', `${where}: model must not contain whitespace`);
  return { providerId, model };
}

export function envKey(template: string, name: string): string {
  return template.replace('{ROLE}', name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')).replace('{TIER}', name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
}

export class DoctrineService {
  /**
   * The authoritative root. Never derived from the working directory, so a target repository's
   * own `doctrine/` cannot be picked up by running the loop from inside it.
   */
  public static root(): string {
    const configured = process.env.FACTORY_DOCTRINE_ROOT;
    if (configured && configured.trim()) return path.resolve(configured);
    let dir = MODULE_DIR;
    for (let depth = 0; depth < 10; depth += 1) {
      const candidate = path.join(dir, 'doctrine');
      if (fs.existsSync(path.join(candidate, 'loop.json'))) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.resolve(MODULE_DIR, 'doctrine');
  }

  public static file(relative: string): string {
    return path.join(this.root(), relative);
  }

  private static cached?: { root: string; digest: string; loaded: LoadedDoctrine };

  /** Loads and validates everything. Cached per root so a mid-run edit is caught by `verifyDigest`. */
  public static load(): LoadedDoctrine {
    const root = this.root();
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw doctrineError('DOCTRINE_ROOT_MISSING', root);
    const digest = this.digest();
    if (this.cached && this.cached.root === root && this.cached.digest === digest) return this.cached.loaded;
    const loop = parseLoopConfig(readJson(path.join(root, 'loop.json')));
    const models = parseModelsConfig(readJson(path.join(root, 'agents/models.json')));
    const rules = parseRulesConfig(readJson(path.join(root, 'rules/rules.json')));
    const hooks = parseHooksConfig(readJson(path.join(root, 'hooks/hooks.json')));
    for (const stage of loop.stages) {
      if (!hooks.stages[stage]) throw doctrineError('DOCTRINE_INVALID_VALUE', `hooks/hooks.json has no entry for stage ${stage}`);
    }
    for (const [stage, entry] of Object.entries(hooks.stages)) {
      if (!loop.stages.includes(stage)) throw doctrineError('DOCTRINE_INVALID_VALUE', `hooks/hooks.json declares unknown stage ${stage}`);
      if (entry.before.length + entry.after.length === 0) throw doctrineError('DOCTRINE_INVALID_VALUE', `hooks/hooks.json stage ${stage} declares no hooks`);
    }
    // A rule or a hook naming a gate that does not exist is a rule nobody enforces. Refusing
    // here means the doctrine cannot be loaded in a shape that would let the loop run unguarded.
    for (const [stage, entry] of Object.entries(hooks.stages)) {
      for (const id of [...entry.before, ...entry.after]) {
        if (!isGateId(id)) throw doctrineError('DOCTRINE_GATE_UNKNOWN', `hooks/hooks.json stage ${stage}: ${id}`);
      }
    }
    for (const rule of rules.rules) {
      if (!isGateId(rule.enforcement)) throw doctrineError('DOCTRINE_GATE_UNKNOWN', `rules/rules.json ${rule.id}: ${rule.enforcement}`);
    }
    const loaded: LoadedDoctrine = { root, digest, loop, models, rules, hooks };
    this.cached = { root, digest, loaded };
    return loaded;
  }

  public static clearCache(): void { this.cached = undefined; }

  /** sha256 over `relpath\ncontent` for every manifest-listed file, sorted by path. */
  public static digest(): string {
    const entries = this.manifestEntries();
    const hash = crypto.createHash('sha256');
    for (const file of Object.keys(entries).sort()) {
      const full = path.join(this.root(), file);
      if (!fs.existsSync(full)) throw doctrineError('DOCTRINE_FILE_MISSING', file);
      hash.update(`${file}\n`);
      hash.update(fs.readFileSync(full));
      hash.update('\n');
    }
    return `sha256:${hash.digest('hex')}`;
  }

  /** The recorded manifest: `{ files: { path: sha256 } }`. */
  public static manifestEntries(): Record<string, string> {
    const file = this.file(MANIFEST);
    if (!fs.existsSync(file)) throw doctrineError('DOCTRINE_MANIFEST_MISSING', MANIFEST);
    const raw = readJson(file);
    requireKeys(MANIFEST, raw, ['version', 'files'], ['version', 'files']);
    const files = raw.files;
    if (!isPlainObject(files)) throw doctrineError('DOCTRINE_MANIFEST_INVALID', 'files');
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(files)) {
      if (typeof value !== 'string' || !value.startsWith('sha256:')) throw doctrineError('DOCTRINE_MANIFEST_INVALID', key);
      entries[key] = value;
    }
    return entries;
  }

  public static verifyManifest(): { ok: boolean; mismatches: string[]; missing: string[]; unexpected: string[] } {
    const entries = this.manifestEntries();
    const mismatches: string[] = [];
    const missing: string[] = [];
    for (const [file, expected] of Object.entries(entries)) {
      const full = path.join(this.root(), file);
      if (!fs.existsSync(full)) { missing.push(file); continue; }
      const actual = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
      if (actual !== expected) mismatches.push(file);
    }
    // Files present on disk but absent from the manifest are just as much a tamper signal: a
    // rule file nobody hashed is a rule file nobody checked.
    const onDisk = this.walk(this.root()).filter((file) => file !== MANIFEST);
    const unexpected = onDisk.filter((file) => !(file in entries));
    return { ok: mismatches.length === 0 && missing.length === 0 && unexpected.length === 0, mismatches, missing, unexpected };
  }

  private static walk(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...this.walk(path.join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  }

  public static manifestFileList(): string[] {
    return DOCUMENTED_FILES.slice().sort();
  }

  /** Documented file list — what the manifest must cover. */
  public static documentedFiles(): readonly string[] { return DOCUMENTED_FILES; }

  public static stageHooks(stage: string): StageHooks {
    const hooks = this.load().hooks.stages[stage];
    if (!hooks) throw doctrineError('DOCTRINE_STAGE_UNKNOWN', stage);
    return hooks;
  }

  public static rules(): Rule[] { return this.load().rules.rules; }

  /**
   * Resolves a role's model assignment. Precedence: role env, tier env, task-document
   * override, doctrine default for the role's tier. Fails closed when the role is unknown or
   * the resolved value is malformed.
   */
  public static modelFor(role: string, taskOverrides?: Record<string, string>): ModelAssignment {
    const models = this.load().models;
    const definition = models.roles[role];
    if (!definition) throw doctrineError('MODEL_ROLE_UNKNOWN', role);

    const roleEnv = process.env[envKey(models.overrides.envByRole, role)];
    if (roleEnv && roleEnv.trim()) {
      const { providerId, model } = assertAssignmentShape(roleEnv.trim(), `env:${role}`);
      return { role, tier: definition.tier, providerId, model, source: 'role-env' };
    }
    const tierEnv = process.env[envKey(models.overrides.envByTier, definition.tier)];
    if (tierEnv && tierEnv.trim()) {
      const { providerId, model } = assertAssignmentShape(tierEnv.trim(), `env:${definition.tier}`);
      return { role, tier: definition.tier, providerId, model, source: 'tier-env' };
    }
    const fromDocument = taskOverrides?.[role];
    if (fromDocument && fromDocument.trim()) {
      const { providerId, model } = assertAssignmentShape(fromDocument.trim(), `task:${role}`);
      return { role, tier: definition.tier, providerId, model, source: 'task-document' };
    }
    const fallback = models.tiers[definition.tier].default;
    const { providerId, model } = assertAssignmentShape(fallback, `doctrine:${definition.tier}`);
    return { role, tier: definition.tier, providerId, model, source: 'doctrine' };
  }

  /** Every required role resolved, so a gate can assert the whole roster in one pass. */
  public static allAssignments(taskOverrides?: Record<string, string>): ModelAssignment[] {
    return this.load().models.requiredRoles.map((role) => this.modelFor(role, taskOverrides));
  }
}
