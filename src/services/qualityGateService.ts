import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DurableStore } from './durableStore';
import { isGitRepository, resolveWithin } from '../utils/pathGuard';

export type AdapterKind = 'node' | 'python' | 'rust' | 'android' | 'static' | 'unknown';
export interface ProjectAdapter { id: string; tenantId: string; projectId: string; kind: AdapterKind; checks: string[]; artifactPath?: string; createdAt: string; }
export interface SecurityScan { id: string; tenantId: string; projectId?: string; status: 'PASSED' | 'BLOCKED'; findings: Array<{ rule: string; severity: 'HIGH' | 'MEDIUM' | 'LOW'; file: string; detail: string }>; scannedAt: string; }

function tenantOf(value: Record<string, unknown>): string { return String(value.tenantId ?? ''); }

/** Directories that are never scanned: vendored or generated, not source. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.data', '.next', '.cache', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.gradle', '.idea', '.factory-worktrees']);

/** Hard bounds. A quality gate must be a bounded sensor, never an unbounded crawl. */
const MAX_FILES = 5_000;
const MAX_DEPTH = 12;
/** Files larger than this are not read into memory for pattern matching. */
const MAX_SCAN_BYTES = 1_000_000;
const AUDIT_TIMEOUT_MS = 60_000;

/**
 * Bounded, symlink-refusing directory walk.
 *
 * SECURITY: the previous implementation recursed from an unchecked caller-supplied
 * path, which allowed reading and fingerprinting any directory on the host and
 * acted as an unbounded denial of service (a request for "/" never returns).
 * Callers must pass a path already validated by the path guard.
 */
function walk(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (result.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= MAX_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        visit(full, depth + 1);
      } else if (entry.isFile()) {
        result.push(full);
      }
    }
  };
  visit(root, 0);
  return result;
}

const SCANNABLE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|json|env|yml|yaml|toml|properties|conf|ini|sh)$/i;

/**
 * Project quality gates: detect a repository's verification contract and screen
 * it for credential-like material before it can be promoted.
 */
export class QualityGateService {
  /**
   * Resolves a caller-supplied repository path to a real path inside the approved
   * workspace. Every entry point goes through here; there is no other way to get a
   * path into this service.
   */
  private static resolveRepository(repositoryPath: unknown): string {
    return resolveWithin(repositoryPath, { code: 'QUALITY_REPOSITORY_OUTSIDE_APPROVED_WORKSPACE', mustExist: true, mustBeDirectory: true });
  }

  public static detect(tenantId: string, projectId: string, repositoryPath: unknown): ProjectAdapter {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') throw new Error('TENANT_CONTEXT_REQUIRED');
    if (typeof projectId !== 'string' || projectId.trim() === '') throw new Error('PROJECT_ID_REQUIRED');
    const root = this.resolveRepository(repositoryPath);
    const files = walk(root).map((file) => path.basename(file));
    const kind: AdapterKind = files.includes('package.json') ? 'node'
      : files.includes('pyproject.toml') || files.includes('requirements.txt') ? 'python'
        : files.includes('Cargo.toml') ? 'rust'
          : files.includes('build.gradle') || files.includes('gradlew') ? 'android'
            : files.includes('index.html') ? 'static' : 'unknown';
    const checks = kind === 'node' ? ['npm run lint', 'npm test', 'npm run build', 'secret-scan']
      : kind === 'python' ? ['python -m compileall', 'pytest', 'secret-scan']
        : kind === 'rust' ? ['cargo fmt --check', 'cargo test', 'cargo build --release', 'secret-scan']
          : ['git diff --check', 'secret-scan'];
    const adapter: ProjectAdapter = { id: DurableStore.id('adapter', `${tenantId}:${projectId}`), tenantId, projectId, kind, checks, artifactPath: root, createdAt: new Date().toISOString() };
    DurableStore.upsert('projectAdapters', adapter.id, adapter as unknown as Record<string, unknown>);
    return adapter;
  }

  public static scan(tenantId: string, repositoryPath: unknown, projectId?: string): SecurityScan {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') throw new Error('TENANT_CONTEXT_REQUIRED');
    const root = this.resolveRepository(repositoryPath);
    const findings: SecurityScan['findings'] = [];
    for (const file of walk(root)) {
      if (!SCANNABLE.test(file)) continue;
      let text: string;
      try {
        if (fs.statSync(file).size > MAX_SCAN_BYTES) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const relative = path.relative(root, file);
      if (/(AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})/.test(text)) {
        findings.push({ rule: 'secret-pattern', severity: 'HIGH', file: relative, detail: 'Credential-like material detected' });
      }
      if (/password\s*[:=]\s*['"][^'"]{4,}['"]|api[_-]?key\s*[:=]\s*['"][^'"]{4,}['"]/i.test(text) && !/\.example$/.test(file)) {
        findings.push({ rule: 'inline-secret', severity: 'HIGH', file: relative, detail: 'Possible inline credential detected' });
      }
    }
    if (isGitRepository(root) && fs.existsSync(path.join(root, 'package-lock.json'))) {
      try {
        execFileSync('npm', ['audit', '--package-lock-only', '--audit-level=high', '--json'], { cwd: root, stdio: 'pipe', timeout: AUDIT_TIMEOUT_MS, maxBuffer: 5_000_000 });
      } catch (error: unknown) {
        const failure = error as { stdout?: Buffer | string; message?: string };
        const detail = String(failure.stdout ?? failure.message ?? 'Dependency audit failed').slice(0, 2000);
        // A non-zero exit means vulnerabilities were found; that is a finding, not a crash.
        if (!/ENOTFOUND|ENOENT|EAI_AGAIN|ECONNREFUSED/.test(detail)) {
          findings.push({ rule: 'dependency-audit', severity: 'MEDIUM', file: 'package-lock.json', detail });
        }
      }
    }
    const record: SecurityScan = { id: DurableStore.id('scan', `${tenantId}:${root}`), tenantId, projectId, status: findings.some((item) => item.severity === 'HIGH') ? 'BLOCKED' : 'PASSED', findings, scannedAt: new Date().toISOString() };
    DurableStore.upsert('securityScans', record.id, record as unknown as Record<string, unknown>);
    return record;
  }

  public static list(tenantId: string): SecurityScan[] { return DurableStore.list('securityScans').filter((item) => tenantOf(item) === tenantId) as unknown as SecurityScan[]; }
}
