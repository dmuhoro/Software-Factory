#!/usr/bin/env tsx
/**
 * `npm run bench:skills -- [options]`
 *
 * The skills benchmark orchestrator (Sprint 33, WP-4). It runs the fixture tasks under
 * `test/fixtures/bench/` twice — once with skills injection **on**, once **off** — repeats each
 * side, and prints a JSON report carrying the first-attempt rates, their Wilson intervals, and the
 * verdict of the pre-registered adoption rule (`sprints/sprint-33-closing-sprint.md`).
 *
 * The decision this informs is whether a vendored skill helps enough to enable for a role
 * (ADR-013 §7). It is deliberately not a happy path: a stub dry pass proves the plumbing and is
 * labelled `stub: true`, and `benchReportEvidence` refuses such a report as capability evidence.
 *
 * The two arms are realised the way an operator would: the `on` arm runs against a temporary
 * doctrine root whose `loop.json` has `skills.inject: true` (with the manifest re-pinned for that
 * root), the `off` arm against the shipped doctrine. Nothing else differs between the arms.
 *
 * Options:
 *   --dry                  run the stub dry pass (no model; deterministic). Labelled stub: true.
 *   --model <spec>         the model, as provider/model. Required unless --dry.
 *   --tenant <id>          the tenant whose providers are used (default: bench).
 *   --repetitions <n>      repetitions per fixture per arm (default 3; the rule requires >= 3).
 *   --limit <n>            use only the first n fixtures (a fast smoke run).
 *   --fixtures <dir>       fixture root (default: test/fixtures/bench).
 *   --out <path>           write the report here instead of stdout.
 *   --now <iso>            fix the report timestamp (reproducible output; default: now).
 *
 * Exit codes: 0 report produced · 1 usage or run error.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ExecutionLoopService } from '../src/services/executionLoopService';
import { FrontierModelService } from '../src/services/frontierModelService';
import { DoctrineService } from '../src/services/doctrineService';
import { DurableStore } from '../src/services/durableStore';
import { runSkillBench, type BenchRunResult, type BenchReport } from '../src/services/skillBenchService';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Args {
  dry: boolean;
  model?: string;
  tenant: string;
  repetitions: number;
  limit?: number;
  fixtures: string;
  out?: string;
  now?: string;
}

function usage(): string {
  return 'Usage: npm run bench:skills -- [--dry | --model provider/model] [--tenant id] [--repetitions n] [--limit n] [--fixtures dir] [--out path] [--now iso]';
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dry: false, tenant: 'bench', repetitions: 3, fixtures: path.join(ROOT, 'test', 'fixtures', 'bench') };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`FLAG_REQUIRES_VALUE:${flag}`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--dry': args.dry = true; break;
      case '--model': args.model = value(); break;
      case '--tenant': args.tenant = value(); break;
      case '--repetitions': args.repetitions = Number(value()); break;
      case '--limit': args.limit = Number(value()); break;
      case '--fixtures': args.fixtures = path.resolve(value()); break;
      case '--out': args.out = path.resolve(value()); break;
      case '--now': args.now = value(); break;
      case '--help': case '-h': throw new Error('HELP');
      default: throw new Error(`FLAG_UNKNOWN:${flag}`);
    }
  }
  return args;
}

/** A stub model speaking the OpenAI-compatible shape FrontierModelService expects. */
async function startStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> };
      const prompt = (parsed.messages ?? []).map((message) => message.content ?? '').join('\n');
      let reply: unknown;
      if (/reviewer for an unattended software delivery loop/i.test(prompt)) {
        reply = { approved: true, findings: [] };
      } else {
        const token = /contains ([A-Za-z0-9_-]+)/.exec(prompt);
        reply = { files: [{ path: 'bench.txt', content: `${token ? token[1] : 'unknown'}\n` }], notes: 'stub wrote the token' };
      }
      const content = ['```json', JSON.stringify(reply), '```'].join('\n');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A copy of the shipped doctrine with `skills.inject` flipped on, and its manifest re-pinned. */
