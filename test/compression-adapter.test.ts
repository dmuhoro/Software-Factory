/**
 * Compression adapter tests (Layer 4 Adapter).
 *
 * Proves:
 *  - CA-1  adapter compresses text and returns ratio
 *  - CA-2  decompress round-trips to original (light level)
 *  - CA-3  llm target uses aggressive compression
 *  - CA-4  frontend target uses medium compression
 *  - CA-5  storage target uses light compression
 *  - CA-6  evidence markers survive compression
 *  - CA-7  same input always yields same result (deterministic)
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compressionAdapter,
  type CompressionInput,
} from '../src/services/compressionAdapter';

const VERBOSE_OUTPUT = `src/utils/apiError.ts:42: exit 1 - unrecognised error code
src/services/loopGates.ts:127: gate ast-structural-verification not implemented

The implementation returned malformed JSON. The model failed to produce
the required file-manifest contract. Please review and re-submit.

Exit code: 1
GATE_REFUSED:verify:ground-truth:check failed
`;

const INPUT: CompressionInput = { text: VERBOSE_OUTPUT };

test('CA-1: adapter compresses text and returns ratio', () => {
  const result = compressionAdapter.compress(INPUT);
  assert.ok(result.originalBytes > 0);
  assert.ok(result.compressedBytes > 0);
  assert.ok(result.ratio >= 0 && result.ratio <= 1);
  assert.ok(typeof result.compressed === 'string');
});

test('CA-2: decompress round-trips to original (light level)', () => {
  const compressed = compressionAdapter.compress({ ...INPUT, level: 'light' });
  const decompressed = compressionAdapter.decompress(compressed.compressed);
  assert.equal(decompressed, VERBOSE_OUTPUT);
});

test('CA-3: llm target uses aggressive compression', () => {
  const llm = compressionAdapter.compress({ ...INPUT, target: 'llm' });
  const medium = compressionAdapter.compress({ ...INPUT, level: 'medium' });
  assert.ok(llm.compressedBytes <= medium.compressedBytes, 'llm (aggressive) <= medium');
});

test('CA-4: frontend target uses medium compression', () => {
  const frontend = compressionAdapter.compress({ ...INPUT, target: 'frontend' });
  const light = compressionAdapter.compress({ ...INPUT, level: 'light' });
  assert.ok(frontend.compressedBytes <= light.compressedBytes, 'frontend (medium) <= light');
});

test('CA-5: storage target uses light compression', () => {
  const storage = compressionAdapter.compress({ ...INPUT, target: 'storage' });
  const aggressive = compressionAdapter.compress({ ...INPUT, level: 'aggressive' });
  assert.ok(storage.compressedBytes >= aggressive.compressedBytes, 'storage (light) >= aggressive');
});

test('CA-6: evidence markers survive compression', () => {
  const compressed = compressionAdapter.compress(INPUT);
  const decompressed = compressionAdapter.decompress(compressed.compressed);
  assert.ok(decompressed.includes('src/utils/apiError.ts:42'), 'file:line preserved');
  assert.ok(decompressed.includes('exit 1'), 'exit code preserved');
  assert.ok(decompressed.includes('GATE_REFUSED:verify:ground-truth:check failed'), 'gate refusal preserved');
});

test('CA-7: same input always yields same result (deterministic)', () => {
  const first = compressionAdapter.compress(INPUT);
  for (let i = 0; i < 10; i += 1) {
    const repeated = compressionAdapter.compress(INPUT);
    assert.equal(repeated.compressed, first.compressed);
    assert.equal(repeated.ratio, first.ratio);
  }
});

test('CA-8: roundTrip adapter helper', () => {
  assert.ok(compressionAdapter.roundTrip(VERBOSE_OUTPUT, 'light'));
  assert.ok(!compressionAdapter.roundTrip(VERBOSE_OUTPUT, 'aggressive'), 'aggressive is lossy');
});
