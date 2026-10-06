import assert from 'node:assert/strict';
import test from 'node:test';
import { FrontierModelService as fm } from '../src/services/frontierModelService';

const TENANT = 'model-timeout-test';

test('Model provider registration validates timeoutMs bounds', () => {
  // Below min
  assert.throws(() => {
    fm.register({ tenantId: TENANT, id: 'bad-small', kind: 'local', timeoutMs: 5_000 });
  }, (err: Error) => err.message.includes('MODEL_PROVIDER_TIMEOUT_OUT_OF_RANGE'));

  // Above max
  assert.throws(() => {
    fm.register({ tenantId: TENANT, id: 'bad-big', kind: 'local', timeoutMs: 700_000 });
  }, (err: Error) => err.message.includes('MODEL_PROVIDER_TIMEOUT_OUT_OF_RANGE'));

  // Valid timeout
  const good = fm.register({ tenantId: TENANT, id: 'good', kind: 'local', timeoutMs: 30_000 });
  assert.equal(good.timeoutMs, 30_000);
});
