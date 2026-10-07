/**
 * The complete set of gate identifiers the loop may execute.
 *
 * This module has no imports on purpose. `doctrineService` needs the list to refuse a rule whose
 * enforcement it cannot resolve, and the gate registry needs it to prove it implements every id;
 * if either imported the other there would be a cycle, and a cycle is exactly how a validation
 * ends up not running. One plain list, imported by both.
 */
export const GATE_IDS = [
  'doctrine-integrity',
  'doctrine-isolation',
  'resource-admission',
  'plan-is-executable',
  'model-assignment',
  'no-op-unit',
  'claimed-files-exist',
  'ground-truth',
  'attempt-cap',
  'review-approve',
  'secret-scan',
  'clean-tree',
  'verified-commit-message',
  'one-commit-per-unit',
  'evidence-is-machine-derived',
] as const;

export type GateId = (typeof GATE_IDS)[number];

export function isGateId(value: string): value is GateId {
  return (GATE_IDS as readonly string[]).includes(value);
}
