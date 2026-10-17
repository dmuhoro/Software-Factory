#!/usr/bin/env tsx
/**
 * `npm run trial:note -- --repo <path> [--verdict accept|reject|hold] --notes "<text>"`
 *
 * Record the operator's judgement of a trial. This is the one part of a trial report that is not
 * derived, so it is stored labelled (`source: "operator"`) and printed in its own section. It
 * appends to `<ledger dir>/trial-notes.jsonl`; it never edits a run record.
 */
import path from 'node:path';
import { DurableStore } from '../src/services/durableStore';
import { appendTrialNote, type TrialNote, type TrialVerdict } from '../src/services/trialReportService';

const VERDICTS: TrialVerdict[] = ['accept', 'reject', 'hold'];

function fail(message: string): never {
  console.error(`refusing: ${message}`);
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: npm run trial:note -- --repo <path> [--verdict accept|reject|hold] --notes "<text>"');
    return;
  }
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    return next && !next.startsWith('--') ? next : undefined;
  };

  const repoArg = value('--repo') ?? fail('--repo is required');
  const notes = value('--notes') ?? fail('--notes is required');
  const verdictArg = value('--verdict');
  if (verdictArg !== undefined && !VERDICTS.includes(verdictArg as TrialVerdict)) {
    fail(`--verdict must be one of ${VERDICTS.join(', ')}`);
  }

  const note: TrialNote = {
    at: new Date().toISOString(),
    repo: path.resolve(repoArg),
    verdict: (verdictArg as TrialVerdict | undefined) ?? null,
    notes,
    source: 'operator',
  };
  appendTrialNote(DurableStore.dataFile(), note);
  console.log(`recorded operator note for ${note.repo} (verdict: ${note.verdict ?? 'unjudged'})`);
}

main();
