/**
 * ADR-011: model egress has one door.
 *
 * The finding that scoped Sprint 29: `egressGuard.ts` calls itself the single authority for outbound
 * model egress, yet `geminiService.ts` was a second door — it imported the vendor SDK client
 * directly, read the provider key from the environment, and called the provider on the live
 * telemetry path, never consulting `FACTORY_ALLOWED_SECRET_REFS` or `FACTORY_MODEL_ALLOWED_HOSTS`.
 *
 * A control that is not asserted is a comment (ADR-008). This is the assertion, and it is written
 * to fail against the pre-fix tree: before WP-2, `geminiService.ts` both imports `GoogleGenAI` and
 * reads `process.env.GEMINI_API_KEY`, so rules A and B below report it.
 *
 * Three invariants over the server-side source tree:
 *
 *   A. A vendor model SDK's *client constructor* is imported in exactly one module
 *      (`src/utils/modelEgress.ts`). Schema-builder imports (`Type`) stay allowed everywhere —
 *      ADR-002 is preserved; the SDK is the schema builder, not the transport authority.
 *   B. A provider secret is read from the environment in exactly one module
 *      (`src/utils/egressGuard.ts`, inside `resolveSecretRef`/`resolveOptionalSecretRef`).
 *   C. A raw network client (`node:https`, `node:http`, `undici`, `node-fetch`, `axios`, `got`) is
 *      imported only by the guard or the process's own HTTP listener (`server.ts`).
 *
 * Plus a positive assertion that the sanctioned module actually routes through the guard: it must
 * name the key resolver and the endpoint validator. A confinement test that passes while the one
 * door is unguarded would be exactly the false confidence this sprint exists to remove.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const SANCTIONED_SDK_MODULE = 'src/utils/modelEgress.ts';
const SANCTIONED_SECRET_MODULE = 'src/utils/egressGuard.ts';
const RAW_CLIENT_ALLOWED = new Set([SANCTIONED_SECRET_MODULE, 'server.ts']);

/** Vendor model SDKs and the client constructor each exports. */
const VENDOR_SDK_CLIENTS: Record<string, string[]> = {
  '@google/genai': ['GoogleGenAI'],
  '@google/generative-ai': ['GoogleGenerativeAI'],
  openai: ['OpenAI'],
  '@anthropic-ai/sdk': ['Anthropic'],
  '@mistralai/mistralai': ['Mistral'],
  'groq-sdk': ['Groq'],
  'cohere-ai': ['CohereClient'],
};

/** Raw network clients that must not be imported outside the sanctioned boundary. */
const RAW_NETWORK_CLIENTS = new Set([
  'node:https',
  'node:http',
  'https',
  'http',
  'undici',
  'node-fetch',
  'fetch',
  'axios',
  'got',
]);

/** Environment names that denote a provider credential. */
const PROVIDER_SECRET_NAME = /(?:^|_)(?:GEMINI|GOOGLE|OPENAI|ANTHROPIC|MISTRAL|COHERE|GROQ|DEEPSEEK)(?:_API)?_(?:KEY|TOKEN|SECRET)$/i;

interface ImportedModule {
  spec: string;
  names: Set<string>;
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
}

/** Every server-side source file the assertion governs: src/**.ts(x) plus the entrypoint. */
function serverSourceFiles(): string[] {
  const files: string[] = [];
  walk(path.join(ROOT, 'src'), files);
  const server = path.join(ROOT, 'server.ts');
  if (fs.existsSync(server)) files.push(server);
  return files;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/** Blanks comment and template-literal content so a code sample shown in the UI is not read as a real import. */
function maskNonCode(text: string): string {
  const out = text.split('');
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out[i] = ' '; }
      else if (c === '/' && next === '*') { state = 'block'; out[i] = ' '; }
      else if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') { state = 'template'; out[i] = ' '; }
    } else if (state === 'line') {
      if (c === '\n') state = 'code'; else out[i] = ' ';
    } else if (state === 'block') {
      out[i] = ' ';
      if (c === '*' && next === '/') { out[i + 1] = ' '; i += 1; state = 'code'; }
    } else if (state === 'single' || state === 'double') {
      // Keep quoted strings: import specifiers live inside them.
      const quote = state === 'single' ? "'" : '"';
      if (c === '\\') { out[i] = ' '; if (i + 1 < text.length) { out[i + 1] = ' '; i += 1; } }
      else if (c === quote) state = 'code';
      else if (c === '\n') state = 'code';
    } else if (state === 'template') {
      out[i] = ' ';
      if (c === '\\') { out[i] = ' '; if (i + 1 < text.length) { out[i + 1] = ' '; i += 1; } }
      else if (c === '`') state = 'code';
    }
  }
  return out.join('');
}

