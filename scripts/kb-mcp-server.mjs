#!/usr/bin/env node
/**
 * Knowledge base MCP server.
 *
 * Why this exists, and why it is a server rather than a client.
 *
 * CodeRabbit's MCP integration makes CodeRabbit the *client*: it queries MCP servers to pull
 * context into a review (docs.coderabbit.ai/knowledge-base/mcp-context, "CodeRabbit acts as
 * the MCP client -- it ingests data from your connected MCP servers, not the other way
 * around"). So the integration does not let Software Factory call CodeRabbit. It lets
 * CodeRabbit read Software Factory's context. Exposing this repository's own durable record
 * -- constitution, ADRs, contracts, sprint evidence -- as an MCP server is therefore the
 * direction that actually does something.
 *
 * The alternative, mirroring the repo to Confluence or Notion and pointing CodeRabbit at
 * that, was rejected. It creates a second copy of the record with no defined reconciliation,
 * and this repository already had a version-drift problem: the constitution still listed
 * NC-3 as open after it was resolved, and the operational playbook still documented Bun
 * commands after npm became canonical. A second source does not fix drift, it multiplies it.
 *
 * Everything this serves is already committed here. The server does not summarise, rank, or
 * invent; it returns text that exists in the repository, and every tool response names the
 * file it came from. A knowledge tool that paraphrases an ADR is a knowledge tool that can
 * misstate an ADR.
 *
 * Transport: stdio. CodeRabbit reaches it over the reverse tunnel, or a local process. There
 * is no network listener in this file, so running it exposes no port and holds no
 * credentials.
 *
 * Security: read-only over committed files, with two hard limits. Paths are resolved against
 * the repository root and then checked to still be inside it, so no caller-supplied path can
 * escape to /etc or ~/.ssh. Environment files are refused outright rather than filtered --
 * .env is not documentation, and a knowledge server that will read it on request is a
 * credential-disclosure tool wearing a documentation costume.
 *
 * Usage:
 *   node scripts/kb-mcp-server.mjs            # stdio, for an MCP client
 *   node scripts/kb-mcp-server.mjs --self-test # exits nonzero if the record is unreadable
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Never served, at any path. .env holds live credentials; a ledger holds tenant records. */
const REFUSED = new Set(['.env', '.env.local', '.env.production', '.data', '.git', 'node_modules', 'dist', 'target']);

/** Directories the knowledge base indexes. Kept explicit: a generated server should not walk. */
const INDEXED = ['docs', 'sprints', '.github'];

/** Protocol version this server implements. */
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'search_knowledge',
    description:
      'Search the Software Factory knowledge base: constitution, ADRs, contracts, sprint evidence and CI workflows. Use this to find the governing rules for a change before reviewing it. Returns matching documents with the file each match came from.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for, e.g. "egress", "fail closed", "tenant isolation".' },
        limit: { type: 'integer', description: 'Maximum documents to return (default 8).', minimum: 1, maximum: 25 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_document',
    description:
      'Read one knowledge-base document in full, verbatim, by path. Paths are relative to the repository root, e.g. "docs/CONSTITUTION.md" or "docs/adr/ADR-005-unserved-niche-is-refused.md". Returns the exact committed text with no summarisation.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repository-relative path of a markdown document.' } },
      required: ['path'],
    },
  },
  {
    name: 'list_documents',
    description:
      'List every document the knowledge base can serve, grouped by category, with each document one-line description. Use this to discover what exists before searching.',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', description: 'Optional filter: governance, adr, contract, evidence, ci.' } },
    },
  },
  {
    name: 'get_governing_rules',
    description:
      'Return the rules most likely to constrain a change to a given area: the constitution articles, the ADRs in force, and the non-conformances currently open. Start here when reviewing any change, so a review comment cites a rule that actually exists rather than one the reviewer remembered.',
    inputSchema: {
      type: 'object',
      properties: { area: { type: 'string', description: 'Area of change, e.g. "kubernetes", "tenancy", "dependencies", "images".' } },
    },
  },
];

const CATEGORY_OF = (rel) => {
  if (rel.startsWith('docs/adr/')) return 'adr';
  if (rel === 'docs/CONSTITUTION.md' || rel === 'docs/REPOSITORY_CONTEXT_INDEX.md') return 'governance';
  if (rel.startsWith('docs/')) return 'contract';
  if (rel.startsWith('sprints/')) return 'evidence';
  if (rel.startsWith('.github/')) return 'ci';
  return 'other';
};

