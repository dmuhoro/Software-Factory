import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './groundTruthService';
import { DoctrineService } from './doctrineService';
import { DoctrineIsolationService } from './doctrineIsolationService';
import type { LoopSandboxConfig } from './loopTypes';

export interface VerificationStep { id: string; label: string; executable: string; args: string[]; }
export interface VerificationProfile { id: string; name: string; steps: VerificationStep[]; detectedFrom: string[]; }
export type FailureClass = 'TYPECHECK' | 'TEST' | 'BUILD' | 'SECURITY' | 'FORMAT' | 'UNKNOWN';
export interface VerificationExecution { profile: VerificationProfile; passed: boolean; exitCode: number; output: string; failedStep?: string; failureClass?: FailureClass; }

const has = (repo: string, file: string): boolean => fs.existsSync(path.join(repo, file));
const packageScripts = (repo: string): Record<string, string> => { try { return JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts ?? {}; } catch { return {}; } };
const npmStep = (id: string, script: string): VerificationStep => ({ id, label: `npm run ${script}`, executable: 'npm', args: ['run', script] });

export function detectVerificationProfile(repo: string): VerificationProfile {
  if (has(repo, 'gradlew') || has(repo, 'gradlew.bat')) return { id: 'android-gradle', name: 'Android Gradle verification', steps: [{ id: 'unit', label: './gradlew test', executable: './gradlew', args: ['test'] }, { id: 'lint', label: './gradlew lint', executable: './gradlew', args: ['lint'] }, { id: 'assemble', label: './gradlew assembleOfflineRelease', executable: './gradlew', args: ['assembleOfflineRelease'] }], detectedFrom: ['gradlew'] };
  if (has(repo, 'Cargo.toml')) return { id: 'rust-cargo', name: 'Rust Cargo verification', steps: [{ id: 'fmt', label: 'cargo fmt --check', executable: 'cargo', args: ['fmt', '--', '--check'] }, { id: 'test', label: 'cargo test', executable: 'cargo', args: ['test'] }, { id: 'build', label: 'cargo build --release', executable: 'cargo', args: ['build', '--release'] }], detectedFrom: ['Cargo.toml'] };
  if (has(repo, 'pyproject.toml') || has(repo, 'pytest.ini')) return { id: 'python', name: 'Python verification', steps: [{ id: 'lint', label: 'ruff check .', executable: 'ruff', args: ['check', '.'] }, { id: 'test', label: 'pytest', executable: 'pytest', args: [] }], detectedFrom: ['pyproject.toml or pytest.ini'] };
  if (has(repo, 'package.json')) {
    const scripts = packageScripts(repo);
    const names = ['verify', 'lint', 'test', 'build'].filter((name) => scripts[name]);
    const selected = scripts.verify ? ['verify'] : names;
    return { id: 'node-npm', name: 'Node.js npm verification', steps: selected.map((script) => npmStep(script, script)), detectedFrom: ['package.json', ...selected.map((script) => `scripts.${script}`)] };
  }
  return { id: 'git-integrity', name: 'Git integrity verification', steps: [{ id: 'diff', label: 'git diff --check', executable: 'git', args: ['diff', '--check'] }], detectedFrom: ['.git'] };
}

/** Shell-escapes a single argv token for use inside `sh -c` (via the doctrine sandbox). */
function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

function sandboxVisiblePath(repo: string): string {
  const localBin = path.join(path.resolve(repo), 'node_modules', '.bin');
  return `/usr/bin:/bin:${localBin}`;
}

function resolveExecutable(executable: string, repo: string): string {
  if (executable.startsWith('./') || executable.startsWith('../') || path.isAbsolute(executable)) return executable;
  const system = executable === 'node' ? '/usr/bin/node' : executable === 'npm' ? '/usr/bin/npm' : executable === 'git' ? '/usr/bin/git' : '';
  if (system && fs.existsSync(system)) return system;
  const local = path.join(path.resolve(repo), 'node_modules', '.bin', executable);
  if (fs.existsSync(local)) return local;
  return executable;
}

/**
 * Builds the shell command for a profile step. npm steps expand to the script body when system npm
 * is not visible inside the bwrap sandbox (common on developer machines); CI images with
 * `/usr/bin/npm` keep the normal `npm run` invocation.
 */
export function verificationStepCommand(step: VerificationStep, repo: string): string {
  const resolvedRepo = path.resolve(repo);
  if (step.executable === 'npm' && step.args[0] === 'run' && typeof step.args[1] === 'string') {
    const npmPath = resolveExecutable('npm', resolvedRepo);
    if (npmPath === 'npm' || !fs.existsSync(npmPath)) {
      const body = packageScripts(resolvedRepo)[step.args[1]];
      if (body?.trim()) {
        return `PATH=${shellQuote(sandboxVisiblePath(resolvedRepo))} ${body}`;
      }
    }
  }
  const executable = resolveExecutable(step.executable, resolvedRepo);
  const argv = [executable, ...step.args].map(shellQuote).join(' ');
  if (step.executable === 'npm' || step.executable === 'node') {
    return `PATH=${shellQuote(sandboxVisiblePath(resolvedRepo))} ${argv}`;
  }
  return argv;
}

export function executeVerification(
  repo: string,
  profile: VerificationProfile,
  timeoutMs: number,
  sandbox: LoopSandboxConfig,
): VerificationExecution {
  // Every spawned verification command receives only the loop's scrubbed environment. The ambient
  // environment is never forwarded: `sandboxArgv` copies every entry it is given onto the bwrap
  // command line, so passing `process.env` would put the operator's credentials into a
  // world-readable argv. The doctrine root is the same one the sandbox is configured from.
  const doctrine = DoctrineService.load();
  const env = DoctrineIsolationService.childEnv(doctrine.root, doctrine.digest);
  const logs: string[] = [];
  for (const step of profile.steps) {
    const command = verificationStepCommand(step, repo);
    const result = runCommand(repo, command, timeoutMs, env, sandbox);
    logs.push(`$ ${step.label}\n${result.output}`);
    if (result.exitCode !== 0) {
      return {
        profile,
        passed: false,
        exitCode: result.exitCode,
        output: logs.join('\n'),
        failedStep: step.id,
        failureClass: classifyFailure(step.id, result.output),
      };
    }
  }
  return { profile, passed: true, exitCode: 0, output: logs.join('\n') };
}

export function classifyFailure(step: string, output: string): FailureClass {
  const value = `${step} ${output}`.toLowerCase();
  if (/security|vulnerability|secret|permission/.test(value)) return 'SECURITY';
  if (/\btypecheck\b|\btsc\b|\bcompile\b|error ts/i.test(value)) return 'TYPECHECK';
  if (/test|pytest|cargo test/.test(value)) return 'TEST';
  if (/build|assemble|bundle/.test(value)) return 'BUILD';
  if (/fmt|lint|format/.test(value)) return 'FORMAT';
  return 'UNKNOWN';
}