function importedNamesFromClause(clause: string): Set<string> {
  const names = new Set<string>();
  const brace = clause.match(/\{([\s\S]*?)\}/);
  if (brace) {
    for (const part of brace[1].split(',')) {
      const cleaned = part
        .trim()
        .replace(/^type\s+/, '')
        .replace(/\bas\b.*$/, '')
        .trim();
      const named = cleaned.match(/^([A-Za-z_$][\w$]*)/);
      if (named) names.add(named[1]);
    }
  }
  const beforeBrace = brace ? clause.slice(0, brace.index) : clause;
  const defaultImport = beforeBrace.match(/([A-Za-z_$][\w$]*)\s*,?\s*$/);
  if (defaultImport) names.add(defaultImport[1]);
  return names;
}

function importsOf(rawText: string): ImportedModule[] {
  const text = maskNonCode(rawText);
  const found: ImportedModule[] = [];
  const fromImport = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = fromImport.exec(text)) !== null) {
    found.push({ spec: match[2], names: importedNamesFromClause(match[1]) });
  }
  const sideEffect = /\bimport\s+['"]([^'"]+)['"]/g;
  while ((match = sideEffect.exec(text)) !== null) {
    found.push({ spec: match[1], names: new Set() });
  }
  const requireCall = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireCall.exec(text)) !== null) {
    found.push({ spec: match[1], names: new Set() });
  }
  return found;
}

function providerSecretReads(rawText: string): string[] {
  const text = maskNonCode(rawText);
  const reads: string[] = [];
  const pattern = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1] ?? match[2];
    if (PROVIDER_SECRET_NAME.test(name)) reads.push(name);
  }
  return reads;
}

