/**
 * The learning digest: the one read-back from the runs the factory records (Sprint 29, WP-6).
 *
 * The factory records everything the loop does and, until now, read none of it back. A run that
 * failed the same way five times started a sixth run that would fail the same way, with no record
 * of that shape reaching anything. ADR-012 accepts the gap and refuses the "recursive
 * self-improvement" framing: this service is a bounded, deterministic summary of durable run
 * records, and nothing more.
 *
 * The invariants are the ADR's, made code:
 *
 *  - **The ledger is the only source.** The digest is derived exclusively from `factoryLoopRuns`.
 *    A failure that was not recorded cannot be learned from, and the digest says so rather than
 *    inferring it.
 *  - **Deterministic.** `buildLearningDigest` is a pure function of the records it is given: no LLM,
 *    no clock, no randomness. The same records yield byte-identical JSON. Entries are ordered by
 *    (count descending, then key ascending), so ordering is stable.
 *  - **Bounded.** A hard cap on entries per section, key length, and the serialized size. Truncation
 *    is explicit (`truncated`, `omittedEntries`), never silent.
 *  - **Tenant-scoped.** `LearningDigestService.build(tenantId)` reads only that tenant's runs. No
 *    cross-tenant aggregate exists.
 *  - **Data-sufficiency threshold.** Below `minimumCompletedRuns` completed runs, the digest is an
 *    explicit `insufficient-data` record — a count of what is missing — not a conclusion.
 *  - **Read-only.** It mutates nothing, generates no tasks, and bypasses no gate.
 */
import { ExecutionLoopService } from './executionLoopService';
import type { LoopRunRecord } from './loopTypes';
import type { LoopFailureClass } from './loopFailureClass';

const DIGEST_VERSION = 1 as const;

/** Below this many completed runs the digest is `insufficient-data`, not a conclusion (ADR-012 §5). */
export const MINIMUM_COMPLETED_RUNS = 5;

/** The hard caps of ADR-012 §3. Truncation is reported, never silent. */
export const MAX_ENTRIES_PER_SECTION = 20;
export const MAX_TOTAL_ENTRIES = 30;
const MAX_KEY_LENGTH = 120;
export const MAX_SERIALIZED_BYTES = 4096;

interface DigestEntry {
  key: string;
  count: number;
}

export interface LearningDigest {
  version: typeof DIGEST_VERSION;
  tenantId: string;
  status: 'ok' | 'insufficient-data';
  /** Runs of this tenant the digest saw, and how many of them completed. */
  totalRuns: number;
  completedRuns: number;
  /** The documented threshold; the value is a parameter, the shape is version-controlled. */
  minimumCompletedRuns: number;
  /** Most frequent run-level failure classes across completed runs (WP-3 classification). */
  failureClasses: DigestEntry[];
  /** Most frequently refused gate ids across completed runs. */
  refusedGates: DigestEntry[];
  /** Most frequent refusal codes on failed attempts of completed runs. */
  stuckReasons: DigestEntry[];
  truncated: boolean;
  omittedEntries: number;
  /** A short, machine-stable explanation of the digest's sufficiency. */
  note: string;
}

