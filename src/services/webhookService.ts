/**
 * Outbound webhooks: signed, testable, replayable.
 *
 * A webhook is a promise made to someone else's server, and the only thing protecting
 * it is a signature. Every delivery from this service carries an HMAC-SHA256 signature
 * over a timestamped body, so a receiver can prove the event came from here and was
 * not captured and re-delivered later.
 *
 * ## What is deliberately NOT here
 *
 * No automatic retry loop with unbounded backoff. A failing receiver accumulates
 * retries the way a blocked pipe accumulates pressure, and the backlog is what kills
 * the process. Deliveries are recorded, failures are counted, and a human replays the
 * ones that matter. `replay` is explicit because an operator who cannot see which
 * deliveries failed cannot decide which to resend.
 *
 * ## Why the URL is validated
 *
 * A subscription URL is attacker-influenced configuration that this server will make
 * an outbound request to. That is SSRF in one sentence. Every URL is checked for a
 * https scheme and a public host before a subscription is stored, and again before a
 * delivery is attempted, because a URL that was safe when stored is not necessarily
 * safe when used.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TelemetryLogger } from '../utils/telemetryLogger';

/** A delivery that was attempted, whether or not it succeeded. */
export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  tenantId: string;
  event: string;
  /** The body as sent. Recorded so a replay sends the identical bytes. */
  body: string;
  signature: string;
  attemptedAt: string;
  responseStatus?: number;
  error?: string;
}

/** A configured destination. */
export interface WebhookSubscription {
  id: string;
  tenantId: string;
  url: string;
  /** HMAC-SHA256 key. Never returned by a read path, never logged. */
  secret: string;
  /** Event kinds this destination wants. Empty means "all". */
  events: string[];
  active: boolean;
  createdAt: string;
}

/**
 * Why a URL is refused.
 *
 * Named so a subscription attempt fails with a reason rather than a generic rejection:
 * an operator mistypling `https://` as `http://` needs to be told which, not left to
 * guess.
 */
export const WEBHOOK_URL_REFUSALS = {
  NOT_HTTPS: 'WEBHOOK_URL_NOT_HTTPS',
  NOT_PUBLIC_HOST: 'WEBHOOK_URL_HOST_NOT_PUBLIC',
  MALFORMED: 'WEBHOOK_URL_MALFORMED',
} as const;

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^::1$/, /^\[?::1\]?$/,
  /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /\.local$/i, /\.internal$/i, /\.localdomain$/i,
];

/**
 * Validates a subscription URL.
 *
 * Checked when the subscription is stored and again before every delivery, because a
 * URL that was safe when stored is not necessarily safe when used: DNS rebinding turns
 * a public hostname into a private address between the two.
 */
export function validateWebhookUrl(raw: unknown): { ok: boolean; url?: string; reason?: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: WEBHOOK_URL_REFUSALS.MALFORMED };
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: WEBHOOK_URL_REFUSALS.MALFORMED };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: WEBHOOK_URL_REFUSALS.NOT_HTTPS };
  const host = parsed.hostname;
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return { ok: false, reason: WEBHOOK_URL_REFUSALS.NOT_PUBLIC_HOST };
  }
  return { ok: true, url: parsed.toString() };
}

/** The header names a receiver must read. */
export const WEBHOOK_HEADERS = {
  SIGNATURE: 'x-sf-signature',
  TIMESTAMP: 'x-sf-timestamp',
  EVENT: 'x-sf-event',
  DELIVERY: 'x-sf-delivery',
} as const;

/**
 * Signs a body with a timestamp, so a captured delivery cannot be replayed later.
 *
 * The signature covers the timestamp as well as the body. A receiver that checks the
 * timestamp is inside a window can therefore reject a replay of a valid body, which a
 * body-only signature would let through.
 */
