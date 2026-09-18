import express from 'express';
import path from 'node:path';
import http from 'node:http';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './src/api';
import { globalErrorHandler } from './src/api/middleware';

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);
  app.disable('x-powered-by');
  app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT || '1mb' }));
  app.use('/api', apiRouter);
  app.use(globalErrorHandler);
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  const server = http.createServer(app);
  server.listen(port, '0.0.0.0', () => console.log(`[Software Factory] listening on 0.0.0.0:${port}`));
  const shutdown = (signal: string) => {
    console.log(`[Software Factory] ${signal} received; draining HTTP connections`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((error) => { console.error('[Software Factory] startup failure', error); process.exit(1); });
