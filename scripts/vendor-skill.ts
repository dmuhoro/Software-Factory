#!/usr/bin/env tsx
/**
 * Vendor external skills (Sprint 33, WP-1; ADR-013 §2/§3).
 *
 * ADR-013 says a skill is *vendored*: it lives in this repository, committed, pinned by sha256, and
 * the bytes reviewed are the bytes that run. Nothing is fetched at run time. This script is the
 * maintainer's tool: it clones a source at a fixed commit, copies only the markdown the skill
 * references, strips everything else (scripts, agents, hooks, configs), normalizes the frontmatter to
 * the registry's strict contract, writes `skills/<name>.skill.md`, copies each upstream LICENSE, and
 * records provenance (source URL, commit, licence, sha256) into `skills-lock.json`.
 *
 * Two things are refused, never smuggled:
 *
 *  - A skill whose body names an egress endpoint (`http(s)://`, `ws(s)://`, `ftp://`) is refused
 *    whole, because the injection seam would refuse it anyway (ADR-013 §6, `skillInjectionService`).
 *  - A referenced markdown file that names an egress endpoint is **not copied**, and the omission is
 *    reported. A file that pulls a CDN cannot be vendored into a no-new-egress repository.
 *
 * The script is deterministic: same commit in, same bytes out, same sha256. It is a maintainer
 * action, not a run-path action — nothing here runs during a loop.
 *
 * Usage:
 *   npx tsx scripts/vendor-skill.ts            # clone, vendor, update the lock
 *   npx tsx scripts/vendor-skill.ts --check    # verify the committed bytes match the lock (no network)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeSkillHash } from '../src/services/skillRegistryService';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const LOCK_PATH = path.join(ROOT, 'skills-lock.json');

/** The same egress shape the injection seam refuses. */
const EGRESS = /\b(?:https?|wss?|ftp):\/\//i;

interface SourceSkill {
  /** The skill's name in the registry (its upstream frontmatter `name`). */
  name: string;
  /** The directory inside the source repo that holds `SKILL.md`. */
  dir: string;
}

interface Source {
  key: string;
  url: string;
  commit: string;
  licence: string;
  skills: SourceSkill[];
}

/**
 * The starter set. Every source is public and MIT; every commit is the reviewed commit. A skill the
 * brief named but this list omits is omitted on purpose (see `skills/PROVENANCE.md`): it instructs a
 * network call, a config edit, a skipped approval, or unbounded looping, and the brief's own rule
 * excludes those.
 */
const SOURCES: Source[] = [
  {
    key: 'pocock',
    url: 'https://github.com/mattpocock/skills',
    commit: '49dd158d1076134a641b33efb035946536778336',
    licence: 'MIT',
    skills: [
      { name: 'tdd', dir: 'skills/engineering/tdd' },
      { name: 'diagnosing-bugs', dir: 'skills/engineering/diagnosing-bugs' },
      { name: 'to-spec', dir: 'skills/engineering/to-spec' },
      { name: 'to-tickets', dir: 'skills/engineering/to-tickets' },
      { name: 'code-review', dir: 'skills/engineering/code-review' },
      { name: 'improve-codebase-architecture', dir: 'skills/engineering/improve-codebase-architecture' },
      { name: 'grilling', dir: 'skills/productivity/grilling' },
      { name: 'handoff', dir: 'skills/productivity/handoff' },
    ],
  },
];

interface SkillPinEntry {
  source: string;
  sourceType: string;
  skillPath: string;
  licence: string;
  sourceCommit: string;
  computedHash: string;
}

interface VendorResult {
  name: string;
  source: string;
  commit: string;
  written: string;
  sha256: string;
  inlined: string[];
  omitted: string[];
}

function cloneAt(url: string, commit: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-skill-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '--quiet');
  git('remote', 'add', 'origin', url);
  git('fetch', '--quiet', '--depth', '1', 'origin', commit);
  git('checkout', '--quiet', 'FETCH_HEAD');
  return dir;
}

/** Parses the two frontmatter fields we need, tolerating the upstream field set we do not keep. */
function readFrontmatter(raw: string): { name: string; description: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error('SKILL.md has no frontmatter block');
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(':');
    if (at < 0) continue;
    fields[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, '$2').replace(/\s+/g, ' ').trim();
  const name = fields.name;
  const description = unquote(fields.description ?? '');
  const body = match[2].trim();
  if (!name) throw new Error('SKILL.md frontmatter has no name');
  if (!description) throw new Error(`skill '${name}' has no description`);
  if (!body) throw new Error(`skill '${name}' has an empty body`);
  return { name, description, body };
}

