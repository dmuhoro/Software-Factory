import { DurableStore } from './durableStore';

export type HarnessAction = 'READ_REPOSITORY' | 'MODIFY_BRANCH' | 'RUN_VERIFICATION' | 'CREATE_PREVIEW' | 'PUSH_BRANCH' | 'DEPLOY_PRODUCTION' | 'CHANGE_CREDENTIALS' | 'DELETE_DATA' | 'SEND_EXTERNAL_MESSAGE';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export interface ApprovalRequest { id: string; tenantId: string; jobId?: string; action: HarnessAction; rationale: string; status: ApprovalStatus; requestedBy: string; decidedBy?: string; decisionNote?: string; requestedAt: string; decidedAt?: string; }

const automatic = new Set<HarnessAction>(['READ_REPOSITORY', 'MODIFY_BRANCH', 'RUN_VERIFICATION', 'CREATE_PREVIEW']);
export class ApprovalPolicyService {
  public static requiresApproval(action: HarnessAction): boolean { return !automatic.has(action); }
  public static request(input: { tenantId: string; jobId?: string; action: HarnessAction; rationale: string; requestedBy?: string }): ApprovalRequest {
    const request: ApprovalRequest = { id: DurableStore.id('approval', `${input.tenantId}:${input.jobId ?? ''}:${input.action}`), tenantId: input.tenantId, jobId: input.jobId, action: input.action, rationale: input.rationale.trim(), status: 'PENDING', requestedBy: input.requestedBy ?? 'founder', requestedAt: new Date().toISOString() };
    DurableStore.upsert('approvals', request.id, request as unknown as Record<string, unknown>);
    DurableStore.appendAudit({ logId: DurableStore.id('audit', request.id), tenantId: request.tenantId, action: 'APPROVAL_REQUESTED', resourceUri: `factory://approvals/${request.id}`, timestamp: request.requestedAt });
    return request;
  }
  public static decide(tenantId: string, id: string, status: 'APPROVED' | 'REJECTED', note: string, decidedBy = 'founder'): ApprovalRequest {
    const request = DurableStore.get('approvals', id) as unknown as ApprovalRequest | undefined;
    if (!request || request.tenantId !== tenantId) throw new Error('APPROVAL_NOT_FOUND');
    if (request.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
    const updated: ApprovalRequest = { ...request, status, decisionNote: note.trim(), decidedBy, decidedAt: new Date().toISOString() };
    DurableStore.upsert('approvals', id, updated as unknown as Record<string, unknown>);
    DurableStore.appendAudit({ logId: DurableStore.id('audit', id), tenantId, action: `APPROVAL_${status}`, resourceUri: `factory://approvals/${id}`, timestamp: updated.decidedAt });
    return updated;
  }
  public static get(tenantId: string, id: string): ApprovalRequest | undefined { const request = DurableStore.get('approvals', id) as unknown as ApprovalRequest | undefined; return request?.tenantId === tenantId ? request : undefined; }
  public static list(tenantId: string): ApprovalRequest[] { return DurableStore.list('approvals').filter((request) => request.tenantId === tenantId) as unknown as ApprovalRequest[]; }
  public static assertApproved(tenantId: string, jobId: string, action: HarnessAction): void {
    if (!this.requiresApproval(action)) return;
    const approved = this.list(tenantId).find((request) => request.jobId === jobId && request.action === action && request.status === 'APPROVED');
    if (!approved) throw new Error(`APPROVAL_REQUIRED:${action}`);
  }
}
