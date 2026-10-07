#!/usr/bin/env tsx
/**
 * `npm run factory:run -- --repo <target> --task <task.md>`
 *
 * The unattended entry point. It reads a task document, loads Software Factory's doctrine from
 * outside the target repository, and runs PLAN → IMPLEMENT → VERIFY → COMMIT → REPORT until
 * every unit is committed, stuck, or the run hits a hard stop. It asks nothing; it reports.
 *
 * Exit codes are the contract with cron and CI:
 *   0  every unit committed and verified
 *   1  the run refused to start (dirty tree, bad document, doctrine drift, unknown gate)
 *   2  the run finished, but at least one unit is STUCK or BLOCKED
 *   3  the run halted at a hard stop (wall clock, attempts, commits, resources, doctrine)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExecutionLoopService } from '../src/services/executionLoopService';
import { classifyApiError } from '../src/utils/apiError';
import type { LoopRunRecord } from '../src/services/loopTypes';

interface Args {
  repo?: string;
  task?: string;
  tenant?: string;
  attemptCap?: number;
  resume?: string;
  reportDir?: string;
  json: boolean;
  help: boolean;
}

function usage(): string {
  return [
    'Usage: npm run factory:run -- --repo <path> --task <task-document.md> [options]',
    '',
    '  --repo <path>          target repository (must be clean and under git)',
    '  --task <path>          task document to execute',
    '  --tenant <id>          tenant whose model providers are used (default: default)',
    '  --attempt-cap <n>      lowers doctrine attempts.maxPerUnit; cannot raise it',
    '  --resume <runId>       continue an interrupted run',
    '  --report-dir <path>    where the run report is written (default: .data/loop-runs)',
    '  --json                 print the run record instead of the summary',
    '  --help                 this text',
    '',
    'Exit codes: 0 all committed · 1 refused to start · 2 some units stuck · 3 hard stop',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`FLAG_REQUIRES_VALUE:${flag}`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--repo': args.repo = value(); break;
      case '--task': args.task = value(); break;
      case '--tenant': args.tenant = value(); break;
      case '--attempt-cap': args.attemptCap = Number(value()); break;
      case '--resume': args.resume = value(); break;
      case '--report-dir': args.reportDir = value(); break;
      case '--json': args.json = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`FLAG_UNKNOWN:${flag}`);
    }
  }
  return args;
}

function summary(record: LoopRunRecord): string {
  if (!record) return '';
  const done = record.units.filter((unit) => unit.status === 'done').length;
  const stuck = record.units.filter((unit) => unit.status === 'stuck').length;
  const blocked = record.units.filter((unit) => unit.status === 'blocked').length;
  const refused = record.gates.filter((gate) => !gate.passed).length;
  return [
    `run       ${record.runId}`,
    `status    ${record.status}${record.hardStop ? ` — ${record.hardStop}` : ''}${record.refusal ? ` — ${record.refusal}` : ''}`,
    `units     ${done} committed · ${stuck} stuck · ${blocked} blocked · ${record.units.length} total`,
    `commits   ${record.commits.length}`,
    `gates     ${record.gates.length} executed, ${refused} refused`,
    `narration ${record.narrationRejected} claim(s) recorded and discarded`,
  ].join('\n');
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // Usage errors are ours and name a flag; they are printed as the code, not the sentence.
    const code = (error as Error).message.split(':')[0] || 'FLAG_INVALID';
    process.stderr.write(`${code}\n${usage()}\n`);
    return 1;
  }

  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (!args.repo || !args.task) {
    process.stderr.write(`FLAG_REQUIRED:--repo and --task are required\n${usage()}\n`);
    return 1;
  }
  for (const flag of ['--repo', '--task'] as const) {
    const value = flag === '--repo' ? args.repo! : args.task!;
    if (!fs.existsSync(value)) {
      process.stderr.write(`PATH_MISSING:${value}\n`);
      return 1;
    }
  }

  try {
    const outcome = await ExecutionLoopService.run({
      repo: path.resolve(args.repo),
      taskDocument: path.resolve(args.task),
      tenantId: args.tenant,
      attemptCap: args.attemptCap,
      resumeRunId: args.resume,
      reportDir: args.reportDir,
      onStart: (eventsPath) => {
        // The stream is live from the first gate check; print where to watch it before the run
        // moves on. JSON callers get the line on stderr so stdout remains a single document.
        const line = `watch     ${eventsPath}`;
        if (args.json) process.stderr.write(`${line}\n`);
        else process.stdout.write(`${line}\n`);
      },
      onEvent: (entry) => {
        // Live JSONL event stream – one line per event. process.stdout flushes each write;
        // there is no flush() method on a Node Writable.
        const line = JSON.stringify(entry);
        process.stdout.write(`${line}\n`);
      },
    });
    if (args.json) process.stdout.write(`${JSON.stringify(outcome.record, null, 2)}\n`);
    else process.stdout.write(`${summary(outcome.record)}\nreport    ${outcome.reportFiles.markdown}\nevents    ${outcome.eventsPath}\n`);
    return outcome.exitCode;
  } catch (error) {
    const classified = classifyApiError(error as Error);
    // The published message only: raw detail stays in the log, never on a terminal that may be
    // captured in a shared transcript.
    process.stderr.write(`${classified.code}: ${classified.message}\n`);
    if (classified.internal) process.stderr.write(`incident ${classified.incidentId}\n`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
