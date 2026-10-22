/**
 * Parallel read-only inspection (Layer 2/3).
 *
 * The orca steal, adapted to SF constraints: work that only *reads* is done
 * concurrently, and the writing stays with one writer.
 *
 * Two properties are load-bearing:
 *
 *  - **Read-only by construction.** The API takes descriptions of reads —
 *    paths and operation names — never callbacks. A write is therefore not
 *    expressible through this service, so it cannot become a second writer of
 *    a target tree (NC-2) and it cannot race the loop's commits.
 *  - **Order-preserving and failure-isolating.** Results come back in the
 *    order they were asked for, and one unreadable file does not lose the
 *    results of the others. A caller gets the whole picture with the holes
 *    marked, instead of an exception that hides the rest.
 *
 * Bounded: the concurrency is clamped to a hard ceiling, so a caller cannot
 * open a thousand file descriptors by asking nicely.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildKnowledgeGraph, type KnowledgeGraph } from './astKnowledgeGraph';

/** The hard ceiling on concurrent reads. Doctrine's `maxParallelCeiling` is 8. */
export const MAX_READ_CONCURRENCY = 8;
/** The default number of concurrent reads (doctrine's `maxParallelDefault`). */
export const DEFAULT_READ_CONCURRENCY = 4;

export interface ParallelReadOptions {
  /** How many reads may be in flight at once. Clamped to [1, MAX_READ_CONCURRENCY]. */
  concurrency?: number;
}

export interface FileRead {
  /** The path that was asked for, as given. */
  path: string;
  /** The content, when the read succeeded. */
  content?: string;
  /** The exact bytes that were read, base64 encoded. A hash of the file must be taken from
   *  these bytes and not from the decoded text, or a file that is not valid UTF-8 would hash
   *  differently here than it does everywhere else. */
  base64?: string;
  /** The size of the file on disk, before any truncation. */
  originalBytes: number;
  /** How many bytes were read. */
  bytes: number;
  /** True when the file was larger than the byte ceiling and was cut. */
  truncated: boolean;
  /** True when the file does not exist. */
  missing: boolean;
  /** Why the read failed, when it failed. */
  error?: string;
}

export interface PathStat {
  path: string;
  exists: boolean;
  size: number;
  isDirectory: boolean;
  error?: string;
}

export interface ParsedSource {
  path: string;
  graph?: KnowledgeGraph;
  error?: string;
}

/** Clamp a requested concurrency into the range this service is willing to run. */
export function resolveConcurrency(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_READ_CONCURRENCY;
  const value = Math.floor(requested);
  if (value < 1) return 1;
  if (value > MAX_READ_CONCURRENCY) return MAX_READ_CONCURRENCY;
  return value;
}

/**
 * Run an operation over every item, with bounded concurrency, preserving the
 * input order and isolating failures.
 *
 * The worker is expected to be read-only. This function cannot prove that; the
 * read-only service below is where the guarantee is structural.
 */
export async function mapReadOnly<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: ParallelReadOptions = {},
): Promise<Array<{ ok: boolean; value?: R; error?: string }>> {
  const concurrency = resolveConcurrency(options.concurrency);
  const results: Array<{ ok: boolean; value?: R; error?: string }> = new Array(items.length);
  let cursor = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  };

  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => runner());
  await Promise.all(runners);
  return results;
}

/** Resolve a repository-relative path, refusing anything that escapes the repository. */
function resolveInside(repo: string, relative: string): string | undefined {
  const root = path.resolve(repo);
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return resolved;
}

/**
 * Read files concurrently. Each result carries what was read and what went
 * wrong; a missing file is reported as missing, not as an exception.
 */
