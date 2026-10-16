/**
 * PR flow adapter (sprint 28, WP-4).
 *
 * Turns a finished loop run into a reviewable, worded change set instead of a silence: a written
 * manifest (a rendered pull-request body) plus a durable record and a reviewable branch ref. The
 * local default needs no network and no credential; the GitHub half is a real API call that is
 * explicitly refused, before any socket, whenever the credential or an egress permit is missing.
 *
 * The design rule that governs the whole file: the loop never pushes, and this service never
 * merges. Opening a pull request is the furthest any code here goes; folding the change into the
 * target branch stays an operator action.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DurableStore } from './durableStore';
import { egressJson, resolveSecretRef } from '../utils/egressGuard';
import type { LoopRunRecord } from './loopTypes';

type PrFlowMode = 'local' | 'github';
type PullRequestStatus = 'DRAFTED' | 'OPENED';

interface PullRequestRecord {
  id: string;
  tenantId: string;
  runId: string;
  flow: PrFlowMode;
  status: PullRequestStatus;
  title: string;
  body: string;
  targetBranch: string;
  baseBranch: string;
  sourceSha: string;
  branch: string;
  commitCount: number;
  mergeable: boolean;
  prNumber?: number;
  htmlUrl?: string;
  openPendingNote?: string;
  createdAt: string;
  openedAt?: string;
}

interface PrDraftOptions {
  tenantId: string;
  run: LoopRunRecord;
  repo: string;
  mode?: PrFlowMode;
  targetBranch?: string;
  baseBranch?: string;
}

interface PrGithubOpenOptions extends PrDraftOptions {
  mode: 'github';
  owner: string;
  repoName: string;
  head: string;
  tokenSecretRef: string;
  baseUrl?: string;
}

const GITHUB_API = 'https://api.github.com';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const PR_DETAIL = Object.freeze({
  DRAFTED: 'drafted locally as a reviewable branch and manifest; merge remains an operator action',
  OPENED: 'opened on the remote; merge remains an operator action',
});

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function headRef(repo: string): string {
  return git(repo, ['rev-parse', 'HEAD']);
}

function prBranch(runId: string): string {
  return `factory/pr/${runId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12) || 'run'}`;
}

function tail(value: string, max = 240): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Renders the pull-request body from a finished run. Every fact comes from the run record; a run
 * that reached no stage cannot claim a stage it never entered.
 */
function renderManifest(run: LoopRunRecord, repo: string): string {
  const title = `Automated change: ${path.basename(repo)}/${run.runId}`;
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`Run \`${run.runId}\` on \`${run.repo}\`.`);
  lines.push(`Status: **${run.status.toUpperCase()}**${run.hardStop ? ` — hard stop \`${run.hardStop}\`` : ''}${run.refusal ? ` — refused to start: \`${run.refusal}\`` : ''}`);
  lines.push(`Execution: \`${run.execution}\``);
  lines.push(`Span: ${run.startedAt} → ${run.finishedAt ?? '(interrupted)'}`);
  lines.push('');

  const units = run.units;
  lines.push('## Units');
  lines.push('');
  lines.push('| unit | type | status | attempts | commit | merged | proof |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const unit of units) {
    lines.push(`| ${unit.unitId} | ${unit.type} | ${unit.status} | ${unit.attempts.length} | ${unit.commitSha ? short(unit.commitSha) : '—'} | ${unit.mergeSha ? short(unit.mergeSha) : '—'} | ${unit.proofDigest ? short(unit.proofDigest) : '—'} |`);
  }
  lines.push('');

  lines.push('## Commits');
  lines.push('');
  if (run.commits.length === 0) lines.push('_None — nothing was committed._');
  for (const commit of run.commits) {
    const body = commitProof(run, commit.sha, commit.unitId);
    lines.push(`- \`${short(commit.sha)}\` ${commit.subject} (unit ${commit.unitId})`);
    if (body) lines.push(body);
  }
  lines.push('');

  lines.push('## Merges');
  lines.push('');
  if (!run.merges?.length) lines.push('_Sequential run: each commit was written directly onto the target branch._');
  for (const merge of run.merges ?? []) {
    lines.push(`- \`${short(merge.sha)}\` folded unit ${merge.unitId} onto the branch (${merge.subject})`);
  }
  lines.push('');

  lines.push('## Gates');
  lines.push('');
  const gates = run.gates;
  if (gates.length === 0) lines.push('_No gate results were recorded._');
  else {
    lines.push(`- Checked: ${gates.filter((gate) => gate.passed).length}/${gates.length}; blocking refusals: ${gates.filter((gate) => !gate.passed && gate.blocking).length}.`);
    for (const gate of gates.filter((item) => !item.passed).slice(0, 8)) {
      lines.push(`- \`${gate.id}\` at ${gate.stage}/${gate.timing}: ${tail(gate.detail)}`);
    }
  }
  lines.push('');

  lines.push('## Review');
  lines.push('');
  const approvedUnits = units.filter((unit) => unit.attempts.some((attempt) => attempt.review?.approved));
  const refusedUnits = units.filter((unit) => unit.attempts.some((attempt) => attempt.review && !attempt.review.approved));
  lines.push(`- Two-axis review approved: ${approvedUnits.length} unit(s); refused at least once: ${refusedUnits.length} unit(s).`);
  for (const unit of refusedUnits) {
    const refusal = unit.attempts.find((attempt) => attempt.review && !attempt.review.approved);
    for (const finding of refusal?.review?.findings ?? []) lines.push(`- ${unit.unitId}: ${tail(finding, 160)}`);
  }
  lines.push('');

  lines.push('## Outcome');
  lines.push('');
  lines.push(`Generated by the unattended loop from the run record. ${PR_DETAIL.DRAFTED}.`);
  return lines.join('\n');
}

