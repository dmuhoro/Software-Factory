#!/usr/bin/env node
/**
 * Generate the delivery dashboard from Git, the release gate, and the manifest set.
 *
 * The requirement was a single place showing the work across ~9 months, and the trap is
 * obvious: a hand-maintained status document is wrong within two weeks, and nobody notices
 * because it still looks authoritative. So this file is generated and nothing in it is typed
 * by hand. Every number below is read from `git log`, the version sites, the verification
 * scripts, or the repository's own governance tables.
 *
 * Where a number cannot be obtained without credentials -- live model latency, production
 * request volume, deployed image digests -- it is reported as unavailable with the reason.
 * An honest blank is worth more than a plausible number, and a dashboard that guesses is
 * worse than no dashboard, because a CEO cannot tell a guess from a measurement.
 *
 * Usage: node scripts/generate-dashboard.mjs [--write] [--json]
 *   --write  rewrite docs/DELIVERY_DASHBOARD.md
 *   --json   emit the machine-readable record the MCP server serves
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const asJson = process.argv.includes('--json');

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
};

/** Run a verification script and return its verdict without failing the dashboard. */
function tryRun(script, args = []) {
  try {
    const out = execFileSync('bash', [path.join(REPO_ROOT, 'scripts', script), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const unavailable = (reason, owner) => ({ status: 'unavailable', reason, owner });

/** Gate scripts colour their output. A committed dashboard must not contain escape codes. */
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '').trim();

async function main() {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const cargoToml = await readFile(path.join(REPO_ROOT, 'software_factory', 'Cargo.toml'), 'utf8');
  const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? 'unknown';

  // ── Delivery history, from Git only ──────────────────────────────────────────────────
  const firstCommit = git('log', '--reverse', '--format=%ad', '--date=short').split('\n')[0] || 'unknown';
  const lastCommit = git('log', '-1', '--format=%ad', '--date=short') || 'unknown';
  const totalCommits = Number(git('rev-list', '--count', 'HEAD')) || 0;
  const authors = git('shortlog', '-sne', '--all', 'HEAD').split('\n').filter(Boolean);

  const months = {};
  for (const line of git('log', '--format=%ad', '--date=format:%Y-%m').split('\n').filter(Boolean)) {
    months[line] = (months[line] ?? 0) + 1;
  }

  const subjects = git('log', '--format=%s', '--since=2000-01-01').split('\n').filter(Boolean);
  const conventional = subjects.filter((s) => /^(feat|fix|docs|test|refactor|chore|perf|build|ci)(\(.+\))?!?:/.test(s));
  // Commit subjects here use `NC-n:` prefixes, not the word "wave". Counting /wave/i returned
  // zero against a repository that had resolved four non-conformances, which is the kind of
  // metric that looks plausible on a dashboard and measures nothing. Count the prefixes that
  // are actually used.
  const ncCommits = subjects.filter((s) => /^NC-\d+[a-z]?:/i.test(s));

  // Non-conformances, read from the constitution rather than restated.
  const constitution = await readFile(path.join(REPO_ROOT, 'docs', 'CONSTITUTION.md'), 'utf8');
  const openSection = constitution.split('### Resolved')[0];
  const resolvedSection = constitution.split('### Resolved')[1] ?? '';
  const openNCs = [...openSection.matchAll(/^\|\s*(NC-\d+)\s*\|([^|]*)\|([^|]*)\|/gm)]
    .map((m) => ({ id: m[1].trim(), article: m[2].trim(), text: m[3].trim() }))
    .filter((nc) => !nc.id.startsWith('NC-x'));
  const resolvedNCs = [...resolvedSection.matchAll(/^\|\s*(NC-\d+)\s*\|\s*([^|]*)\|/gm)].map((m) => ({
    id: m[1].trim(),
    resolvedIn: m[2].trim(),
  }));

  const adrs = (await readdirSafe(path.join(REPO_ROOT, 'docs', 'adr')))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
  const sprints = (await readdirSafe(path.join(REPO_ROOT, 'sprints'))).filter((f) => f.endsWith('.md')).sort();

  // ── Verification state, actually run ─────────────────────────────────────────────────
  // Every gate that can run without credentials runs here. The list used to omit the
  // Kubernetes manifest gate, and when the NC-5 egress wildcard was reintroduced as a control
  // the dashboard still printed a clean verification table -- a status document that cannot
  // report a regression is a status document nobody should read. A gate absent from this list
  // is a gate that does not exist as far as the dashboard is concerned, so the list is
  // asserted against the scripts on disk rather than trusted.
  const gates = [
    { name: 'TypeScript typecheck', cmd: ['npm', 'run', 'lint'] },
    { name: 'TypeScript tests', cmd: ['npm', 'test'] },
    { name: 'Layer 1 harness (filesystem, egress, durability)', cmd: ['bash', 'scripts/verify-layer1.sh'] },
    { name: 'Layer 2 harness (tenant isolation)', cmd: ['bash', 'scripts/verify-layer2.sh'] },
    { name: 'Layer 3 harness (error contract, writer lock)', cmd: ['bash', 'scripts/verify-layer3.sh'] },
    { name: 'Layer 4 harness (durable tenancy)', cmd: ['bash', 'scripts/verify-layer4.sh'] },
    { name: 'Image gate (both images built)', cmd: ['bash', 'scripts/verify-image.sh', 'all'] },
    { name: 'Kubernetes manifests', cmd: ['python3', 'software_factory/scripts/verify-k8s.py'] },
    { name: 'Rust tests', cmd: ['bash', 'scripts/verify-rust.sh'] },
    { name: 'Knowledge base MCP self-test', cmd: ['node', 'scripts/kb-mcp-server.mjs', '--self-test'] },
    {
      name: 'Release record gate (pre-release mode)',
      cmd: ['bash', 'scripts/verify-release.sh', '--pre-release'],
      note: 'Run in pre-release mode: full mode also requires the v4.8.0 tag, which does not exist until release.',
    },
  ];

  // If a verification script exists but is not represented above, say so instead of printing a
  // table that implies full coverage.
  const scriptsOnDisk = (await readdirSafe(path.join(REPO_ROOT, 'scripts')))
    .filter((f) => /^verify.*\.(sh|mjs|py)$/.test(f))
    .map((f) => f.replace(/\.(sh|mjs|py)$/, ''))
    .filter((name) => !gates.some((g) => g.cmd.join(' ').includes(name)));

  const gateResults = [];
  for (const gate of gates) {
    const started = Date.now();
    let result;
    try {
      const out = execFileSync(gate.cmd[0], gate.cmd.slice(1), { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      result = { ok: true, tail: stripAnsi(out).split('\n').filter(Boolean).slice(-1)[0] ?? '' };
    } catch (error) {
      result = { ok: false, tail: stripAnsi(`${error.stdout ?? ''}${error.stderr ?? ''}`).split('\n').filter(Boolean).slice(-3).join(' ') };
    }
    gateResults.push({ name: gate.name, ok: result.ok, detail: result.tail, seconds: Math.round((Date.now() - started) / 1000) });
  }

  // ── What genuinely cannot be known from here ─────────────────────────────────────────
  const external = [
    {
      subject: 'Live Gemini and Appwrite behaviour',
      reason: 'Needs real credentials, which are not present in this environment.',
      owner: 'release operator with Appwrite + Gemini keys',
    },
    {
      subject: 'Production volume, error rate and latency',
      reason: 'Comes from the /metrics endpoint of a deployed pod; no cluster is reachable here.',
      owner: 'platform operator, via Prometheus scraping the deployed service',
    },
    {
      subject: 'The deployed image digest',
      reason: 'Cannot be read from a registry without push credentials.',
      owner: 'release operator, after the tag is pushed',
    },
    {
      subject: 'CodeRabbit, SonarQube, Snyk and Datadog findings',
      reason: 'Each reports through its own API and none is connected to this repository.',
      owner: 'repository admin, by adding the corresponding CI secrets',
    },
  ];

  const record = {
    generatedAt: new Date().toISOString(),
    generatedFrom: 'git log, package.json, software_factory/Cargo.toml, docs/CONSTITUTION.md, and live execution of the verification scripts',
    version: { typescript: pkg.version, rust: cargoVersion, agree: pkg.version === cargoVersion },
    delivery: {
      firstCommit,
      lastCommit,
      totalCommits,
      authorCount: authors.length,
      commitsByMonth: months,
      conventionalCommitSubjects: conventional.length,
      totalSubjects: subjects.length,
      nonConformanceResolutions: ncCommits.length,
    },
    governance: {
      openNonConformances: openNCs,
      resolvedNonConformances: resolvedNCs,
      adrs,
      sprintCount: sprints.length,
      sprints,
    },
    verification: gateResults,
    unrepresentedGates: scriptsOnDisk,
    notMeasuredHere: external,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push('# Delivery Dashboard');
  lines.push('');
  lines.push('> Generated by `scripts/generate-dashboard.mjs`. Every figure below is read from Git, the');
  lines.push('> version files, the governance tables, or a verification script executed at generation');
  lines.push('> time. Nothing here is typed by hand, so this file cannot drift from the repository.');
  lines.push('');
  lines.push(`Generated at: **${record.generatedAt}**`);
  lines.push('');
  lines.push('## Release');
  lines.push('');
  lines.push('| Component | Version |');
  lines.push('|---|---|');
  lines.push(`| TypeScript service | ${pkg.version} |`);
  lines.push(`| Rust runtime | ${cargoVersion} |`);
  lines.push(`| Versions agree | ${record.version.agree ? 'yes' : '**NO — release gate will fail**'} |`);
  lines.push('');
  lines.push('## Delivery history');
  lines.push('');
  const monthCount = Object.keys(months).length;
  lines.push(`- **${totalCommits} commits** from ${firstCommit} to ${lastCommit} across ${monthCount} ${monthCount === 1 ? 'month' : 'months'}`);
  lines.push(`- ${authors.length} ${authors.length === 1 ? 'author' : 'authors'}`);
  lines.push(`- ${record.delivery.conventionalCommitSubjects} of ${record.delivery.totalSubjects} commit subjects follow Conventional Commits`);
  lines.push(`- ${record.delivery.nonConformanceResolutions} commit subjects close a recorded non-conformance`);
  lines.push('');
  lines.push('| Month | Commits |');
  lines.push('|---|---:|');
  for (const [month, count] of Object.entries(months).sort()) lines.push(`| ${month} | ${count} |`);
  lines.push('');
  lines.push('## Governance');
  lines.push('');
  lines.push(`**${resolvedNCs.length} resolved, ${openNCs.length} open.**`);
  lines.push('');
  lines.push('| ID | Status | Subject |');
  lines.push('|---|---|---|');
  for (const nc of resolvedNCs) lines.push(`| ${nc.id} | resolved in ${nc.resolvedIn} | see docs/CONSTITUTION.md |`);
  for (const nc of openNCs) lines.push(`| ${nc.id} | **open** | ${nc.text.replace(/\|/g, '\\|')} |`);
  lines.push('');
  lines.push(`${adrs.length} architecture decision records in force:`);
  for (const adr of adrs) lines.push(`- \`${adr}\``);
  lines.push('');
  lines.push('## Verification, run now');
  lines.push('');
  lines.push('| Gate | Result | Detail |');
  lines.push('|---|---|---|');
  for (const gate of gateResults) {
    const label = gate.note ? `${gate.name}<br><sub>${gate.note}</sub>` : gate.name;
    lines.push(`| ${label} | ${gate.ok ? 'pass' : '**FAIL**'} | ${gate.detail.replace(/\|/g, '\\|').slice(0, 110)} (${gate.seconds}s) |`);
  }
  lines.push('');
  if (scriptsOnDisk.length) {
    lines.push(`**Not represented in this table:** ${scriptsOnDisk.join(', ')}. A verification script that this dashboard does not run is a script that cannot report a regression here.`);
    lines.push('');
  } else {
    lines.push('Every verification script in `scripts/` is represented in this table.');
    lines.push('');
  }
  lines.push('## Not measured here');
  lines.push('');
  lines.push('These are absent because measuring them needs access this environment does not have.');
  lines.push('A blank here is deliberate. No figure in this file is estimated or inferred.');
  lines.push('');
  lines.push('| What | Why unavailable | Owner |');
  lines.push('|---|---|---|');
  for (const item of external) lines.push(`| ${item.subject} | ${item.reason} | ${item.owner} |`);
  lines.push('');

  const output = lines.join('\n');
  if (write) {
    await writeFile(path.join(REPO_ROOT, 'docs', 'DELIVERY_DASHBOARD.md'), `${output}\n`);
    process.stderr.write('wrote docs/DELIVERY_DASHBOARD.md\n');
  } else {
    process.stdout.write(output);
  }
}

async function readdirSafe(dir) {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(dir);
  } catch {
    return [];
  }
}

await main();
