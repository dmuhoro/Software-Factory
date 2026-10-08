/**
 * Sprint 25, phase 6: outbound webhooks.
 *
 * The rule under test is that a delivery is provably from this service and cannot be
 * replayed later, and that a destination which is not a public https endpoint is
 * refused at registration and again immediately before every send.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WEBHOOK_HEADERS,
  WEBHOOK_URL_REFUSALS,
  WebhookService,
  signWebhook,
  validateWebhookUrl,
  verifyWebhookSignature,
  type WebhookTransport,
} from '../src/services/webhookService';

const TENANT = 'tenant_scoped_0001';

test('a destination must be public https, and says which rule refused it', () => {
  assert.equal(validateWebhookUrl('https://hooks.example.com/x').ok, true);
  assert.equal(validateWebhookUrl('http://hooks.example.com/x').reason, WEBHOOK_URL_REFUSALS.NOT_HTTPS);
  assert.equal(validateWebhookUrl('ftp://hooks.example.com/x').reason, WEBHOOK_URL_REFUSALS.NOT_HTTPS);
  assert.equal(validateWebhookUrl('not a url').reason, WEBHOOK_URL_REFUSALS.MALFORMED);
  // An unbracketed IPv6 literal does not parse at all, so it is malformed, not private.
  assert.equal(validateWebhookUrl('https://::1/hook').reason, WEBHOOK_URL_REFUSALS.MALFORMED);
  assert.equal(validateWebhookUrl('').reason, WEBHOOK_URL_REFUSALS.MALFORMED);
  assert.equal(validateWebhookUrl(undefined).reason, WEBHOOK_URL_REFUSALS.MALFORMED);

  // The SSRF half: a private or link-local host is refused, including the spellings a
  // caller might hope slip through.
  for (const host of [
    'https://localhost/hook', 'https://127.0.0.1/hook', 'https://0.0.0.0/hook',
    'https://10.0.0.5/hook', 'https://192.168.1.1/hook', 'https://172.16.0.1/hook',
    'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/hook',
    'https://foo.local/hook', 'https://intranet.internal/hook', 'https://[::1]/hook',
  ]) {
    assert.equal(validateWebhookUrl(host).reason, WEBHOOK_URL_REFUSALS.NOT_PUBLIC_HOST, `${host} must be refused`);
  }
});

test('a refused URL cannot be subscribed to, at all', () => {
  WebhookService.resetForTests();
  assert.throws(() => WebhookService.subscribe({ tenantId: TENANT, url: 'http://insecure.example.com' }), /WEBHOOK_URL_NOT_HTTPS/);
  assert.throws(() => WebhookService.subscribe({ tenantId: TENANT, url: 'https://169.254.169.254/x' }), /WEBHOOK_URL_HOST_NOT_PUBLIC/);
  assert.deepEqual(WebhookService.list(TENANT), [], 'nothing may be stored for a refused URL');
});

test('the signature covers the timestamp, so a captured body cannot be replayed', () => {
  const body = JSON.stringify({ event: 'loop.run.settled', runId: 'run_42' });
  const secret = 'whsec_test_secret_value';
  // Relative to now: a fixed timestamp would race the window check.
  const at = new Date().toISOString();

  const signature = signWebhook(body, secret, at);
  assert.ok(verifyWebhookSignature(body, secret, at, signature), 'a genuine signature verifies');

  // Every one of these is a real attack a body-only signature would miss.
  assert.equal(verifyWebhookSignature(body + ' ', secret, at, signature), false, 'a tampered body is refused');
  assert.equal(verifyWebhookSignature(body, 'whsec_wrong', at, signature), false, 'a wrong secret is refused');
  assert.equal(verifyWebhookSignature(body, secret, new Date(Date.now() + 60_000).toISOString(), signature), false, 'a replayed signature at a new time is refused');
  assert.equal(verifyWebhookSignature(body, secret, 'not-a-date', signature), false, 'an unparseable timestamp is refused');
  assert.equal(verifyWebhookSignature(body, secret, at, 'deadbeef'), false, 'a forged signature is refused');
  assert.equal(verifyWebhookSignature(body, secret, at, ''), false, 'an empty signature is refused');

  // And a stale-but-genuine delivery falls outside the window.
  const stale = new Date(Date.now() - 3600_000).toISOString();
  const staleSignature = signWebhook(body, secret, stale);
  assert.equal(verifyWebhookSignature(body, secret, stale, staleSignature), false, 'a delivery outside the tolerance is refused');
});

test('the secret is never returned by a read path', () => {
  WebhookService.resetForTests();
  const created = WebhookService.subscribe({ tenantId: TENANT, url: 'https://hooks.example.com/a' });
  assert.ok(created.secret.startsWith('whsec_'), 'a secret is issued');

  const read = WebhookService.get(created.id)!;
  assert.equal((read as { secret?: string }).secret, undefined, 'the secret must not be readable');
  const listed = WebhookService.list(TENANT)[0] as { secret?: string };
  assert.equal(listed.secret, undefined, 'and not via the list either');
});

test('a delivery carries the four headers a receiver needs, and the body it signed', async () => {
  WebhookService.resetForTests();
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const transport: WebhookTransport = async (url, body, headers) => {
    sent.push({ url, body, headers: { ...headers } });
    return 200;
  };
  const subscription = WebhookService.subscribe({ tenantId: TENANT, url: 'https://hooks.example.com/a', events: ['loop.run.settled'] });

  const results = await WebhookService.dispatch(TENANT, 'loop.run.settled', { runId: 'run_42' }, transport);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].delivery.responseStatus, 200);

  assert.equal(sent.length, 1);
  const [first] = sent;
  assert.equal(first.url, 'https://hooks.example.com/a');
  const parsed = JSON.parse(first.body) as { event: string; tenantId: string; payload: { runId: string } };
  assert.equal(parsed.event, 'loop.run.settled');
  assert.equal(parsed.tenantId, TENANT);
  assert.equal(parsed.payload.runId, 'run_42');

  // The signature in the header must verify against the body that was actually sent,
  // with the timestamp that was actually sent. A receiver that checks exactly this is
  // the contract.
  assert.ok(verifyWebhookSignature(first.body, subscription.secret, first.headers.timestamp, first.headers.signature));
  assert.equal(first.headers.event, 'loop.run.settled');
  assert.ok(first.headers.deliveryId.startsWith('whd_'));
});

test('a destination only receives the events it subscribed to, and only while active', async () => {
  WebhookService.resetForTests();
  const seen: string[] = [];
  const transport: WebhookTransport = async (_url, body) => {
    seen.push((JSON.parse(body) as { event: string }).event);
    return 200;
  };
  const subscription = WebhookService.subscribe({ tenantId: TENANT, url: 'https://hooks.example.com/a', events: ['loop.run.settled'] });

  await WebhookService.dispatch(TENANT, 'loop.run.settled', {}, transport);
  await WebhookService.dispatch(TENANT, 'loop.run.cancel', {}, transport);
  assert.deepEqual(seen, ['loop.run.settled'], 'an unsubscribed event must not be delivered');

  WebhookService.unsubscribe(subscription.id);
  await WebhookService.dispatch(TENANT, 'loop.run.settled', {}, transport);
  assert.deepEqual(seen, ['loop.run.settled'], 'a deactivated destination must not receive deliveries');

  // And another tenant's destination never sees this tenant's events.
  WebhookService.subscribe({ tenantId: 'tenant_other', url: 'https://hooks.example.com/b' });
  await WebhookService.dispatch(TENANT, 'loop.run.settled', {}, transport);
  assert.deepEqual(seen, ['loop.run.settled'], 'a cross-tenant delivery must not happen');
});

test('test-send proves a receiver is wired without a real event reaching it', async () => {
  WebhookService.resetForTests();
  const sent: Array<{ body: string; headers: Record<string, string> }> = [];
  const transport: WebhookTransport = async (_url, body, headers) => {
    sent.push({ body, headers: { ...headers } });
    return 204;
  };
  const subscription = WebhookService.subscribe({ tenantId: TENANT, url: 'https://hooks.example.com/a' });

  const result = await WebhookService.testSend(subscription.id, transport);
  assert.equal(result.ok, true);
  assert.equal(result.delivery.responseStatus, 204);
  const parsed = JSON.parse(sent[0].body) as { event: string; payload: unknown };
  assert.equal(parsed.event, 'webhook.test', 'a test-send is labelled as one');
  assert.ok(verifyWebhookSignature(sent[0].body, subscription.secret, sent[0].headers.timestamp, sent[0].headers.signature));

  await assert.rejects(() => WebhookService.testSend('whs_missing', transport), /No webhook subscription/);
});

test('a replay sends the identical body with a fresh, valid signature', async () => {
  WebhookService.resetForTests();
  const sent: Array<{ body: string; headers: Record<string, string> }> = [];
  const transport: WebhookTransport = async (_url, body, headers) => {
    sent.push({ body, headers: { ...headers } });
    return 200;
  };
  const subscription = WebhookService.subscribe({ tenantId: TENANT, url: 'https://hooks.example.com/a' });

  const [original] = await WebhookService.dispatch(TENANT, 'loop.run.settled', { runId: 'run_42' }, transport);
  assert.equal(original.ok, true);

  const replayed = await WebhookService.replay(original.delivery.id, transport);
  assert.equal(replayed.ok, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body, sent[0].body, 'a replay must send the identical bytes, not a re-render');

  // New timestamp, new signature — and the new one is valid, which is the difference
  // between an operator resending and an attacker replaying a capture.
  assert.notEqual(sent[1].headers.signature, sent[0].headers.signature);
  assert.ok(verifyWebhookSignature(sent[1].body, subscription.secret, sent[1].headers.timestamp, sent[1].headers.signature));
  assert.ok(sent[1].headers.deliveryId.startsWith('whd_'));
  assert.notEqual(sent[1].headers.deliveryId, sent[0].headers.deliveryId, 'a replay is a new delivery, recorded separately');

  await assert.rejects(() => WebhookService.replay('whd_missing', transport), /No webhook delivery/);
});

test('a failing receiver is recorded, not retried into a backlog', async () => {
  WebhookService.resetForTests();
  const transport: WebhookTransport = async () => { throw new Error('receiver is down'); };
  WebhookService.subscribe({ tenantId: TENANT, url: 'https://hooks.example.com/a' });

  const results = await WebhookService.dispatch(TENANT, 'loop.run.settled', {}, transport);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].delivery.error, 'receiver is down');
  assert.equal(results[0].delivery.responseStatus, undefined, 'a failed delivery has no status, not a fake one');

  // One attempt. No hidden retry loop accumulating pressure behind a blocked receiver.
  const attempts: number[] = [];
  const counting: WebhookTransport = async () => { attempts.push(1); throw new Error('down'); };
  await WebhookService.dispatch(TENANT, 'loop.run.settled', {}, counting);
  assert.equal(attempts.length, 1, 'a failing receiver must get exactly one attempt per dispatch');
});

test('the signature header names are stable, because a receiver is written against them', () => {
  assert.equal(WEBHOOK_HEADERS.SIGNATURE, 'x-sf-signature');
  assert.equal(WEBHOOK_HEADERS.TIMESTAMP, 'x-sf-timestamp');
  assert.equal(WEBHOOK_HEADERS.EVENT, 'x-sf-event');
  assert.equal(WEBHOOK_HEADERS.DELIVERY, 'x-sf-delivery');
});
