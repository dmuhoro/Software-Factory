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
 * Hashes and installs the configured per-tenant credentials.
 *
 * Runs before the port is bound so a tenant is never told it is authenticated and then
 * fail on its first request. The plaintext is discarded here; only the scrypt digest
 * reaches the registry.
 */
async function provisionTenantCredentials(): Promise<void> {
  const entries = Object.entries(config.tenantCredentials);
  for (const [tenantId, secret] of entries) {
    if (!TenantService.getTenant(tenantId)) {
      process.stderr.write(`[Software Factory] WARNING FACTORY_TENANT_CREDENTIALS names unknown tenant '${tenantId}'; the credential is not installed and that tenant cannot authenticate.\n`);
      continue;
    }
    await TenantService.provisionCredential(tenantId, secret);
  }
  if (entries.length > 0) {
    process.stderr.write(`[Software Factory] provisioned ${Object.keys(config.tenantCredentials).length} tenant credential(s); digests only are retained.\n`);
  }
}

async function startServer() {
  await provisionTenantCredentials();

  // Pre-flight: probe the durable ledger BEFORE binding a port. A corrupt ledger is
  // recoverable, but an operator must learn about it from the startup banner, and no
  // request should be served before that state is known.
  const readiness = classifyReadiness();
  if (readiness.status === 'unhealthy') {
    process.stderr.write('[Software Factory] readiness pre-flight failed:\n');
    for (const check of readiness.details) process.stderr.write(`  ${check.state.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
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
