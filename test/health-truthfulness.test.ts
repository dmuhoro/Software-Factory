/**
 * WP-2: runtime honesty.
 *
 * The health board used to render a Rust/Tokio threadpool, jemalloc heap, trippable
 * circuit breakers and HPA pod counts -- none of which this Node service runs -- and it
 * read `systemHealth.threadpool`, a field the API never sent. That read threw, the
 * surrounding catch swallowed it, and the board rendered nothing while looking like a
 * health board. A dashboard that invents health is worse than one that shows only the
 * truth, because it manufactures confidence.
 *
 * This test has two arms:
 *   1. the API payload contains measurable fields and none of the invented ones; and
 *   2. the health UI source contains none of the fabricated-runtime tokens, so the
 *      display cannot silently drift back into claiming a runtime this process lacks.
 *
 * WP-2b (the simulated Rust error trace in the stream tab) is a separate layer and is
 * deliberately outside this guard's token set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = `/tmp/opencode/sf-health-truth-${process.pid}`;
delete process.env.ALLOW_INSECURE_LOCAL;

const { apiRouter } = await import('../src/api');

async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('health reports only measurable fields and none of the invented Rust runtime', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/api/factory/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;

    // Real, measurable values.
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.systemHealth.memory.heapUsedMb, 'number');
    assert.equal(typeof body.systemHealth.memory.rssMb, 'number');
    assert.equal(typeof body.systemHealth.memory.memoryPressureScore, 'number');
    assert.equal(typeof body.systemHealth.process.node, 'string');
    assert.ok(Array.isArray(body.checkDetails), 'readiness check details must be present');
    assert.ok(body.checkDetails.length > 0, 'the server must classify at least one readiness check');

    // No fabricated runtime.
    assert.equal(body.systemHealth.threadpool, undefined, 'there is no Rust threadpool');
    assert.equal(body.systemHealth.circuitBreakers, undefined, 'there are no circuit breakers in the payload');
    assert.equal(body.kubernetes, undefined, 'the service is not scheduled by Kubernetes here');
    assert.equal(body.systemHealth.memory.rustTokioHeapMb, undefined, 'there is no Rust heap');
  } finally {
    await server.close();
  }
});

test('the health UI claims no runtime the process does not run', () => {
  const componentsDir = path.resolve(process.cwd(), 'src/components');
  const files = [
    path.resolve(process.cwd(), 'src/App.tsx'),
    path.resolve(process.cwd(), 'src/types.ts'),
    ...fs.readdirSync(componentsDir).filter((name) => name.endsWith('.tsx')).map((name) => path.join(componentsDir, name)),
  ];
  const forbidden = [
    'threadpool',
    'circuitbreaker',
    'hpareplicas',
    'rusttokioheap',
    'workstealing',
    'jemalloc',
    'tokio workers',
  ];
  // Scan code, not prose. The comments that explain why these fields were removed name
  // them on purpose; a guard that fired on its own rationale would be unusable.
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8')).toLowerCase();
    for (const token of forbidden) {
      assert.ok(!text.includes(token), `${path.relative(process.cwd(), file)} must not reference the fabricated runtime token "${token}"`);
    }
  }
});
