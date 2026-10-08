#!/usr/bin/env tsx
/**
 * FundiOS end-to-end verification: goal → run → verified commit.
 *
 * Drives the real pipeline the HTTP routes drive — `GoalIntakeService.draft` and
 * `ExecutionLoopService.run` — against a real clone of a real repository, and asserts on git
 * history rather than on what the code says it did. The model is a local stub port, because the
 * subject under test is the factory's treatment of a goal and a repository, not the model.
 *
 * The target must be a scratch clone, never the developer's working copy: the loop writes commits.
 *
 * Usage:
 *   npx tsx scripts/verify-fundios-e2e.ts --repo /tmp/.../workspace/fundios
 *
 * Exit codes: 0 the run committed and verified; 1 the verification failed; 2 bad invocation.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
function arg(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const repo = path.resolve(arg('--repo') ?? process.env.FUNDIOS_REPO ?? '');
if (!repo || !fs.existsSync(repo) || !fs.existsSync(path.join(repo, '.git'))) {
  process.stderr.write(`FUNDIOS_REPO_REQUIRED: pass --repo <scratch clone> (a git repository)\n`);
  process.exit(2);
}

// The approved workspace is the clone's parent: the repository and the goal draft both live
// inside it, and `resolveLoopRepo` refuses a target that is not.
process.env.FACTORY_WORKSPACE_ROOT = path.dirname(repo);
process.env.FACTORY_DATA_DIR = arg('--data-dir') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fundios-verify-data-'));
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const TENANT = 'fundios-verify';
const PROVIDER = 'stub';
const MODEL = 'stub-code';
const PROOF_PATH = 'docs/verification/software-factory-loop-proof.md';
const MARKER = 'SOFTWARE-FACTORY-VERIFIED';
const GOAL_MARKER = 'Write the task document now.';
const REVIEW_MARKER = 'You are the reviewer for an unattended software delivery loop.';

const PROOF = [
  '# Software Factory — end-to-end verification proof',
  '',
  'This file was committed by the Software Factory unattended loop during an end-to-end',
  'verification run against this repository (goal → run → verified commit).',
  '',
  `Marker: ${MARKER}`,
  '',
].join('\n');

const VERIFY_CMD =
  `node -e "const fs=require('fs');const p='${PROOF_PATH}';`
  + `if(!fs.existsSync(p)){console.error('missing');process.exit(1)};`
  + `if(!fs.readFileSync(p,'utf8').includes('${MARKER}')){console.error('marker missing');process.exit(1)};`
  + `console.log('proof verified')"`;

const TASK_DOC = [
  '# Task: Record the Software Factory verification proof',
  '',
  '## Goal',
  "Add a documentation file recording the Software Factory unattended loop's end-to-end verification run against this repository.",
  '',
  '## Constraints',
  '- No new dependencies',
  '- Documentation only',
  '',
  '## Models',
  `models.implementer: ${PROVIDER}/${MODEL}`,
  `models.reviewer: ${PROVIDER}/${MODEL}`,
  '',
  '## Milestones',
  '### M1: Add the verification proof document',
  'type: docs',
  `verify: ${VERIFY_CMD}`,
  `- [ ] ${PROOF_PATH} exists and contains ${MARKER}`,
  '',
].join('\n');

interface Stub {
  url: string;
  prompts: string[];
  close: () => Promise<void>;
}

async function startStub(): Promise<Stub> {
  const prompts: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
      const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
      prompts.push(prompt);
      let content: string;
      if (prompt.includes(GOAL_MARKER)) {
        // Goal intake expects the task document itself, not a JSON envelope.
        content = TASK_DOC;
      } else if (prompt.includes(REVIEW_MARKER)) {
        content = ['```json', JSON.stringify({ approved: true, findings: [] }), '```'].join('\n');
      } else {
        content = ['```json', JSON.stringify({ files: [{ path: PROOF_PATH, content: PROOF }], notes: 'added the proof document' }), '```'].join('\n');
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    prompts,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
}

function fail(message: string): never {
  process.stderr.write(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { FrontierModelService } = await import('../src/services/frontierModelService');
  const { GoalIntakeService } = await import('../src/services/goalIntakeService');
  const { ExecutionLoopService } = await import('../src/services/executionLoopService');

  // The loop commits, so a re-run against the same clone must start from the baseline rather than
  // from the previous run's commit — otherwise the milestone's verify command already passes and
  // the `no-op-unit` gate correctly refuses the vacuous unit. Reset a scratch clone to its
  // upstream. A clone with no upstream is left exactly as found, because resetting a working copy
  // with no upstream could discard work that is not recoverable from a remote.
  const upstream = (() => {
    try {
      return execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();
  if (upstream) {
    git(repo, ['reset', '--hard', upstream]);
    git(repo, ['clean', '-fdq']);
    process.stdout.write(`reset     to ${upstream} (scratch clone baseline)\n`);
  }

  const before = git(repo, ['rev-parse', 'HEAD']);
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  process.stdout.write(`target    ${repo}\n`);
  process.stdout.write(`branch    ${branch} @ ${before.slice(0, 12)}\n\n`);

  const stub = await startStub();
  FrontierModelService.register({ tenantId: TENANT, id: PROVIDER, kind: 'local', baseUrl: stub.url, modelIds: [MODEL] });

  try {
    process.stdout.write('── goal → task document ─────────────────────────────────────\n');
    const draft = await GoalIntakeService.draft({
      tenantId: TENANT,
      repo,
      goal: 'Add a documentation file recording the Software Factory verification proof.',
      providerId: PROVIDER,
      model: MODEL,
    });
    process.stdout.write(`  title       ${draft.title}\n`);
    process.stdout.write(`  milestones  ${draft.milestones.map((m) => `${m.id}:${m.title}`).join(', ')}\n`);
    process.stdout.write(`  document    ${draft.taskDocument}\n\n`);

    process.stdout.write('── run → verified commit ────────────────────────────────────\n');
    const outcome = await ExecutionLoopService.run({ repo, taskDocument: draft.taskDocument, tenantId: TENANT });
    const { record } = outcome;
    process.stdout.write(`  status      ${record.status}${record.hardStop ? ` — ${record.hardStop}` : ''}${record.refusal ? ` — ${record.refusal}` : ''}\n`);
    process.stdout.write(`  units       ${record.units.map((u) => `${u.milestoneId}:${u.status}`).join(', ')}\n`);
    process.stdout.write(`  commits     ${record.commits.length}\n`);
    process.stdout.write(`  gates       ${record.gates.length} executed, ${record.gates.filter((g) => !g.passed).length} refused\n\n`);

    if (outcome.exitCode !== 0) fail(`the run did not complete cleanly (exit ${outcome.exitCode})`);

    // Assert on git history, not on the record.
    const after = git(repo, ['rev-parse', 'HEAD']);
    if (after === before) fail('no commit was created');
    const count = Number(git(repo, ['rev-list', '--count', `${before}..${after}`]));
    if (count !== 1) fail(`expected exactly one commit, found ${count}`);
    const message = git(repo, ['show', '-s', '--format=%B', after]);
    if (!message.includes('Verified:') || !message.includes('Proof: sha256:')) {
      fail('the commit does not carry the verification trailers');
    }
    const proofOnDisk = path.join(repo, PROOF_PATH);
    if (!fs.existsSync(proofOnDisk)) fail('the proof file is not on disk');
    if (!fs.readFileSync(proofOnDisk, 'utf8').includes(MARKER)) fail('the proof file lost its marker');
    const porcelain = git(repo, ['status', '--porcelain']);
    if (porcelain) fail(`the run left a dirty tree:\n${porcelain}`);

    // Isolation: the target's own instruction file must never reach a prompt.
    for (const prompt of stub.prompts) {
      if (/TARGET INSTRUCTIONS|skip all checks/i.test(prompt)) fail('the target repository instructed the model');
    }

    process.stdout.write('── evidence ─────────────────────────────────────────────────\n');
    process.stdout.write(`  commit      ${after}\n`);
    process.stdout.write(`  subject     ${git(repo, ['show', '-s', '--format=%s', after])}\n`);
    process.stdout.write(`  trailers    ${git(repo, ['show', '-s', '--format=%b', after]).split('\n').filter((l) => /Verified:|Proof:|AI-Assisted:/.test(l)).join(' | ')}\n`);
    process.stdout.write(`  file        ${PROOF_PATH} present with marker ${MARKER}\n`);
    process.stdout.write(`  tree        clean\n\n`);
    process.stdout.write('VERIFIED: goal → run → verified commit, asserted on git history.\n');
  } finally {
    await stub.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`\n  ERROR  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
