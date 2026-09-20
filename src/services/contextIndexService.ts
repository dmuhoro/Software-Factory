import { DurableStore } from './durableStore';

export type ContextKind = 'product' | 'architecture' | 'quality' | 'operations' | 'security' | 'knowledge';
export interface RepositoryContext {
  id: string;
  repository: string;
  commit: string;
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
  public static importRepository(context: Omit<RepositoryContext, 'id' | 'importedAt'>): RepositoryContext {
    const record: RepositoryContext = { ...context, id: DurableStore.id('context', context.repository), importedAt: new Date().toISOString() };
    DurableStore.upsert('repositoryContexts', record.id, record as unknown as Record<string, unknown>);
    return record;
  }
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
}

export const BUILT_IN_REPOSITORY_CONTEXTS: Array<Omit<RepositoryContext, 'id' | 'importedAt'>> = [
  { repository: 'Hermes-Forge', commit: 'def6f40', mission: 'Offline-first local AI engineering workspace with context-aware agents and explicit command approval.', kinds: ['architecture', 'security', 'knowledge', 'operations'], patterns: ['local-first inference', 'AST-driven context indexing', 'AbortController cancellation', 'human approval membrane for shell commands', 'offline privacy boundary'], qualityPractices: ['lint and typecheck', 'unit and integration tests', 'local release checklist', 'performance benchmarking'], risks: ['cloud fallback must remain opt-in', 'local model availability is an operational dependency'], adapters: ['context export', 'local model routing', 'approval gate', 'codebase oracle'], qualityScore: 76, qualityDimensions: { verification: 17, security: 18, evidence: 13, operability: 15, productDiscipline: 13 } },
  { repository: 'Forge', commit: 'cc19a56', mission: 'Portable decision and orchestration core for building and maintaining the ecosystem with planner, reviewer, evaluations, and sandbox.', kinds: ['architecture', 'quality', 'operations', 'knowledge'], patterns: ['planner-reviewer separation', 'evaluation-driven changes', 'sandboxed execution', 'SOP-driven operations', 'portable decision core'], qualityPractices: ['CI workflow', 'review gates', 'evaluation suites', 'sandbox boundary'], risks: ['transport and production integration remain separate concerns'], adapters: ['planner', 'reviewer', 'evaluation runner', 'sandbox executor', 'SOP importer'], qualityScore: 72, qualityDimensions: { verification: 18, security: 15, evidence: 13, operability: 14, productDiscipline: 12 } },
  { repository: 'Portable-UI-Engine', commit: 'a3677b8', mission: 'Framework-agnostic UI asset library with native web components, Shadow DOM isolation, and stable data/event contracts.', kinds: ['product', 'architecture', 'quality'], patterns: ['framework-agnostic components', 'Shadow DOM isolation', 'JSON payload contracts', 'defensive parsing', 'composed DOM events', 'design tokens'], qualityPractices: ['build pipeline', 'browser QA pressure test', 'component contract documentation'], risks: ['browser/device matrix and CI coverage should expand'], adapters: ['UI component generator', 'design-token importer', 'contract fixture generator'], qualityScore: 68, qualityDimensions: { verification: 13, security: 13, evidence: 12, operability: 12, productDiscipline: 18 } },
  { repository: 'ShrinkMedia', commit: 'd317271', mission: 'Private on-device media and document toolkit with honest offline/connected profiles, operational evidence, and device verification.', kinds: ['product', 'security', 'quality', 'operations', 'knowledge'], patterns: ['offline-first privacy', 'explicit connected flavor', 'device verification evidence', 'ADR and constitution governance', 'failure surfacing and audit logs', '3-2-1 backup operations'], qualityPractices: ['unit and integration tests', 'CI', 'device verification', 'evidence logs', 'release runbooks', 'honest aspirational status labels'], risks: ['Android device matrix and external deployment credentials require explicit gates'], adapters: ['evidence importer', 'ADR importer', 'offline profile', 'device-verification gate', 'backup runbook'], qualityScore: 88, qualityDimensions: { verification: 23, security: 20, evidence: 20, operability: 15, productDiscipline: 10 } },
  { repository: 'Forge.ai', commit: '717e960', mission: 'AI-assisted product builder surface for turning an idea into an application experience.', kinds: ['product', 'architecture'], patterns: ['guided product builder', 'authenticated project workspace', 'interactive preview surface', 'Supabase-backed product state'], qualityPractices: ['typecheck and build scripts'], risks: ['no detected tests or CI', 'provider and deployment boundaries need verification', 'product claims should be separated from verified capability'], adapters: ['product brief UI', 'preview surface', 'project intake'], qualityScore: 34, qualityDimensions: { verification: 5, security: 8, evidence: 4, operability: 5, productDiscipline: 12 } },
];

export function seedBuiltInContexts(): RepositoryContext[] {
  if (ContextIndexService.list().length > 0) return ContextIndexService.list();
  return BUILT_IN_REPOSITORY_CONTEXTS.map((context) => ContextIndexService.importRepository(context));
}
