import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DurableStore } from './durableStore';
import { ContextIndexService, seedBuiltInContexts } from './contextIndexService';

export type FactoryJobStatus = 'IDEA' | 'SPECIFIED' | 'IMPLEMENTING' | 'VALIDATING' | 'DELIVERED' | 'BLOCKED';
export interface ProductBrief { problem: string; audience: string; valueHypothesis: string; wedge: string; nonGoals: string[]; acceptanceCriteria: string[]; createdAt: string; }
export interface ImplementationPlan { objective: string; contextRefs: string[]; inheritedPatterns: string[]; qualityGates: string[]; steps: Array<{ id: string; title: string; description: string; status: 'pending' | 'complete' }>; verificationCommand: string; generatedAt: string; }
export interface RepositoryRun { repositoryPath: string; branch: string; baseCommit: string; changedFiles: string[]; appliedAt: string; }
export interface VerificationRun { command: string; passed: boolean; exitCode: number; output: string; startedAt: string; completedAt: string; }
export interface PreviewArtifact { directory: string; entrypoint: string; generatedAt: string; }
export interface FactoryJob {
  id: string; tenantId: string; title: string; problem: string; desiredOutcome: string; status: FactoryJobStatus; acceptanceCriteria: string[];
  evidence: Array<{ kind: string; description: string; uri?: string; recordedAt: string }>;
  productBrief?: ProductBrief; implementationPlan?: ImplementationPlan; repositoryRun?: RepositoryRun; verificationRun?: VerificationRun; preview?: PreviewArtifact;
  createdAt: string; updatedAt: string;
}

const transitions: Record<FactoryJobStatus, FactoryJobStatus[]> = {
  IDEA: ['SPECIFIED', 'BLOCKED'], SPECIFIED: ['IMPLEMENTING', 'BLOCKED'], IMPLEMENTING: ['VALIDATING', 'BLOCKED'], VALIDATING: ['DELIVERED', 'IMPLEMENTING', 'BLOCKED'], DELIVERED: [], BLOCKED: ['SPECIFIED', 'IMPLEMENTING'],
};

