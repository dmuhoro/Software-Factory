#!/usr/bin/env tsx
/**
 * `npm run trial:report -- --repo <path> --since <YYYY-MM-DD> [--json] [--out <file>]`
 *
 * Derive a production-trial report from the ledger and from git, and nothing else. Every figure
 * is either measured or `null`: the report names what it could not derive rather than printing a
 * plausible zero. Exit 0 means the report was produced — it is not a verdict. A trial's verdict is
 * an operator note (`npm run trial:note`), printed separately and labelled as such.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DurableStore } from '../src/services/durableStore';
import { ExecutionLoopService } from '../src/services/executionLoopService';
import type { UsageEvent } from '../src/services/usageMeteringService';
import {
  assertGitRepository, buildTrialReport, collectCommitFacts, readTrialNotes, renderTrialReport,
} from '../src/services/trialReportService';

interface Args {
  repo?: string;
  since?: string;
  json: boolean;
  out?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: argv.includes('--json'), help: argv.includes('--help') || argv.includes('-h') };
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      console.error(`${flag} needs a value`);
      process.exit(2);
    }
    return next;
  };
  args.repo = value('--repo');
  args.since = value('--since');
  args.out = value('--out');
  return args;
}

function usage(): void {
  console.log('usage: npm run trial:report -- --repo <path> --since <YYYY-MM-DD> [--json] [--out <file>]');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (!args.repo) { console.error('refusing: --repo is required'); usage(); process.exit(2); }
  if (!args.since) { console.error('refusing: --since is required'); usage(); process.exit(2); }

  const repo = path.resolve(args.repo);
  const sinceMs = Date.parse(args.since);
  if (!Number.isFinite(sinceMs)) {
    console.error(`refusing: --since is not a date: ${args.since}`);
    process.exit(2);
  }
  const since = new Date(sinceMs).toISOString();

  try {
    assertGitRepository(repo);
  } catch (error) {
    console.error(`refusing: ${(error as Error).message}`);
    process.exit(2);
  }

  const ledger = DurableStore.dataFile();
  const runs = ExecutionLoopService.listRuns();
  const inWindow = runs.filter((run) => path.resolve(run.repo) === repo && Date.parse(run.startedAt) >= sinceMs);
  const loopShas = [
    ...new Set(inWindow.flatMap((run) => [...run.commits.map((c) => c.sha), ...(run.merges ?? []).map((m) => m.sha)])),
  ];

  const report = buildTrialReport({
    repo,
    since,
    runs,
    usage: DurableStore.list('usageEvents') as unknown as UsageEvent[],
    notes: readTrialNotes(ledger, repo),
    commitFacts: collectCommitFacts(repo, loopShas, since),
    ledger,
  });

  const body = args.json ? `${JSON.stringify(report, null, 2)}\n` : renderTrialReport(report);
  if (args.out) {
    const out = path.resolve(args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body, 'utf8');
    console.log(`trial report written to ${out}`);
  } else {
    process.stdout.write(body);
  }
}

main();
