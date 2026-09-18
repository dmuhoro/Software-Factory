import { DurableStore } from './durableStore';

export type FactoryJobStatus = 'IDEA' | 'SPECIFIED' | 'IMPLEMENTING' | 'VALIDATING' | 'DELIVERED' | 'BLOCKED';

export interface FactoryJob {
  id: string;
  tenantId: string;
  title: string;
  problem: string;
  desiredOutcome: string;
  status: FactoryJobStatus;
  acceptanceCriteria: string[];
  evidence: Array<{ kind: string; description: string; uri?: string; recordedAt: string }>;
  createdAt: string;
  updatedAt: string;
}

const transitions: Record<FactoryJobStatus, FactoryJobStatus[]> = {
  IDEA: ['SPECIFIED', 'BLOCKED'], SPECIFIED: ['IMPLEMENTING', 'BLOCKED'], IMPLEMENTING: ['VALIDATING', 'BLOCKED'], VALIDATING: ['DELIVERED', 'IMPLEMENTING', 'BLOCKED'], DELIVERED: [], BLOCKED: ['SPECIFIED', 'IMPLEMENTING'],
};

export class FactoryJobService {
  public static create(input: { tenantId: string; title: string; problem: string; desiredOutcome: string; acceptanceCriteria?: string[] }): FactoryJob {
    const now = new Date().toISOString();
    const job: FactoryJob = { id: DurableStore.id('job', `${input.tenantId}:${input.title}`), tenantId: input.tenantId, title: input.title.trim(), problem: input.problem.trim(), desiredOutcome: input.desiredOutcome.trim(), status: 'IDEA', acceptanceCriteria: input.acceptanceCriteria ?? [], evidence: [], createdAt: now, updatedAt: now };
    DurableStore.upsert('factoryJobs', job.id, job as unknown as Record<string, unknown>);
    void this.audit(job, 'FACTORY_JOB_CREATED');
    return job;
  }

  public static list(tenantId: string): FactoryJob[] {
    return DurableStore.list('factoryJobs').filter((job) => job.tenantId === tenantId) as unknown as FactoryJob[];
  }

  public static get(tenantId: string, id: string): FactoryJob | undefined {
    const job = DurableStore.get('factoryJobs', id) as unknown as FactoryJob | undefined;
    return job?.tenantId === tenantId ? job : undefined;
  }

  public static transition(tenantId: string, id: string, status: FactoryJobStatus): FactoryJob {
    const job = this.get(tenantId, id);
    if (!job) throw new Error('FACTORY_JOB_NOT_FOUND');
    if (!transitions[job.status].includes(status)) throw new Error(`INVALID_FACTORY_TRANSITION:${job.status}->${status}`);
    const updated = { ...job, status, updatedAt: new Date().toISOString() };
    DurableStore.upsert('factoryJobs', id, updated as unknown as Record<string, unknown>);
    void this.audit(updated, 'FACTORY_JOB_STATUS_CHANGED');
    return updated;
  }

  public static addEvidence(tenantId: string, id: string, evidence: { kind: string; description: string; uri?: string }): FactoryJob {
    const job = this.get(tenantId, id);
    if (!job) throw new Error('FACTORY_JOB_NOT_FOUND');
    const updated = { ...job, evidence: [...job.evidence, { ...evidence, recordedAt: new Date().toISOString() }], updatedAt: new Date().toISOString() };
    DurableStore.upsert('factoryJobs', id, updated as unknown as Record<string, unknown>);
    void this.audit(updated, 'FACTORY_JOB_EVIDENCE_RECORDED');
    return updated;
  }

  private static async audit(job: FactoryJob, action: string): Promise<void> {
    DurableStore.appendAudit({ logId: DurableStore.id('audit', `${action}:${job.id}:${job.updatedAt}`), tenantId: job.tenantId, actorId: 'founder', action, resourceUri: `factory://jobs/${job.id}`, timestamp: new Date().toISOString() });
  }
}