function commitProof(run: LoopRunRecord, sha: string, unitId: string): string {
  const unit = run.units.find((candidate) => candidate.unitId === unitId);
  if (!unit?.proof) return '';
  const proof = unit.proof;
  const checks = proof.checks.map((check) => `\`${check.command}\` → exit ${check.exitCode}`).join('; ');
  const lines = [`  - **Proof:** \`${proof.digest}\``];
  if (checks) lines.push(`  - **Checks:** ${checks}`);
  if (proof.claimedFiles.length) lines.push(`  - **Files:** ${proof.claimedFiles.map((file) => `\`${file}\``).join(', ')}`);
  return lines.join('\n');
}

/** One pull-request record per run. The id is content-derived so a re-draft overwrites in place
 *  instead of duplicating, and a later `getRecord` for the same run resolves to the same document. */
function prRecordId(tenantId: string, runId: string): string {
  return DurableStore.deterministicId('pr', tenantId, runId);
}

function upsertRecord(tenantId: string, runId: string, record: Omit<PullRequestRecord, 'id' | 'tenantId' | 'runId' | 'createdAt'> & { createdAt?: string }): PullRequestRecord {
  const created = record.createdAt ?? new Date().toISOString();
  const { createdAt: _createdAt, ...rest } = record;
  const stored: PullRequestRecord = { ...rest, id: prRecordId(tenantId, runId), tenantId, runId, createdAt: created };
  DurableStore.upsert('pullRequests', stored.id, stored as unknown as Record<string, unknown>);
  return stored;
}

/**
 * Drafts the local, reviewable artifact for a finished run: the durable record, the written
 * manifest, and a branch ref that points at the run's head. `local` (the default) and `github`
 * behave identically here — in both flows the record is DRAFTED and nothing touches the network.
 */
function draft(input: PrDraftOptions): PullRequestRecord {
  const mode: PrFlowMode = input.mode ?? 'local';
  if (mode !== 'local' && mode !== 'github') throw new Error('PR_MODE_UNSUPPORTED');
  const repo = path.resolve(input.repo);
  const targetBranch = input.targetBranch ?? 'main';
  const baseBranch = input.baseBranch ?? targetBranch;
  const sourceSha = headRef(repo);
  const branch = prBranch(input.run.runId);

  try {
    git(repo, ['branch', '-f', branch, sourceSha]);
  } catch (error) {
    throw new Error(`PR_HEAD_REF_CREATION_FAILED: ${tail((error as Error).message, 240)}`);
  }

  const run = input.run;
  const mergeable = run.status === 'completed' && run.units.every((unit) => unit.status === 'done');
  const openPendingNote = mode === 'github'
    ? 'Drafted locally. Opening on GitHub needs a pushed head branch, an allowlisted token, and an egress permit; the loop never pushes.'
    : undefined;

  const record = upsertRecord(input.tenantId, input.run.runId, {
    flow: mode,
    status: 'DRAFTED',
    title: `Automated change: ${path.basename(repo)}/${input.run.runId}`,
    body: renderManifest(run, repo),
    targetBranch,
    baseBranch,
    sourceSha,
    branch,
    commitCount: run.commits.length,
    mergeable,
    openPendingNote,
  });
  return record;
}

/**
 * Opens the pull request on a GitHub-compatible API. Every precondition refuses before a socket:
 * the token must be a well-formed, allowlisted secret reference; the repository must be named; the
 * head branch must be named and already pushed; the base URL is re-validated at the socket. Opening
 * a pull request never merges anything.
 */
async function openGithub(input: PrGithubOpenOptions): Promise<PullRequestRecord> {
  const token = resolveSecretRef(input.tokenSecretRef);
  if (!token) throw new Error('PR_GITHUB_TOKEN_REQUIRED');
  if (!input.owner.trim() || !input.repoName.trim()) throw new Error('PR_GITHUB_REPO_REQUIRED');
  if (!REPO_PATTERN.test(`${input.owner}/${input.repoName}`)) throw new Error('PR_GITHUB_REPO_MALFORMED');
  if (!input.head.trim()) throw new Error('PR_GITHUB_HEAD_REQUIRED');

  const baseUrl = input.baseUrl ?? GITHUB_API;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new Error('PR_GITHUB_OPEN_FAILED: the base url could not be parsed');
  }
  const kind = isLoopbackHost(hostname) ? 'local' : 'remote';

  const drafted = draft({ tenantId: input.tenantId, run: input.run, repo: input.repo, mode: 'github', targetBranch: input.targetBranch, baseBranch: input.baseBranch });

  const { status, body } = await egressJson({
    baseUrl,
    kind,
    method: 'POST',
    pathname: `/repos/${input.owner}/${input.repoName}/pulls`,
    secret: token,
    body: JSON.stringify({ title: drafted.title, body: drafted.body, head: input.head, base: drafted.baseBranch }),
    timeoutMs: 30000,
    maxResponseBytes: 2_000_000,
  });

  if (status === 401 || status === 403) throw new Error('PR_GITHUB_AUTH_FAILED');
  if (status === 422) throw new Error('PR_GITHUB_UNPROCESSABLE');
  if (status < 200 || status >= 300) throw new Error(`PR_GITHUB_OPEN_FAILED: status ${status}`);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('PR_GITHUB_OPEN_FAILED: the response was not a pull request');

  const payload = body as Record<string, unknown>;
  const prNumber = typeof payload.number === 'number' ? payload.number : undefined;
  const htmlUrl = typeof payload.html_url === 'string' ? payload.html_url : undefined;

  const opened = upsertRecord(input.tenantId, input.run.runId, {
    flow: 'github',
    status: 'OPENED',
    title: drafted.title,
    body: drafted.body,
    targetBranch: drafted.targetBranch,
    baseBranch: drafted.baseBranch,
    sourceSha: drafted.sourceSha,
    branch: drafted.branch,
    commitCount: drafted.commitCount,
    mergeable: drafted.mergeable,
    prNumber,
    htmlUrl,
    createdAt: drafted.createdAt,
    openedAt: new Date().toISOString(),
  });
  return opened;
}

/**
 * Derives the `owner/name` pair from a repository's `origin` remote, when it points at GitHub.
 * Returns `undefined` rather than guessing — a repository with no GitHub remote is a refusal the
 * caller must handle, not a name invented here.
 */
function githubTarget(repo: string): { owner: string; repoName: string } | undefined {
  let url = '';
  try {
    url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 10000 }).trim();
  } catch {
    return undefined;
  }
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!match) return undefined;
  return { owner: match[1], repoName: match[2] };
}

/** The stored record for a run, when one exists. */
function getRecord(tenantId: string, runId: string): PullRequestRecord | undefined {
  const id = prRecordId(tenantId, runId);
  const record = DurableStore.get('pullRequests', id) as unknown as PullRequestRecord | undefined;
  return record?.tenantId === tenantId && record.runId === runId ? record : undefined;
}

/** A narrowed view of the unmerged units for the caller: a PR is mergeable only if fully merged. */
function mergeable(run: LoopRunRecord): { mergeable: boolean; reason?: string } {
  if (run.status !== 'completed') return { mergeable: false, reason: `run is ${run.status}` };
  const open = run.units.filter((unit) => unit.status !== 'done');
  if (open.length) return { mergeable: false, reason: `${open.length} unit(s) not done: ${open.map((unit) => unit.unitId).join(', ')}` };
  if (run.hardStop) return { mergeable: false, reason: run.hardStop };
  return { mergeable: true };
}
export const prFlowService = {
  renderManifest,
  draft,
  openGithub,
  getRecord,
  mergeable,
  prBranch,
  githubTarget,
};
