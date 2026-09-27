/**
 * Outbound Egress Guard.
 *
 * Single authority for "may the factory send a request here, and may it attach
 * a secret?".
 *
 * This module exists because of a proven vulnerability: model providers accepted
 * a caller-supplied `secretRef` and a caller-supplied `baseUrl`, then resolved
 * the first against the server's own environment and sent the result to the
 * second as a bearer token. Any API key holder could read any secret in the
 * process environment. Registration now validates, and every actual request
 * re-validates at the socket boundary, because DNS answers can change between
 * registration and egress (rebinding).
 *
 * Design rules:
 *  - Fail CLOSED. An unconfigured allowlist denies every secret reference.
 *  - Validate at egress, not only at registration.
 *  - A secret is never sent to a host we did not explicitly permit.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

export type EgressCode =
  | 'MODEL_PROVIDER_URL_INVALID'
  | 'MODEL_PROVIDER_URL_SCHEME_NOT_ALLOWED'
  | 'MODEL_PROVIDER_HOST_NOT_ALLOWED'
  | 'MODEL_PROVIDER_ADDRESS_NOT_ALLOWED'
  | 'MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED'
  | 'MODEL_PROVIDER_REQUEST_TIMEOUT'
  | 'MODEL_PROVIDER_RESPONSE_TOO_LARGE'
  | 'MODEL_PROVIDER_MALFORMED_URL';

/** Environment variable names must look like names, never like injected values. */
const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Provider kinds that are permitted to talk to a private or loopback address. */
const LOCAL_PROVIDER_KINDS = new Set(['local']);

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/** Hosts an operator has explicitly permitted regardless of address class. */
export function allowedHosts(): Set<string> {
  return parseAllowlist(process.env.FACTORY_MODEL_ALLOWED_HOSTS);
}

/**
 * Secret references the factory may resolve from its own environment.
 * Unset means NO secret may be resolved. This is the fail-closed default.
 */
export function allowedSecretRefs(): Set<string> {
  return parseAllowlist(process.env.FACTORY_ALLOWED_SECRET_REFS);
}

/** Validates the shape of a secret reference. Does not grant permission. */
export function isWellFormedSecretRef(value: unknown): value is string {
  return typeof value === 'string' && SECRET_REF_PATTERN.test(value);
}

/**
 * Resolves a secret reference to its value, or refuses.
 * Returns undefined when no reference was supplied (a provider may be unauthenticated).
 */
export function resolveSecretRef(secretRef: unknown): string | undefined {
  if (secretRef === undefined || secretRef === null || secretRef === '') return undefined;
  if (!isWellFormedSecretRef(secretRef)) throw new Error('MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED');
  if (!allowedSecretRefs().has(secretRef)) throw new Error('MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED');
  const value = process.env[secretRef];
  // An allowlisted-but-unset reference is a configuration error, not a free pass.
  if (!value) throw new Error('MODEL_PROVIDER_SECRET_REF_NOT_ALLOWED');
  return value;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inCidrV4(address: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const target = ipv4ToInt(address);
  const base = ipv4ToInt(network);
  if (target === null || base === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((target & mask) >>> 0) === ((base & mask) >>> 0);
}

/** Address ranges that must never be reachable from a caller-supplied URL. */
const BLOCKED_V4 = [
  '0.0.0.0/8', // this network
  '10.0.0.0/8', // RFC1918 private
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, incl. cloud metadata at 169.254.169.254
  '172.16.0.0/12', // RFC1918 private
  '192.0.0.0/24', // IETF protocol assignments
  '192.168.0.0/16', // RFC1918 private
  '198.18.0.0/15', // benchmarking
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
];

/** Returns a rejection reason for a literal IP, or undefined when it is acceptable. */
export function classifyAddress(address: string): string | undefined {
  const version = net.isIP(address);
  if (version === 4) {
    for (const cidr of BLOCKED_V4) if (inCidrV4(address, cidr)) return `address ${address} is in blocked range ${cidr}`;
    return undefined;
  }
  if (version === 6) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === '::1' || normalized === '::') return `address ${address} is loopback or unspecified`;
    // IPv4-mapped and IPv4-compatible forms must be judged as IPv4.
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return classifyAddress(mapped[1]);
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return `address ${address} is unique-local`;
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return `address ${address} is link-local`;
    }
    if (normalized.startsWith('ff')) return `address ${address} is multicast`;
    return undefined;
  }
  return `address ${address} is not a valid IP`;
}

