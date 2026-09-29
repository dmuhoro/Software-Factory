import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './src/api';
import { globalErrorHandler } from './src/api/middleware';
import { classifyReadiness } from './src/services/healthService';
import { describeConfig, errorsOf, resolveRuntimeConfig } from './src/configurations/runtimeConfig';
import { TenantService } from './src/services/tenantService';
import { DurableStore } from './src/services/durableStore';

const config = resolveRuntimeConfig();

// Fail closed: a production deployment with an unusable configuration must not
// bind a port and serve 401s. It must refuse to start with an actionable message.
const fatal = errorsOf(config);
if (fatal.length > 0) {
  process.stderr.write(`[Software Factory] refusing to start: ${fatal.length} configuration error(s)\n${describeConfig(config)}\n`);
  process.exit(78); // EX_CONFIG
}

// eslint-disable-next-line no-console -- startup banner is the operator's first signal
console.log(`[Software Factory] starting\n${describeConfig(config)}`);

/**
 * Hashes and installs the configured per-tenant credentials into the durable registry.
 *
 * Runs before the port is bound so a tenant is never told it is authenticated and then
 * fail on its first request. The plaintext is discarded here; only the scrypt digest
 * reaches the registry.
 *
 * A credential naming a tenant that does not exist is FATAL, not a warning. It used to log
 * a warning and continue, which means an operator who mistyped an id saw a healthy start-up
 * banner, a line of warning text nobody reads, and a tenant that could never authenticate.
 * The operator's belief and the system's behaviour now disagree, and the process refuses
 * rather than leaving the disagreement for someone to discover as an outage.
 */
async function provisionTenantCredentials(): Promise<void> {
  const entries = Object.entries(config.tenantCredentials);
  const unknown = entries.filter(([tenantId]) => !TenantService.getTenant(tenantId)).map(([tenantId]) => tenantId);
  if (unknown.length > 0) {
    throw new Error(
      `FACTORY_TENANT_CREDENTIALS names ${unknown.length} tenant(s) that do not exist in the registry: ${unknown.join(', ')}. `
      + 'Provision the tenant first, or remove the entry. Refusing to start, because a credential nobody can use is a silent outage.'
    );
  }
  for (const [tenantId, secret] of entries) {
    await TenantService.provisionCredential(tenantId, secret);
  }
  if (entries.length > 0) {
    process.stderr.write(`[Software Factory] provisioned ${entries.length} tenant credential(s); digests only are retained.\n`);
  }
  // Drop the plaintext from the config object. The digests in the registry are now the only
  // copy of these secrets in this process. JS strings are immutable so the buffer cannot be
  // overwritten, but removing the last reference makes the material collectable instead of
  // pinning every tenant's plaintext in memory for the life of the process.
  for (const tenantId of Object.keys(config.tenantCredentials)) delete config.tenantCredentials[tenantId];
}

/**
 * Exit code for "this ledger is temporarily not mine to write".
 *
 * 75 is EX_TEMPFAIL, which tells a supervisor or Kubernetes the condition is expected to
 * clear on its own, so it retries. A contended writer lock is exactly that: the other
 * process is live and will eventually exit. Reporting it as a generic failure tells the
 * supervisor the same thing as a corrupt document -- restart now, forever, and never
 * converge on the one instance that may hold the lock.
 */
function refuseWhileLedgerUnusable(reason: string): never {
  process.stderr.write(`[Software Factory] refusing to serve while the ledger is unusable: ${reason}\n`);
  process.exit(75);
}