function doctrineWithSkillsOn(): { root: string; cleanup: () => void } {
  const source = DoctrineService.root();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-bench-doctrine-'));
  fs.cpSync(source, root, { recursive: true });
  const loopPath = path.join(root, 'loop.json');
  const loop = JSON.parse(fs.readFileSync(loopPath, 'utf8')) as Record<string, unknown>;
  const skills = loop.skills as { inject: boolean; byRole: Record<string, string[]> };
  loop.skills = { ...skills, inject: true };
  fs.writeFileSync(loopPath, `${JSON.stringify(loop, null, 2)}\n`, 'utf8');

  const manifestPath = path.join(root, 'manifest.json');
  const covered = Object.keys((JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')) as { files: Record<string, string> }).files);
  const files: Record<string, string> = {};
  for (const rel of covered) {
    const full = path.join(root, rel);
    files[rel] = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, 'utf8');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function git(repo: string, args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
}

/** Copies a fixture seed into a fresh git repository and writes its task document outside it. */
function materialiseFixture(fixtureDir: string, model: string, workRoot: string): { repo: string; task: string } {
  const repo = fs.mkdtempSync(path.join(workRoot, 'repo-'));
  fs.cpSync(fixtureDir, repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'bench@test.local']);
  git(repo, ['config', 'user.name', 'Bench']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'initial']);

  const task = path.join(workRoot, `task-${path.basename(repo)}.md`);
  const raw = fs.readFileSync(path.join(fixtureDir, 'task.md'), 'utf8').replaceAll('__MODEL__', model);
  fs.writeFileSync(task, raw, 'utf8');
  return { repo, task };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'HELP') { process.stdout.write(`${usage()}\n`); return 0; }
    process.stderr.write(`${message.split(':')[0]}\n${usage()}\n`);
    return 1;
  }

  if (!args.dry && !args.model) {
    process.stderr.write('FLAG_REQUIRED:--model (or --dry)\n');
    return 1;
  }
  const model = args.dry ? 'stub/stub-code' : args.model!;

  const fixtureNames = fs.readdirSync(args.fixtures, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .slice(0, args.limit ?? undefined);
  if (!fixtureNames.length) {
    process.stderr.write(`NO_FIXTURES:${args.fixtures}\n`);
    return 1;
  }

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-bench-'));
  const reportDir = path.join(workRoot, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const stub = args.dry ? await startStub() : undefined;
  if (stub) FrontierModelService.register({ tenantId: args.tenant, id: 'stub', kind: 'local', baseUrl: stub.url, modelIds: ['stub-code'] });

  const onDoctrine = doctrineWithSkillsOn();
  DurableStore.resetForTests();

  const shipppedRoot = DoctrineService.root();
  const runOne = async ({ fixture, arm }: { fixture: string; arm: 'on' | 'off'; repetition: number }): Promise<BenchRunResult> => {
    process.env.FACTORY_DOCTRINE_ROOT = arm === 'on' ? onDoctrine.root : shipppedRoot;
    DoctrineService.clearCache();
    const { repo, task } = materialiseFixture(path.join(args.fixtures, fixture), model, workRoot);
    const outcome = await ExecutionLoopService.run({ repo, taskDocument: task, tenantId: args.tenant, reportDir });
    const unit = outcome.record.units[0];
    const attempts = unit?.attempts ?? [];
    return {
      firstAttemptSuccess: attempts[0]?.passed === true,
      stuck: unit?.status === 'stuck',
      refusals: attempts.filter((attempt) => !attempt.passed).length,
    };
  };

  let report: BenchReport;
  try {
    report = await runSkillBench({
      fixtures: fixtureNames,
      repetitions: args.repetitions,
      arms: ['on', 'off'],
      stub: args.dry,
      model,
      runOne,
      now: () => args.now ?? new Date().toISOString(),
    });
  } finally {
    delete process.env.FACTORY_DOCTRINE_ROOT;
    DoctrineService.clearCache();
    onDoctrine.cleanup();
    if (stub) await stub.close();
    fs.rmSync(workRoot, { recursive: true, force: true });
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, json, 'utf8');
  else process.stdout.write(json);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