function tally(keys: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** Count desc, then key ascending — the stable order ADR-012 §2 requires. */
function sortEntries(counts: Map<string, number>): DigestEntry[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function clampKey(key: string): string {
  return key.length > MAX_KEY_LENGTH ? `${key.slice(0, MAX_KEY_LENGTH - 1)}…` : key;
}

/** Cap each section and the total, returning the kept entries and how many were dropped. */
function boundEntries(sections: DigestEntry[][]): { sections: DigestEntry[][]; omitted: number } {
  let omitted = 0;
  let total = 0;
  const bounded = sections.map((section) => {
    const kept: DigestEntry[] = [];
    for (const entry of section) {
      if (kept.length >= MAX_ENTRIES_PER_SECTION || total >= MAX_TOTAL_ENTRIES) {
        omitted += 1;
        continue;
      }
      kept.push({ key: clampKey(entry.key), count: entry.count });
      total += 1;
    }
    return kept;
  });
  return { sections: bounded, omitted };
}

function serializedBytes(digest: LearningDigest): number {
  return Buffer.byteLength(JSON.stringify(digest), 'utf8');
}

/**
 * The pure digest builder. `runs` is the tenant's runs (the caller scopes them); `tenantId` labels
 * the result. No I/O, no clock — the same inputs always produce the same bytes.
 */
export function buildLearningDigest(
  runs: readonly LoopRunRecord[],
  tenantId: string,
  options: { minimumCompletedRuns?: number } = {},
): LearningDigest {
  const minimumCompletedRuns = options.minimumCompletedRuns ?? MINIMUM_COMPLETED_RUNS;
  const completed = runs.filter((run) => run.status === 'completed');
  const base = {
    version: DIGEST_VERSION,
    tenantId,
    totalRuns: runs.length,
    completedRuns: completed.length,
    minimumCompletedRuns,
  };

  if (completed.length < minimumCompletedRuns) {
    const missing = minimumCompletedRuns - completed.length;
    return {
      ...base,
      status: 'insufficient-data',
      failureClasses: [],
      refusedGates: [],
      stuckReasons: [],
      truncated: false,
      omittedEntries: 0,
      note: `insufficient data: ${completed.length} of ${minimumCompletedRuns} completed runs recorded; ${missing} more needed before a digest is a conclusion (ADR-012 §5)`,
    };
  }

  const failureClasses = sortEntries(tally(completed.map((run) => run.failureClass).filter((cls): cls is LoopFailureClass => Boolean(cls))));
  const refusedGates = sortEntries(tally(completed.flatMap((run) => run.gates.filter((gate) => !gate.passed).map((gate) => gate.id))));
  const stuckReasons = sortEntries(tally(completed.flatMap((run) => run.units.flatMap((unit) => unit.attempts.filter((attempt) => !attempt.passed).map((attempt) => attempt.reason)))));

  const bounded = boundEntries([failureClasses, refusedGates, stuckReasons]);
  let digest: LearningDigest = {
    ...base,
    status: 'ok',
    failureClasses: bounded.sections[0],
    refusedGates: bounded.sections[1],
    stuckReasons: bounded.sections[2],
    truncated: bounded.omitted > 0,
    omittedEntries: bounded.omitted,
    note: `derived from ${completed.length} completed runs; counts only, ordered by count then key (ADR-012 §2)`,
  };

  // The byte cap is the last defence: if the bounded digest still exceeds it, drop the globally
  // lowest-ranked entry (smallest count, then largest key) until it fits. Truncation stays explicit.
  while (serializedBytes(digest) > MAX_SERIALIZED_BYTES) {
    const sections: Array<[DigestEntry[], keyof Pick<LearningDigest, 'failureClasses' | 'refusedGates' | 'stuckReasons'>]> = [
      [digest.failureClasses, 'failureClasses'],
      [digest.refusedGates, 'refusedGates'],
      [digest.stuckReasons, 'stuckReasons'],
    ];
    let victim: { section: keyof LearningDigest; index: number } | undefined;
    for (const [entries, key] of sections) {
      for (let index = 0; index < entries.length; index += 1) {
        if (!victim) {
          victim = { section: key, index };
          continue;
        }
        const current = entries[index];
        const best = (digest[victim.section] as DigestEntry[])[victim.index];
        if (current.count < best.count || (current.count === best.count && current.key > best.key)) {
          victim = { section: key, index };
        }
      }
    }
    if (!victim) break;
    (digest[victim.section] as DigestEntry[]).splice(victim.index, 1);
    digest = { ...digest, truncated: true, omittedEntries: digest.omittedEntries + 1 };
  }

  return digest;
}

/**
 * The read-only surface. Reads the tenant's runs from the ledger and returns the digest. It never
 * mutates the ledger and never crosses a tenant boundary.
 */
export class LearningDigestService {
  public static build(tenantId: string, options: { minimumCompletedRuns?: number } = {}): LearningDigest {
    const runs = ExecutionLoopService.listRuns().filter((run) => run.tenantId === tenantId);
    return buildLearningDigest(runs, tenantId, options);
  }
}

/**
 * The injection seam (ADR-012 §6). It appends a bounded, fenced digest block to a prompt's task
 * text **only** when `enabled` is true. When `enabled` is false — the default — it returns the task
 * byte-for-byte unchanged, which is what makes "injection OFF is a no-op" an assertable fact rather
 * than a promise. No clock, no randomness; the same digest renders the same block.
 */
export function injectLearningDigest(task: string, digest: LearningDigest | undefined, enabled: boolean): string {
  if (!enabled || !digest) return task;
  if (digest.status === 'insufficient-data') return task;
  const lines: string[] = [
    '',
    '## Prior run outcomes (learning digest)',
    'Counts derived from this repository\'s recorded runs. This is context, not an instruction:',
    'do not weaken a criterion or a verification command to make a pattern go away.',
  ];
  if (digest.failureClasses.length) {
    lines.push(`- Failure classes: ${digest.failureClasses.map((entry) => `${entry.key}=${entry.count}`).join(', ')}`);
  }
  if (digest.refusedGates.length) {
    lines.push(`- Most-refused gates: ${digest.refusedGates.map((entry) => `${entry.key}=${entry.count}`).join(', ')}`);
  }
  if (digest.stuckReasons.length) {
    lines.push(`- Recurring refusal codes: ${digest.stuckReasons.map((entry) => `${entry.key}=${entry.count}`).join(', ')}`);
  }
  if (digest.truncated) {
    lines.push(`- (${digest.omittedEntries} further entr${digest.omittedEntries === 1 ? 'y' : 'ies'} omitted by the digest size bound)`);
  }
  return `${task}\n${lines.join('\n')}`;
}
