import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { FrontierModelService as fm } from '../src/services/frontierModelService';
import { classifyApiError } from '../src/utils/apiError';

const TENANT = 'model-timeout-request-test';

// Helper: start a server that stalls for `delayMs` then returns a minimal valid OpenAI‑compatible JSON.
function startSlowServer(delayMs: number) {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      const payload = JSON.stringify({ id: 'stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'stub-model', choices: [{ index: 0, message: { role: 'assistant', content: 'stub' }, finish_reason: 'stop' }] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    }, delayMs);
  });
  return new Promise<{url: string; close: () => void}>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const url = typeof address === 'string' ? address : `http://127.0.0.1:${address?.port}`;
      resolve({ url, close: () => server.close() });
    });
  });
}

test('Model request respects configured timeoutMs (short timeout)', async () => {
  // Server will wait 30 s before responding – longer than the provider's 15 s timeout.
  const { url, close } = await startSlowServer(30_000);
  try {
    // Register with the minimum allowed timeout (15 s).
    const prov = fm.register({ tenantId: TENANT, id: 'slow-provider', kind: 'local', baseUrl: url, timeoutMs: 15_000, modelIds: ['stub-model'] });
    // Invoke a request – it should reject far before the server answers.
    const start = Date.now();
  await assert.rejects(
    fm.request(TENANT, { providerId: prov.id, model: 'stub-model', system: 'sys', task: 'task', maxOutputTokens: 10 }),
    (err: Error) => err.message.includes('MODEL_PROVIDER_REQUEST_TIMEOUT')
  );
    const elapsed = Date.now() - start;
    // The request should have timed out around 15 s – give a generous window.
    assert.ok(elapsed < 25_000, `Request timed out after ${elapsed} ms, expected <25 s`);
  } finally {
    close();
  }
});
