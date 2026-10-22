/**
 * Output compression (Layer 7 Interface).
 *
 * Headroom steal, adapted to SF constraints: compresses tool outputs, logs,
 * and RAG chunks before they reach the LLM or frontend, targeting 60-95%
 * reduction. Lossless on evidence fields: file:line pointers, exit codes,
 * error codes, and verification results are preserved verbatim.
 *
 * Pure: no clock, no model, no network. Deterministic: the same input always
 * yields the same compressed output. No new dependencies — uses Node's built-in
 * zlib plus a pre-processing pass that strips noise while protecting evidence.
 */

import zlib from 'node:zlib';

/** Patterns that must survive compression unchanged — they are evidence. */
const EVIDENCE_PATTERNS: RegExp[] = [
  /[A-Za-z0-9_./-]+\.(?:ts|js|json|md|txt|py|go|rs|java|rb|cs|php|c|h|cpp|hpp|yaml|yml|toml|ini|cfg|conf):\d+/g, // file:line
  /exit \d+/g,                                                          // exit codes
  /ERROR|FAIL|PANIC|FATAL/g,                                            // error severity
  /GATE_REFUSED:\S+/g,                                                  // gate refusals
  /^(DEFECT_|BUG_|SECRET_|MODEL_|IMPLEMENTER_|SANDBOX_|GIT_|WORKTREE_)\S*/g, // refusal codes
  /\b(?:critical|high|medium|low|info):/gi,                             // severity
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g,                              // timestamps
];

/** Compression level. Higher = smaller output, more aggressive noise removal. */
export type CompressionLevel = 'light' | 'medium' | 'aggressive';

export interface CompressionResult {
  /** Compressed output as base64. */
  compressed: string;
  /** Original byte length. */
  originalBytes: number;
  /** Compressed byte length. */
  compressedBytes: number;
  /** Compression ratio (0..1, higher = more compressed). */
  ratio: number;
  /** How many evidence markers were preserved. */
  evidencePreserved: number;
  /** Level used. */
  level: CompressionLevel;
}

/** The result of reducing a payload without encoding it. */
export interface ReducedText {
  /** The reduced text, ready to be placed in a prompt. */
  text: string;
  /** The byte length before reduction. */
  originalBytes: number;
  /** The byte length after reduction. */
  compressedBytes: number;
  /** How much was removed (0..1). */
  ratio: number;
  /** How many evidence markers were protected and restored. */
  evidencePreserved: number;
  /** The level used. */
  level: CompressionLevel;
}

/**
 * Reduce a payload: protect the evidence, strip the noise, restore the evidence.
 *
 * This is the step the gzip path also uses, exposed on its own because a model context needs the
 * reduced *text*, not a base64 blob. The reduction is conservative by construction: at `medium` it
 * removes blank lines and trailing whitespace, and at `aggressive` it also removes filler words —
 * which is why a prompt uses `medium` and a log uses `aggressive`.
 */
export function reduceText(text: string, level: CompressionLevel = 'medium'): ReducedText {
  const originalBytes = Buffer.byteLength(text, 'utf8');

  // Step 1: Find and protect evidence markers.
  const protectedSegments: Array<{ placeholder: string; original: string }> = [];
  let protectedText = text;
  let evidenceCount = 0;

  for (const pattern of EVIDENCE_PATTERNS) {
    protectedText = protectedText.replace(pattern, (match) => {
      evidenceCount += 1;
      const placeholder = `<<EVIDENCE_${evidenceCount}>>`;
      protectedSegments.push({ placeholder, original: match });
      return placeholder;
    });
  }

  // Step 2: Noise removal based on level.
  let processed = protectedText;
  if (level === 'medium' || level === 'aggressive') {
    // Remove blank lines and trailing whitespace.
    processed = processed
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .join('\n');
  }
  if (level === 'aggressive') {
    // Remove common noise words from non-evidence text.
    processed = processed.replace(/\b(the|a|an|and|or|but|in|on|at|to|for|of|with|by)\b/gi, ' ');
    // Collapse multiple spaces.
    processed = processed.replace(/\s+/g, ' ').trim();
  }

  // Step 3: Restore evidence markers.
  for (const { placeholder, original } of protectedSegments) {
    processed = processed.replace(placeholder, original);
  }

  const compressedBytes = Buffer.byteLength(processed, 'utf8');
  return {
    text: processed,
    originalBytes,
    compressedBytes,
    ratio: originalBytes > 0 ? 1 - compressedBytes / originalBytes : 0,
    evidencePreserved: evidenceCount,
    level,
  };
}

/** Compress text output. Evidence markers are protected before compression. */
export function compressOutput(
  text: string,
  level: CompressionLevel = 'medium',
): CompressionResult {
  const reduced = reduceText(text, level);

  // Step 4: Gzip compress the reduced text.
  const compressedBuf = zlib.gzipSync(Buffer.from(reduced.text, 'utf8'), { level: 9 });
  const compressed = compressedBuf.toString('base64');
  const compressedBytes = compressedBuf.length;

  return {
    compressed,
    originalBytes: reduced.originalBytes,
    compressedBytes,
    ratio: reduced.originalBytes > 0 ? 1 - compressedBytes / reduced.originalBytes : 0,
    evidencePreserved: reduced.evidencePreserved,
    level,
  };
}

/** Decompress output back to original text. */
export function decompressOutput(compressedBase64: string): string {
  const buf = Buffer.from(compressedBase64, 'base64');
  return zlib.gunzipSync(buf).toString('utf8');
}

/** Compress specifically for LLM input: aggressive but evidence-preserving. */
export function compressForLLM(text: string): CompressionResult {
  return compressOutput(text, 'aggressive');
}

/** Compress for frontend payload: medium balance. */
export function compressForFrontend(text: string): CompressionResult {
  return compressOutput(text, 'medium');
}

/** Compress for storage/archival: light, maximum fidelity. */
export function compressForStorage(text: string): CompressionResult {
  return compressOutput(text, 'light');
}

/** Round-trip check: compress then decompress yields the original. Only guaranteed
 *  for 'light' level; medium/aggressive intentionally remove noise (blank lines,
 *  filler words) and are lossy on non-evidence text. */
export function roundTrip(text: string, level: CompressionLevel = 'light'): boolean {
  const result = compressOutput(text, level);
  const decompressed = decompressOutput(result.compressed);
  return decompressed === text;
}
