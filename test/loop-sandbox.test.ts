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