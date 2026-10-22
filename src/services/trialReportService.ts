/**
 * The production-trial report (Sprint 34, WP-4).
 *
 * A trial is judged on numbers, so the report's one hard rule is: **a number it cannot derive is
 * `null`, never zero and never an estimate.** Zero is a measurement ("no stuck units"); `null` is
 * the absence of one. Conflating them is how a trial gets declared a success on data that was
 * never collected.
 *
 * Everything here is derived from two sources and nothing else:
 *
 *  - the ledger's `factoryLoopRuns` (what the loop itself recorded) and `usageEvents` (what a
 *    dependency reported spending), and
 *  - the target repository via git (whether a recorded commit still exists and is an ancestor of
 *    HEAD, and whether a later commit reverted or repaired it).
 *
 * Operator judgement is not derived. `trial:note` appends a note labelled `source: "operator"`
 * and the report prints it separately, so a reader can always tell a measurement from an opinion.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LoopRunRecord } from './loopTypes';
import type { UsageEvent } from './usageMeteringService';

export type TrialVerdict = 'accept' | 'reject' | 'hold';

export interface TrialNote {
  at: string;
  repo: string;
  verdict: TrialVerdict | null;
  notes: string;
  source: 'operator';
}

/**
 * What git says about one recorded loop commit. `verified` is the only honest form of "this
 * commit shipped": the object still exists *and* HEAD contains it. A commit that was rebased
 * away, squashed, or never created is recorded as unverified with the reason.
 */
export interface CommitFact {
  sha: string;
  verified: boolean;
  reason?: 'missing-from-repository' | 'not-an-ancestor-of-head';
  revertedBy?: string;
  fixedBy?: string[];
}

interface TrialTotals {
  runs: number;
  runsByStatus: Record<string, number>;
  units: {
    attempted: number;
    done: number;
    stuck: number;
    blocked: number;
    pending: number;
  };
  failureClasses: Record<string, number>;
  /** Failed attempts that carried no class. Counted, never assigned a guessed class. */
  unclassifiedFailedAttempts: number;
  commits: {
    recorded: number;
    verified: number;
    unverified: Array<{ sha: string; reason: string }>;
    reverted: number;
    fixedAfterMerge: number;
  };
  wallTimeMs: number | null;
  wallTimeReason?: string;
  tokens: number | null;
  tokenEvents: number;
  models: string[];
  costUsd: null;
  costReason: string;
}

export interface TrialReport {
  version: 1;
  repo: string;
  since: string;
  generatedAt: string;
  ledger: string;
  totals: TrialTotals;
  commits: CommitFact[];
  notes: TrialNote[];
  /** Every figure the inputs could not support, named — the report's honesty ledger. */
  underivable: string[];
}

function parseInstant(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryGit(repo: string, args: string[]): string | null {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

export function assertGitRepository(repo: string): void {
  if (!fs.existsSync(repo)) throw new Error(`repository does not exist: ${repo}`);
  const top = tryGit(repo, ['rev-parse', '--show-toplevel']);
  if (top === null) throw new Error(`not a git repository: ${repo}`);
  if (tryGit(repo, ['rev-parse', '--verify', 'HEAD']) === null) {
    throw new Error(`repository has no commits, so no commit can be verified: ${repo}`);
  }
}

interface WindowedCommit {
  sha: string;
  subject: string;
  body: string;
  files: string[];
}

/**
 * Reverts are read from git's own revert message (`This reverts commit <sha>.`), not from a guess
 * about the subject line. Repairs are commits after a loop commit that touch at least one of the
 * same files and whose subject starts with a repair verb. Both definitions are narrow on purpose:
 * an over-broad "follow-up" count would flatter the loop.
 */
function windowedCommits(repo: string, since: string): WindowedCommit[] {
  const raw = git(repo, ['log', `--since=${since}`, '--format=%H%x1f%s%x1f%B%x1e']);
  return raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, subject, ...rest] = chunk.split('\x1f');
      const body = rest.join('\x1f');
      const files = (tryGit(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]) ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      return { sha, subject: subject ?? '', body, files };
    });
}

const REVERT_POINTER = /This reverts commit ([0-9a-f]{7,40})\b/i;
const REPAIR_SUBJECT = /^(fix|hotfix|bug|repair|correct)\b/i;

