/**
 * WP-1: deploy provenance.
 *
 * A live URL must be able to state which build it is serving. Before this, the UI
 * carried a hardcoded `v3.2.0-PROD` badge and the health payload carried no version
 * at all, so an operator could not distinguish yesterday's bundle from today's. The
 * badge is now fed by this field, so if the field ever regresses to a constant or
 * goes missing, the UI silently lies about the deployed build again.
 *
 * The assertion is against the real `package.json` on disk, not a literal, so the
 * test cannot pass by hardcoding the same value the code does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.FACTORY_DATA_DIR = `/tmp/opencode/sf-health-version-${process.pid}`;
delete process.env.ALLOW_INSECURE_LOCAL;

const { apiRouter } = await import('../src/api');

interface HealthPayload {
  status: string;
  name?: string;
  version?: string;
  runtime?: string;
}

async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { name: string; version: string };

test('health reports the deployed package version and name, read from package.json', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/api/factory/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as HealthPayload;
    assert.equal(body.name, 'software-factory', 'health must name the deployed package');
    assert.equal(body.version, manifest.version, 'health version must equal the deployed package.json version');
    assert.notEqual(body.version, 'unknown', 'a readable manifest must never report an unknown version');
  } finally {
    await server.close();
  }
});