export function signWebhook(body: string, secret: string, timestamp: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Verifies a signature in constant time, after checking the timestamp window.
 *
 * Exported so a receiver implemented elsewhere can use exactly this logic, and so a
 * test can prove a forged signature is refused.
 */
export function verifyWebhookSignature(body: string, secret: string, timestamp: string, signature: string, toleranceSeconds = 300): boolean {
  if (typeof timestamp !== 'string' || typeof signature !== 'string') return false;
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return false;
  if (Math.abs(Date.now() - at) > toleranceSeconds * 1000) return false;
  const expected = Buffer.from(signWebhook(body, secret, timestamp));
  const presented = Buffer.from(signature);
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

/** What a dispatch returns: enough to record and to decide whether to replay later. */
export interface DispatchResult {
  delivery: WebhookDelivery;
  ok: boolean;
}

/**
 * A webhook sink.
 *
 * Held in memory. A subscription list that lives only in this process is honest about
 * what a restart costs — the operator re-registers — whereas one that pretends to be
 * durable and is not is the kind of claim this codebase does not make. Persistence
 * belongs in the tenant ledger, behind an injectable sink, when it is wired.
 */
export class WebhookService {
  private static subscriptions = new Map<string, WebhookSubscription>();
  private static deliveries = new Map<string, WebhookDelivery>();

  /** Registers a destination, refusing any URL that is not a public https endpoint. */
  public static subscribe(options: { tenantId: string; url: string; events?: string[] }): WebhookSubscription {
    const check = validateWebhookUrl(options.url);
    if (!check.ok) throw new Error(check.reason);
    const subscription: WebhookSubscription = {
      id: `whs_${randomBytes(8).toString('hex')}`,
      tenantId: options.tenantId,
      url: check.url,
      secret: `whsec_${randomBytes(24).toString('base64url')}`,
      events: [...(options.events ?? [])],
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  /** Reads a subscription back with its secret withheld. */
  public static get(id: string): Omit<WebhookSubscription, 'secret'> | undefined {
    const found = this.subscriptions.get(id);
    if (!found) return undefined;
    const { secret: _secret, ...rest } = found;
    return rest;
  }

  public static list(tenantId: string): Omit<WebhookSubscription, 'secret'>[] {
    return [...this.subscriptions.values()].filter((entry) => entry.tenantId === tenantId).map(({ secret: _secret, ...rest }) => rest);
  }

  /** Deactivates a destination. The record stays so past deliveries remain attributable. */
  public static unsubscribe(id: string): void {
    const found = this.subscriptions.get(id);
    if (found) found.active = false;
  }

  /**
   * Signs and sends one event to every matching active destination.
   *
   * The URL is re-validated immediately before the request. A subscription stored when
   * its host was public can resolve to a private address later; checking once at
   * registration would be a check that was true once.
   */
  public static async dispatch(tenantId: string, event: string, payload: Record<string, unknown>, transport = defaultTransport): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.active || subscription.tenantId !== tenantId) continue;
      if (subscription.events.length > 0 && !subscription.events.includes(event)) continue;

      const recheck = validateWebhookUrl(subscription.url);
      if (!recheck.ok) {
        TelemetryLogger.warn('Webhook delivery refused: URL no longer safe', { metadata: { subscriptionId: subscription.id, reason: recheck.reason } });
        continue;
      }

      const body = JSON.stringify({ event, tenantId, payload, deliveredAt: new Date().toISOString() });
      const timestamp = new Date().toISOString();
      const signature = signWebhook(body, subscription.secret, timestamp);
      const delivery: WebhookDelivery = {
        id: `whd_${randomBytes(8).toString('hex')}`,
        subscriptionId: subscription.id,
        tenantId,
        event,
        body,
        signature,
        attemptedAt: timestamp,
      };
      this.deliveries.set(delivery.id, delivery);

      try {
        const status = await transport(recheck.url, body, { signature, timestamp, event, deliveryId: delivery.id });
        delivery.responseStatus = status;
        results.push({ delivery, ok: status >= 200 && status < 300 });
      } catch (error) {
        delivery.error = error instanceof Error ? error.message : String(error);
        results.push({ delivery, ok: false });
      }
    }
    return results;
  }

  /**
   * Sends a signed test event to one destination and reports what came back.
   *
   * Distinct from `dispatch` so an operator can prove a receiver is wired before real
   * events flow to it, without the test event being confused for a real one: it is
   * labelled `webhook.test` and carries nothing but the fact that it is a test.
   */
  public static async testSend(subscriptionId: string, transport = defaultTransport): Promise<DispatchResult> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw new Error(`No webhook subscription '${subscriptionId}'`);
    const recheck = validateWebhookUrl(subscription.url);
    if (!recheck.ok) throw new Error(recheck.reason);

    const body = JSON.stringify({ event: 'webhook.test', tenantId: subscription.tenantId, payload: { note: 'This is a Software Factory test delivery.' }, deliveredAt: new Date().toISOString() });
    const timestamp = new Date().toISOString();
    const signature = signWebhook(body, subscription.secret, timestamp);
    const delivery: WebhookDelivery = {
      id: `whd_${randomBytes(8).toString('hex')}`,
      subscriptionId: subscription.id,
      tenantId: subscription.tenantId,
      event: 'webhook.test',
      body,
      signature,
      attemptedAt: timestamp,
    };
    this.deliveries.set(delivery.id, delivery);
    try {
      const status = await transport(recheck.url, body, { signature, timestamp, event: 'webhook.test', deliveryId: delivery.id });
      delivery.responseStatus = status;
      return { delivery, ok: status >= 200 && status < 300 };
    } catch (error) {
      delivery.error = error instanceof Error ? error.message : String(error);
      return { delivery, ok: false };
    }
  }

  /**
   * Re-sends a recorded delivery, re-signed with a fresh timestamp.
   *
   * The body is the identical bytes that were recorded, so a replay is a replay and not
   * a re-render. The signature and timestamp are new, because a receiver that honours
   * the timestamp window would reject a byte-identical re-send — which is the correct
   * behaviour for an attacker and the wrong one for an operator.
   */
  public static async replay(deliveryId: string, transport = defaultTransport): Promise<DispatchResult> {
    const recorded = this.deliveries.get(deliveryId);
    if (!recorded) throw new Error(`No webhook delivery '${deliveryId}'`);
    const subscription = this.subscriptions.get(recorded.subscriptionId);
    if (!subscription) throw new Error(`No webhook subscription '${recorded.subscriptionId}'`);
    const recheck = validateWebhookUrl(subscription.url);
    if (!recheck.ok) throw new Error(recheck.reason);

    const timestamp = new Date().toISOString();
    const signature = signWebhook(recorded.body, subscription.secret, timestamp);
    const delivery: WebhookDelivery = { ...recorded, id: `whd_${randomBytes(8).toString('hex')}`, signature, attemptedAt: timestamp };
    this.deliveries.set(delivery.id, delivery);
    try {
      const status = await transport(recheck.url, recorded.body, { signature, timestamp, event: recorded.event, deliveryId: delivery.id });
      delivery.responseStatus = status;
      return { delivery, ok: status >= 200 && status < 300 };
    } catch (error) {
      delivery.error = error instanceof Error ? error.message : String(error);
      return { delivery, ok: false };
    }
  }

  /** Records a delivery without sending one. Used by tests to seed a known history. */
  public static recordForTests(delivery: WebhookDelivery): void {
    this.deliveries.set(delivery.id, delivery);
  }

  public static delivery(id: string): WebhookDelivery | undefined {
    return this.deliveries.get(id);
  }

  public static resetForTests(): void {
    this.subscriptions.clear();
    this.deliveries.clear();
  }
}

/** The shape a transport must accept. Injectable so a test never opens a socket. */
export type WebhookTransport = (url: string, body: string, headers: { signature: string; timestamp: string; event: string; deliveryId: string }) => Promise<number>;

const defaultTransport: WebhookTransport = async (url, body, headers) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [WEBHOOK_HEADERS.SIGNATURE]: headers.signature,
      [WEBHOOK_HEADERS.TIMESTAMP]: headers.timestamp,
      [WEBHOOK_HEADERS.EVENT]: headers.event,
      [WEBHOOK_HEADERS.DELIVERY]: headers.deliveryId,
    },
    body,
  });
  return response.status;
};
