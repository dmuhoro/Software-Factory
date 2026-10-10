/**
 * WP-2b: error-trace honesty.
 *
 * The stream tab presented a "Raw Rust Backend Error Stack Trace" for errors raised by the
 * Node control plane. The frames were generated client-side with `Math.random()` -- a
 * random worker id, a random panic line, a canned `rustc` backtrace and a fixed register
 * dump -- so the UI manufactured diagnostic evidence that matched no failure that ever
 * happened. In the error path that is the worst place to fabricate: the operator reads a
 * confident-looking stack trace and believes it.
 *
 * The product does contain a Rust crate (`software_factory/`), but the running service is
 * the Node control plane and it does not emit Rust traces. Where a real trace is unavailable,
 * the honest move is to show the real error envelope, not to invent one.
 *
 * This guard has two arms:
 *   1. the error emitter carries no trace field and validation.ts holds no trace generator;
 *   2. the UI carries none of the source-level diagnostic tokens that only exist to make a
 *      fabricated backtrace look real.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

test('the error envelope is the real, deterministic JSON -- no synthesized trace field', async () => {
  const { emitMalformedContextError, emitSecurityError } = await import('../src/utils/validation');
  const malformed = emitMalformedContextError('a description') as Record<string, unknown>;
  assert.deepEqual(Object.keys(malformed).sort(), ['code', 'message', 'status']);
  assert.equal(malformed.rustTrace, undefined, 'no trace field may be attached to an error');

  const security = emitSecurityError('REFUSED', 'a reason') as Record<string, unknown>;
  assert.equal(security.rustTrace, undefined, 'no trace field may be attached to an error');

  const source = fs.readFileSync(path.resolve(root, 'src/utils/validation.ts'), 'utf8');
  assert.ok(!source.includes('generateRustStackTrace'), 'the trace generator must not return');
});

test('the UI synthesizes no source-level diagnostic anywhere', () => {
  const componentsDir = path.resolve(root, 'src/components');
  const files = [
    path.resolve(root, 'src/App.tsx'),
    path.resolve(root, 'src/types.ts'),
    ...fs.readdirSync(componentsDir).filter((n) => n.endsWith('.tsx')).map((n) => path.join(componentsDir, n)),
  ];
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const forbidden = [
    'rust_backtrace',
    'rust_begin_unwind',
    'panic_fmt',
    'core::panicking',
    'tokio-worker',
    'tokio-runtime-worker',
    'rustc/',
    'registers',
  ];
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8')).toLowerCase();
    for (const token of forbidden) {
      assert.ok(!text.includes(token), `${path.relative(root, file)} must not synthesize a diagnostic token "${token}"`);
    }
  }
});
