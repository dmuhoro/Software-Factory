import { DurableStore } from './durableStore';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isGitRepository, resolveWithin } from '../utils/pathGuard';

export type ContextKind = 'product' | 'architecture' | 'quality' | 'operations' | 'security' | 'knowledge';
/**
 * Where an indexed context came from. `bundled-example` records ship with the
 * repository as worked examples of institutional pattern; `imported` records
 * were indexed from a real repository the operator connected. The distinction is
 * surfaced in the API and the audit report so example data is never mistaken for
 * evidence about a real codebase.
 */
export type ContextProvenance = 'bundled-example' | 'imported';
export interface RepositoryContext {
  id: string;
  repository: string;
  commit: string;
  provenance: ContextProvenance;
  mission: string;
  kinds: ContextKind[];
  patterns: string[];
  qualityPractices: string[];
  risks: string[];
  adapters: string[];
  qualityScore: number;
  qualityDimensions: { verification: number; security: number; evidence: number; operability: number; productDiscipline: number };
  importedAt: string;
}
export interface QualitySnapshot {
  id: string;
  tenantId: string;
  jobId?: string;
  productName: string;
  score: number;
  baselineScore: number;
  improvementPercent: number;
  dimensions: RepositoryContext['qualityDimensions'];
  evidenceKinds: string[];
  recordedAt: string;
}

const tokenize = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
const overlap = (a: string[], b: string[]): number => { const set = new Set(a); return b.filter((item) => set.has(item)).length; };

export class ContextIndexService {
  public static importRepository(context: Omit<RepositoryContext, 'id' | 'importedAt' | 'provenance'> & { provenance?: ContextProvenance }): RepositoryContext {
    const record: RepositoryContext = { provenance: 'imported', ...context, id: DurableStore.id('context', context.repository), importedAt: new Date().toISOString() };
    DurableStore.upsert('repositoryContexts', record.id, record as unknown as Record<string, unknown>);
    return record;
  }
  /** Contexts indexed from a real connected repository. Excludes bundled examples. */
  public static listImported(): RepositoryContext[] { return this.list().filter((item) => item.provenance !== 'bundled-example'); }
  public static list(): RepositoryContext[] { return DurableStore.list('repositoryContexts') as unknown as RepositoryContext[]; }
  public static search(query: string, limit = 8): RepositoryContext[] {
    const terms = tokenize(query);
    return this.list().map((context) => ({ context, score: overlap(terms, tokenize([context.repository, context.mission, ...context.patterns, ...context.adapters].join(' '))) }))
      .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.context.qualityScore - a.context.qualityScore).slice(0, limit).map((item) => item.context);
  }
  public static qualityBaseline(): number {
    const contexts = this.list();
    return contexts.length ? Math.round(contexts.reduce((sum, context) => sum + context.qualityScore, 0) / contexts.length) : 0;
  }
  public static recordQuality(input: Omit<QualitySnapshot, 'id' | 'improvementPercent' | 'recordedAt'>): QualitySnapshot {
    const baseline = input.baselineScore || this.qualityBaseline();
    const improvementPercent = baseline > 0 ? Math.round(((input.score - baseline) / baseline) * 1000) / 10 : 0;
    const snapshot: QualitySnapshot = { ...input, baselineScore: baseline, improvementPercent, id: DurableStore.id('quality', `${input.tenantId}:${input.productName}`), recordedAt: new Date().toISOString() };
    DurableStore.upsert('qualitySnapshots', snapshot.id, snapshot as unknown as Record<string, unknown>);
    return snapshot;
  }
  public static qualityHistory(tenantId: string): QualitySnapshot[] { return DurableStore.list('qualitySnapshots').filter((snapshot) => snapshot.tenantId === tenantId) as unknown as QualitySnapshot[]; }
  public static qualitySummary(tenantId?: string) {
    const snapshots = tenantId ? this.qualityHistory(tenantId) : DurableStore.list('qualitySnapshots') as unknown as QualitySnapshot[];
    const latest = [...snapshots].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    return { baselineScore: this.qualityBaseline(), launches: snapshots.length, latestScore: latest?.score ?? null, latestImprovementPercent: latest?.improvementPercent ?? null, averageImprovementPercent: snapshots.length ? Math.round(snapshots.reduce((sum, item) => sum + item.improvementPercent, 0) / snapshots.length * 10) / 10 : 0 };
  }
  public static refreshRepository(repository: string, sourcePath: string): RepositoryContext {
    const current = this.list().find((context) => context.repository.toLowerCase() === repository.trim().toLowerCase()); if (!current) throw new Error('REPOSITORY_CONTEXT_NOT_FOUND');
    const root = resolveWithin(sourcePath, { code: 'REPOSITORY_SOURCE_OUTSIDE_APPROVED_WORKSPACE', mustExist: true, mustBeDirectory: true });
    if (!isGitRepository(root)) throw new Error('REPOSITORY_SOURCE_NOT_GIT');
    const commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 30000 }).trim();
    const files = fs.readdirSync(root, { withFileTypes: true }); const testCount = files.filter((entry) => /test|spec/i.test(entry.name)).length; const hasCi = fs.existsSync(path.join(root, '.github', 'workflows'));
    const refreshed: RepositoryContext = { ...current, commit, provenance: 'imported', qualityPractices: [...new Set([...current.qualityPractices, ...(testCount ? ['refresh detected test assets'] : []), ...(hasCi ? ['refresh detected CI workflows'] : [])])], importedAt: new Date().toISOString() };
    DurableStore.upsert('repositoryContexts', current.id, refreshed as unknown as Record<string, unknown>); return refreshed;
  }
  public static promotePattern(repository: string, pattern: string, adapter: string): RepositoryContext {
    const current = this.list().find((context) => context.repository.toLowerCase() === repository.trim().toLowerCase()); if (!current) throw new Error('REPOSITORY_CONTEXT_NOT_FOUND');
    const updated: RepositoryContext = { ...current, patterns: [...new Set([...current.patterns, pattern.trim()])], adapters: [...new Set([...current.adapters, adapter.trim()])], importedAt: new Date().toISOString() };
    DurableStore.upsert('repositoryContexts', current.id, updated as unknown as Record<string, unknown>); return updated;
  }
}