/** Resolve a caller-supplied path inside the repo, or return null if it escapes or is refused. */
function safeResolve(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const normalised = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const absolute = path.resolve(REPO_ROOT, normalised);
  // The containment check is on the resolved path, not the requested one, because
  // normalization is what makes 'a/../../etc/passwd' dangerous and 'etc/passwd' boring.
  if (absolute !== REPO_ROOT && !absolute.startsWith(REPO_ROOT + path.sep)) return null;
  const segments = absolute.slice(REPO_ROOT.length).split(path.sep).filter(Boolean);
  if (segments.some((segment) => REFUSED.has(segment))) return null;
  if (!absolute.endsWith('.md')) return null;
  return absolute;
}

async function collect() {
  const found = [];
  for (const dir of INDEXED) {
    const base = path.join(REPO_ROOT, dir);
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue; // An absent directory is not an error; a missing knowledge base is.
    }
    for (const entry of entries) {
      const abs = path.join(base, entry.name);
      if (entry.isDirectory()) {
        // One level deep only. docs/adr and sprints are the depth that matters, and an
        // unbounded walk is a server whose output size nobody bounded.
        if (entry.name === 'node_modules' || entry.name === 'target') continue;
        let nested;
        try {
          nested = await readdir(abs, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of nested) {
          if (child.isFile() && child.name.endsWith('.md')) {
            found.push({ rel: path.relative(REPO_ROOT, path.join(abs, child.name)), abs: path.join(abs, child.name) });
          }
        }
      } else if (entry.name.endsWith('.md')) {
        found.push({ rel: path.relative(REPO_ROOT, abs), abs });
      }
    }
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

function firstMeaningfulLine(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('|') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 160);
    }
  }
  return '';
}

async function readDocs() {
  const files = await collect();
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(file.abs, 'utf8');
      return { ...file, text, category: CATEGORY_OF(file.rel.replace(/\\/g, '/')), summary: firstMeaningfulLine(text) };
    }),
  );
}

function score(doc, terms) {
  const haystack = `${doc.rel}\n${doc.text}`.toLowerCase();
  const title = doc.rel.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (title.includes(term)) total += 5; // a hit in the filename is a stronger signal
    const occurrences = haystack.split(term).length - 1;
    if (occurrences > 0) total += Math.min(occurrences, 10);
  }
  return total;
}

function linesAround(text, term, radius = 1) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].toLowerCase().includes(term)) {
      const from = Math.max(0, i - radius);
      const to = Math.min(lines.length, i + radius + 1);
      hits.push(`  L${i + 1}: ${lines.slice(from, to).join('\n        ').trim()}`);
      if (hits.length >= 4) break;
    }
  }
  return hits;
}

