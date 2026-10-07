/**
 * The sandbox boundary (R-14-BOXED-VERIFICATION).
 *
 * Every command below goes through the factory's real `runCommand`, which owns the bwrap
 * invocation. The negative cases observe the refusal — nothing here asserts that a command
 * "would" fail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { collectGroundTruth } from '../src/services/groundTruthService';

function makeRepo(): { repo: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-sbox-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'loop@test.local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Loop Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'initial']);
  return { repo: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function sandbox(overrides: Partial<Parameters<typeof collectGroundTruth>[0]['sandbox']> = {}): NonNullable<Parameters<typeof collectGroundTruth>[0]['sandbox']> {
  return {
    enabled: true,
    backend: 'bwrap',
    enableNetwork: false,
    writableDirs: ['.'],
    bwrapBinary: 'bwrap',
    ...overrides,
  };
}

function commandResult(repo: string, command: string, sandboxConfig: NonNullable<Parameters<typeof collectGroundTruth>[0]['sandbox']>): { exitCode: number; output: string; passed: boolean } {
  const proof = collectGroundTruth({
    repo,
    requireNonEmptyDiff: true,
    commands: [{ id: 'probe', command }],
    timeoutMs: 60_000,
    env: { ...process.env },
    sandbox: sandboxConfig,
  });
  const probe = proof.checks.find((item) => item.id === 'cmd:probe');
  return { exitCode: probe?.exitCode ?? -1, output: probe?.outputTail ?? '', passed: proof.passed };
}

test('a legitimate verification command runs inside the sandbox and its evidence is real', () => {
  const { repo, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'ok\n');
    fs.writeFileSync(path.join(repo, 'check-a.cjs'), 'const fs=require("node:fs");process.exit(fs.existsSync("feature.txt")?0:1);\n');
    const result = commandResult(repo, 'node check-a.cjs', sandbox());
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.passed, true, 'the sandboxed verification must contribute a real passing check');
  } finally {
    cleanup();
  }
});

test('a verification command cannot write into a read-only system directory', () => {
  const { repo, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'ok\n');
    const result = commandResult(repo, "node -e \"require('node:fs').writeFileSync('/etc/sf-nope','x')\"", sandbox());
    assert.equal(result.exitCode, 1, result.output);
    assert.match(result.output, /EROFS|read-only/, 'the write must be refused by the sandbox, not by a stub');
    assert.equal(result.passed, false);
  } finally {
    cleanup();
  }
});

test('a verification command cannot reach the network when network is off', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const result = commandResult(repo, "node -e \"fetch('https://example.com').then(()=>process.exit(0)).catch(()=>process.exit(42))\"" , sandbox());
    assert.equal(result.exitCode, 42, `expected network refusal (got ${result.exitCode}): ${result.output}`);
    assert.equal(result.passed, false);
  } finally {
    cleanup();
  }
});

test('a verification command writing to the host /tmp does not land on the host', () => {
  const { repo, cleanup } = makeRepo();
  const marker = path.join(os.tmpdir(), `sf-sandbox-leak-${process.pid}-${Date.now()}.tmp`);
  try {
    const result = commandResult(repo, `node -e "require('node:fs').writeFileSync('${marker}','x')"`, sandbox());
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(fs.existsSync(marker), false, 'the write must be confined to the container /tmp, not the host');
  } finally {
    cleanup();
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
  }
});

test('a missing sandbox binary fails the command closed — it is refused, never run bare', () => {
  const { repo, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'ok\n');
    const result = commandResult(repo, 'node check-a.cjs', sandbox({ bwrapBinary: '/nonexistent/bwrap' }));
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /bwrap|refused|not found/, result.output);
    assert.equal(result.passed, false);
  } finally {
    cleanup();
  }
});

test('an unknown sandbox backend is refused, never run bare', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const result = commandResult(repo, 'node -e "process.exit(0)"', sandbox({ backend: 'docker' }));
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /backend/, result.output);
    assert.equal(result.passed, false);
  } finally {
    cleanup();
  }
});

test('a writableDir that escapes the repository is refused', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const result = commandResult(repo, 'node -e "process.exit(0)"', sandbox({ writableDirs: ['..'] }));
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /escape the repository/, result.output);
    assert.equal(result.passed, false);
  } finally {
    cleanup();
  }
});

test('the doctrine ships a sandbox block that is enabled and bwrap-backed', async () => {
  const { DoctrineService } = await import('../src/services/doctrineService');
  const sandboxConfig = DoctrineService.load().loop.sandbox;
  assert.equal(sandboxConfig.enabled, true, 'R-14 must be on by default');
  assert.equal(sandboxConfig.backend, 'bwrap');
  assert.equal(sandboxConfig.enableNetwork, false, 'the default is no network');
});

test('break-out: the sandbox sees only its own processes, never the host process table', () => {
  const { repo, cleanup } = makeRepo();
  try {
    const result = commandResult(repo, 'ls /proc | grep -cE "^[0-9]+$"; cat /proc/1/comm; readlink /proc/1/root', sandbox());
    assert.equal(result.exitCode, 0, result.output);
    const [count, pid1Comm, pid1Root] = result.output.split('\n').map((s) => s.trim());
    // A fresh procfs for one verification command shows a handful of the container's own pids.
    // The host here shows 400+; if the host /proc were bound instead of a fresh procfs the count
    // would be that number and pid 1 would be the host init.
    assert.ok(Number(count) <= 10, `the container must see its own pids only (saw ${count}): ${result.output}`);
    assert.ok(pid1Comm === 'bwrap' || pid1Comm === 'sh', `pid 1 must be the container's own init (was ${pid1Comm}): ${result.output}`);
    assert.equal(pid1Root, '/', 'pid 1 root must resolve inside the container, not the host');
  } finally {
    cleanup();
  }
});

test('break-out: a same-user host process is invisible, so its env and cwd cannot be read through /proc', async () => {
  const { repo, cleanup } = makeRepo();
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-host-secret-'));
  let markerPid = 0;
  try {
    const secretPath = path.join(secretDir, 'host-secret.txt');
    fs.writeFileSync(secretPath, 'this-is-the-host-secret\n');
    // A long-lived host process running as the same user, with its cwd in a dir that holds a
    // secret file. On the host we can read that file through /proc/<pid>/cwd and /proc/<pid>/root.
    const { spawn, execFileSync: execFileSyncHost } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { cwd: secretDir, stdio: 'ignore', env: { ...process.env, SF_HOST_SENTINEL: 'env-secret-value' } });
    markerPid = child.pid ?? 0;
    // wait for the process to exist and shed its cwd reference
    await new Promise((resolve) => setTimeout(resolve, 600));
    execFileSyncHost('kill', ['-0', String(markerPid)]);
    const probe = commandResult(
      repo,
      `test -e /proc/${markerPid} && echo "HOST_PROC_VISIBLE" || echo "HOST_PROC_HIDDEN"; test -e /proc/${markerPid}/environ && echo "ENV_REACHABLE" || echo "ENV_HIDDEN"; test -e /proc/${markerPid}/cwd && echo "CWD_VISIBLE" || echo "CWD_HIDDEN"`,
      sandbox(),
    );
    assert.equal(probe.exitCode, 0, probe.output);
    assert.match(probe.output, /HOST_PROC_HIDDEN/, `the host marker process (pid ${markerPid}) must not appear in the container's /proc: ${probe.output}`);
    assert.match(probe.output, /ENV_HIDDEN/, `the host process environment must not be reachable from the sandbox: ${probe.output}`);
    assert.match(probe.output, /CWD_HIDDEN/, `the host process cwd must not be reachable from the sandbox: ${probe.output}`);
  } finally {
    if (markerPid) try { process.kill(markerPid, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(secretDir, { recursive: true, force: true });
    cleanup();
  }
});

test('break-out: a symlink in the repo cannot redirect a write to the host read-only mount', () => {
  const { repo, cleanup } = makeRepo();
  try {
    // The container root is a ro-bind of the host, so its /var is host /var mounted read-only.
    // A verification command runs in / (well, cwd=repo); a repo-owned symlink that points at
    // /var cannot be used to write outside the quarantine.
    fs.symlinkSync('/var', path.join(repo, 'escape'));
    const result = commandResult(repo, `node -e "const fs=require('node:fs');try{fs.writeFileSync('escape/sf-host-write','x');console.log('WROTE')}catch(e){console.log(e.code||e.message)}"`, sandbox());
    assert.equal(result.exitCode, 0, 'node must run and report the refusal');
    assert.match(result.output, /EROFS|EACCES|read-only|permission/i, `the write must be refused by the sandbox, not land through the symlink (got: ${result.output})`);
    assert.equal(fs.existsSync('/var/sf-host-write'), false, 'nothing may be written into the host /var through a repo symlink');
    assert.equal(fs.existsSync(path.join(repo, 'escape')), true, 'the symlink inside the repo stays a symlink; only its target is protected');
  } finally {
    cleanup();
    if (fs.existsSync('/var/sf-host-write')) fs.rmSync('/var/sf-host-write', { force: true });
  }
});

test('break-out: /proc/self/root resolves to the container root, never the host', () => {
  const { repo, cleanup } = makeRepo();
  const marker = path.join(os.tmpdir(), `sf-root-escape-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(marker, 'host-only\n');
    const result = commandResult(repo, `node -e "const fs=require('node:fs');try{fs.accessSync('/proc/self/root${marker}');console.log('HOST_REACHABLE')}catch{console.log('CONTAINED')}"`, sandbox());
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /CONTAINED/, `/proc/self/root must not reach the host filesystem: ${result.output}`);
  } finally {
    fs.rmSync(marker, { force: true });
    cleanup();
  }
});