export function collectCommitFacts(repo: string, loopShas: string[], since: string): CommitFact[] {
  const commits = windowedCommits(repo, since);
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const loopSet = new Set(loopShas);

  const revertedBy = new Map<string, string>();
  for (const commit of commits) {
    const match = REVERT_POINTER.exec(commit.body);
    if (!match) continue;
    const prefix = match[1].toLowerCase();
    const target = loopShas.find((sha) => sha.toLowerCase().startsWith(prefix));
    if (target && !revertedBy.has(target)) revertedBy.set(target, commit.sha);
  }

  const fixedBy = new Map<string, string[]>();
  for (const sha of loopShas) {
    const loopCommit = bySha.get(sha);
    const files = new Set(loopCommit?.files ?? []);
    if (files.size === 0) continue;
    const repairs = commits
      .filter((commit) => commit.sha !== sha && !loopSet.has(commit.sha) && REPAIR_SUBJECT.test(commit.subject))
      .filter((commit) => !REVERT_POINTER.test(commit.body))
      .filter((commit) => commit.files.some((file) => files.has(file)))
      .map((commit) => commit.sha);
    if (repairs.length > 0) fixedBy.set(sha, repairs);
  }

  return loopShas.map((sha) => {
    const exists = tryGit(repo, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
    if (!exists) return { sha, verified: false, reason: 'missing-from-repository' as const };
    const ancestor = tryGit(repo, ['merge-base', '--is-ancestor', sha, 'HEAD']) !== null;
    if (!ancestor) return { sha, verified: false, reason: 'not-an-ancestor-of-head' as const };
    return {
      sha,
      verified: true,
      ...(revertedBy.has(sha) ? { revertedBy: revertedBy.get(sha)! } : {}),
      ...(fixedBy.has(sha) ? { fixedBy: fixedBy.get(sha)! } : {}),
    };
  });
}

export interface BuildTrialReportInput {
  repo: string;
  since: string;
  runs: LoopRunRecord[];
  usage: UsageEvent[];
  notes: TrialNote[];
  commitFacts: CommitFact[];
  ledger: string;
  now?: string;
}

export function buildTrialReport(input: BuildTrialReportInput): TrialReport {
  const now = input.now ?? new Date().toISOString();
  const sinceMs = Date.parse(input.since);
  if (!Number.isFinite(sinceMs)) throw new Error(`--since is not a date: ${input.since}`);

  const runs = input.runs.filter((run) => {
    if (path.resolve(run.repo) !== path.resolve(input.repo)) return false;
    const started = parseInstant(run.startedAt);
    return started !== null && started >= sinceMs;
  });

  const underivable: string[] = [];
  const totals: TrialTotals = {
    runs: runs.length,
    runsByStatus: {},
    units: { attempted: 0, done: 0, stuck: 0, blocked: 0, pending: 0 },
    failureClasses: {},
    unclassifiedFailedAttempts: 0,
    commits: {
      recorded: input.commitFacts.length,
      verified: input.commitFacts.filter((c) => c.verified).length,
      unverified: input.commitFacts
        .filter((c) => !c.verified)
        .map((c) => ({ sha: c.sha, reason: c.reason ?? 'unknown' })),
      reverted: input.commitFacts.filter((c) => c.revertedBy).length,
      fixedAfterMerge: input.commitFacts.filter((c) => (c.fixedBy?.length ?? 0) > 0).length,
    },
    wallTimeMs: null,
    tokens: null,
    tokenEvents: 0,
    models: [],
    costUsd: null,
    costReason: 'no dependency in this product reports a price per call; a cost figure would be invented',
  };

  let wallMs = 0;
  let wallComplete = true;
  const wallProblems: string[] = [];
  for (const run of runs) {
    totals.runsByStatus[run.status] = (totals.runsByStatus[run.status] ?? 0) + 1;
    const started = parseInstant(run.startedAt);
    const finished = parseInstant(run.finishedAt) ?? (run.status === 'running' ? Date.parse(now) : null);
    if (started === null || finished === null) {
      wallComplete = false;
      wallProblems.push(run.runId);
    } else {
      wallMs += Math.max(0, finished - started);
    }

    for (const unit of run.units) {
      if (unit.status === 'pending' && unit.attempts.length === 0) {
        totals.units.pending += 1;
        continue;
      }
      totals.units.attempted += 1;
      if (unit.status === 'done') totals.units.done += 1;
      else if (unit.status === 'stuck') totals.units.stuck += 1;
      else if (unit.status === 'blocked') totals.units.blocked += 1;
      else if (unit.status === 'pending') totals.units.pending += 1;

      for (const attempt of unit.attempts) {
        if (attempt.passed) continue;
        if (attempt.failureClass) {
          totals.failureClasses[attempt.failureClass] = (totals.failureClasses[attempt.failureClass] ?? 0) + 1;
        } else {
          totals.unclassifiedFailedAttempts += 1;
        }
      }
    }
  }

  if (wallComplete) {
    totals.wallTimeMs = wallMs;
  } else {
    totals.wallTimeReason = `run(s) without a parseable start or finish: ${wallProblems.join(', ')}`;
    underivable.push(`wallTimeMs (${totals.wallTimeReason})`);
  }

  const usage = input.usage.filter((event) => {
    const at = parseInstant(event.recordedAt);
    return at !== null && at >= sinceMs;
  });
  totals.tokenEvents = usage.length;
  totals.models = [...new Set(usage.map((event) => event.model).filter((m): m is string => Boolean(m)))].sort();
  if (usage.length === 0) {
    underivable.push(
      'tokens (no usage event was recorded in the window; the execution loop records none, so absence is not zero)',
    );
  } else {
    totals.tokens = usage.reduce((sum, event) => sum + event.tokens, 0);
  }

  if (totals.commits.recorded === 0) {
    underivable.push('commits (no loop run in the window recorded a commit)');
  }
  if (totals.commits.verified === 0 && totals.commits.recorded > 0) {
    underivable.push('verifiedCommits (every recorded commit was missing or not an ancestor of HEAD)');
  }

  return {
    version: 1,
    repo: input.repo,
    since: input.since,
    generatedAt: now,
    ledger: input.ledger,
    totals,
    commits: input.commitFacts,
    notes: input.notes,
    underivable,
  };
}

export function renderTrialReport(report: TrialReport): string {
  const t = report.totals;
  const n = (value: number | null, label: string): string =>
    value === null ? `not derivable (${label})` : String(value);
  const lines = [
    `# Production trial report`,
    '',
    `- **Repository**: \`${report.repo}\``,
    `- **Window**: since ${report.since}, generated ${report.generatedAt}`,
    `- **Ledger**: \`${report.ledger}\``,
    '',
    `## Runs`,
    '',
    `- runs: **${t.runs}** (${Object.entries(t.runsByStatus).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`,
    `- units attempted: **${t.units.attempted}** — done ${t.units.done}, stuck **${t.units.stuck}**, blocked ${t.units.blocked}, pending ${t.units.pending}`,
    `- wall time: **${n(t.wallTimeMs, t.wallTimeReason ?? 'unknown')}**${t.wallTimeMs === null ? '' : ' ms'}`,
    '',
    `## Failure classes`,
    '',
    Object.keys(t.failureClasses).length === 0
      ? '- none recorded'
      : Object.entries(t.failureClasses)
          .sort((a, b) => b[1] - a[1])
          .map(([cls, count]) => `- ${cls}: ${count}`)
          .join('\n'),
    `- unclassified failed attempts: **${t.unclassifiedFailedAttempts}**`,
    '',
    `## Commits (git-derived)`,
    '',
    `- recorded ${t.commits.recorded}, verified **${t.commits.verified}**, reverted ${t.commits.reverted}, repaired after merge ${t.commits.fixedAfterMerge}`,
    ...t.commits.unverified.map((u) => `- unverified \`${u.sha}\`: ${u.reason}`),
    '',
    `## Spend`,
    '',
    `- tokens: **${n(t.tokens, 'no usage event in the window')}** across ${t.tokenEvents} event(s)`,
    `- models: ${t.models.length ? t.models.map((m) => `\`${m}\``).join(', ') : 'none recorded'}`,
    `- cost: not derivable (${t.costReason})`,
    '',
    `## Operator notes (not derived)`,
    '',
    report.notes.length === 0
      ? '- none recorded; record one with `npm run trial:note`'
      : report.notes
          .map((note) => `- ${note.at} **${note.verdict ?? 'unjudged'}** — ${note.notes} _(source: ${note.source})_`)
          .join('\n'),
    '',
    `## Not derivable`,
    '',
    report.underivable.length === 0
      ? '- every figure above was derived from the ledger or git'
      : report.underivable.map((item) => `- ${item}`).join('\n'),
    '',
  ];
  return lines.join('\n');
}

/** Notes live beside the ledger so they are as durable as the runs they judge. */
function trialNotesPath(ledgerFile: string): string {
  return path.join(path.dirname(ledgerFile), 'trial-notes.jsonl');
}

export function readTrialNotes(ledgerFile: string, repo: string): TrialNote[] {
  const file = trialNotesPath(ledgerFile);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrialNote)
    .filter((note) => path.resolve(note.repo) === path.resolve(repo));
}

export function appendTrialNote(ledgerFile: string, note: TrialNote): void {
  const file = trialNotesPath(ledgerFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(note)}\n`, 'utf8');
}
