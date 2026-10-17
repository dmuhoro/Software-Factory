/**
 * The shadow-log report for the unrelated-writes guard (Sprint 33, WP-6).
 *
 * The guard ships in shadow mode: an unclaimed write is recorded, named, and nothing is refused.
 * Turning enforcement on is a decision that needs evidence — how often it would fire, on which
 * units, and on which files — and evidence means reading every run, not the handful an operator
 * happens to open. This service is that reading, and it is pure: it takes run records and the
 * allowlist, and returns the summary. No clock, no I/O, no model, so the same records always yield
 * the same report.
 *
 * It recomputes the unrelated set from each unit's stored proof using the *same function* the gate
 * uses (`unrelatedWritesIn`), rather than parsing the gate's prose. A report that parsed the gate's
 * truncated detail string would silently drop the files past the tenth; this lists every one.
 *
 * The allowlist is passed in, not read from disk, because it is a property of the decision, not of
 * the records: a run was judged against the allowlist in force when it ran, and this report names
 * the allowlist it applied so a reader can tell when the two differ.
 */
import type { LoopRunRecord } from './loopTypes';
import { unrelatedWritesIn } from './unrelatedWrites';

interface UnrelatedWriteFinding {
  runId: string;
  tenantId: string;
  unitId: string;
  unitTitle: string;
  /** When the unit finished (or the run did, or the run started) — best available, never fabricated. */
  at: string;
  /** Every file the guard would refuse for this unit, in observed order. */
  files: string[];
}

export interface UnrelatedWritesReport {
  runsScanned: number;
  /** Units that carried a stored proof, i.e. units whose tree could be compared against a claim. */
  unitsWithProof: number;
  /** One entry per unit that would be refused, none when the guard would fire nowhere. */
  findings: UnrelatedWriteFinding[];
  /** The total number of files the guard would refuse across every run scanned. */
  totalWouldRefuse: number;
  /** The allowlist applied during this summarisation, echoed so the reader can judge it. */
  allowlist: readonly string[];
}

/**
 * Summarise what the shadow guard would refuse across a set of runs.
 *
 * Only units whose status is `done` are counted: a unit that never committed has no committed tree
 * for the guard to have judged, and its proof (if any) describes a tree that was discarded. Counting
 * it would overstate the guard.
 */
export function summariseUnrelatedWrites(runs: readonly LoopRunRecord[], allow: readonly string[]): UnrelatedWritesReport {
  const findings: UnrelatedWriteFinding[] = [];
  let unitsWithProof = 0;

  for (const run of runs) {
    for (const unit of run.units) {
      if (unit.status !== 'done' || !unit.proof) continue;
      unitsWithProof += 1;
      const files = unrelatedWritesIn(unit.proof.claimedFiles, unit.proof.observedFiles, allow);
      if (files.length === 0) continue;
      findings.push({
        runId: run.runId,
        tenantId: run.tenantId,
        unitId: unit.unitId,
        unitTitle: unit.title,
        at: unit.finishedAt ?? run.finishedAt ?? run.startedAt,
        files,
      });
    }
  }

  return {
    runsScanned: runs.length,
    unitsWithProof,
    findings,
    totalWouldRefuse: findings.reduce((sum, finding) => sum + finding.files.length, 0),
    allowlist: [...allow],
  };
}

/** The report as markdown, for a terminal. Empty means empty: it says so rather than printing a blank table. */
export function renderUnrelatedWritesReport(report: UnrelatedWritesReport): string {
  const lines: string[] = [
    '# Unrelated-writes shadow report',
    '',
    `- Runs scanned: ${report.runsScanned}`,
    `- Units judged (committed, with a stored proof): ${report.unitsWithProof}`,
    `- Units the guard would refuse: ${report.findings.length}`,
    `- Files the guard would refuse: ${report.totalWouldRefuse}`,
    `- Allowlist applied: ${report.allowlist.length ? report.allowlist.map((p) => `\`${p}\``).join(', ') : '(empty)'}`,
    '',
  ];
  if (report.findings.length === 0) {
    lines.push('No unclaimed write was recorded. The guard would have refused nothing over these runs.', '');
    return lines.join('\n');
  }
  lines.push('## Would-refuse, by unit', '');
  for (const finding of report.findings) {
    lines.push(`- **${finding.unitId}** — ${finding.unitTitle} (run \`${finding.runId}\`, tenant \`${finding.tenantId}\`, ${finding.at})`);
    for (const file of finding.files) lines.push(`  - \`${file}\``);
  }
  lines.push('');
  return lines.join('\n');
}
