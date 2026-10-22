/**
 * Compression adapter (Layer 4 Adapter).
 *
 * Provider-specific adapter that wraps output compression (headroom steal) for
 * model I/O: compresses tool outputs, logs, and RAG chunks before they reach
 * the LLM, targeting 60-95% reduction. Lossless on evidence fields: file:line
 * pointers, exit codes, error codes are preserved verbatim.
 *
 * Read-only: compresses text in memory, never writes to a target tree.
 * Deterministic: same input always yields the same compressed output.
 */

import {
  compressOutput,
  decompressOutput,
  compressForLLM,
  compressForFrontend,
  type CompressionResult,
} from '../utils/outputCompression';

export interface CompressionInput {
  /** Text to compress. */
  text: string;
  /** Compression level: light (fidelity), medium (balance), aggressive (size). */
  level?: 'light' | 'medium' | 'aggressive';
  /** Target: 'llm' (aggressive), 'frontend' (medium), 'storage' (light). */
  target?: 'llm' | 'frontend' | 'storage';
}

interface CompressionAdapterResult {
  /** Compressed text as base64. */
  compressed: string;
  /** Original byte length. */
  originalBytes: number;
  /** Compressed byte length. */
  compressedBytes: number;
  /** Compression ratio (0..1, higher = more compressed). */
  ratio: number;
  /** Evidence markers preserved during compression. */
  evidencePreserved: number;
}

/** Compress text through the adapter. */
function compressAdapter(input: CompressionInput): CompressionAdapterResult {
  let result: CompressionResult;
  switch (input.target) {
    case 'llm':
      result = compressForLLM(input.text);
      break;
    case 'frontend':
      result = compressForFrontend(input.text);
      break;
    case 'storage':
    default:
      result = compressOutput(input.text, input.level ?? 'light');
      break;
  }

  return {
    compressed: result.compressed,
    originalBytes: result.originalBytes,
    compressedBytes: result.compressedBytes,
    ratio: result.ratio,
    evidencePreserved: result.evidencePreserved,
  };
}

/** Decompress text back to original. */
function decompressAdapter(compressedBase64: string): string {
  return decompressOutput(compressedBase64);
}

/** Round-trip check. */
function roundTripAdapter(text: string, level: 'light' | 'medium' | 'aggressive' = 'light'): boolean {
  const result = compressOutput(text, level);
  return decompressOutput(result.compressed) === text;
}

interface CompressionAdapter {
  compress(input: CompressionInput): CompressionAdapterResult;
  decompress(compressedBase64: string): string;
  roundTrip(text: string, level?: 'light' | 'medium' | 'aggressive'): boolean;
}

class CompressionAdapterImpl implements CompressionAdapter {
  compress(input: CompressionInput): CompressionAdapterResult {
    return compressAdapter(input);
  }
  decompress(compressedBase64: string): string {
    return decompressAdapter(compressedBase64);
  }
  roundTrip(text: string, level?: 'light' | 'medium' | 'aggressive'): boolean {
    return roundTripAdapter(text, level);
  }
}

export const compressionAdapter = new CompressionAdapterImpl();
