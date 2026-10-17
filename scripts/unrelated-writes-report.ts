#!/usr/bin/env tsx
/**
 * `npm run unrelated-writes:report -- [--tenant <id>] [--json]`
 *
 * Summarise the unrelated-writes shadow log across every recorded run: how many units carried a
 * proof, how many would be refused, and every file the guard would refuse. The guard ships in
 * shadow mode; this is the evidence an operator reads before deciding whether to flip
 * `unrelatedWrites.enforce` on (the flip rule is recorded in `sprints/sprint-33-closing-sprint.md`).
 *
 * It reads the ledger and the current doctrine allowlist, and it changes neither. Exit code 0 is a
 * report, not a verdict: an empty report is a valid, useful answer.
 *
 * Usage:
 *   npm run unrelated-writes:report
 *   npm run unrelated-writes:report -- --tenant acme
 *   npm run unrelated-writes:report -- --json
 */
import { ExecutionLoopService } from '../src/services/executionLoopService';
import { DoctrineService } from '../src/services/doctrineService';
import { summariseUnrelatedWrites, renderUnrelatedWritesReport } from '../src/services/unrelatedWritesReportService';

interface Args {
  tenant?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  if (argv.includes('--help') || argv.includes('-h')) return { json: false, help: true };
  const args: Args = { json: argv.includes('--json'), help: false };
  const tenantIndex = argv.indexOf('--tenant');
  if (tenantIndex >= 0) {
    const value = argv[tenantIndex + 1];
    if (!value || value.startsWith('--')) {
      console.error('--tenant needs a value');
      process.exit(2);
    }
    args.tenant = value;
  }
  return args;
}

function usage(): string {
  return [
    'Usage: npm run unrelated-writes:report -- [--tenant <id>] [--json]',
    '',
    '  --tenant <id>  only summarise runs belonging to this tenant',
    '  --json         print the report as JSON instead of markdown',
    '  --help         show this message',
  ].join('\n');
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const allow = DoctrineService.load().loop.unrelatedWrites.allow;
  const allRuns = ExecutionLoopService.listRuns();
  const runs = args.tenant ? allRuns.filter((run) => run.tenantId === args.tenant) : allRuns;

  const report = summariseUnrelatedWrites(runs, allow);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(renderUnrelatedWritesReport(report));
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`unrelated-writes:report could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
