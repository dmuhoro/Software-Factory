import fs from 'node:fs';
import path from 'node:path';

interface Manifest {
  name?: string;
  version?: string;
}

/**
 * The identity of the artifact that is actually running.
 *
 * A process must report the version of the code it was built from, not a value
 * typed into a banner, a comment, or a build script. Those drift silently: the
 * deploy serves yesterday's bundle while every human-readable label insists it is
 * today's. That is exactly the failure this module exists to prevent -- an
 * operator staring at a live URL with no way to tell whether the latest build is
 * actually there.
 *
 * So the version is read from `package.json` on disk at runtime, and the package
 * `name` is checked before the manifest is trusted. A stray `package.json` on the
 * search path (a parent workspace, a nested tool) is never mistaken for this
 * project's.
 *
 * Candidates are resolved relative to the working directory and the entrypoint so
 * the answer is correct in every context this server runs in: `tsx server.ts`
 * from the repo root, `node dist/server.cjs` started by a supervisor, and the
 * container WORKDIR. If nothing resolves, the version is the literal string
 * `unknown` -- fail honest, never guess a plausible-looking version.
 */
function readManifest(): Manifest {
  const candidates: string[] = [
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(process.cwd(), '..', 'package.json'),
  ];
  if (process.argv[1]) {
    const entryDir = path.dirname(path.resolve(process.argv[1]));
    candidates.push(path.resolve(entryDir, '..', 'package.json'), path.resolve(entryDir, 'package.json'));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Manifest;
      if (parsed.name === 'software-factory') return parsed;
    } catch {
      // Try the next candidate. A missing or malformed manifest is not fatal here;
      // an unresolved version is reported as `unknown` rather than crashing a
      // health probe that must always answer.
    }
  }
  return {};
}

const manifest = readManifest();

/** The deployed package name. */
export const APP_NAME = manifest.name ?? 'software-factory';
/** The deployed package version, or `unknown` when no manifest could be read. */
export const APP_VERSION = typeof manifest.version === 'string' && manifest.version ? manifest.version : 'unknown';
