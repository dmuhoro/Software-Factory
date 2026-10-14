/**
 * The public evidence page (Sprint 30, WP-5).
 *
 * The page must state what is live, planned, or blocked, and every live item must name the command
 * that demonstrates it. The failure mode this guards is drift: the page claiming a capability — or a
 * status — the manifest does not declare, or the manifest gaining a capability the page never
 * mentions. The page's capability section is generated from `CAPABILITIES`, and these cases assert
 * the committed page still equals what the manifest renders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const PAGE = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');

const { CAPABILITIES, buildCapabilityManifest } = await import('../src/services/capabilityManifest');
const { renderCapabilitySection, CAPABILITIES_START, CAPABILITIES_END } = await import('../scripts/render-evidence');

function markedSection(html: string): string {
  const start = html.indexOf(CAPABILITIES_START);
  const end = html.indexOf(CAPABILITIES_END);
  assert.ok(start >= 0 && end > start, 'the page must carry the capabilities markers');
  return html.slice(start, end + CAPABILITIES_END.length);
}

test('the page declares exactly the manifest, and nothing it does not declare', () => {
  assert.equal(markedSection(PAGE), renderCapabilitySection(CAPABILITIES), 'the page is stale; run: npm run render:evidence');

  const block = /<script type="application\/json" id="capability-manifest">\s*([\s\S]*?)\s*<\/script>/.exec(PAGE);
  assert.ok(block, 'the page must embed the manifest as JSON');
  assert.deepEqual(JSON.parse(block[1]), buildCapabilityManifest(), 'the page\'s machine-readable claim must equal the served manifest');
});

test('every live capability names its proving command, and every blocked one names its owner', () => {
  const section = markedSection(PAGE);
  for (const entry of CAPABILITIES) {
    assert.ok(section.includes(entry.title), `the page must name the capability '${entry.id}'`);
    if (entry.status === 'blocked') {
      assert.ok(entry.owner && section.includes(entry.owner), `blocked '${entry.id}' must name its owner`);
    } else {
      assert.ok(entry.proves && section.includes(entry.proves), `'${entry.id}' must name the command that proves it`);
    }
  }
});

test('the page carries no stale figure that is not tied to a command', () => {
  // These were hardcoded counts and a version that drifted release over release. A figure on this
  // page must be reproducible by a named command, not frozen at whatever was true when it was typed.
  assert.ok(!/219\s*\/\s*219/.test(PAGE), 'a stale test count must not reappear');
  assert.ok(!/release v4\.11\.0/.test(PAGE), 'a stale version must not reappear');
});