/** Markdown files the skill body links to, that exist beside it. */
function referencedMarkdown(body: string, dir: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\]\(([^)]+\.md)\)/g)) {
    const rel = match[1];
    if (rel.includes('/')) continue;
    if (rel === 'SKILL.md') continue;
    if (fs.existsSync(path.join(dir, rel))) found.add(rel);
  }
  return [...found].sort();
}

function vendorSkill(source: Source, skill: SourceSkill, cloneDir: string): VendorResult {
  const skillDir = path.join(cloneDir, skill.dir);
  const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const { name, description, body } = readFrontmatter(raw);
  if (name !== skill.name) throw new Error(`expected skill '${skill.name}' but the file names '${name}'`);
  if (EGRESS.test(body)) throw new Error(`skill '${name}' body names an egress endpoint; refused (ADR-013 §6)`);

  const inlined: string[] = [];
  const omitted: string[] = [];
  const parts: string[] = [body];
  for (const rel of referencedMarkdown(body, skillDir)) {
    const content = fs.readFileSync(path.join(skillDir, rel), 'utf8').trim();
    if (EGRESS.test(content)) {
      omitted.push(rel);
      continue;
    }
    inlined.push(rel);
    parts.push(`## Reference: ${rel}\n\n${content}`);
  }

  const frontmatter = ['---', `name: ${name}`, `description: ${description}`, 'version: 1.0.0', 'tools: read', 'enabled: true', '---', ''].join('\n');
  const file = `${frontmatter}\n${parts.join('\n\n')}\n`;
  const outPath = path.join(SKILLS_DIR, `${name}.skill.md`);
  fs.writeFileSync(outPath, file);
  return { name, source: source.url, commit: source.commit, written: `${name}.skill.md`, sha256: computeSkillHash(file), inlined, omitted };
}

function updateLock(results: VendorResult[], licences: Map<string, string>): void {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')) as { version: number; skills: Record<string, unknown> };
  for (const result of results) {
    lock.skills[result.name] = {
      source: result.source.replace(/^https:\/\/github\.com\//, ''),
      sourceType: 'github',
      skillPath: `${SOURCES.find((s) => s.url === result.source)!.skills.find((s) => s.name === result.name)!.dir}/SKILL.md`,
      licence: licences.get(result.source) ?? '',
      sourceCommit: result.commit,
      computedHash: result.sha256,
    } satisfies SkillPinEntry;
  }
  const ordered = Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ version: lock.version, skills: ordered }, null, 2)}\n`);
}

function check(): void {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')) as { skills: Record<string, { computedHash: string }> };
  let failures = 0;
  for (const [name, pin] of Object.entries(lock.skills)) {
    const file = path.join(SKILLS_DIR, `${name}.skill.md`);
    if (!fs.existsSync(file)) continue;
    const actual = computeSkillHash(fs.readFileSync(file, 'utf8'));
    if (actual !== pin.computedHash) {
      console.error(`  FAIL  ${name}.skill.md is ${actual}, not the pinned ${pin.computedHash}`);
      failures += 1;
    } else {
      console.log(`  PASS  ${name}.skill.md matches its pin`);
    }
  }
  if (failures) process.exit(1);
  console.log('vendored skills match the lock');
}

const isCheck = process.argv.includes('--check');
if (isCheck) {
  check();
} else {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const results: VendorResult[] = [];
  const licences = new Map<string, string>();
  for (const source of SOURCES) {
    const cloneDir = cloneAt(source.url, source.commit);
    licences.set(source.url, source.licence);
    fs.copyFileSync(path.join(cloneDir, 'LICENSE'), path.join(SKILLS_DIR, `${source.key}-skills-LICENSE`));
    try {
      for (const skill of source.skills) results.push(vendorSkill(source, skill, cloneDir));
    } finally {
      fs.rmSync(cloneDir, { recursive: true, force: true });
    }
  }
  updateLock(results, licences);
  for (const result of results) {
    const omitted = result.omitted.length ? ` (omitted: ${result.omitted.join(', ')})` : '';
    console.log(`vendored ${result.written}  ${result.sha256.slice(0, 12)}…  inlined ${result.inlined.length} reference(s)${omitted}`);
  }
  console.log(`\n${results.length} skill(s) vendored from ${SOURCES.length} source(s); skills-lock.json updated.`);
}
