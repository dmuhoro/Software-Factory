/**
 * The deployment contract (Sprint 30, WP-4).
 *
 * The runtime already refuses to start on an unusable configuration (`server.ts` exits 78 before
 * binding). What was never checked is that the *documented* deployment path actually invokes that
 * runtime correctly: the health-check the platform polls must be a real, public route the code
 * serves, the start command must be the command the image can run, and the replica count must not
 * claim a multi-writer deployment the single-writer ledger (NC-2) cannot honour.
 *
 * These are static assertions over the deployment artifacts, tied back to the code. A manifest that
 * drifts from the code is the failure mode: a platform polling `/health` would mark a healthy
 * service down, and a second replica would silently race the whole-file ledger.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const HEALTH_PATH = '/api/factory/health';

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('the health path the platform polls is a real, public route', () => {
  const routes = read('src/api/routes/factory.routes.ts');
  assert.ok(routes.includes("'/health'"), 'factory.routes.ts must serve the health route the manifests poll');

  const auth = read('src/api/middleware/tenantAuth.ts');
  assert.ok(
    auth.includes("'/factory/health'"),
    'the health path must be a public path, or the platform\u2019s unauthenticated probe is refused',
  );
});

test('railway.json describes the single-writer, health-checked deployment the code can honour', () => {
  const railway = JSON.parse(read('railway.json')) as {
    build: { builder: string; dockerfilePath: string };
    deploy: { startCommand: string; healthcheckPath: string; numReplicas: number };
  };
  assert.equal(railway.build.builder, 'DOCKERFILE');
  assert.equal(railway.build.dockerfilePath, 'Dockerfile');
  // The ledger is single-writer (NC-2). A second replica would race the whole-file rewrite and
  // silently drop the other's records; the deployment must not claim what the store cannot do.
  assert.equal(railway.deploy.numReplicas, 1, 'the ledger is single-writer; more than one replica loses data');
  assert.equal(railway.deploy.healthcheckPath, HEALTH_PATH, 'the platform must poll the route the code serves');
  assert.equal(railway.deploy.startCommand, 'node dist/server.cjs', 'the platform must run the command the image builds');
});

test('the image builds the same command railway runs and probes the same health path', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /npm ci/, 'the image must install from the committed lockfile');
  assert.ok(dockerfile.includes(`CMD ["node", "dist/server.cjs"]`), 'the image CMD must be the command railway starts');
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((line) => line.startsWith('HEALTHCHECK'));
  assert.ok(start >= 0, 'the image must declare a HEALTHCHECK');
  let healthcheck = lines[start];
  for (let i = start; i < lines.length - 1 && lines[i].endsWith('\\'); i += 1) healthcheck += '\n' + lines[i + 1];
  assert.ok(healthcheck.includes(HEALTH_PATH), `the HEALTHCHECK must probe ${HEALTH_PATH}`);
});

test('the compose deployment is fail-closed and shares one volume-backed data path', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /NODE_ENV:\s*production/, 'compose must run the production entrypoint');
  assert.match(compose, /ALLOW_INSECURE_LOCAL:\s*"?false"?/, 'the credential bypass must be off');
  assert.ok(compose.includes(HEALTH_PATH), `the compose healthcheck must probe ${HEALTH_PATH}`);
  assert.match(compose, /FACTORY_DATA_DIR:\s*\/data/, 'the ledger directory must sit on the mounted volume');
  assert.match(compose, /sf-data:\/data/, 'the data directory must be the mounted volume, or state is lost on replace');
});
