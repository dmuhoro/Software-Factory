import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DurableStore } from './durableStore';
import { WorkspaceService } from './workspaceService';

export type ClientAcceptanceStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';
export interface ClientWorkspace { id: string; tenantId: string; projectId: string; clientName: string; isolationRoot: string; allowedMembers: string[]; retentionDays: number; dataClassification: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL'; createdAt: string; }
export interface HandoverPack { id: string; tenantId: string; projectId: string; file: string; checksum: string; sections: string[]; generatedAt: string; }
export interface ClientAcceptance { id: string; tenantId: string; projectId: string; handoverId: string; status: ClientAcceptanceStatus; criteria: Array<{ id: string; label: string; passed: boolean; evidence: string[] }>; acceptedBy?: string; note?: string; updatedAt: string; }

function digest(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function tenantIdOf(value: Record<string, unknown>): string { return String(value.tenantId ?? ''); }

export class ClientDeliveryService {
  public static registerWorkspace(input: { tenantId: string; projectId: string; clientName: string; allowedMembers?: string[]; retentionDays?: number; dataClassification?: ClientWorkspace['dataClassification'] }): ClientWorkspace {
    const project = WorkspaceService.get(input.tenantId, input.projectId); if (!project) throw new Error('PROJECT_NOT_FOUND');
    const isolationRoot = path.resolve(process.env.FACTORY_CLIENT_WORKSPACE_ROOT || path.dirname(project.repositoryPath), `${input.tenantId}-${project.id}`);
    const record: ClientWorkspace = { id: DurableStore.id('clientws', `${input.tenantId}:${input.projectId}`), tenantId: input.tenantId, projectId: input.projectId, clientName: input.clientName.trim(), isolationRoot, allowedMembers: input.allowedMembers ?? [], retentionDays: Math.min(Math.max(input.retentionDays ?? 90, 7), 3650), dataClassification: input.dataClassification ?? 'CONFIDENTIAL', createdAt: new Date().toISOString() };
    fs.mkdirSync(record.isolationRoot, { recursive: true, mode: 0o700 }); DurableStore.upsert('clientWorkspaces', record.id, record as unknown as Record<string, unknown>); DurableStore.appendAudit({ logId: DurableStore.id('audit', record.id), tenantId: record.tenantId, action: 'CLIENT_WORKSPACE_REGISTERED', resourceUri: `factory://client-workspaces/${record.id}`, timestamp: record.createdAt }); return record;
  }
  public static listWorkspaces(tenantId: string): ClientWorkspace[] { return DurableStore.list('clientWorkspaces').filter((item) => tenantIdOf(item) === tenantId) as unknown as ClientWorkspace[]; }
  public static createHandover(tenantId: string, projectId: string, input: { releaseId?: string; verificationDigest?: string; acceptanceCriteria?: string[]; runbook?: string[] }): HandoverPack {
    const workspace = this.listWorkspaces(tenantId).find((item) => item.projectId === projectId); if (!workspace) throw new Error('CLIENT_WORKSPACE_NOT_FOUND');
    const project = WorkspaceService.get(tenantId, projectId); if (!project) throw new Error('PROJECT_NOT_FOUND');
    const sections = ['product-summary', 'verification-evidence', 'deployment-runbook', 'rollback-runbook', 'known-limitations', 'acceptance-criteria']; const payload = { version: 1, project: { id: project.id, name: project.name, language: project.language, verificationProfile: project.verificationProfile }, releaseId: input.releaseId ?? null, verificationDigest: input.verificationDigest ?? null, acceptanceCriteria: input.acceptanceCriteria ?? [], runbook: input.runbook ?? ['Verify health endpoint', 'Confirm current release checksum', 'Use rollback target if health degrades'], knownLimitations: ['Client acceptance remains explicit', 'Production credentials are never included in the pack'], generatedAt: new Date().toISOString() };
    const file = path.join(workspace.isolationRoot, `handover-${DurableStore.id('pack', projectId)}.json`); const content = JSON.stringify(payload, null, 2); fs.writeFileSync(file, content, { mode: 0o600 }); const pack: HandoverPack = { id: DurableStore.id('handover', `${tenantId}:${projectId}`), tenantId, projectId, file, checksum: digest(content), sections, generatedAt: payload.generatedAt }; DurableStore.upsert('handovers', pack.id, pack as unknown as Record<string, unknown>); return pack;
  }
  public static accept(tenantId: string, projectId: string, handoverId: string, input: { acceptedBy: string; criteria: Array<{ id: string; label: string; passed: boolean; evidence?: string[] }>; note?: string }): ClientAcceptance {
    const handover = DurableStore.get('handovers', handoverId) as unknown as HandoverPack | undefined; if (!handover || handover.tenantId !== tenantId || handover.projectId !== projectId) throw new Error('HANDOVER_NOT_FOUND');
    const criteria = input.criteria.map((item) => ({ id: item.id, label: item.label, passed: item.passed, evidence: item.evidence ?? [] })); const status: ClientAcceptanceStatus = criteria.length > 0 && criteria.every((item) => item.passed && item.evidence.length > 0) ? 'ACCEPTED' : 'REJECTED'; const acceptance: ClientAcceptance = { id: DurableStore.id('acceptance', `${tenantId}:${projectId}:${handoverId}`), tenantId, projectId, handoverId, status, criteria, acceptedBy: input.acceptedBy, note: input.note, updatedAt: new Date().toISOString() }; DurableStore.upsert('clientAcceptances', acceptance.id, acceptance as unknown as Record<string, unknown>); return acceptance;
  }
  public static listAcceptances(tenantId: string): ClientAcceptance[] { return DurableStore.list('clientAcceptances').filter((item) => tenantIdOf(item) === tenantId) as unknown as ClientAcceptance[]; }
}
