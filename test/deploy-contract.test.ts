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

// ─────────────────────────────────────────────────────────────────────────────
// The executor host (Sprint 33, WP-5).
//
// The host artifacts were reachable at two paths and the image that runs the loop carried no
// sandbox runtime. Both are the same class of defect: a deployment that looks finished and
// fails at the boundary. These assert the artifacts live where the runbook says, that every
// live reference agrees, and that the image ships a bubblewrap the preflight can actually use.
// ─────────────────────────────────────────────────────────────────────────────

test('the executor-host artifacts live under deploy/host and nowhere else', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'deploy/host/provision-executor-host.sh')), 'the provisioning script must live at deploy/host/');
  assert.ok(fs.existsSync(path.join(ROOT, 'deploy/host/software-factory-executor.service')), 'the hardened unit must live at deploy/host/');
  assert.ok(!fs.existsSync(path.join(ROOT, 'software_factory/host')), 'the old software_factory/host path must be gone, or two copies drift');
});

test('no live reference still points at the moved host path', () => {
  // The live surface: the runbook, the README, the scripts and the artifacts. Sprint files are
  // historical records and may name the old path when describing the move itself.
  const roots = ['README.md', 'docs', 'scripts', 'deploy'];
  const offenders: string[] = [];
  const walk = (rel: string): void => {
    const full = path.join(ROOT, rel);
    if (fs.statSync(full).isDirectory()) {
      for (const entry of fs.readdirSync(full)) walk(path.join(rel, entry));
      return;
    }
    if (!/\.(ts|md|sh|json|service|yml|yaml)$/.test(full)) return;
    const text = fs.readFileSync(full, 'utf8');
    if (text.includes('software_factory/host')) offenders.push(rel);
  };
  for (const rel of roots) walk(rel);
  assert.deepEqual(offenders, [], `these files still name the moved path: ${offenders.join(', ')}`);
});

test('the Node image installs bubblewrap in the runtime stage', () => {
  const dockerfile = read('Dockerfile');
  const runtimeStart = dockerfile.indexOf('FROM node:22-slim AS runtime');
  assert.ok(runtimeStart >= 0, 'the Node Dockerfile must have a runtime stage');
  const runtime = dockerfile.slice(runtimeStart);
  assert.match(runtime, /apt-get install -y --no-install-recommends bubblewrap/, 'the runtime stage must install bubblewrap; the loop refuses without a sandbox');
  assert.match(runtime, /rm -rf \/var\/lib\/apt\/lists\/\*/, 'the apt lists must be removed in the same layer, as with every install here');
});

test('verify:image reports the sandbox runtime flags and fails closed without bwrap', () => {
  const script = read('scripts/verify-image.sh');
  assert.ok(script.includes('--cap-add SYS_ADMIN'), 'the gate must name the runtime flags the sandbox needs');
  assert.ok(script.includes('seccomp=unconfined'), 'the gate must name the seccomp flag the sandbox needs');
  assert.match(script, /command -v bwrap/, 'the gate must check the binary is present');
  assert.match(script, /bwrap --unshare-all/, 'the gate must actually create a sandbox, not just find the binary');
  // Fail closed: the absence of bwrap is a FAIL in the Node section, not a printed warning.
  assert.match(script, /bubblewrap is absent from the Node image; every sandboxed run would refuse at the boundary/);
});

test('the executor-host runbook names the commands it tells you to run', () => {
  const runbook = read('docs/RUNBOOK_EXECUTOR_HOST.md');
  for (const command of ['deploy/host/provision-executor-host.sh', 'scripts/verify-host.ts', 'scripts/verify-image.sh', 'scripts/run-factory-loop.ts']) {
    assert.ok(runbook.includes(command), `the runbook must name ${command}, and it must exist on disk`);
  }
});

test('the preflight evidence is a dated file that records a failure, not only a pass', async () => {
  const { renderHostRecord } = await import('../scripts/verify-host');
  const markdown = renderHostRecord({
    hostname: 'executor',
    date: '2026-10-17',
    bindOnly: false,
    results: [
      { name: 'bubblewrap can create a container', ok: true, required: true, detail: 'sandbox created' },
      { name: 'FACTORY_BIND_HOST is set to a private address', ok: false, required: true, detail: 'unset', remediation: 'set FACTORY_BIND_HOST=127.0.0.1' },
    ],
  });
  assert.match(markdown, /# Executor-host preflight — 2026-10-17/);
  assert.match(markdown, /Verdict: \*\*FAIL\*\*/, 'a failed required check must render the record as FAIL');
  assert.match(markdown, /\| bubblewrap can create a container \| PASS \| yes \|/);
  assert.match(markdown, /## Remediation\n\n- \*\*FACTORY_BIND_HOST is set to a private address\*\* — set FACTORY_BIND_HOST=127\.0\.0\.1/);
});