test('ADR-011 A: a vendor model SDK client constructor is imported behind one door', () => {
  const violations: string[] = [];
  const files = serverSourceFiles();
  assert.ok(files.length > 40, `the scan must see the real source tree, saw ${files.length} files`);

  for (const file of files) {
    const rel = relative(file);
    for (const imported of importsOf(fs.readFileSync(file, 'utf8'))) {
      const constructors = VENDOR_SDK_CLIENTS[imported.spec];
      if (!constructors) continue;
      const used = constructors.filter((name) => imported.names.has(name));
      if (used.length && rel !== SANCTIONED_SDK_MODULE) {
        violations.push(`${rel} imports ${used.join(', ')} from ${imported.spec}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `a vendor model SDK client was imported outside ${SANCTIONED_SDK_MODULE}:\n  ${violations.join('\n  ')}`,
  );
});

test('ADR-011 B: a provider secret is read only inside the guard', () => {
  const violations: string[] = [];
  for (const file of serverSourceFiles()) {
    const rel = relative(file);
    const reads = providerSecretReads(fs.readFileSync(file, 'utf8'));
    if (reads.length && rel !== SANCTIONED_SECRET_MODULE) {
      violations.push(`${rel} reads ${[...new Set(reads)].join(', ')}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `a provider secret was read outside ${SANCTIONED_SECRET_MODULE}:\n  ${violations.join('\n  ')}`,
  );
});

test('ADR-011 C: a raw network client is imported only by the guard or the HTTP listener', () => {
  const violations: string[] = [];
  for (const file of serverSourceFiles()) {
    const rel = relative(file);
    if (RAW_CLIENT_ALLOWED.has(rel)) continue;
    for (const imported of importsOf(fs.readFileSync(file, 'utf8'))) {
      if (RAW_NETWORK_CLIENTS.has(imported.spec)) {
        violations.push(`${rel} imports ${imported.spec}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `a raw network client was imported outside the sanctioned boundary:\n  ${violations.join('\n  ')}`,
  );
});

test('ADR-011: the sanctioned SDK module routes through the guard, not around it', () => {
  const file = path.join(ROOT, SANCTIONED_SDK_MODULE);
  assert.ok(fs.existsSync(file), `${SANCTIONED_SDK_MODULE} must exist: the one door the SDK may leave through`);
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /resolveOptionalSecretRef|resolveSecretRef/, 'the module must resolve its key through the guard');
  assert.match(source, /authorizeProviderEndpoint|validateProviderUrl/, 'the module must validate its endpoint through the guard');
});

test('the guard exposes the resolver and endpoint authorizer the one door depends on', () => {
  const source = fs.readFileSync(path.join(ROOT, SANCTIONED_SECRET_MODULE), 'utf8');
  assert.match(source, /export function resolveOptionalSecretRef/, 'the guard must export the optional-ref resolver');
  assert.match(source, /export async function authorizeProviderEndpoint/, 'the guard must export the endpoint authorizer');
});

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

test('ADR-011: no mounted key means no live client — the deterministic path, never a fallback call', async () => {
  const { createGeminiClient, resetGeminiClientForTests } = await import('../src/utils/modelEgress');
  resetGeminiClientForTests();
  await withEnv(
    { GEMINI_API_KEY: undefined, FACTORY_ALLOWED_SECRET_REFS: undefined, FACTORY_MODEL_ALLOWED_HOSTS: undefined },
    async () => {
      assert.equal(await createGeminiClient(), null, 'an unconfigured Gemini must build no client');
    },
  );
});

test('ADR-011: a mounted key whose reference is not allowlisted is refused, not silently used', async () => {
  const { createGeminiClient, resetGeminiClientForTests } = await import('../src/utils/modelEgress');
  resetGeminiClientForTests();
  await withEnv(
    { GEMINI_API_KEY: 'live-looking-key', FACTORY_ALLOWED_SECRET_REFS: '', FACTORY_MODEL_ALLOWED_HOSTS: 'generativelanguage.googleapis.com' },
    async () => {
      await assert.rejects(
        () => createGeminiClient(),
        /MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED/,
        'a mounted credential without an allowlist entry is a configuration error, not a free pass',
      );
    },
  );
});

test('ADR-011: an allowlisted key whose host is not permitted is refused before the client is built', async () => {
  const { createGeminiClient, resetGeminiClientForTests } = await import('../src/utils/modelEgress');
  resetGeminiClientForTests();
  await withEnv(
    { GEMINI_API_KEY: 'live-looking-key', FACTORY_ALLOWED_SECRET_REFS: 'GEMINI_API_KEY', FACTORY_MODEL_ALLOWED_HOSTS: '' },
    async () => {
      await assert.rejects(
        () => createGeminiClient(),
        /MODEL_PROVIDER_HOST_NOT_ALLOWED/,
        'an allowlisted key is still refused when its endpoint host is not permitted',
      );
    },
  );
});

test('ADR-011: the optional resolver reports absence as undefined and a mounted unpermitted key as a refusal', async () => {
  const { resolveOptionalSecretRef } = await import('../src/utils/egressGuard');
  await withEnv({ GEMINI_API_KEY: undefined, FACTORY_ALLOWED_SECRET_REFS: undefined }, () => {
    assert.equal(resolveOptionalSecretRef('GEMINI_API_KEY'), undefined, 'an unmounted reference is the offline path');
  });
  await withEnv({ GEMINI_API_KEY: 'mounted-secret-value', FACTORY_ALLOWED_SECRET_REFS: '' }, () => {
    assert.throws(() => resolveOptionalSecretRef('GEMINI_API_KEY'), /MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED/);
  });
  await withEnv({ GEMINI_API_KEY: 'mounted-secret-value', FACTORY_ALLOWED_SECRET_REFS: 'GEMINI_API_KEY' }, () => {
    assert.equal(resolveOptionalSecretRef('GEMINI_API_KEY'), 'mounted-secret-value');
  });
});

test('ADR-011: the endpoint authorizer refuses a non-permitted host and permits a local target without a socket', async () => {
  const { authorizeProviderEndpoint } = await import('../src/utils/egressGuard');
  await withEnv({ FACTORY_MODEL_ALLOWED_HOSTS: '' }, async () => {
    await assert.rejects(
      () => authorizeProviderEndpoint('https://generativelanguage.googleapis.com', 'gemini-native'),
      /MODEL_PROVIDER_HOST_NOT_ALLOWED/,
    );
    const local = await authorizeProviderEndpoint('http://127.0.0.1:9', 'local');
    assert.equal(local.hostname, '127.0.0.1', 'a permitted local target authorizes without DNS');
  });
});

