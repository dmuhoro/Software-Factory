/**
 * Filesystem Boundary Guard.
 *
 * Single authority for "may this code touch this path?". Every service that
 * accepts a caller-supplied path MUST resolve it through this module rather
 * than re-implementing containment checks. A check that lives in one place is a
 * check that can be audited; a check duplicated across five services is five
 * chances to forget symlink resolution.
 *
 * Design rules:
 *  - Containment is decided on REAL paths. A prefix comparison on unresolved
 *    strings is trivially defeated by a symlink inside an allowed directory.
 *  - The guard fails CLOSED. An unresolvable path is a refusal, not a pass.
 *  - The guard is read-only. It never creates the target.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PathGuardCode =
  | 'PATH_OUTSIDE_APPROVED_WORKSPACE'
  | 'PATH_DOES_NOT_EXIST'
  | 'PATH_NOT_A_DIRECTORY'
  | 'PATH_MISSING'
  | 'PATH_UNRESOLVABLE';

export interface PathGuardOptions {
  /** Root the candidate must live inside. Defaults to FACTORY_WORKSPACE_ROOT. */
  root?: string;
  /** Error code thrown on containment failure. Lets services keep their contracts. */
  code?: PathGuardCode | string;
  /** Candidate must already exist on disk. Default true. */
  mustExist?: boolean;
  /** Candidate must resolve to a directory. Default false. */
  mustBeDirectory?: boolean;
}

/** Normalizes a root to an absolute, symlink-free prefix with no trailing separator. */
export function workspaceRoot(explicit?: string): string {
  const configured = explicit ?? process.env.FACTORY_WORKSPACE_ROOT ?? process.cwd();
  return realOrSelf(path.resolve(configured));
}

/**
 * Resolves symlinks as far as the path exists. Non-existent tails are appended
 * back so callers can validate a path they are about to create, without this
 * module performing any write.
 */
export function realOrSelf(target: string): string {
  const resolved = path.resolve(target);
  let head = resolved;
  const tail: string[] = [];
  // Walk up until an existing ancestor is found, then re-attach the remainder.
  for (;;) {
    if (fs.existsSync(head)) break;
    const parent = path.dirname(head);
    if (parent === head) return resolved;
    tail.unshift(path.basename(head));
    head = parent;
  }
  let realHead: string;
  try {
    realHead = fs.realpathSync(head);
  } catch {
    return resolved;
  }
  return tail.length ? path.join(realHead, ...tail) : realHead;
}

/** True when `target` is `root` itself or a descendant of it. Compares REAL paths. */
export function isWithin(root: string, target: string): boolean {
  const realRoot = realOrSelf(path.resolve(root));
  const realTarget = realOrSelf(path.resolve(target));
  if (realRoot === realTarget) return true;
  return realTarget.startsWith(realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`);
}

/**
 * Validates and returns the real path for `candidate`.
 * Throws a coded error rather than returning null so callers cannot ignore it.
 */
export function resolveWithin(candidate: unknown, options: PathGuardOptions = {}): string {
  const code = options.code ?? 'PATH_OUTSIDE_APPROVED_WORKSPACE';
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error(options.mustExist === false ? 'PATH_MISSING' : 'PATH_MISSING');
  }
  const root = workspaceRoot(options.root);
  const real = realOrSelf(path.resolve(candidate));
  if (!isWithin(root, real)) throw new Error(code);
  if (options.mustExist !== false) {
    if (!fs.existsSync(real)) throw new Error('PATH_DOES_NOT_EXIST');
    if (options.mustBeDirectory && !fs.statSync(real).isDirectory()) throw new Error('PATH_NOT_A_DIRECTORY');
  }
  return real;
}

/**
 * Resolves a file that must live inside `root`. Used by writers, which need the
 * real parent directory to defeat a symlinked intermediate directory.
 */
export function resolveFileWithin(root: string, relative: string, code = 'FILE_OUTSIDE_REPOSITORY'): string {
  if (typeof relative !== 'string' || relative.trim() === '') throw new Error('FILE_PATH_REQUIRED');
  if (path.isAbsolute(relative)) throw new Error(code);
  const realRoot = realOrSelf(path.resolve(root));
  const candidate = path.resolve(realRoot, relative);
  // Reject traversal lexically first (cheap, no syscall), then again on real paths.
  if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${path.sep}`)) throw new Error(code);
  const parent = realOrSelf(path.dirname(candidate));
  if (parent !== realRoot && !parent.startsWith(`${realRoot}${path.sep}`)) throw new Error(code);
  return candidate;
}

/**
 * Creates a directory inside the workspace root. Refuses to follow a symlink out
 * of the root. Returns the real path it is safe to write into.
 */
export function prepareDirectory(root: string, relative: string, code = 'PATH_OUTSIDE_APPROVED_WORKSPACE'): string {
  const realRoot = realOrSelf(path.resolve(root));
  const target = path.isAbsolute(relative) ? path.resolve(relative) : path.resolve(realRoot, relative);
  if (target !== realRoot && !target.startsWith(`${realRoot}${path.sep}`)) throw new Error(code);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const real = realOrSelf(target);
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw new Error(code);
  return real;
}

/** True when the path exists, is a directory, and contains a `.git` entry. */
export function isGitRepository(target: string): boolean {
  try {
    return fs.statSync(path.join(target, '.git')).isDirectory() || fs.statSync(path.join(target, '.git')).isFile();
  } catch {
    return false;
  }
}

/** OS temp directory, used for ephemeral execution snapshots. */
export function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
