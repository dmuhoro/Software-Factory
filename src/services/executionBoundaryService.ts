import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { DurableStore } from './durableStore';
import { detectVerificationProfile, FailureClass, VerificationProfile } from './verificationProfileService';

export interface ExecutionManifest { id: string; tenantId: string; sourcePath: string; snapshotPath: string; sourceCommit: string; profile: VerificationProfile; network: 'disabled'; environment: 'sanitized'; timeoutMs: number; maxOutputBytes: number; createdAt: string; }
export interface IsolatedRun { manifest: ExecutionManifest; passed: boolean; exitCode: number; output: string; failedStep?: string; failureClass?: FailureClass; completedAt: string; }

function commit(repo: string): string { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30000 }).trim(); }
function copyTree(source: string, target: string): void { fs.cpSync(source, target, { recursive: true, filter: (item) => !item.includes(`${path.sep}.git${path.sep}`) && !item.includes(`${path.sep}.data${path.sep}`) }); }
function classify(step: string, output: string): FailureClass { const value = `${step} ${output}`.toLowerCase(); if (/security|secret|permission/.test(value)) return 'SECURITY'; if (/type|tsc|compile/.test(value)) return 'TYPECHECK'; if (/test|pytest|cargo test/.test(value)) return 'TEST'; if (/build|assemble|bundle/.test(value)) return 'BUILD'; if (/fmt|lint|format/.test(value)) return 'FORMAT'; return 'UNKNOWN'; }

export class ExecutionBoundaryService {
  public static createManifest(tenantId: string, sourcePath: string, options: { timeoutMs?: number; maxOutputBytes?: number } = {}): ExecutionManifest {
    const root = path.resolve(sourcePath); const approved = path.resolve(process.env.FACTORY_WORKSPACE_ROOT || process.cwd()); if (!(root === approved || root.startsWith(`${approved}${path.sep}`))) throw new Error('EXECUTION_SOURCE_OUTSIDE_APPROVED_WORKSPACE'); if (!fs.existsSync(path.join(root, '.git'))) throw new Error('EXECUTION_SOURCE_NOT_GIT');
    const snapshotPath = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-execution-')); copyTree(root, snapshotPath); const profile = detectVerificationProfile(snapshotPath); const manifest: ExecutionManifest = { id: DurableStore.id('execution', `${tenantId}:${root}`), tenantId, sourcePath: root, snapshotPath, sourceCommit: commit(root), profile, network: 'disabled', environment: 'sanitized', timeoutMs: Math.min(options.timeoutMs ?? 120000, 300000), maxOutputBytes: Math.min(options.maxOutputBytes ?? 2_000_000, 5_000_000), createdAt: new Date().toISOString() };
    DurableStore.upsert('backups', manifest.id, manifest as unknown as Record<string, unknown>); return manifest;
  }
  public static run(tenantId: string, manifestId: string): IsolatedRun {
    const manifest = DurableStore.get('backups', manifestId) as unknown as ExecutionManifest | undefined; if (!manifest || manifest.tenantId !== tenantId || !manifest.snapshotPath) throw new Error('EXECUTION_MANIFEST_NOT_FOUND');
    const env = { PATH: process.env.PATH || '', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'factory-home-')), NODE_ENV: 'test', CI: 'true' }; const output: string[] = [];
    for (const step of manifest.profile.steps) {
      try { const value = execFileSync(step.executable, step.args, { cwd: manifest.snapshotPath, env, encoding: 'utf8', timeout: manifest.timeoutMs, maxBuffer: manifest.maxOutputBytes, stdio: ['ignore', 'pipe', 'pipe'] }); output.push(`$ ${step.label}\n${value}`); } catch (error: any) { const value = `${error.stdout || ''}${error.stderr || ''}`.slice(-manifest.maxOutputBytes); output.push(`$ ${step.label}\n${value}`); const result: IsolatedRun = { manifest, passed: false, exitCode: typeof error.status === 'number' ? error.status : 1, output: output.join('\n'), failedStep: step.id, failureClass: classify(step.id, value), completedAt: new Date().toISOString() }; this.cleanup(manifest); return result; }
    }
    const result: IsolatedRun = { manifest, passed: true, exitCode: 0, output: output.join('\n'), completedAt: new Date().toISOString() }; this.cleanup(manifest); return result;
  }
  public static cleanup(manifest: ExecutionManifest): void { if (manifest.snapshotPath && fs.existsSync(manifest.snapshotPath)) fs.rmSync(manifest.snapshotPath, { recursive: true, force: true }); }
  public static digestRun(run: IsolatedRun): string { return crypto.createHash('sha256').update(JSON.stringify({ id: run.manifest.id, commit: run.manifest.sourceCommit, profile: run.manifest.profile.id, passed: run.passed, output: run.output })).digest('hex'); }
}
