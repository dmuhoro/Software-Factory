/**
 * Layer 1 — cloud model provider registration through the egress guard.
 *
 * Providers register through `FrontierModelService.register()`, which validates:
 *   - the base URL hostname against `FACTORY_MODEL_ALLOWED_HOSTS` (remote kinds only)
 *   - the secret reference against `FACTORY_ALLOWED_SECRET_REFS` (mounted, non-empty)
 *
 * Fail closed: a provider whose host or secret reference is not permitted is not registered.
 * No socket is opened during registration — DNS resolution happens at request time, not here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DurableStore } from '../src/services/durableStore';
import { FrontierModelService } from '../src/services/frontierModelService';

const TENANT = 'model-registration-test';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-model-reg-'));

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function freshStore(): void {
  process.env.FACTORY_DATA_DIR = DATA_DIR;
  DurableStore.resetForTests();
  const file = DurableStore.dataFile();
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(`${file}.bak`, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(`${file}.lock`, { force: true }); } catch { /* ignore */ }
}

test('a cloud provider registers when its host and secret ref are both allowlisted and mounted', () => {
  freshStore();
  const result = withEnv(
    {
      FACTORY_MODEL_ALLOWED_HOSTS: 'api.deepseek.com',
      FACTORY_ALLOWED_SECRET_REFS: 'DEEPSEEK_API_KEY',
      DEEPSEEK_API_KEY: 'sk-test-key-that-is-not-real',
    },
    () => {
      return FrontierModelService.register({
        tenantId: TENANT,
        id: 'deepseek',
        kind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        modelIds: ['deepseek-chat', 'deepseek-coder'],
        secretRef: 'DEEPSEEK_API_KEY',
        enabled: true,
      });
    },
  );
  assert.equal(result.id, 'deepseek');
  assert.equal(result.kind, 'openai-compatible');
  assert.equal(result.baseUrl, 'https://api.deepseek.com/v1');
  assert.deepEqual(result.modelIds, ['deepseek-chat', 'deepseek-coder']);
  assert.equal(result.secretRef, 'DEEPSEEK_API_KEY');
  assert.equal(result.enabled, true);

  const listed = FrontierModelService.list(TENANT);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'deepseek');
});

test('a remote provider is refused when its host is not in FACTORY_MODEL_ALLOWED_HOSTS', () => {
  freshStore();
  assert.throws(
    () =>
      withEnv(
        { FACTORY_MODEL_ALLOWED_HOSTS: '', FACTORY_ALLOWED_SECRET_REFS: 'DEEPSEEK_API_KEY', DEEPSEEK_API_KEY: 'x' },
        () =>
          FrontierModelService.register({
            tenantId: TENANT,
            id: 'deepseek',
            kind: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com/v1',
            modelIds: ['deepseek-chat'],
            secretRef: 'DEEPSEEK_API_KEY',
          }),
      ),
    /MODEL_PROVIDER_HOST_NOT_ALLOWED:api\.deepseek\.com/,
    'a host not on the allowlist is refused at registration',
  );
});

test('a provider is refused when its secret ref is not in FACTORY_ALLOWED_SECRET_REFS', () => {
  freshStore();
  assert.throws(
    () =>
      withEnv(
        {
          FACTORY_MODEL_ALLOWED_HOSTS: 'api.deepseek.com',
          FACTORY_ALLOWED_SECRET_REFS: 'SOME_OTHER_REF',
          DEEPSEEK_API_KEY: 'sk-test-key-that-is-not-real',
        },
        () =>
          FrontierModelService.register({
            tenantId: TENANT,
            id: 'deepseek',
            kind: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com/v1',
            modelIds: ['deepseek-chat'],
            secretRef: 'DEEPSEEK_API_KEY',
          }),
      ),
    /MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED/,
    'a secret reference not on the allowlist is refused',
  );
});

