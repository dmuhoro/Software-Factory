/**
 * Doctrine manifest.
 *
 * The doctrine is the rulebook the unattended loop runs under. A rulebook that can be edited
 * by the thing it is judging — or edited silently halfway through a run — is not a rulebook.
 * This pins every doctrine file's sha256 into `doctrine/manifest.json`.
 *
 *   npx tsx scripts/doctrine-manifest.ts           # regenerate
 *   npx tsx scripts/doctrine-manifest.ts --check   # verify (exit 1 on any drift)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCTRINE = path.join(ROOT, 'doctrine');
const MANIFEST = path.join(DOCTRINE, 'manifest.json');
const COVERED = [
  'README.md',
  'DOCTRINE.md',
  'loop.json',
  'agents/models.json',
  'rules/rules.json',
  'hooks/hooks.json',
].sort();

function sha256(file: string): string {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function build(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of COVERED) {
    const full = path.join(DOCTRINE, rel);
    if (!fs.existsSync(full)) throw new Error(`doctrine file missing: ${rel}`);
    files[rel] = sha256(full);
  }
  return files;
}

function main(): void {
  const check = process.argv.includes('--check');
  const files = build();

  // An unhashed file is a rule nobody checked: fail on anything on disk that is not covered.
  const onDisk = walk(DOCTRINE).filter((rel) => rel !== 'manifest.json');
  const uncovered = onDisk.filter((rel) => !(rel in files));
  if (uncovered.length) {
    console.error(`doctrine: unhashed files: ${uncovered.join(', ')}`);
    process.exit(1);
  }

  if (check) {
    if (!fs.existsSync(MANIFEST)) {
      console.error('doctrine: doctrine/manifest.json is missing');
      process.exit(1);
    }
    const recorded = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { files?: Record<string, string> };
    const drift: string[] = [];
    for (const [rel, expected] of Object.entries(files)) {
      const actual = recorded.files?.[rel];
      if (actual !== expected) drift.push(`${rel} (recorded ${actual ?? 'absent'}, actual ${expected})`);
    }
    for (const rel of Object.keys(recorded.files ?? {})) {
      if (!(rel in files)) drift.push(`${rel} (recorded, no longer present)`);
    }
    if (drift.length) {
      console.error('doctrine: manifest drift detected:');
      for (const line of drift) console.error(`  - ${line}`);
      console.error('run `npm run doctrine:manifest` to re-pin, then re-review the change');
      process.exit(1);
    }
    console.log(`doctrine: manifest verified (${Object.keys(files).length} files)`);
    return;
  }

  fs.writeFileSync(MANIFEST, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, 'utf8');
  console.log(`doctrine: pinned ${Object.keys(files).length} files into doctrine/manifest.json`);
}

main();