async function startServer() {
  // Load the tenant registry from the durable ledger before anything reads it. An
  // unreadable registry aborts startup rather than leaving an empty cache that would make
  // every provisioned tenant look deleted.
  //
  // This is the first thing to touch the ledger, so it is the first thing that can find a
  // contended writer lock. It must classify that the same way the readiness pre-flight
  // below does, or the same physical fault is reported with two different exit codes
  // depending only on which check happened to run first.
  try {
    TenantService.bootstrap();
  } catch (error) {
    refuseWhileLedgerUnusable(error instanceof Error ? error.message : String(error));
  }
  await provisionTenantCredentials();

  // Pre-flight: probe the durable ledger BEFORE binding a port. A corrupt ledger is
  // recoverable, but an operator must learn about it from the startup banner, and no
  // request should be served before that state is known.
  const readiness = classifyReadiness();
  if (readiness.status === 'unhealthy') {
    process.stderr.write('[Software Factory] readiness pre-flight failed:\n');
    for (const check of readiness.details) process.stderr.write(`  ${check.state.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
    // Fail closed. Binding a port here would serve traffic from a process that cannot
    // guarantee its own writes -- for example one that lost a race for the writer lock
    // and would overwrite the other writer's records. An orchestrator restarts on a
    // non-zero exit, which is the correct response; a 200 health check is not.
    refuseWhileLedgerUnusable('readiness pre-flight failed');
  } else if (readiness.status === 'degraded') {
    process.stderr.write('[Software Factory] running DEGRADED:\n');
    for (const check of readiness.details) {
      if (check.state !== 'pass') process.stderr.write(`  ${check.state.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
    }
  }

  const app = express();
  const port = config.port;
  app.disable('x-powered-by');
  app.set('trust proxy', config.isProduction ? 1 : false);
  app.use(express.json({ limit: config.requestBodyLimit }));
  app.use('/api', apiRouter);
  // Anything under /api that no route claimed is a 404, and it must be decided here. The
  // SPA fallback below answers `app.get('*')` with index.html and a 200, so without this
  // a mistyped API path returned HTTP 200 and an HTML body: a client that checks the
  // status would treat a missing endpoint as a successful call.
  app.use('/api', (_req, res) => {
    res.status(404).json({ status: 'error', code: 'ENDPOINT_NOT_FOUND', message: 'No such API endpoint.' });
  });
  if (!config.isProduction) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    // Resolve the bundle relative to the entrypoint, not the working directory, so
    // the service still serves correctly when a supervisor starts it from elsewhere.
    const entry = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : process.cwd();
    const distPath = [entry, path.join(entry, '..'), process.cwd()]
      .map((base) => path.resolve(base, 'dist'))
      .find((candidate) => fs.existsSync(path.join(candidate, 'index.html')));
    if (!distPath) {
      throw new Error(`Production bundle not found. Looked for dist/index.html next to ${entry} and in ${process.cwd()}. Run "npm run build" before starting in production.`);
    }
    app.use(express.static(distPath, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  // The error handler is registered LAST so it observes failures from the API
  // router and from the static/SPA layer. Registering it earlier let SPA-layer
  // throws bypass it entirely and hang the request.
  app.use(globalErrorHandler);
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 120_000;
  server.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[Software Factory] listening on 0.0.0.0:${port} (${config.nodeEnv}) readiness=${readiness.status}`);
  });
  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[Software Factory] ${signal} received; draining HTTP connections`);
    server.close(() => {
      // Hand the writer lock back only once no further request can be served. Releasing it
      // earlier would let a replacement instance start while this one was still writing.
      DurableStore.releaseWriterLock();
      process.exit(0);
    });
    setTimeout(() => {
      DurableStore.releaseWriterLock();
      process.exit(1);
    }, 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[Software Factory] unhandled promise rejection', reason);
  });
  // An uncaught exception means the process is in an unknown state. Logging it and
  // continuing is unsafe: the process would keep reporting itself as healthy while
  // holding an unknown amount of corrupted state, and a failed bind (EADDRINUSE /
  // EACCES) would leave a "started" banner attached to a process serving nothing.
  // Fail loudly and let the supervisor restart us.
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[Software Factory] FATAL uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      process.stderr.write(`[Software Factory] FATAL cannot bind port ${port} (${code}). Another process owns it, or the container lacks the capability.\n`);
    }
    process.exit(70); // EX_SOFTWARE
  });
}

startServer().catch((error) => {
  process.stderr.write(`[Software Factory] startup failure: ${(error as Error).message}\n`);
  process.exit(1);
});
