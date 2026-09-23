import crypto from 'node:crypto';
import { DurableStore } from './durableStore';

export type ReadinessLevel = 'LEVEL_1_FOUNDER' | 'LEVEL_2_CLIENT' | 'LEVEL_3_PRODUCTION' | 'LEVEL_4_AUTONOMY';
export type ProofStatus = 'PLANNED' | 'OBSERVED' | 'PASSED' | 'FAILED';
export interface ProofRecord { id: string; tenantId: string; level: ReadinessLevel; criterion: string; runId?: string; status: ProofStatus; observedAt?: string; artifactRefs: string[]; measurements: Record<string, number | string | boolean>; reviewer: string; note?: string; createdAt: string; }
const criteria: Record<ReadinessLevel, string[]> = { LEVEL_1_FOUNDER: ['five complete founder jobs', 'no lost durable state', 'no hidden unfinished work'], LEVEL_2_CLIENT: ['three client-like dry runs', 'isolated client workspace', 'reproducible handover and acceptance'], LEVEL_3_PRODUCTION: ['hosted deployment succeeds', 'secret isolation verified', 'health failure blocks or rolls back release'], LEVEL_4_AUTONOMY: ['hardened execution boundary', 'parallel agents preserve task order', 'irreversible actions escalate'] };
function tenantOf(value: Record<string, unknown>): string { return String(value.tenantId ?? ''); }

export class ReadinessEvidenceService {
  public static criteria(level: ReadinessLevel): string[] { return criteria[level]; }
  public static record(input: Omit<ProofRecord, 'id' | 'createdAt'>): ProofRecord { if (!criteria[input.level].includes(input.criterion)) throw new Error('READINESS_CRITERION_NOT_RECOGNIZED'); if (input.status === 'PASSED' && (!input.runId || input.artifactRefs.length === 0 || !input.observedAt)) throw new Error('PASSED_PROOF_REQUIRES_OBSERVATION'); const record: ProofRecord = { ...input, id: DurableStore.id('proof', `${input.tenantId}:${input.level}:${input.criterion}:${input.runId ?? ''}`), createdAt: new Date().toISOString() }; DurableStore.upsert('proofRecords', record.id, record as unknown as Record<string, unknown>); return record; }
  public static list(tenantId: string, level?: ReadinessLevel): ProofRecord[] { return DurableStore.list('proofRecords').filter((item) => tenantOf(item) === tenantId && (!level || item.level === level)) as unknown as ProofRecord[]; }
  public static summary(tenantId: string, level: ReadinessLevel): { level: ReadinessLevel; criteria: string[]; passed: string[]; failed: string[]; pending: string[]; readyForDeclaration: boolean } { const records = this.list(tenantId, level); const passed = criteria[level].filter((criterion) => records.some((record) => record.criterion === criterion && record.status === 'PASSED')); const failed = criteria[level].filter((criterion) => records.some((record) => record.criterion === criterion && record.status === 'FAILED')); return { level, criteria: criteria[level], passed, failed, pending: criteria[level].filter((criterion) => !passed.includes(criterion) && !failed.includes(criterion)), readyForDeclaration: passed.length === criteria[level].length && failed.length === 0 }; }
  public static evidenceDigest(tenantId: string, level: ReadinessLevel): string { return crypto.createHash('sha256').update(JSON.stringify(this.list(tenantId, level))).digest('hex'); }
}
