/**
 * AST knowledge graph tests (Graphify steal, adapted to SF).
 *
 * Proves:
 *  - AKG-1  a source file parses into symbols with file:line locations
 *  - AKG-2  function, class, variable, import, export symbols are detected
 *  - AKG-3  call edges are recorded between symbols
 *  - AKG-4  findSymbol / findDefinition return real locations, never guesses
 *  - AKG-5  the same source always yields the same graph (deterministic)
 *  - AKG-6  edgesFor returns all edges touching a symbol
 *  - AKG-7  diagnoseLocation returns definition + callers + references
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKnowledgeGraph,
  findSymbol,
  findDefinition,
  edgesFor,
  diagnoseLocation,
  type SymbolNode,
  type KnowledgeGraph,
} from '../src/services/astKnowledgeGraph';

const SOURCE = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_PATH = join(__dirname, 'config.json');

export function loadConfig(): unknown {
  return readFileSync(CONFIG_PATH, 'utf8');
}

class ConfigLoader {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  load(): unknown {
    return loadConfig();
  }
}

export const loader = new ConfigLoader(CONFIG_PATH);
`;

test('AKG-1: a source file parses into symbols with file:line locations', () => {
  const graph = buildKnowledgeGraph('/repo/src/config.ts', SOURCE);
  assert.ok(graph.symbols.length > 0, 'at least one symbol detected');
  for (const sym of graph.symbols) {
    assert.ok(sym.id.length > 0, 'symbol must have an id');
    assert.ok(sym.name.length > 0, 'symbol must have a name');
    assert.ok(sym.line > 0, `symbol ${sym.name} must have a line`);
    assert.equal(sym.file, '/repo/src/config.ts');
  }
});

test('AKG-2: function, class, variable, import symbols are detected', () => {
  const graph = buildKnowledgeGraph('/repo/src/config.ts', SOURCE);
  const kinds = new Set(graph.symbols.map((s) => s.kind));
  assert.ok(kinds.has('import'), 'import symbol detected');
  assert.ok(kinds.has('variable'), 'variable symbol detected');
  assert.ok(kinds.has('function'), 'function symbol detected');
  assert.ok(kinds.has('class'), 'class symbol detected');
});

test('AKG-3: call edges are recorded between symbols', () => {
  const graph = buildKnowledgeGraph('/repo/src/config.ts', SOURCE);
  const callEdges = graph.edges.filter((e) => e.kind === 'calls');
  assert.ok(callEdges.length > 0, 'at least one call edge recorded');
  // loadConfig calls readFileSync via CONFIG_PATH reference; ConfigLoader.load calls loadConfig
  const loadConfigCall = callEdges.find((e) => e.to === 'loadConfig');
  assert.ok(loadConfigCall, 'loadConfig is called from ConfigLoader.load');
});

test('AKG-4: findSymbol / findDefinition return real locations, never guesses', () => {
  const graph = buildKnowledgeGraph('/repo/src/config.ts', SOURCE);
  const configs = findSymbol(graph, 'CONFIG_PATH');
  assert.equal(configs.length, 1, 'CONFIG_PATH found exactly once');
  assert.equal(configs[0].line, 4, 'CONFIG_PATH is on line 4');
  assert.equal(configs[0].file, '/repo/src/config.ts');

  const def = findDefinition(graph, 'loadConfig');
  assert.ok(def, 'loadConfig definition found');
  assert.equal(def!.kind, 'function');
  assert.equal(def!.line, 6, 'loadConfig function is on line 6');

  const missing = findSymbol(graph, 'doesNotExist');
  assert.deepEqual(missing, [], 'unknown symbol returns empty');
});

test('AKG-5: the same source always yields the same graph (deterministic)', () => {
  const first = buildKnowledgeGraph('/repo/src/config.ts', SOURCE);
  for (let i = 0; i < 50; i += 1) {
    const repeated = buildKnowledgeGraph('/repo/src/config.ts', SOURCE);
    assert.equal(repeated.symbols.length, first.symbols.length);
    assert.equal(repeated.edges.length, first.edges.length);
    for (const s of repeated.symbols) {
      const orig = first.byId.get(s.id);
      assert.ok(orig, `symbol ${s.id} must exist in original graph`);
      assert.equal(orig.name, s.name);
      assert.equal(orig.line, s.line);
    }
  }
});

test('AKG-6: edgesFor returns all edges touching a symbol', () => {
  const graph = buildKnowledgeGraph('/repo/src/config.ts', SOURCE);
  const def = findDefinition(graph, 'loadConfig');
  assert.ok(def, 'loadConfig definition must exist');
  const edges = edgesFor(graph, def.id);
  assert.ok(edges.length > 0, 'loadConfig must have at least one edge');
  for (const e of edges) {
    assert.ok(e.from === def.id || e.to === def.id, 'edge must touch the symbol');
  }
});

test('AKG-7: diagnoseLocation returns definition + callers + references', () => {
  const graph = buildKnowledgeGraph('/repo/src/config.ts', SOURCE);
  const diag = diagnoseLocation(graph, 'loadConfig');
  assert.ok(diag.definition, 'definition must be present');
  assert.equal(diag.definition!.name, 'loadConfig');
  assert.ok(Array.isArray(diag.callers), 'callers must be an array');
  assert.ok(Array.isArray(diag.references), 'references must be an array');
});
