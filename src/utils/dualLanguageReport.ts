/**
 * Dual-language reporting.
 *
 * Every durable record Software Factory produces is rendered in two vocabularies:
 *
 * - Technical: proof digests, gate results, failure classes, commit SHAs, verification exit codes,
 *   the machine-readable evidence an engineer audits.
 * - Founder/CEO: plain-language status, what is built, what is blocked, what decision is needed,
 *   and the outcome — no figure without a named command that reproduces it.
 *
 * Both renderings describe the same record. No capability is claimed here that the code cannot
 * reproduce with a named command.
 */

type Vocabulary = 'technical' | 'founder';

export interface DualLanguageRecord {
  runId: string;
  repo: string;
  taskDocument: string;
  status: 'running' | 'completed' | 'halted' | 'refused';
  units: UnitSummary[];
  gates: GateSummary[];
  failureClass?: string;
  narrationRejected: number;
  startedAt: string;
  finishedAt?: string;
  hardStop?: string;
  refusal?: string;
  /** Named command that reproduces the figures in this record. */
  reproducesWith: string;
}

export interface UnitSummary {
  unitId: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'stuck' | 'blocked';
  attempts: number;
  commitSha?: string;
  failureClass?: string;
  blockedBy?: string;
}

interface GateSummary {
  id: string;
  stage: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}

/**
 * Renders a loop run record in both vocabularies. Returns an object the caller (API, CLI, or
 * frontend) can serialize however it chooses. No model is involved; every figure comes from the
 * durable record itself.
 */
export function renderDualLanguage(record: DualLanguageRecord): {
  technical: string;
  founder: string;
} {
  const doneUnits = record.units.filter((u) => u.status === 'done').length;
  const stuckUnits = record.units.filter((u) => u.status === 'stuck').length;
  const blockedUnits = record.units.filter((u) => u.status === 'blocked').length;
  const totalUnits = record.units.length;
  const passedGates = record.gates.filter((g) => g.passed).length;
  const totalGates = record.gates.length;
  const refusedGates = record.gates.filter((g) => !g.passed && g.blocking).length;

  const technical = [
    `Run ${record.runId}`,
    `Repo: ${record.repo}`,
    `Task document: ${record.taskDocument}`,
    `Status: ${record.status}`,
    `Started: ${record.startedAt}`,
    record.finishedAt ? `Finished: ${record.finishedAt}` : 'Finished: —',
    `Units: ${doneUnits}/${totalUnits} done, ${stuckUnits} stuck, ${blockedUnits} blocked`,
    `Gates: ${passedGates}/${totalGates} passed, ${refusedGates} blocking refusals`,
    `Narration rejected: ${record.narrationRejected}`,
    record.failureClass ? `Dominant failure class: ${record.failureClass}` : 'Failure class: —',
    record.hardStop ? `Hard stop: ${record.hardStop}` : 'Hard stop: —',
    record.refusal ? `Refusal: ${record.refusal}` : 'Refusal: —',
    '',
    'Units:',
    ...record.units.map(
      (u) =>
        `  ${u.unitId} ${u.title} — ${u.status} (${u.attempts} attempt${
          u.attempts !== 1 ? 's' : ''
        }${u.commitSha ? `, commit ${u.commitSha}` : ''}${
          u.failureClass ? `, failure class ${u.failureClass}` : ''
        }${u.blockedBy ? `, blocked by ${u.blockedBy}` : ''})`
    ),
    '',
    'Gates:',
    ...record.gates.map(
      (g) => `  ${g.id} (${g.stage}) — ${g.passed ? 'passed' : 'FAILED'}${g.blocking ? ' (blocking)' : ''}: ${g.detail}`
    ),
    '',
    `Reproduces with: ${record.reproducesWith}`,
  ].join('\n');

  const founder = [
    `Product run ${record.runId} — ${record.status}`,
    `Repository: ${record.repo}`,
    `Started: ${record.startedAt}${record.finishedAt ? ', finished: ' + record.finishedAt : ''}, still running`,
    '',
    'What was built:',
    ...record.units
      .filter((u) => u.status === 'done')
      .map((u) => `  ✓ ${u.title} — ${founderStatus(u.status)}${
        u.commitSha ? ` (${u.commitSha.slice(0, 7)})` : ''
      }`),
    '',
    stuckUnits > 0
      ? [
          'What is blocked (needs your decision):',
          ...record.units
            .filter((u) => u.status === 'stuck')
            .map(
              (u) =>
                `  ⚠ ${u.title} — ${founderStatus(u.status)} after ${u.attempts} attempt${
                  u.attempts !== 1 ? 's' : ''
                }. ${
                  u.failureClass ? `Failure class: ${u.failureClass}.` : ''
                } Next step is recorded on the run record.`
            ),
          '',
        ]
      : [],
    blockedUnits > 0
      ? [
          'What is waiting on dependencies:',
          ...record.units
            .filter((u) => u.status === 'blocked')
            .map((u) => `  … ${u.title} — ${founderStatus(u.status)}`),
          '',
        ]
      : [],
    `Verification: ${passedGates}/${totalGates} checks passed${refusedGates > 0 ? `; ${refusedGates} blocking checks refused` : ''}.`,
    record.narrationRejected > 0
      ? `Narration rejected: ${record.narrationRejected} unsupported claims were discarded; only executed commands count as evidence.`
      : '',
    record.refusal
      ? `The run was refused: ${record.refusal}.`
      : record.hardStop
        ? `The run hit a hard stop: ${record.hardStop}.`
        : '',
    '',
    'Reproduces with:',
    `  ${record.reproducesWith}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { technical, founder };
}

/**
 * Renders a single unit result in both vocabularies.
 */
export function renderUnitDualLanguage(unit: {
  unitId: string;
  title: string;
  status: UnitSummary['status'];
  attempts: number;
  commitSha?: string;
  failureClass?: string;
  detail?: string;
  reproducesWith: string;
}): { technical: string; founder: string } {
  const technical = [
    `Unit ${unit.unitId}: ${unit.title}`,
    `Status: ${unit.status}`,
    `Attempts: ${unit.attempts}`,
    unit.commitSha ? `Commit: ${unit.commitSha}` : 'Commit: —',
    unit.failureClass ? `Failure class: ${unit.failureClass}` : 'Failure class: —',
    unit.detail ? `Detail: ${unit.detail}` : '',
    `Reproduces with: ${unit.reproducesWith}`,
  ]
    .filter(Boolean)
    .join('\n');

  const founder = [
    `${unit.title} — ${founderStatus(unit.status)}`,
    unit.attempts > 0 ? `Attempts: ${unit.attempts}` : '',
    unit.commitSha ? `Committed: ${unit.commitSha.slice(0, 7)}` : 'Not yet committed.',
    unit.failureClass ? `Issue class: ${unit.failureClass}.` : '',
    unit.detail ? `${unit.detail}` : '',
    `Reproduces with: ${unit.reproducesWith}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { technical, founder };
}

/** Plain-language rendering of a unit status. */
function founderStatus(status: UnitSummary['status']): string {
  switch (status) {
    case 'done':
      return 'Built and verified';
    case 'stuck':
      return 'Blocked — needs your decision';
    case 'blocked':
      return 'Waiting on a dependency';
    case 'running':
      return 'In progress';
    default:
      return 'Not started';
  }
}
