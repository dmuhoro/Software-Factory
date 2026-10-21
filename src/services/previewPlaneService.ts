/**
 * Preview plane — Layer 2 Agency.
 *
 * After each commit, builds the target repo in an ephemeral git worktree, runs
 * its dev server on an ephemeral port, and exposes it through a commit → preview
 * mapping. Additive only: it never touches the loop, the doctrine, or any gate.
 * The target repo is never modified — worktrees are read-only views used solely
 * for rendering a preview.
 *
 * Sessions live in memory for the process lifetime. On process exit every
 * worktree is removed and every dev server is killed, so nothing leaks.
 */

import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface PreviewSession {
  sessionId: string;
  tenantId: string;
  repo: string;
  commit: string;
  worktreePath: string;
  port: number;
  url: string;
  devCommand: string;
  status: 'starting' | 'ready' | 'stopped' | 'error';
  error?: string;
  createdAt: string;
  stoppedAt?: string;
  pid?: number;
}

export interface PreviewScreenshots {
  sessionId: string;
  commit: string;
  screenshots: Array<{ path: string; takenAt: string; viewport: string }>;
}

/** Free port probe: binds to port 0, returns the assigned port, closes immediately. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Probe whether a dev server is accepting connections on the given port. */
async function isPortReady(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Wait for a port to become ready, polling at intervals. */
async function waitForPort(port: number, maxMs = 15_000, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await isPortReady(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** Read the dev script name from a repo's package.json, with a sensible fallback. */
function detectDevCommand(repo: string): string {
  const pkgPath = path.join(repo, 'package.json');
  if (!fs.existsSync(pkgPath)) return '';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = pkg.scripts ?? {};
    if (typeof scripts.dev === 'string' && scripts.dev.length > 0) return 'dev';
    if (typeof scripts.start === 'string' && scripts.start.length > 0) return 'start';
  } catch {
    /* package.json unreadable → fall through to empty */
  }
  return '';
}

/** Run a git command against a repo, returning trimmed stdout. */
function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4_000_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export class PreviewPlaneService {
  private sessions = new Map<string, PreviewSession>();
  private procs = new Map<string, ChildProcess>();
  private readonly worktreeRoot: string;

  constructor(worktreeRoot?: string) {
    this.worktreeRoot = worktreeRoot ?? path.join(os.tmpdir(), 'sf-preview-worktrees');
    fs.mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 });

    // Clean up every session on process exit so nothing leaks.
    process.on('exit', () => this.stopAll());
    process.on('SIGTERM', () => {
      this.stopAll();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      this.stopAll();
      process.exit(0);
    });
  }

  /** Create a preview session for a repo at a commit. Returns the session record. */
  async createSession(input: {
    tenantId: string;
    repo: string;
    commit: string;
  }): Promise<PreviewSession> {
    const { tenantId, repo, commit } = input;
    const sessionId = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Verify the commit exists in the repo.
    git(repo, ['rev-parse', '--verify', `${commit}^{commit}`]);

    const worktreePath = path.join(this.worktreeRoot, sessionId);
    const port = await findFreePort();
    const devCommand = detectDevCommand(repo);

    const session: PreviewSession = {
      sessionId,
      tenantId,
      repo,
      commit,
      worktreePath,
      port,
      url: `http://127.0.0.1:${port}`,
      devCommand,
      status: 'starting',
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);

    try {
      // Create the ephemeral worktree at the exact commit (detached HEAD).
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
      git(repo, ['worktree', 'add', '--detach', worktreePath, commit]);

      // Start the dev server if a command was detected.
      let proc: ChildProcess | undefined;
      if (devCommand) {
        proc = this.startDevServer(worktreePath, devCommand, port, sessionId);
        this.procs.set(sessionId, proc);
        session.pid = proc.pid ?? undefined;

        const ready = await waitForPort(port);
        if (!ready) {
          throw new Error(`dev server on port ${port} did not become ready`);
        }
      }

      session.status = 'ready';
      return session;
    } catch (error: any) {
      session.status = 'error';
      session.error = error?.message ?? String(error);
      // Best-effort cleanup of the worktree and the session record.
      try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* leave it */ }
      this.sessions.delete(sessionId);
      return session;
    }
  }

  /** Start the dev server inside the worktree, bound to the ephemeral port. */
  private startDevServer(worktreePath: string, scriptName: string, port: number, sessionId: string): ChildProcess {
    // Detect package manager from lockfile.
    let runner = 'npm';
    if (fs.existsSync(path.join(worktreePath, 'pnpm-lock.yaml'))) runner = 'pnpm';
    else if (fs.existsSync(path.join(worktreePath, 'yarn.lock'))) runner = 'yarn';
    else if (fs.existsSync(path.join(worktreePath, 'bun.lockb'))) runner = 'bun';

    const cmd = `${runner} run ${scriptName}`;

    const proc = spawn('sh', ['-c', cmd], {
      cwd: worktreePath,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', () => {}); // consume so the pipe doesn't back up
    proc.stderr.on('data', () => {});
    proc.unref(); // the dev server must not keep the Node event loop alive after tests finish
    proc.on('exit', () => {
      const session = [...this.sessions.values()].find((s) => s.worktreePath === worktreePath);
      if (session && session.status === 'ready') {
        session.status = 'stopped';
        session.stoppedAt = new Date().toISOString();
      }
      this.procs.delete(sessionId);
    });

    return proc;
  }

  /** Get a session by id. */
  get(sessionId: string): PreviewSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** List all sessions for a tenant (or all if no tenant filter). */
  list(tenantId?: string): PreviewSession[] {
    const sessions = Array.from(this.sessions.values());
    return tenantId ? sessions.filter((s) => s.tenantId === tenantId) : sessions;
  }

  /** Stop a session: kill the dev server, remove the worktree. */
  stop(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const proc = this.procs.get(sessionId);
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      try { proc.stdout.destroy(); } catch { /* ignore */ }
      try { proc.stderr.destroy(); } catch { /* ignore */ }
      this.procs.delete(sessionId);
    }

    try { fs.rmSync(session.worktreePath, { recursive: true, force: true }); } catch { /* leave it */ }

    session.status = 'stopped';
    session.stoppedAt = new Date().toISOString();
    this.sessions.delete(sessionId);
    return true;
  }

  /** Stop every session and remove every worktree. */
  stopAll(): void {
    for (const [sessionId, proc] of this.procs) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      try { proc.stdout.destroy(); } catch { /* ignore */ }
      try { proc.stderr.destroy(); } catch { /* ignore */ }
    }
    this.procs.clear();
    for (const session of this.sessions.values()) {
      try { fs.rmSync(session.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
      session.status = 'stopped';
      session.stoppedAt = new Date().toISOString();
    }
    this.sessions.clear();
  }

  /** Take a screenshot of the preview (best-effort, requires a browser binary). */
  async screenshot(sessionId: string): Promise<{ path: string; takenAt: string } | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'ready') return null;

    // Best-effort: try common headless Chrome/Chromium locations.
    const chromeCandidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
    const chrome = chromeCandidates.find((c) => fs.existsSync(c));
    if (!chrome) return null;

    const outDir = path.join(os.tmpdir(), 'sf-preview-screenshots');
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const outPath = path.join(outDir, `${sessionId}-${Date.now()}.png`);

    try {
      execFileSync(chrome, [
        '--headless', '--new',
        `--screenshot=${outPath}`,
        `--window-size=1280,800`,
        session.url,
      ], { timeout: 30_000, stdio: 'pipe' });
      return { path: outPath, takenAt: new Date().toISOString() };
    } catch {
      return null;
    }
  }
}

export const previewPlaneService = new PreviewPlaneService();
