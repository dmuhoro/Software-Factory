/**
 * The ledger's single-writer guarantee, proven across two processes.
 *
 * `l3-error-contract.test.ts` proves the lock is taken and held within one process. That is
 * necessary but not sufficient: the failure the lock exists to prevent is a SECOND process
 * opening the same ledger and interleaving its records with the first. This case holds the lock
 * in the test process and spawns a real child process pointed at the same data directory, then
 * asserts the child is refused -- not that the code says it would be.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const PROBE = path.join(ROOT, 'scripts', 'durable-writer-probe.ts');

test('a second live process is refused while the first holds the writer lock', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-writer-lock-'));
  const previous = process.env.FACTORY_DATA_DIR;
  process.env.FACTORY_DATA_DIR = dataDir;
  try {
    const { DurableStore } = await import('../src/services/durableStore');
    DurableStore.resetForTests();
    // A real write takes and holds the lock for the life of this process.
    DurableStore.upsert('qualitySnapshots', 'holder', { id: 'holder', tenantId: 'writer-lock-test' });
    assert.ok(fs.existsSync(`${DurableStore.dataFile()}.lock`), 'the holder must own the lock file');

    const child = runProbe();
    assert.equal(child.code, 1, `the second process must be refused; it exited ${child.code} with: ${child.output}`);
    assert.match(child.output, /LEDGER_ANOTHER_WRITER_ACTIVE/, 'the refusal must name why, not fail with a generic error');
  } finally {
    const { DurableStore } = await import('../src/services/durableStore');
    DurableStore.resetForTests();
    if (previous === undefined) delete process.env.FACTORY_DATA_DIR;
    else process.env.FACTORY_DATA_DIR = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a lone process writes successfully when no lock is held', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-writer-lone-'));
  const previous = process.env.FACTORY_DATA_DIR;
  process.env.FACTORY_DATA_DIR = dataDir;
  try {
    const child = runProbe();
    assert.equal(child.code, 0, `a lone process must be able to write; it exited ${child.code} with: ${child.output}`);
    assert.match(child.output, /WRITE_OK/);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_DATA_DIR;
    else process.env.FACTORY_DATA_DIR = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function runProbe(): { code: number; output: string } {
  try {
    const output = execFileSync(TSX, [PROBE], { encoding: 'utf8', env: process.env, timeout: 60_000 });
    return { code: 0, output };
  } catch (error: any) {
    return { code: typeof error.status === 'number' ? error.status : 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}