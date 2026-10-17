import path from 'node:path';
import { pathMatchesPattern } from './commitService';

/**
 * The unrelated writes: files the implementer changed but did not claim, and that the allowlist does
 * not clear.
 *
 * This is one function on purpose. The `unrelated-writes` gate is the sensor that records them in
 * shadow mode, and `unrelated-writes:report` summarises what the sensor recorded across runs. If the
 * report re-derived the set with its own copy of the matching rules, the two would eventually
 * disagree, and the report would describe a guard that does not exist. One implementation, two
 * callers.
 *
 * Order is preserved from `observed` so the output is deterministic.
 */
export function unrelatedWritesIn(claimed: readonly string[], observed: readonly string[], allow: readonly string[]): string[] {
  const claimedSet = new Set(claimed);
  const allowed = (file: string): boolean =>
    allow.some((pattern) => pathMatchesPattern(file, pattern) || pathMatchesPattern(path.basename(file), pattern));
  return observed.filter((file) => !claimedSet.has(file) && !allowed(file));
}