function runGit(repo: string, args: string[]): string { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function workspaceAllowed(repo: string): boolean {
  const root = path.resolve(process.env.FACTORY_WORKSPACE_ROOT || process.cwd());
  const resolved = path.resolve(repo);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}
function audit(job: FactoryJob, action: string): void {
  DurableStore.appendAudit({ logId: DurableStore.id('audit', `${action}:${job.id}:${job.updatedAt}`), tenantId: job.tenantId, actorId: 'founder', action, resourceUri: `factory://jobs/${job.id}`, timestamp: new Date().toISOString() });
}

export class FactoryJobService {
  public static create(input: { tenantId: string; title: string; problem: string; desiredOutcome: string; acceptanceCriteria?: string[] }): FactoryJob {
    const now = new Date().toISOString();
    const job: FactoryJob = { id: DurableStore.id('job', `${input.tenantId}:${input.title}`), tenantId: input.tenantId, title: input.title.trim(), problem: input.problem.trim(), desiredOutcome: input.desiredOutcome.trim(), status: 'IDEA', acceptanceCriteria: input.acceptanceCriteria ?? [], evidence: [], createdAt: now, updatedAt: now };
    DurableStore.upsert('factoryJobs', job.id, job as unknown as Record<string, unknown>); audit(job, 'FACTORY_JOB_CREATED'); return job;
  }
  public static list(tenantId: string): FactoryJob[] { return DurableStore.list('factoryJobs').filter((job) => job.tenantId === tenantId) as unknown as FactoryJob[]; }
  public static get(tenantId: string, id: string): FactoryJob | undefined { const job = DurableStore.get('factoryJobs', id) as unknown as FactoryJob | undefined; return job?.tenantId === tenantId ? job : undefined; }
  private static save(job: FactoryJob): FactoryJob { const updated = { ...job, updatedAt: new Date().toISOString() }; DurableStore.upsert('factoryJobs', job.id, updated as unknown as Record<string, unknown>); return updated; }
  public static transition(tenantId: string, id: string, status: FactoryJobStatus): FactoryJob { const job = this.get(tenantId, id); if (!job) throw new Error('FACTORY_JOB_NOT_FOUND'); if (!transitions[job.status].includes(status)) throw new Error(`INVALID_FACTORY_TRANSITION:${job.status}->${status}`); const updated = this.save({ ...job, status }); audit(updated, 'FACTORY_JOB_STATUS_CHANGED'); return updated; }
  public static addEvidence(tenantId: string, id: string, evidence: { kind: string; description: string; uri?: string }): FactoryJob { const job = this.get(tenantId, id); if (!job) throw new Error('FACTORY_JOB_NOT_FOUND'); const updated = this.save({ ...job, evidence: [...job.evidence, { ...evidence, recordedAt: new Date().toISOString() }] }); audit(updated, 'FACTORY_JOB_EVIDENCE_RECORDED'); return updated; }

  public static createProductBrief(tenantId: string, id: string, input: { audience: string; valueHypothesis: string; wedge: string; nonGoals?: string[] }): FactoryJob {
    const job = this.get(tenantId, id); if (!job) throw new Error('FACTORY_JOB_NOT_FOUND');
    const brief: ProductBrief = { problem: job.problem, audience: input.audience.trim(), valueHypothesis: input.valueHypothesis.trim(), wedge: input.wedge.trim(), nonGoals: input.nonGoals ?? [], acceptanceCriteria: job.acceptanceCriteria, createdAt: new Date().toISOString() };
    const updated = this.save({ ...job, productBrief: brief, status: job.status === 'IDEA' ? 'SPECIFIED' : job.status }); audit(updated, 'PRODUCT_BRIEF_CREATED'); return updated;
  }

  public static createImplementationPlan(tenantId: string, id: string): FactoryJob {
    const job = this.get(tenantId, id); if (!job?.productBrief) throw new Error(job ? 'PRODUCT_BRIEF_REQUIRED' : 'FACTORY_JOB_NOT_FOUND');
    seedBuiltInContexts();
    const contexts = ContextIndexService.search(`${job.title} ${job.problem} ${job.productBrief.audience}`, 3);
    const plan: ImplementationPlan = { objective: job.productBrief.valueHypothesis, steps: [
      { id: 'contract', title: 'Define contract', description: 'Convert acceptance criteria into executable interfaces and states.', status: 'pending' },
      { id: 'implement', title: 'Implement vertical slice', description: `Build the smallest path for: ${job.productBrief.valueHypothesis}`, status: 'pending' },
      { id: 'verify', title: 'Verify trust layer', description: 'Run type checks, tests, security checks, and smoke validation.', status: 'pending' },
      { id: 'deliver', title: 'Prepare delivery evidence', description: 'Create a preview and attach the commit, verification, and preview artifacts.', status: 'pending' },
    ], contextRefs: contexts.map((context) => context.repository), inheritedPatterns: [...new Set(contexts.flatMap((context) => context.patterns))].slice(0, 8), qualityGates: ['typecheck or compile gate', 'unit/integration verification gate', 'security and tenant-boundary review', 'observable evidence attached before delivery'], verificationCommand: 'npm run verify', generatedAt: new Date().toISOString() };
    const updated = this.save({ ...job, implementationPlan: plan }); audit(updated, 'IMPLEMENTATION_PLAN_CREATED'); return updated;
  }

  public static prepareRepository(tenantId: string, id: string, input: { repositoryPath: string; branch?: string }): FactoryJob {
    const job = this.get(tenantId, id); if (!job?.implementationPlan) throw new Error(job ? 'IMPLEMENTATION_PLAN_REQUIRED' : 'FACTORY_JOB_NOT_FOUND');
    const repo = path.resolve(input.repositoryPath); if (!workspaceAllowed(repo) || !fs.existsSync(path.join(repo, '.git'))) throw new Error('REPOSITORY_OUTSIDE_APPROVED_WORKSPACE');
    const branch = input.branch || `factory/${id}`; const baseCommit = runGit(repo, ['rev-parse', 'HEAD']);
    try { runGit(repo, ['switch', branch]); } catch { runGit(repo, ['switch', '-c', branch]); }
    const updated = this.save({ ...job, repositoryRun: { repositoryPath: repo, branch, baseCommit, changedFiles: [], appliedAt: new Date().toISOString() }, status: 'IMPLEMENTING' }); audit(updated, 'REPOSITORY_BRANCH_PREPARED'); return updated;
  }

  public static modifyRepository(tenantId: string, id: string, input: { files: Array<{ path: string; content: string }> }): FactoryJob {
    const job = this.get(tenantId, id); if (!job?.repositoryRun) throw new Error(job ? 'REPOSITORY_BRANCH_REQUIRED' : 'FACTORY_JOB_NOT_FOUND');
    const repo = job.repositoryRun.repositoryPath; const changedFiles: string[] = [];
    for (const file of input.files) { const target = path.resolve(repo, file.path); if (!target.startsWith(`${repo}${path.sep}`)) throw new Error('FILE_OUTSIDE_REPOSITORY'); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content, 'utf8'); changedFiles.push(path.relative(repo, target)); }
    const updated = this.save({ ...job, repositoryRun: { ...job.repositoryRun, changedFiles: [...new Set([...job.repositoryRun.changedFiles, ...changedFiles])] } }); audit(updated, 'REPOSITORY_FILES_MODIFIED'); return updated;
  }

  public static verifyRepository(tenantId: string, id: string): FactoryJob {
    const job = this.get(tenantId, id); if (!job?.repositoryRun) throw new Error(job ? 'REPOSITORY_BRANCH_REQUIRED' : 'FACTORY_JOB_NOT_FOUND');
    const startedAt = new Date().toISOString(); let exitCode = 0; let output = '';
    try { output = execFileSync('npm', ['run', 'verify'], { cwd: job.repositoryRun.repositoryPath, encoding: 'utf8', timeout: Number(process.env.FACTORY_VERIFY_TIMEOUT_MS || 120000), maxBuffer: 2_000_000 }); } catch (error: any) { exitCode = typeof error.status === 'number' ? error.status : 1; output = `${error.stdout || ''}${error.stderr || ''}`.slice(-2_000_000); }
    const verificationRun: VerificationRun = { command: 'npm run verify', passed: exitCode === 0, exitCode, output, startedAt, completedAt: new Date().toISOString() };
    const updated = this.save({ ...job, verificationRun, status: verificationRun.passed ? 'VALIDATING' : 'BLOCKED' }); audit(updated, verificationRun.passed ? 'REPOSITORY_VERIFIED' : 'REPOSITORY_VERIFICATION_FAILED'); return updated;
  }

  public static createPreview(tenantId: string, id: string): FactoryJob {
    const job = this.get(tenantId, id); if (!job?.repositoryRun || !job.verificationRun?.passed) throw new Error(job ? 'PASSED_VERIFICATION_REQUIRED' : 'FACTORY_JOB_NOT_FOUND');
    const dist = path.join(job.repositoryRun.repositoryPath, 'dist'); if (!fs.existsSync(dist)) throw new Error('BUILD_OUTPUT_NOT_FOUND');
    const previewDir = path.resolve(process.env.FACTORY_PREVIEW_DIR || '.data/previews', job.id); fs.rmSync(previewDir, { recursive: true, force: true }); fs.cpSync(dist, previewDir, { recursive: true });
    const preview: PreviewArtifact = { directory: previewDir, entrypoint: path.join(previewDir, 'index.html'), generatedAt: new Date().toISOString() };
    const updated = this.save({ ...job, preview }); audit(updated, 'PREVIEW_CREATED'); return updated;
  }

  public static recordLaunchQuality(tenantId: string, id: string) {
    const job = this.get(tenantId, id); if (!job) throw new Error('FACTORY_JOB_NOT_FOUND');
    const dimensions = {
      verification: job.verificationRun?.passed ? 25 : 0,
      security: job.evidence.some((item) => item.kind.toLowerCase().includes('security')) ? 20 : 0,
      evidence: Math.min(20, job.evidence.length * 5),
      operability: job.repositoryRun && job.preview ? 15 : 0,
      productDiscipline: job.productBrief && job.implementationPlan ? 20 : 0,
    };
    const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
    return ContextIndexService.recordQuality({ tenantId, jobId: id, productName: job.title, score, baselineScore: ContextIndexService.qualityBaseline(), dimensions, evidenceKinds: job.evidence.map((item) => item.kind) });
  }

}