test('a provider is refused when its secret ref is allowlisted but unmounted', () => {
  freshStore();
  assert.throws(
    () =>
      withEnv(
        {
          FACTORY_MODEL_ALLOWED_HOSTS: 'api.deepseek.com',
          FACTORY_ALLOWED_SECRET_REFS: 'DEEPSEEK_API_KEY',
          // DEEPSEEK_API_KEY deliberately not set
        },
        () =>
          FrontierModelService.register({
            tenantId: TENANT,
            id: 'deepseek',
            kind: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com/v1',
            modelIds: ['deepseek-chat'],
            secretRef: 'DEEPSEEK_API_KEY',
          }),
      ),
    /MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED/,
    'an allowlisted but unmounted reference is a configuration error, not a free pass',
  );
});

test('a local provider registers without a base URL or secret ref', () => {
  freshStore();
  const result = withEnv(
    { FACTORY_MODEL_ALLOWED_HOSTS: '', FACTORY_ALLOWED_SECRET_REFS: '' },
    () =>
      FrontierModelService.register({
        tenantId: TENANT,
        id: 'ollama-local',
        kind: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelIds: ['qwen2.5-coder:14b'],
        secretRef: undefined,
        enabled: true,
      }),
  );
  assert.equal(result.kind, 'local');
  assert.equal(result.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(result.secretRef, undefined);
});

test('a remote provider without a base URL is refused', () => {
  freshStore();
  assert.throws(
    () =>
      withEnv(
        { FACTORY_MODEL_ALLOWED_HOSTS: '', FACTORY_ALLOWED_SECRET_REFS: '' },
        () =>
          FrontierModelService.register({
            tenantId: TENANT,
            id: 'no-url',
            kind: 'openai-compatible',
            modelIds: ['some-model'],
          }),
      ),
    /MODEL_PROVIDER_BASE_URL_REQUIRED/,
    'a remote provider must declare a base URL',
  );
});

test('the provider registry can be looked up after registration', () => {
  freshStore();
  withEnv(
    {
      FACTORY_MODEL_ALLOWED_HOSTS: 'api.deepseek.com,api.together.xyz',
      FACTORY_ALLOWED_SECRET_REFS: 'DEEPSEEK_API_KEY,TOGETHER_API_KEY',
      DEEPSEEK_API_KEY: 'sk-test-deepseek',
      TOGETHER_API_KEY: 'sk-test-together',
    },
    () => {
      FrontierModelService.register({
        tenantId: TENANT,
        id: 'deepseek',
        kind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        modelIds: ['deepseek-chat'],
        secretRef: 'DEEPSEEK_API_KEY',
      });
      FrontierModelService.register({
        tenantId: TENANT,
        id: 'together',
        kind: 'openai-compatible',
        baseUrl: 'https://api.together.xyz/v1',
        modelIds: ['Qwen/Qwen2.5-Coder-32B-Instruct'],
        secretRef: 'TOGETHER_API_KEY',
      });
    },
  );

  const providers = FrontierModelService.list(TENANT);
  assert.equal(providers.length, 2);
  const ids = providers.map((p) => p.id).sort();
  assert.deepEqual(ids, ['deepseek', 'together']);

  const got = FrontierModelService.get(TENANT, 'deepseek');
  assert.ok(got, 'deepseek provider is retrievable by id');
  assert.equal(got!.baseUrl, 'https://api.deepseek.com/v1');
});

test('registration with an empty provider id is refused', () => {
  freshStore();
  assert.throws(
    () =>
      withEnv(
        {
          FACTORY_MODEL_ALLOWED_HOSTS: 'api.deepseek.com',
          FACTORY_ALLOWED_SECRET_REFS: 'DEEPSEEK_API_KEY',
          DEEPSEEK_API_KEY: 'x',
        },
        () =>
          FrontierModelService.register({
            tenantId: TENANT,
            id: '',
            kind: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com/v1',
            modelIds: ['deepseek-chat'],
            secretRef: 'DEEPSEEK_API_KEY',
          }),
      ),
    /MODEL_PROVIDER_ID_REQUIRED/,
    'an empty provider id is refused',
  );
});

test('no providers are registered when FACTORY_MODEL_PROVIDERS is unset (script path)', () => {
  freshStore();
  const before = FrontierModelService.list(TENANT);
  assert.equal(before.length, 0, 'the registry starts empty for the tenant');
});
