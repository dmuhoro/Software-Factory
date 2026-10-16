/**
 * The skills registry: declarative capability definitions the factory can be told about.
 *
 * A capability that lives only as TypeScript is a capability the factory ships with. A capability
 * declared as a file is one an operator can add, review, and remove without a release — which is the
 * pattern the `skills` reference named. This module adopts the pattern, not the repository: it
 * defines a small, strict file format, parses it without a YAML dependency, and refuses anything it
 * does not fully understand.
 *
 * The format is one fenced frontmatter block then a markdown body:
 *
 *     ---
 *     name: repo-hygiene
 *     description: One sentence on what this skill does.
 *     version: 1.0.0
 *     tools: read, write
 *     enabled: true
 *     ---
 *     # Repo hygiene
 *     ...body...
 *
 * The rules are fail-closed and pure (no clock, no model, no I/O in the parser): an unknown field,
 * a missing required field, a bad version, a duplicate field, or an empty body all refuse the file
 * with a machine-readable code. A refused file is reported, never silently ignored.
 *
 * The registry is read-only from the API's point of view; loading reads a directory of `*.skill.md`
 * files. The directory defaults to `<cwd>/skills` and can be pointed elsewhere with
 * `FACTORY_SKILLS_DIR` (tests use a temp directory).
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  tools: string[];
  enabled: boolean;
  body: string;
  /** The file this skill was read from, for the operator reading a refusal or a listing. */
  source: string;
}

export type SkillErrorCode =
  | 'SKILL_MISSING_FRONTMATTER'
  | 'SKILL_UNKNOWN_FIELD'
  | 'SKILL_DUPLICATE_FIELD'
  | 'SKILL_INVALID_FIELD'
  | 'SKILL_MISSING_FIELD'
  | 'SKILL_INVALID_NAME'
  | 'SKILL_INVALID_VERSION'
  | 'SKILL_EMPTY_BODY'
  | 'SKILL_UNPINNED'
  | 'SKILL_PIN_MISMATCH'
  | 'SKILL_LOCK_INVALID'
  | 'SKILL_NAMES_EGRESS';

export class SkillError extends Error {
  public readonly code: SkillErrorCode;
  constructor(code: SkillErrorCode, detail: string) {
    super(`${code}:${detail}`);
    this.name = 'SkillError';
    this.code = code;
  }
}

const ALLOWED_FIELDS = new Set(['name', 'description', 'version', 'tools', 'enabled']);
const REQUIRED_FIELDS = ['name', 'description', 'version'] as const;
const SKILL_FILE = /\.skill\.md$/;

/** The directory skills are loaded from. Overridable so a deployment (or a test) can point elsewhere. */
export function resolveSkillsDir(): string {
  const configured = process.env.FACTORY_SKILLS_DIR;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.resolve(process.cwd(), 'skills');
}

function parseFrontmatter(raw: string, source: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new SkillError('SKILL_MISSING_FRONTMATTER', `${source}: a skill must begin with a '---' frontmatter block`);
  const fields: Record<string, string> = {};
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) throw new SkillError('SKILL_INVALID_FIELD', `${source}: '${line}' is not a 'key: value' line`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!ALLOWED_FIELDS.has(key)) throw new SkillError('SKILL_UNKNOWN_FIELD', `${source}: unknown field '${key}'`);
    if (key in fields) throw new SkillError('SKILL_DUPLICATE_FIELD', `${source}: field '${key}' appears twice`);
    fields[key] = value;
  }
  return { fields, body: match[2].trim() };
}