/**
 * Bundled worked examples of institutional engineering pattern.
 *
 * These are NOT indexes of real connected repositories. They ship with the
 * repository so the planning, context-search, and pattern-promotion paths are
 * exercisable from a fresh clone, and they are tagged `bundled-example` so the
 * API, the UI, and the audit report can say so. Set `FACTORY_SEED_EXAMPLES=false`
 * to start with an empty index.
 */
export const EXAMPLE_REFERENCE_CONTEXTS: Array<Omit<RepositoryContext, 'id' | 'importedAt'>> = [
  { repository: 'Hermes-Forge', commit: 'def6f40', provenance: 'bundled-example', mission: 'Offline-first local AI engineering workspace with context-aware agents and explicit command approval.', kinds: ['architecture', 'security', 'knowledge', 'operations'], patterns: ['local-first inference', 'AST-driven context indexing', 'AbortController cancellation', 'human approval membrane for shell commands', 'offline privacy boundary'], qualityPractices: ['lint and typecheck', 'unit and integration tests', 'local release checklist', 'performance benchmarking'], risks: ['cloud fallback must remain opt-in', 'local model availability is an operational dependency'], adapters: ['context export', 'local model routing', 'approval gate', 'codebase oracle'], qualityScore: 76, qualityDimensions: { verification: 17, security: 18, evidence: 13, operability: 15, productDiscipline: 13 } },
  { repository: 'Forge', commit: 'cc19a56', provenance: 'bundled-example', mission: 'Portable decision and orchestration core for building and maintaining the ecosystem with planner, reviewer, evaluations, and sandbox.', kinds: ['architecture', 'quality', 'operations', 'knowledge'], patterns: ['planner-reviewer separation', 'evaluation-driven changes', 'sandboxed execution', 'SOP-driven operations', 'portable decision core'], qualityPractices: ['CI workflow', 'review gates', 'evaluation suites', 'sandbox boundary'], risks: ['transport and production integration remain separate concerns'], adapters: ['planner', 'reviewer', 'evaluation runner', 'sandbox executor', 'SOP importer'], qualityScore: 72, qualityDimensions: { verification: 18, security: 15, evidence: 13, operability: 14, productDiscipline: 12 } },
  { repository: 'Portable-UI-Engine', commit: 'a3677b8', provenance: 'bundled-example', mission: 'Framework-agnostic UI asset library with native web components, Shadow DOM isolation, and stable data/event contracts.', kinds: ['product', 'architecture', 'quality'], patterns: ['framework-agnostic UI', 'Shadow DOM isolation', 'JSON payload contracts', 'defensive parsing', 'composed DOM events', 'design tokens'], qualityPractices: ['build pipeline', 'browser QA pressure test', 'component contract documentation'], risks: ['browser/device matrix and CI coverage should expand'], adapters: ['UI component generator', 'design-token importer', 'contract fixture generator'], qualityScore: 68, qualityDimensions: { verification: 13, security: 13, evidence: 12, operability: 12, productDiscipline: 18 } },
  { repository: 'ShrinkMedia', commit: 'd317271', provenance: 'bundled-example', mission: 'Private on-device media and document toolkit with honest offline/connected profiles, operational evidence, and device verification.', kinds: ['product', 'security', 'quality', 'operations', 'knowledge'], patterns: ['offline-first privacy', 'explicit connected flavor', 'device verification evidence', 'ADR and constitution governance', 'failure surfacing and audit logs', '3-2-1 backup operations'], qualityPractices: ['unit and integration tests', 'CI', 'device verification', 'evidence logs', 'release runbooks', 'honest aspirational status labels'], risks: ['Android device matrix and external deployment credentials require explicit gates'], adapters: ['evidence importer', 'ADR importer', 'offline profile', 'device-verification gate', 'backup runbook'], qualityScore: 88, qualityDimensions: { verification: 23, security: 20, evidence: 20, operability: 15, productDiscipline: 10 } },
  { repository: 'Forge.ai', commit: '717e960', provenance: 'bundled-example', mission: 'AI-assisted product builder surface for turning an idea into an application experience.', kinds: ['product', 'architecture'], patterns: ['guided product builder', 'authenticated project workspace', 'interactive preview surface', 'Supabase-backed product state'], qualityPractices: ['typecheck and build scripts'], risks: ['no detected tests or CI', 'provider and deployment boundaries need verification', 'product claims should be separated from verified capability'], adapters: ['product brief UI', 'preview surface', 'project intake'], qualityScore: 34, qualityDimensions: { verification: 5, security: 8, evidence: 4, operability: 5, productDiscipline: 12 } },
];

/** Backwards-compatible alias. Retained because older call sites import this name. */
export const BUILT_IN_REPOSITORY_CONTEXTS = EXAMPLE_REFERENCE_CONTEXTS;

/**
 * Ensures the bundled examples exist in the index. Idempotent, and safe to call
 * from a request handler: it must never be invoked at module scope, because that
 * turns a ledger read into an import-time side effect and made a corrupt ledger
 * fatal to process start.
 */
export function seedBuiltInContexts(): RepositoryContext[] {
  if (process.env.FACTORY_SEED_EXAMPLES === 'false') return ContextIndexService.list();
  if (ContextIndexService.list().length > 0) return ContextIndexService.list();
  return EXAMPLE_REFERENCE_CONTEXTS.map((context) => ContextIndexService.importRepository(context));
}
