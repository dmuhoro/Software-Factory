import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DurableStore } from './durableStore';
import { detectVerificationProfile } from './verificationProfileService';
import { isGitRepository, resolveWithin } from '../utils/pathGuard';

export type ProjectLifecycle = 'active' | 'paused' | 'blocked' | 'delivered' | 'retired';
export type ProjectKind = 'personal' | 'client' | 'product';
export interface ProjectRecord { id: string; tenantId: string; name: string; repositoryPath: string; kind: ProjectKind; owner: string; language: string; verificationProfile: string; developmentCommand?: string; previewCommand?: string; deploymentTarget?: string; requiredEnv: string[]; lifecycle: ProjectLifecycle; createdAt: string; updatedAt: string; }
export interface WorkspaceInbox { projects: ProjectRecord[]; jobsRequiringDecision: unknown[]; blockedJobs: unknown[]; unfinishedJobs: unknown[]; releasesAwaitingApproval: unknown[]; staleContexts: unknown[]; generatedAt: string; }

function approvedPath(repositoryPath: string): string { return resolveWithin(repositoryPath, { code: 'PROJECT_OUTSIDE_APPROVED_WORKSPACE', mustExist: true, mustBeDirectory: true }); }
function checksum(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }

export class WorkspaceService {
  public static register(input: { tenantId: string; name: string; repositoryPath: string; kind?: ProjectKind; owner?: string; language?: string; developmentCommand?: string; previewCommand?: string; deploymentTarget?: string; requiredEnv?: string[] }): ProjectRecord {
    const repositoryPath = approvedPath(input.repositoryPath); if (!isGitRepository(repositoryPath)) throw new Error('PROJECT_REPOSITORY_NOT_GIT');
    const profile = detectVerificationProfile(repositoryPath); const now = new Date().toISOString();
    const record: ProjectRecord = { id: DurableStore.id('project', `${input.tenantId}:${input.name}`), tenantId: input.tenantId, name: input.name.trim(), repositoryPath, kind: input.kind ?? 'personal', owner: input.owner ?? 'founder', language: input.language ?? profile.id, verificationProfile: profile.id, developmentCommand: input.developmentCommand, previewCommand: input.previewCommand, deploymentTarget: input.deploymentTarget ?? 'filesystem-preview', requiredEnv: input.requiredEnv ?? [], lifecycle: 'active', createdAt: now, updatedAt: now };
    DurableStore.upsert('projects', record.id, record as unknown as Record<string, unknown>); DurableStore.appendAudit({ logId: DurableStore.id('audit', record.id), tenantId: record.tenantId, action: 'PROJECT_REGISTERED', resourceUri: `factory://projects/${record.id}`, timestamp: now }); return record;
  }
  public static list(tenantId: string): ProjectRecord[] { return DurableStore.list('projects').filter((item) => item.tenantId === tenantId) as unknown as ProjectRecord[]; }
  public static get(tenantId: string, id: string): ProjectRecord | undefined { const project = DurableStore.get('projects', id) as unknown as ProjectRecord | undefined; return project?.tenantId === tenantId ? project : undefined; }
  public static select(tenantId: string, name: string): ProjectRecord | undefined { return this.list(tenantId).find((project) => project.name.toLowerCase() === name.trim().toLowerCase()); }
  public static updateLifecycle(tenantId: string, id: string, lifecycle: ProjectLifecycle): ProjectRecord { const project = this.get(tenantId, id); if (!project) throw new Error('PROJECT_NOT_FOUND'); const updated = { ...project, lifecycle, updatedAt: new Date().toISOString() }; DurableStore.upsert('projects', id, updated as unknown as Record<string, unknown>); return updated; }
  public static backup(tenantId: string): { id: string; tenantId: string; file: string; checksum: string; createdAt: string; recordCount: number } {
    const source = path.resolve(process.env.FACTORY_DATA_DIR || '.data', 'software-factory.json'); if (!fs.existsSync(source)) throw new Error('FACTORY_LEDGER_NOT_FOUND');
    const backupDir = path.resolve(process.env.FACTORY_BACKUP_DIR || '.data/backups'); fs.mkdirSync(backupDir, { recursive: true }); const createdAt = new Date().toISOString(); const id = DurableStore.id('backup', tenantId); const file = path.join(backupDir, `${id}.json`); fs.copyFileSync(source, file); const value = { id, tenantId, file, checksum: checksum(fs.readFileSync(file, 'utf8')), createdAt, recordCount: Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length }; DurableStore.upsert('backups', id, value); return value;
  }
  public static restore(tenantId: string, backupId: string): { id: string; restoredFrom: string; checksum: string; restoredAt: string } {
    const backup = DurableStore.get('backups', backupId) as { tenantId?: string; file?: string; checksum?: string } | undefined;
    if (!backup || backup.tenantId !== tenantId || !backup.file) throw new Error('BACKUP_NOT_FOUND');
    if (!fs.existsSync(backup.file)) throw new Error('BACKUP_FILE_NOT_FOUND');
    const data = fs.readFileSync(backup.file, 'utf8');
    if (checksum(data) !== backup.checksum) throw new Error('BACKUP_CHECKSUM_MISMATCH');
    // DurableStore.replaceDocument validates and swaps in one locked operation. The
    // previous implementation wrote the file and then called a test-only reset,
    // which let an in-flight request persist pre-restore state over the restored file.
    DurableStore.replaceDocument(data);
    return { id: backupId, restoredFrom: backup.file, checksum: backup.checksum, restoredAt: new Date().toISOString() };
  }
  public static inbox(tenantId: string): WorkspaceInbox {
    const jobs = DurableStore.list('factoryJobs').filter((item) => item.tenantId === tenantId) as Array<Record<string, any>>; const approvals = DurableStore.list('approvals').filter((item) => item.tenantId === tenantId) as Array<Record<string, any>>;
    return { projects: this.list(tenantId), jobsRequiringDecision: jobs.filter((job) => ['IDEA', 'SPECIFIED', 'RELEASE_PENDING'].includes(job.status)), blockedJobs: jobs.filter((job) => job.status === 'BLOCKED'), unfinishedJobs: jobs.filter((job) => !['DELIVERED', 'CLOSED'].includes(job.status)), releasesAwaitingApproval: approvals.filter((approval) => approval.status === 'PENDING'), staleContexts: [], generatedAt: new Date().toISOString() };
  }
}
