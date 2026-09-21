import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

export function executeVerification(repo: string, profile: VerificationProfile, timeoutMs: number): VerificationExecution {
  const logs: string[] = [];
  for (const step of profile.steps) {
    try {
      const output = execFileSync(step.executable, step.args, { cwd: repo, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
      logs.push(`$ ${step.label}\n${output}`);
    } catch (error: any) {
      const output = `${error.stdout || ''}${error.stderr || ''}`.slice(-2_000_000);
      logs.push(`$ ${step.label}\n${output}`);
      return { profile, passed: false, exitCode: typeof error.status === 'number' ? error.status : 1, output: logs.join('\n'), failedStep: step.id, failureClass: classifyFailure(step.id, output) };
    }
  }
  return { profile, passed: true, exitCode: 0, output: logs.join('\n') };
}

export function classifyFailure(step: string, output: string): FailureClass {
  const value = `${step} ${output}`.toLowerCase();
  if (/security|vulnerability|secret|permission/.test(value)) return 'SECURITY';
  if (/type|tsc|compile/.test(value)) return 'TYPECHECK';
  if (/test|pytest|cargo test/.test(value)) return 'TEST';
  if (/build|assemble|bundle/.test(value)) return 'BUILD';
  if (/fmt|lint|format/.test(value)) return 'FORMAT';
  return 'UNKNOWN';
}