/** Parses one skill file's text. Pure: no I/O, no clock, deterministic. Throws `SkillError`. */
export function parseSkillFile(raw: string, source: string): SkillDefinition {
  const { fields, body } = parseFrontmatter(raw, source);
  for (const required of REQUIRED_FIELDS) {
    if (!fields[required]) throw new SkillError('SKILL_MISSING_FIELD', `${source}: missing required field '${required}'`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(fields.name)) {
    throw new SkillError('SKILL_INVALID_NAME', `${source}: name '${fields.name}' must be lowercase letters, digits and hyphens`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(fields.version)) {
    throw new SkillError('SKILL_INVALID_VERSION', `${source}: version '${fields.version}' must be semver (x.y.z)`);
  }
  let enabled = true;
  if (fields.enabled !== undefined) {
    if (fields.enabled !== 'true' && fields.enabled !== 'false') {
      throw new SkillError('SKILL_INVALID_FIELD', `${source}: enabled must be 'true' or 'false'`);
    }
    enabled = fields.enabled === 'true';
  }
  if (!body) throw new SkillError('SKILL_EMPTY_BODY', `${source}: the skill body is empty`);
  const tools = fields.tools ? fields.tools.split(',').map((tool) => tool.trim()).filter(Boolean) : [];
  return { name: fields.name, description: fields.description, version: fields.version, tools, enabled, body, source: path.basename(source) };
}

export interface SkillRefusal {
  source: string;
  code: SkillErrorCode;
  detail: string;
}

/**
 * Loads every `*.skill.md` in a directory. A refused file is reported in `refusals` and left out of
 * `skills`; the load never throws for a bad file, because one malformed skill must not take down the
 * registry — but it is never silently dropped either.
 */
export function loadSkills(dir: string = resolveSkillsDir()): { skills: SkillDefinition[]; refusals: SkillRefusal[] } {
  if (!fs.existsSync(dir)) return { skills: [], refusals: [] };
  const names = fs.readdirSync(dir).filter((name) => SKILL_FILE.test(name)).sort();
  const skills: SkillDefinition[] = [];
  const refusals: SkillRefusal[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      skills.push(parseSkillFile(fs.readFileSync(full, 'utf8'), full));
    } catch (error) {
      if (error instanceof SkillError) refusals.push({ source: name, code: error.code, detail: error.message });
      else refusals.push({ source: name, code: 'SKILL_INVALID_FIELD', detail: `${name}: ${(error as Error).message}` });
    }
  }
  return { skills, refusals };
}

/** The read-only surface. Lists the installed skills, deterministically ordered by name. */
export class SkillRegistryService {
  public static list(dir: string = resolveSkillsDir()): { skills: SkillDefinition[]; refusals: SkillRefusal[] } {
    return loadSkills(dir);
  }
}

/** A pin for one vendored skill: where it came from, under what licence, and the bytes reviewed. */
export interface SkillPin {
  source: string;
  sourceType: string;
  skillPath: string;
  licence: string;
  sourceCommit?: string;
  computedHash: string;
}

/** The lock skills are pinned against. Overridable so a deployment (or a test) can point elsewhere. */
function resolveSkillsLockPath(): string {
  const configured = process.env.FACTORY_SKILLS_LOCK;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  return path.resolve(process.cwd(), 'skills-lock.json');
}

/** The sha256 of a skill file's exact bytes, the same digest `sha256sum` produces. */
export function computeSkillHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Parses the lock. Fail-closed and pure like the skill parser: a lock that is not an object with a
 * `skills` map, or whose entries lack a `computedHash`, refuses the whole load rather than silently
 * treating every skill as unpinned one by one. Entries for skills this registry does not load (for
 * example the opencode tooling pins) are carried but not required to name a licence.
 */
export function parseSkillsLock(raw: string, source: string): Record<string, SkillPin> {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new SkillError('SKILL_LOCK_INVALID', `${source}: not JSON (${(error as Error).message})`);
  }
  if (typeof doc !== 'object' || doc === null) throw new SkillError('SKILL_LOCK_INVALID', `${source}: the lock must be an object`);
  const skills = (doc as { skills?: unknown }).skills;
  if (typeof skills !== 'object' || skills === null || Array.isArray(skills)) {
    throw new SkillError('SKILL_LOCK_INVALID', `${source}: the lock must have a 'skills' object`);
  }
  const pins: Record<string, SkillPin> = {};
  for (const [name, value] of Object.entries(skills as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) throw new SkillError('SKILL_LOCK_INVALID', `${source}: pin '${name}' is not an object`);
    const entry = value as Record<string, unknown>;
    if (typeof entry.computedHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.computedHash)) {
      throw new SkillError('SKILL_LOCK_INVALID', `${source}: pin '${name}' has no sha256 computedHash`);
    }
    pins[name] = {
      source: typeof entry.source === 'string' ? entry.source : '',
      sourceType: typeof entry.sourceType === 'string' ? entry.sourceType : '',
      skillPath: typeof entry.skillPath === 'string' ? entry.skillPath : '',
      licence: typeof entry.licence === 'string' ? entry.licence : '',
      sourceCommit: typeof entry.sourceCommit === 'string' ? entry.sourceCommit : undefined,
      computedHash: entry.computedHash,
    };
  }
  return pins;
}

/**
 * Loads the skills a model may be *shown*, refusing any whose bytes are not the reviewed bytes.
 *
 * `loadSkills` is inspection: it says what parsed. This is influence: it says what may reach a run,
 * and it is fail-closed. A skill with no pin refuses (`SKILL_UNPINNED`); a skill whose bytes differ
 * from its pin refuses (`SKILL_PIN_MISMATCH`); a pin with no licence refuses (`SKILL_LOCK_INVALID`),
 * because a licence that was never recorded is a licence that was never reviewed. A refusal is
 * reported, never silently dropped.
 */
export function loadPinnedSkills(
  dir: string = resolveSkillsDir(),
  lockPath: string = resolveSkillsLockPath(),
): { skills: SkillDefinition[]; refusals: SkillRefusal[] } {
  const { skills, refusals } = loadSkills(dir);
  if (!fs.existsSync(lockPath)) {
    return {
      skills: [],
      refusals: [...refusals, { source: lockPath, code: 'SKILL_UNPINNED', detail: `${lockPath}: no skills lock; every skill is unpinned and none may influence a run` }],
    };
  }
  let pins: Record<string, SkillPin>;
  try {
    pins = parseSkillsLock(fs.readFileSync(lockPath, 'utf8'), lockPath);
  } catch (error) {
    if (error instanceof SkillError) return { skills: [], refusals: [...refusals, { source: lockPath, code: error.code, detail: error.message }] };
    throw error;
  }
  const pinned: SkillDefinition[] = [];
  for (const skill of skills) {
    const pin = pins[skill.name];
    if (!pin) {
      refusals.push({ source: skill.source, code: 'SKILL_UNPINNED', detail: `${skill.source}: '${skill.name}' has no pin in ${path.basename(lockPath)}` });
      continue;
    }
    if (!pin.licence) {
      refusals.push({ source: skill.source, code: 'SKILL_LOCK_INVALID', detail: `${skill.source}: pin '${skill.name}' records no licence; a licence that was never recorded is a licence that was never reviewed` });
      continue;
    }
    const actual = computeSkillHash(fs.readFileSync(path.join(dir, skill.source), 'utf8'));
    if (actual !== pin.computedHash) {
      refusals.push({ source: skill.source, code: 'SKILL_PIN_MISMATCH', detail: `${skill.source}: '${skill.name}' is ${actual}, not the pinned ${pin.computedHash}; the reviewed bytes are not the bytes on disk` });
      continue;
    }
    pinned.push(skill);
  }
  return { skills: pinned, refusals };
}
