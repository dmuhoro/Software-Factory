import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './src/api';
import { globalErrorHandler } from './src/api/middleware';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Mount Software Factory API Routes FIRST
  app.use('/api', apiRouter);

  // Global error handler
  app.use(globalErrorHandler);

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Software Factory Engine] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Software Factory Engine] Fatal startup crash:', err);
  process.exit(1);
});
