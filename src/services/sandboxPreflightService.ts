/**
 * The sandbox preflight (Sprint 31, WP-1: reproducibility).
 *
 * ## Why this exists
 *
 * A run whose doctrine enables the sandbox must not start unless bubblewrap is present and
 * can actually create a container. `sandboxArgv` (groundTruthService) already refuses a
 * command whose binary is missing, but that refusal happens *per verification command*,
 * deep inside a unit attempt, and reaches the operator as a failed unit rather than a
 * misconfigured host. On CI, with no bubblewrap at all, that produced 44 failed tests whose
 * only signal was the word `bwrap` — a host problem wearing the costume of a code regression.
 *
 * This moves the same decision to the run boundary. One refusal, before any work starts,
 * naming the code and the fix.
 *
 * ## Fail-closed
 *
 * `ok: true` is only returned after a real `bwrap` unshare succeeds — the same shape
 * `sandboxArgv` builds, minus the repository bind. A preflight that reported success it did
 * not earn would be worse than none: it would claim the host can sandbox while every
 * command afterwards is refused. The probe runs the container; only its exit status decides.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LoopSandboxConfig } from './loopTypes';

export interface SandboxPreflightResult {
  ok: boolean;
  /** A SANDBOX_* code when `ok` is false; the classifier publishes it by name. */
  code?: string;
  /** The resolved executable, when one was found. */
  binary?: string;
  /** Operator-facing detail. Logged; it carries a path, so it is never the published message. */
  detail: string;
  /** What the operator can do about it, when the fix is not obvious. */
  remediation?: string;
}

/**
 * Injectable so the preflight can be proven without a sandbox: a test supplies a resolver
 * and a probe that reports the outcomes (found, missing, unusable) it needs to assert.
 */
export interface SandboxPreflightDeps {
  resolveBinary?: (name: string) => string | null;
  probe?: (binary: string) => void;
}

/**
 * The probe mirrors `sandboxArgv`: the same namespace flags, the same read-only root. If the
 * host restricts unprivileged user namespaces and the bubblewrap AppArmor profile is absent,
 * the unshare is refused and this throws — which is exactly the condition we must detect.
 */
function probeArguments(enableNetwork: boolean): string[] {
  return [
    '--unshare-user-try', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    ...(enableNetwork ? [] : ['--unshare-net']),
    '--die-with-parent', '--new-session',
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp',
    '--dev', '/dev',
    '--proc', '/proc',
    '/bin/sh', '-c', 'exit 0',
  ];
}

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile() && (fs.accessSync(candidate, fs.constants.X_OK), true);
  } catch {
    return false;
  }
}

/** Resolve a configured binary: an explicit path is honoured, a bare name is searched on PATH. */
export function resolveSandboxBinary(name: string): string | null {
  if (name.includes(path.sep)) return isExecutableFile(name) ? name : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { stderr?: Buffer | string; message?: string };
    const stderr = candidate.stderr ? String(candidate.stderr).trim() : '';
    if (stderr) return stderr.split('\n').map((line) => line.trim()).filter(Boolean).slice(-2).join(' ');
    if (candidate.message) return candidate.message.split('\n')[0];
  }
  return String(error);
}

export function preflightSandbox(config: LoopSandboxConfig, deps: SandboxPreflightDeps = {}): SandboxPreflightResult {
  if (!config.enabled) {
    return { ok: true, detail: 'the sandbox is disabled, so no container is required for this run' };
  }

  if (config.backend !== 'bwrap') {
    return {
      ok: false,
      code: 'SANDBOX_BACKEND_UNSUPPORTED',
      detail: `the doctrine names sandbox backend "${config.backend}" and only bwrap is implemented`,
      remediation: 'set loop.sandbox.backend to "bwrap", or set loop.sandbox.enabled to false',
    };
  }

  const resolveBinary = deps.resolveBinary ?? resolveSandboxBinary;
  const binary = resolveBinary(config.bwrapBinary);
  if (!binary) {
    return {
      ok: false,
      code: 'SANDBOX_BINARY_MISSING',
      detail: `the sandbox executable "${config.bwrapBinary}" was not found on PATH and is not an executable file`,
      remediation: 'install bubblewrap (for example, apt-get install -y bubblewrap) or point loop.sandbox.bwrapBinary at it',
    };
  }

  const probe = deps.probe ?? ((target: string): void => {
    execFileSync(target, probeArguments(config.enableNetwork), { stdio: 'pipe', timeout: 15_000 });
  });

  try {
    probe(binary);
  } catch (error) {
    return {
      ok: false,
      code: 'SANDBOX_BINARY_UNUSABLE',
      binary,
      detail: `the sandbox executable "${binary}" is present but could not create a container: ${reasonOf(error)}`,
      remediation: 'the host restricts unprivileged user namespaces; load the distribution\'s bubblewrap AppArmor profile, or set kernel.unprivileged_userns_clone=1',
    };
  }

  return { ok: true, binary, detail: `the sandbox executable "${binary}" can create a container` };
}
