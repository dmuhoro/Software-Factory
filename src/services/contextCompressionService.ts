/**
 * Context compression (Layer 7 Interface).
 *
 * The headroom steal, adapted to SF constraints: the payloads that go to a model are reduced
 * before they leave, so a model receives the evidence and the instructions without the noise
 * around them.
 *
 * What is compressed, and what is deliberately not:
 *
 *  - **Log and tool output** (a refusal, a command's output, a diff) is reduced: blank lines and
 *    trailing whitespace go, and the evidence markers — file:line, exit codes, error codes,
 *    timestamps — are protected and restored byte for byte.
 *  - **Source code** is never compressed. The implementer must reproduce a file exactly; a
 *    compressed file is a file the model will invent the rest of.
 *
 * The saving is measured and reported, because a compression that cannot say what it saved is a
 * claim. `CompressionCollector` accumulates the segments a run compressed, and the run record
 * carries the totals.
 */

import { reduceText, type CompressionLevel } from '../utils/outputCompression';

export interface ContextCompression {
  /** The reduced text. */
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

export interface CompressionCollector {
  /** How many segments were compressed. */
  segments: number;
  /** The bytes before reduction. */
  originalBytes: number;
  /** The bytes after reduction. */
  compressedBytes: number;
  /** How many evidence markers were protected. */
  evidencePreserved: number;
}

/** A fresh collector for one run. */
export function createCollector(): CompressionCollector {
  return { segments: 0, originalBytes: 0, compressedBytes: 0, evidencePreserved: 0 };
}

/**
 * Reduce one segment and record what it cost and what it saved.
 *
 * An empty segment is not compressed and not counted: there is nothing to save, and counting it
 * would make the ratio a smaller number than the truth.
 */
function compressSegment(
  text: string,
  level: CompressionLevel = 'medium',
  collector?: CompressionCollector,
): ContextCompression {
  if (!text) {
    return { text, originalBytes: 0, compressedBytes: 0, ratio: 0, evidencePreserved: 0, level };
  }
  const reduced = reduceText(text, level);
  if (collector) {
    collector.segments += 1;
    collector.originalBytes += reduced.originalBytes;
    collector.compressedBytes += reduced.compressedBytes;
    collector.evidencePreserved += reduced.evidencePreserved;
  }
  return reduced;
}

/**
 * Reduce a log or refusal tail. `medium` is the level for a model payload: it removes blank
 * lines and trailing whitespace and keeps every word of the prose.
 */
export function compressLog(text: string, collector?: CompressionCollector): ContextCompression {
  return compressSegment(text, 'medium', collector);
}

/**
 * Reduce a diff. A diff is mostly blank lines and indentation noise, and every line of it is
 * evidence, so the reduction is conservative and the markers are protected.
 */
export function compressDiff(text: string, collector?: CompressionCollector): ContextCompression {
  return compressSegment(text, 'medium', collector);
}

/** The totals of a collector, ready to be written into a run record. */
export function collectorTotals(collector: CompressionCollector): {
  segments: number;
  originalBytes: number;
  compressedBytes: number;
  ratio: number;
  evidencePreserved: number;
} {
  return {
    segments: collector.segments,
    originalBytes: collector.originalBytes,
    compressedBytes: collector.compressedBytes,
    ratio: collector.originalBytes > 0 ? Math.round((1 - collector.compressedBytes / collector.originalBytes) * 1000) / 1000 : 0,
    evidencePreserved: collector.evidencePreserved,
  };
}

interface ContextCompressionService {
  compressLog(text: string, collector?: CompressionCollector): ContextCompression;
  compressDiff(text: string, collector?: CompressionCollector): ContextCompression;
}

class ContextCompressionServiceImpl implements ContextCompressionService {
  compressLog(text: string, collector?: CompressionCollector): ContextCompression {
    return compressLog(text, collector);
  }
  compressDiff(text: string, collector?: CompressionCollector): ContextCompression {
    return compressDiff(text, collector);
  }
}

