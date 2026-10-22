/**
 * Parallel read-only inspection tests (Layer 2/3, orca steal).
 *
 * Proves:
 *  - PR-1  reads happen concurrently, bounded, and come back in the order they were asked for
 *  - PR-2  one unreadable file does not lose the results of the others
 *  - PR-3  a path that escapes the repository is refused
 *  - PR-4  the concurrency ceiling is enforced
 *  - PR-5  the parallel path and the synchronous path show the model the same bytes
 *  - PR-6  parallel isolation staging produces the same quarantine evidence as synchronous staging
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import {
  MAX_READ_CONCURRENCY,
  mapReadOnly,
  readFiles,
  resolveConcurrency,
  statPaths,
} from '../src/services/parallelReadService';
import { DoctrineIsolationService } from '../src/services/doctrineIsolationService';
import { buildPrompts, readReferencedFiles } from '../src/services/implementerService';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-parallel-read-'));
const repo = path.join(state, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
fs.writeFileSync(path.join(repo, 'b.txt'), 'beta\n');
fs.writeFileSync(path.join(repo, 'c.txt'), 'gamma\n');

test('PR-1: reads come back in the order they were asked for', async () => {
  const reads = await readFiles(repo, ['c.txt', 'a.txt', 'b.txt']);
  assert.deepEqual(reads.map((read) => read.path), ['c.txt', 'a.txt', 'b.txt']);
  assert.equal(reads[0].content, 'gamma\n');
  assert.equal(reads[2].content, 'beta\n');
  for (const read of reads) {
    assert.equal(read.missing, false);
    assert.equal(read.error, undefined);
  }
});

test('PR-2: one unreadable file does not lose the results of the others', async () => {
  const reads = await readFiles(repo, ['a.txt', 'missing.txt', 'b.txt']);
  assert.equal(reads[0].content, 'alpha\n');
  assert.equal(reads[1].missing, true);
  assert.equal(reads[1].error, undefined, 'a missing file is reported, not raised');
  assert.equal(reads[2].content, 'beta\n');
});

test('PR-3: a path that escapes the repository is refused', async () => {
  const reads = await readFiles(repo, ['../outside.txt']);
  assert.equal(reads[0].error, 'PATH_ESCAPES_REPOSITORY');
  assert.equal(reads[0].content, undefined);
});

test('PR-4: the concurrency ceiling is enforced', () => {
  assert.equal(resolveConcurrency(undefined), 4);
  assert.equal(resolveConcurrency(0), 1);
  assert.equal(resolveConcurrency(1000), MAX_READ_CONCURRENCY);
  assert.equal(resolveConcurrency(2), 2);
});

test('PR-4b: no more than the requested number of reads are in flight at once', async () => {
  let inFlight = 0;
  let peak = 0;
  await mapReadOnly(
    Array.from({ length: 12 }, (_, index) => index),
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return true;
    },
    { concurrency: 3 },
  );
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, `the reads did not overlap (peak ${peak})`);
});

test('PR-5: the parallel path and the synchronous path show the model the same bytes', async () => {
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'the original content\n');
  const unit = {
    id: 'U-1',
    title: 'Feature',
    milestoneId: 'M-1',
    type: 'feature',
    status: 'pending' as const,
    criteria: [{ id: 'C-1', text: 'feature.txt holds the original content', check: "grep original feature.txt" }],
    verify: 'grep original feature.txt',
    dependsOn: [],
  } as never;
  const document = {
    id: 'T-1',
    title: 'Task',
    goal: 'Goal',
    constraints: [],
    milestones: [],
    models: {},
    sourceHash: 'hash',
  } as never;
  const request = {
    tenantId: 'tenant',
    repo,
    unit,
    document,
    assignment: { providerId: 'p', model: 'm' },
    doctrineLines: [],
    isolation: {} as never,
    timeoutMs: 1000,
  } as never;

  const referenced = await readReferencedFiles(repo, unit);
  assert.equal(referenced.length, 1);
  assert.equal(referenced[0].path, 'feature.txt');
  assert.equal(referenced[0].content, 'the original content\n');
  assert.equal(referenced[0].originalBytes, 'the original content\n'.length);

  const parallelPrompt = buildPrompts(request, { enabled: false, block: '' }, referenced);
  const synchronousPrompt = buildPrompts(request, { enabled: false, block: '' });
  assert.equal(parallelPrompt.task, synchronousPrompt.task, 'both paths must produce the same prompt');
});

test('PR-6: parallel isolation staging produces the same quarantine evidence as synchronous staging', async () => {
  const target = path.join(state, 'target');
  fs.mkdirSync(target, { recursive: true });
  execFileSync('git', ['init', '-q', target]);
  fs.writeFileSync(path.join(target, 'AGENTS.md'), '# TARGET INSTRUCTIONS: do not do this\n');
  fs.writeFileSync(path.join(target, '.cursorrules'), 'cursor rules\n');
  fs.writeFileSync(path.join(target, 'README.md'), '# target\n');

  const synchronous = DoctrineIsolationService.stage(target);
  const parallel = await DoctrineIsolationService.stageAsync(target);

  assert.deepEqual(
    parallel.quarantine.map((entry) => entry.relativePath),
    synchronous.quarantine.map((entry) => entry.relativePath),
  );
  assert.deepEqual(
    parallel.quarantine.map((entry) => entry.sha256),
    synchronous.quarantine.map((entry) => entry.sha256),
  );
  assert.equal(parallel.quarantine.length, 2, 'only instruction files are quarantined');
  assert.equal(parallel.doctrineDigest, synchronous.doctrineDigest);
});

test('PR-7: statPaths reports existence without reading content', async () => {
  const stats = await statPaths(repo, ['a.txt', 'missing.txt', 'src']);
  assert.equal(stats[0].exists, true);
  assert.equal(stats[0].isDirectory, false);
  assert.equal(stats[1].exists, false);
  assert.equal(stats[2].isDirectory, true);
});
