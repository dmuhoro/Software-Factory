/**
 * The README must not claim a capability or a figure the code does not (Sprint 31, WP-2).
 *
 * The audit that scoped Sprint 31 found the README carrying typed claims that had drifted: a test
 * count, a model locality, and a throughput extrapolated from four units. This test makes the two
 * structural claims machine-checkable — the capability list is generated from the manifest, and the
 * duplicate section is gone — and proves the generator actually tracks the manifest (so the gate
 * cannot pass by rendering a constant).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, type CapabilityEntry } from '../src/services/capabilityManifest';
import {
  renderReadmeCapabilitySection,
  README_CAPS_START,
  README_CAPS_END,
} from '../scripts/render-readme';

const README = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

test('the README capability block equals the section rendered from the manifest', () => {
  const start = README.indexOf(README_CAPS_START);
  const end = README.indexOf(README_CAPS_END);
  assert.ok(start >= 0 && end > start, 'README.md is missing the readme-capabilities markers');
  const committed = README.slice(start, end + README_CAPS_END.length);
  assert.equal(
    committed,
    renderReadmeCapabilitySection(CAPABILITIES),
    'README.md capability block drifted from src/services/capabilityManifest.ts (run: npm run render:readme)',
  );
});

test('the README has exactly one "Remote control plane" section', () => {
  const headings = README.match(/^## Remote control plane\s*$/gm) ?? [];
  assert.equal(headings.length, 1, 'the duplicate "Remote control plane" heading is back');
});

test('the README states no throughput extrapolation that no command reproduces', () => {
  assert.equal(
    /units\/hour/.test(README),
    false,
    'README.md carries an extrapolated throughput figure; state only measured numbers',
  );
});

test('the capability block changes when the manifest changes (the gate cannot pass on a constant)', () => {
  const withExtra: CapabilityEntry[] = [
    ...CAPABILITIES,
    { id: 'wp2-probe', title: 'WP-2 probe', status: 'blocked', summary: 'probe', owner: 'operator' },
  ];
  assert.notEqual(
    renderReadmeCapabilitySection(withExtra),
    renderReadmeCapabilitySection(CAPABILITIES),
    'the renderer ignored a manifest change, so the --check gate would never fail',
  );
});