export async function readFiles(
  repo: string,
  paths: readonly string[],
  options: ParallelReadOptions & { maxBytes?: number } = {},
): Promise<FileRead[]> {
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const settled = await mapReadOnly(paths, async (relative): Promise<FileRead> => {
    const absolute = resolveInside(repo, relative);
    if (!absolute) {
      return { path: relative, originalBytes: 0, bytes: 0, truncated: false, missing: false, error: 'PATH_ESCAPES_REPOSITORY' };
    }
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(absolute);
    } catch {
      return { path: relative, originalBytes: 0, bytes: 0, truncated: false, missing: true };
    }
    if (!stat.isFile()) {
      return { path: relative, originalBytes: 0, bytes: 0, truncated: false, missing: false, error: 'NOT_A_FILE' };
    }
    const truncated = stat.size > maxBytes;
    try {
      const buffer = await fsp.readFile(absolute);
      const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
      return {
        path: relative,
        content: slice.toString('utf8'),
        base64: slice.toString('base64'),
        originalBytes: stat.size,
        bytes: slice.byteLength,
        truncated,
        missing: false,
      };
    } catch (error) {
      return { path: relative, originalBytes: 0, bytes: 0, truncated: false, missing: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, options);

  return settled.map((result, index) =>
    result.ok && result.value
      ? result.value
      : { path: paths[index], originalBytes: 0, bytes: 0, truncated: false, missing: false, error: result.error ?? 'READ_FAILED' },
  );
}

/** Stat paths concurrently. */
export async function statPaths(repo: string, paths: readonly string[], options: ParallelReadOptions = {}): Promise<PathStat[]> {
  const settled = await mapReadOnly(paths, async (relative): Promise<PathStat> => {
    const absolute = resolveInside(repo, relative);
    if (!absolute) return { path: relative, exists: false, size: 0, isDirectory: false, error: 'PATH_ESCAPES_REPOSITORY' };
    try {
      const stat = await fsp.stat(absolute);
      return { path: relative, exists: true, size: stat.size, isDirectory: stat.isDirectory() };
    } catch {
      return { path: relative, exists: false, size: 0, isDirectory: false };
    }
  }, options);

  return settled.map((result, index) =>
    result.ok && result.value ? result.value : { path: paths[index], exists: false, size: 0, isDirectory: false, error: result.error ?? 'STAT_FAILED' },
  );
}

/**
 * Parse source files into AST knowledge graphs concurrently.
 *
 * Parsing is CPU-bound, so the win here is that the reads and the parses
 * overlap rather than queueing behind one another; the ordering guarantee is
 * what makes the result reproducible.
 */
export async function parseSourceFiles(
  repo: string,
  paths: readonly string[],
  options: ParallelReadOptions = {},
): Promise<ParsedSource[]> {
  const reads = await readFiles(repo, paths, options);
  return Promise.all(
    reads.map(async (read): Promise<ParsedSource> => {
      if (read.error) return { path: read.path, error: read.error };
      if (read.missing) return { path: read.path, error: 'FILE_NOT_FOUND' };
      if (read.content === undefined) return { path: read.path, error: 'FILE_UNREADABLE' };
      try {
        return { path: read.path, graph: buildKnowledgeGraph(read.path, read.content) };
      } catch (error) {
        return { path: read.path, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

export interface ParallelReadService {
  readFiles(repo: string, paths: readonly string[], options?: ParallelReadOptions & { maxBytes?: number }): Promise<FileRead[]>;
  statPaths(repo: string, paths: readonly string[], options?: ParallelReadOptions): Promise<PathStat[]>;
  parseSourceFiles(repo: string, paths: readonly string[], options?: ParallelReadOptions): Promise<ParsedSource[]>;
}

export class ParallelReadServiceImpl implements ParallelReadService {
  readFiles(repo: string, paths: readonly string[], options: ParallelReadOptions & { maxBytes?: number } = {}): Promise<FileRead[]> {
    return readFiles(repo, paths, options);
  }
  statPaths(repo: string, paths: readonly string[], options: ParallelReadOptions = {}): Promise<PathStat[]> {
    return statPaths(repo, paths, options);
  }
  parseSourceFiles(repo: string, paths: readonly string[], options: ParallelReadOptions = {}): Promise<ParsedSource[]> {
    return parseSourceFiles(repo, paths, options);
  }
}

export const parallelReadService = new ParallelReadServiceImpl();
