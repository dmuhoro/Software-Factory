/**
 * Persistent cross-run memory (Layer 3 Runtime).
 *
 * ai-memory steal, adapted to SF constraints: TypeScript (no Rust, per ADR-016),
 * single-writer JSON ledger, tenant-scoped. Memories are created from run outcomes
 * — what worked, what failed, structural patterns — and persist across `--resume`
 * runs so the loop learns from its own history without fabricating claims.
 *
 * Read-only from the perspective of the target tree: memories are written to SF's
 * own durable ledger, never to a target repository. The same input always yields
 * the same memory record.
 */

import { DurableStore } from './durableStore';
import crypto from 'node:crypto';
import fs from 'node:fs';

export interface MemoryRecord {
  id: string;
  tenantId: string;
  runId?: string;
  /** What the memory is about: 'outcome', 'pattern', 'warning', 'fix'. */
  kind: 'outcome' | 'pattern' | 'warning' | 'fix';
  /** Short description of what was observed. */
  summary: string;
  /** Machine-readable detail: file:line, error codes, gate results. */
  detail: string;
  /** Related unit id, if the memory is about a specific unit. */
  unitId?: string;
  /** Related failure class, if applicable. */
  failureClass?: string;
  /** How many times this memory has been consulted. */
  consultCount: number;
  createdAt: string;
  lastConsultedAt?: string;
}

export interface MemoryQuery {
  tenantId: string;
  kind?: MemoryRecord['kind'];
  failureClass?: string;
  unitId?: string;
  since?: string;
  limit?: number;
}

/** Hash content to a stable id. */
function memoryId(tenantId: string, summary: string, detail: string): string {
  return crypto.createHash('sha256').update(`${tenantId}:${summary}:${detail}`).digest('hex').slice(0, 20);
}

/** The persistent memory service: record and query cross-run memories. */
export class PersistentMemoryService {
  /** Record a memory from a run outcome. Idempotent: same summary+detail reuses the existing record. */
  public static record(input: {
    tenantId: string;
    runId?: string;
    kind: MemoryRecord['kind'];
    summary: string;
    detail: string;
    unitId?: string;
    failureClass?: string;
  }): MemoryRecord {
    const id = memoryId(input.tenantId, input.summary, input.detail);
    const now = new Date().toISOString();
    const existing = DurableStore.get('loopMemories', id) as unknown as MemoryRecord | undefined;

    if (existing) {
      // Update consult count and last consulted, keep the original summary/detail.
      const updated = { ...existing, consultCount: existing.consultCount + 1, lastConsultedAt: now };
      DurableStore.upsert('loopMemories', id, updated as unknown as Record<string, unknown>);
      return updated;
    }

    const record: MemoryRecord = {
      id,
      tenantId: input.tenantId,
      runId: input.runId,
      kind: input.kind,
      summary: input.summary,
      detail: input.detail,
      unitId: input.unitId,
      failureClass: input.failureClass,
      consultCount: 1,
      createdAt: now,
    };
    DurableStore.upsert('loopMemories', id, record as unknown as Record<string, unknown>);
    return record;
  }

  /** Query memories with optional filters. Returns newest first. */
  public static query(query: MemoryQuery): MemoryRecord[] {
    let memories = DurableStore.list('loopMemories') as unknown as MemoryRecord[];

    memories = memories.filter((m) => m.tenantId === query.tenantId);
    if (query.kind) memories = memories.filter((m) => m.kind === query.kind);
    if (query.failureClass) memories = memories.filter((m) => m.failureClass === query.failureClass);
    if (query.unitId) memories = memories.filter((m) => m.unitId === query.unitId);
    if (query.since) memories = memories.filter((m) => m.createdAt >= query.since!);

    memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (query.limit) memories = memories.slice(0, query.limit);
    return memories;
  }

  /** Mark a memory as consulted (increment consult count). */
  public static consult(id: string): MemoryRecord | undefined {
    const record = DurableStore.get('loopMemories', id) as unknown as MemoryRecord | undefined;
    if (!record) return undefined;
    const updated = { ...record, consultCount: record.consultCount + 1, lastConsultedAt: new Date().toISOString() };
    DurableStore.upsert('loopMemories', id, updated as unknown as Record<string, unknown>);
    return updated;
  }

  /** Test seam: reset the memory store. Clears disk so memories don't persist across tests. */
  public static resetForTests(): void {
    DurableStore.resetForTests();
    const dataFile = DurableStore.dataFile();
    try { fs.rmSync(dataFile, { force: true }); } catch { /* ignore */ }
  }
}

export const persistentMemoryService = PersistentMemoryService;
