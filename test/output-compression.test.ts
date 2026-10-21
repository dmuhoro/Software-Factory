/**
 * Output compression tests (Layer 7 Interface, headroom steal).
 *
 * Proves:
 *  - OC-1  compression reduces byte size (ratio > 0)
 *  - OC-2  decompression round-trips to original (lossless)
 *  - OC-3  evidence markers (file:line, exit codes, error codes) survive
 *  - OC-4  aggressive level compresses more than medium
 *  - OC-5  same input always yields same compressed output (deterministic)
 *  - OC-6  empty input handled gracefully
 *  - OC-7  compression ratio is between 0 and 1
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compressOutput,
  decompressOutput,
  compressForLLM,
  compressForFrontend,
  compressForStorage,
  roundTrip,
  type CompressionResult,
} from '../src/utils/outputCompression';

const VERBOSE_OUTPUT = `
src/utils/apiError.ts:42: exit 1 - unrecognised error code leaks internal path
src/services/loopGates.ts:127: gate bug-diagnosis-evidence not implemented
src/services/bugDetectiveService.ts:89: DEFECT_DETECTED in verification stage

The implementation returned malformed JSON. The model failed to produce
the required file-manifest contract. Please review the output and fix
the formatting before re-submitting.

Verification command: node check.cjs
Exit code: 1
Output: missing alpha

GATE_REFUSED:verify:ground-truth:check failed
SECRET_CONTENT_REFUSED: staged content contains credential
`;

test('OC-1: compression reduces byte size (ratio > 0)', () => {
  const result = compressOutput(VERBOSE_OUTPUT);
  assert.ok(result.ratio > 0, `compression ratio should be > 0, got ${result.ratio}`);
  assert.ok(result.compressedBytes < result.originalBytes, 'compressed should be smaller than original');
});

test('OC-2: decompression round-trips to original (lossless, light level)', () => {
  const result = compressOutput(VERBOSE_OUTPUT, 'light');
  const decompressed = decompressOutput(result.compressed);
  assert.equal(decompressed, VERBOSE_OUTPUT, 'decompressed output must match original');
});

test('OC-2b: roundTrip helper returns true for light level (lossless)', () => {
  assert.ok(roundTrip(VERBOSE_OUTPUT, 'light'), 'light round-trip is lossless');
  // Medium and aggressive intentionally remove noise (blank lines), so they are lossy.
  assert.ok(!roundTrip(VERBOSE_OUTPUT, 'medium'), 'medium round-trip is lossy (blank lines removed)');
  assert.ok(!roundTrip(VERBOSE_OUTPUT, 'aggressive'), 'aggressive round-trip is lossy (noise removed)');
});

test('OC-3: evidence markers survive compression', () => {
  const result = compressOutput(VERBOSE_OUTPUT, 'aggressive');
  const decompressed = decompressOutput(result.compressed);

  // file:line pointers preserved
  assert.ok(decompressed.includes('src/utils/apiError.ts:42'), 'file:line preserved');
  assert.ok(decompressed.includes('src/services/loopGates.ts:127'), 'file:line preserved');
  assert.ok(decompressed.includes('src/services/bugDetectiveService.ts:89'), 'file:line preserved');

  // exit codes preserved
  assert.ok(decompressed.includes('exit 1'), 'exit code preserved');

  // error codes preserved
  assert.ok(decompressed.includes('DEFECT_DETECTED'), 'refusal code preserved');
  assert.ok(decompressed.includes('GATE_REFUSED:verify:ground-truth:check failed'), 'gate refusal preserved');
  assert.ok(decompressed.includes('SECRET_CONTENT_REFUSED'), 'secret refusal preserved');

  // evidence count > 0
  assert.ok(result.evidencePreserved > 0, 'evidence markers were detected and preserved');
});

test('OC-4: aggressive level compresses more than medium', () => {
  const medium = compressOutput(VERBOSE_OUTPUT, 'medium');
  const aggressive = compressOutput(VERBOSE_OUTPUT, 'aggressive');
  assert.ok(aggressive.compressedBytes <= medium.compressedBytes,
    `aggressive (${aggressive.compressedBytes}) should be <= medium (${medium.compressedBytes})`);
});

test('OC-5: same input always yields same compressed output (deterministic)', () => {
  const first = compressOutput(VERBOSE_OUTPUT, 'medium');
  for (let i = 0; i < 20; i += 1) {
    const repeated = compressOutput(VERBOSE_OUTPUT, 'medium');
    assert.equal(repeated.compressed, first.compressed, 'compressed output must be deterministic');
    assert.equal(repeated.ratio, first.ratio, 'ratio must be deterministic');
  }
});

test('OC-6: empty input handled gracefully', () => {
  const result = compressOutput('');
  assert.equal(result.originalBytes, 0);
  assert.equal(result.ratio, 0);
  assert.equal(decompressOutput(result.compressed), '');
});

test('OC-7: compression ratio is between 0 and 1', () => {
  const result = compressOutput(VERBOSE_OUTPUT, 'medium');
  assert.ok(result.ratio >= 0, 'ratio should be >= 0');
  assert.ok(result.ratio <= 1, 'ratio should be <= 1');
});

test('OC-8: compressForLLM uses aggressive level', () => {
  const llm = compressForLLM(VERBOSE_OUTPUT);
  const aggressive = compressOutput(VERBOSE_OUTPUT, 'aggressive');
  assert.equal(llm.level, 'aggressive');
  assert.equal(llm.compressed, aggressive.compressed);
});

test('OC-9: compressForFrontend uses medium level', () => {
  const frontend = compressForFrontend(VERBOSE_OUTPUT);
  const medium = compressOutput(VERBOSE_OUTPUT, 'medium');
  assert.equal(frontend.level, 'medium');
  assert.equal(frontend.compressed, medium.compressed);
});

test('OC-10: compressForStorage uses light level', () => {
  const storage = compressForStorage(VERBOSE_OUTPUT);
  const light = compressOutput(VERBOSE_OUTPUT, 'light');
  assert.equal(storage.level, 'light');
  assert.equal(storage.compressed, light.compressed);
});