async function callTool(name, args) {
  const docs = await readDocs();

  if (name === 'list_documents') {
    const filter = args?.category;
    const selected = filter ? docs.filter((d) => d.category === filter) : docs;
    const grouped = new Map();
    for (const doc of selected) {
      if (!grouped.has(doc.category)) grouped.set(doc.category, []);
      grouped.get(doc.category).push(doc);
    }
    const lines = [`Software Factory knowledge base: ${selected.length} documents`, ''];
    for (const [category, items] of [...grouped].sort()) {
      lines.push(`${category} (${items.length}):`);
      for (const item of items) lines.push(`  ${item.rel} -- ${item.summary}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'get_document') {
    const absolute = safeResolve(args?.path);
    if (!absolute) {
      return {
        content: [{ type: 'text', text: `Refused: ${args?.path}. Paths must be repository-relative markdown files, and credentials and ledgers are never served.` }],
        isError: true,
      };
    }
    try {
      await stat(absolute);
    } catch {
      return { content: [{ type: 'text', text: `Not found: ${args?.path}` }], isError: true };
    }
    const text = await readFile(absolute, 'utf8');
    return {
      content: [{ type: 'text', text: `SOURCE: ${path.relative(REPO_ROOT, absolute)}\nVERBATIM, UNMODIFIED\n\n${text}` }],
    };
  }

  if (name === 'search_knowledge') {
    const query = String(args?.query ?? '').trim();
    if (!query) return { content: [{ type: 'text', text: 'Refused: query must be non-empty.' }], isError: true };
    const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 25);
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length === 0) {
      return { content: [{ type: 'text', text: 'Refused: query needs at least one term longer than two characters.' }], isError: true };
    }
    const ranked = docs.map((doc) => ({ doc, weight: score(doc, terms) })).filter((r) => r.weight > 0).sort((a, b) => b.weight - a.weight);
    if (ranked.length === 0) {
      return {
        content: [{ type: 'text', text: `No document mentions ${JSON.stringify(query)}. Call list_documents to see what exists rather than assuming the answer is "none".` }],
      };
    }
    const out = [`Search: ${JSON.stringify(query)} -- ${ranked.length} matching documents, showing ${Math.min(limit, ranked.length)}`, ''];
    for (const { doc, weight } of ranked.slice(0, limit)) {
      out.push(`## ${doc.rel}  [${doc.category}, score ${weight}]`);
      out.push(linesAround(doc.text, terms[0]).join('\n') || `  ${doc.summary}`);
      out.push('');
    }
    out.push('Use get_document with the path for the full text. This is a ranked excerpt, not a summary.');
    return { content: [{ type: 'text', text: out.join('\n') }] };
  }

  if (name === 'get_governing_rules') {
    const area = String(args?.area ?? '').toLowerCase();
    const constitution = docs.find((d) => d.rel.endsWith('docs/CONSTITUTION.md'));
    const adrs = docs.filter((d) => d.category === 'adr');
    const out = [];
    if (constitution) {
      out.push(`# Constitution: ${constitution.rel}`);
      const openRows = constitution.text.split('\n').filter((l) => l.trim().startsWith('| NC-'));
      out.push(openRows.length ? 'Open or tracked non-conformances:\n' + openRows.join('\n') : 'No NC- rows are present.');
      out.push('');
    }
    if (adrs.length) {
      out.push('# Architecture decision records in force');
      for (const adr of adrs) out.push(`  ${adr.rel} -- ${adr.summary}`);
    } else {
      out.push('# No ADRs are committed.');
    }
    if (area) {
      out.push('');
      out.push(`# Documents most relevant to ${JSON.stringify(area)}`);
      const ranked = docs
        .map((doc) => ({ doc, weight: score(doc, area.split(/[^a-z0-9]+/).filter((t) => t.length > 2)) }))
        .filter((r) => r.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5);
      for (const { doc } of ranked) out.push(`  ${doc.rel} (${doc.category})`);
      if (ranked.length === 0) out.push('  No document mentions this area. Say so rather than inferring a rule.');
    }
    return { content: [{ type: 'text', text: out.join('\n') }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

async function selfTest() {
  const problems = [];
  const docs = await readDocs();
  if (docs.length === 0) problems.push('no documents are indexable; the knowledge base is empty');
  for (const required of ['docs/CONSTITUTION.md']) {
    if (!docs.some((d) => d.rel === required)) problems.push(`missing ${required}`);
  }
  if (!docs.some((d) => d.category === 'adr')) problems.push('no ADRs are indexed');

  // The refusals are the part that must be proven, not assumed.
  for (const attack of ['.env', '../../.env', '/etc/passwd', '.data/ledger.json', 'docs/../.env', 'docs/CONSTITUTION.md']) {
    const resolved = safeResolve(attack);
    const expectedRefused = !attack.endsWith('CONSTITUTION.md');
    if (expectedRefused && resolved !== null) problems.push(`safeResolve accepted ${JSON.stringify(attack)} -> ${resolved}`);
    if (!expectedRefused && resolved === null) problems.push(`safeResolve refused the legitimate path ${JSON.stringify(attack)}`);
  }

  const search = await callTool('search_knowledge', { query: 'egress' });
  if (search.isError) problems.push('search_knowledge returned an error on a valid query');

  const read = await callTool('get_document', { path: 'docs/CONSTITUTION.md' });
  if (read.isError) problems.push('get_document refused a legitimate path');

  const denied = await callTool('get_document', { path: '.env' });
  if (!denied.isError) problems.push('get_document served .env');

  if (problems.length) {
    for (const p of problems) process.stderr.write(`  FAIL  ${p}\n`);
    process.stderr.write(`\nKB SELF-TEST: ${problems.length} problem(s)\n`);
    return 1;
  }
  process.stdout.write(`KB SELF-TEST: ${docs.length} documents indexed, refusals hold, tools respond\n`);
  return 0;
}

async function serve() {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      continue;
    }
    const { id, method, params } = request;
    let response;
    if (method === 'initialize') {
      response = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'software-factory-knowledge-base', version: '1.0.0' },
        },
      };
    } else if (method === 'tools/list') {
      response = { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    } else if (method === 'tools/call') {
      try {
        response = { jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments) };
      } catch (error) {
        response = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true } };
      }
    } else if (method === 'notifications/initialized') {
      continue;
    } else {
      response = { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv.includes('--self-test')) {
  process.exit(await selfTest());
}
await serve();
