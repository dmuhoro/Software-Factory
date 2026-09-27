/**
 * Layer 3, part 2: the audit report.
 *
 * The report is a standalone HTML file that an auditor opens, so every value
 * interpolated into it is attacker-reachable. The telemetry fields are supplied by the
 * client that posted the event, which makes `eventType` the direct vector.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTenantReportHtml } from '../src/utils/reportGenerator';

const PAYLOAD = '<img src=x onerror=alert(1)>';
const BREAKOUT = '"><script>alert(2)</script>';

function report(overrides: Record<string, unknown> = {}): string {
  return generateTenantReportHtml({
    tenantId: 'tenant_hc_1042',
    niche: 'healthcare',
    generatedAt: '2026-01-01T00:00:00.000Z',
    config: undefined,
    logs: [],
    ...overrides,
  } as never);
}

test('L3: a telemetry eventType carrying markup is escaped, not rendered', () => {
  const html = report({
    logs: [{ tenantId: 'tenant_hc_1042', correlationId: 'c1', eventType: PAYLOAD, timestamp: 't', durationMs: 1, status: 'success' }],
  });
  // The payload must survive only in escaped form. `<img` as a real tag is the failure.
  assert.ok(!html.includes('<img'), 'an injected <img tag was rendered as markup');
  assert.ok(html.includes('&lt;img'), 'the payload should still be visible, escaped');
  assert.ok(!/<script/i.test(html), 'an injected <script> tag was rendered as markup');
});

test('L3: an attribute breakout attempt in any field is neutralised', () => {
  const html = report({
    tenantId: 'tenant_hc_1042',
    niche: BREAKOUT,
    generatedAt: '2026-01-01',
    logs: [
      { tenantId: 'tenant_hc_1042', correlationId: BREAKOUT, eventType: 'evt', timestamp: BREAKOUT, durationMs: 1, status: 'success' },
    ],
  });
  assert.ok(!/<script/i.test(html), 'a breakout injected a script tag');
  // A raw double quote next to a tag would let an attribute escape.
  assert.ok(!html.includes('"><'), 'a raw attribute breakout survived');
});

/**
 * A regex cannot distinguish an event-handler ATTRIBUTE from text that merely looks like
 * one: after escaping, the payload `x" onload="alert(1)` correctly renders as the text
 * `x&quot; onload=&quot;alert(1)`, which a naive scan still flags. So this test compares
 * the set of element names in the document against the report's own markup instead. Any
 * successful injection necessarily introduces an element the template never emits.
 */
const REPORT_ELEMENTS = new Set([
  'html', 'head', 'title', 'meta', 'style', 'body', 'div', 'button', 'strong', 'br',
  'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'h1',
]);

function elementNames(html: string): Set<string> {
  return new Set([...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()));
}

test('L3: a payload cannot introduce an element the report does not emit', () => {
  const html = report({
    tenantId: 'tenant_hc_1042',
    niche: PAYLOAD,
    generatedAt: BREAKOUT,
    logs: [
      { tenantId: 'tenant_hc_1042', correlationId: PAYLOAD, eventType: PAYLOAD, timestamp: BREAKOUT, durationMs: 1, status: 'success' },
    ],
  });
  const injected = [...elementNames(html)].filter((name) => !REPORT_ELEMENTS.has(name));
  assert.deepEqual(injected, [], `payload introduced element(s): ${injected.join(', ')}`);
});

test('L3: the only event handler in the document is the report\'s own print button', () => {
  const html = report({
    logs: [{ tenantId: 'tenant_hc_1042', correlationId: 'c', eventType: 'x" onload="alert(1)', timestamp: 't', durationMs: 1, status: 'success' }],
  });
  // Scan only real tag bodies, so escaped text inside a <td> is never inspected.
  const tagBodies = [...html.matchAll(/<([a-zA-Z][^>]*)>/g)].map((m) => m[1]);
  const handlers = tagBodies.filter((body) => /\son(?:error|load|click|mouseover|focus)\s*=/i.test(body));
  assert.deepEqual(handlers, ['button class="btn-print" onclick="window.print()"'], `unexpected handler tag(s): ${handlers.join(' | ')}`);
});

test('L3: a log with no status does not crash report generation', () => {
  // `log.status.toUpperCase()` threw on a missing status, so building a report for a
  // partially written telemetry log failed outright instead of degrading.
  const html = report({
    logs: [{ tenantId: 'tenant_hc_1042', correlationId: 'c', eventType: 'e', timestamp: 't', durationMs: 1 } as never],
  });
  assert.ok(html.includes('UNKNOWN'), 'a missing status should render as UNKNOWN, not throw');
});

test('L3: a report for a tenant with no telemetry still renders', () => {
  const html = report({ logs: [] });
  assert.ok(html.includes('No telemetry events recorded'), 'the empty state is wrong');
});