export interface ValidatedTarget {
  url: URL;
  hostname: string;
  isLocalProvider: boolean;
}

/**
 * Validates a provider base URL for registration. Performs name-level checks
 * only; address-level checks happen at egress, once DNS has been resolved.
 */
export function validateProviderUrl(baseUrl: unknown, kind: string): URL {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') throw new Error('MODEL_PROVIDER_URL_INVALID');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('MODEL_PROVIDER_URL_MALFORMED_URL');
  }
  const isLocal = LOCAL_PROVIDER_KINDS.has(kind);
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    throw new Error('MODEL_PROVIDER_URL_SCHEME_NOT_ALLOWED');
  }
  if (!url.hostname) throw new Error('MODEL_PROVIDER_URL_INVALID');
  // A literal address is judged immediately; a hostname is judged after resolution.
  if (net.isIP(url.hostname) && !isLocal) {
    const reason = classifyAddress(url.hostname);
    if (reason) throw new Error(`MODEL_PROVIDER_ADDRESS_NOT_ALLOWED:${reason}`);
  }
  if (!isLocal && !allowedHosts().has(url.hostname)) {
    // Host must be an operator-declared target for remote providers.
    throw new Error(`MODEL_PROVIDER_HOST_NOT_ALLOWED:${url.hostname}`);
  }
  return url;
}

async function assertResolvedAddressesAllowed(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    const reason = classifyAddress(hostname);
    if (reason) throw new Error(`MODEL_PROVIDER_ADDRESS_NOT_ALLOWED:${reason}`);
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`MODEL_PROVIDER_HOST_NOT_ALLOWED:${hostname}`);
  }
  if (!records.length) throw new Error(`MODEL_PROVIDER_HOST_NOT_ALLOWED:${hostname}`);
  for (const record of records) {
    const reason = classifyAddress(record.address);
    if (reason) throw new Error(`MODEL_PROVIDER_ADDRESS_NOT_ALLOWED:${reason}`);
  }
}

export interface EgressOptions {
  baseUrl: string;
  kind: string;
  pathname: string;
  method?: 'GET' | 'POST';
  body?: string;
  secret?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Performs the only outbound HTTP call the factory is permitted to make to a
 * model provider, subject to timeout, redirect, and size limits.
 */
export async function egressJson(options: EgressOptions): Promise<{ status: number; body: unknown }> {
  const url = validateProviderUrl(options.baseUrl, options.kind);
  const isLocal = LOCAL_PROVIDER_KINDS.has(options.kind);
  if (!isLocal) await assertResolvedAddressesAllowed(url.hostname);
  const target = new URL(`${url.toString().replace(/\/$/, '')}${options.pathname}`);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1_000), 120_000);
  const maxBytes = Math.min(Math.max(options.maxResponseBytes ?? 5_000_000, 1_024), 20_000_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.secret ? { Authorization: `Bearer ${options.secret}` } : {}),
      },
      ...(options.body ? { body: options.body } : {}),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      // Never follow a redirect: it is an unvalidated egress target.
      throw new Error(`MODEL_PROVIDER_REDIRECT_NOT_ALLOWED:${response.status}`);
    }
    const text = await readCapped(response, maxBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('MODEL_PROVIDER_INVALID_RESPONSE');
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).name === 'AbortError') {
      throw new Error('MODEL_PROVIDER_REQUEST_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('MODEL_PROVIDER_RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('MODEL_PROVIDER_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
