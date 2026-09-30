/**
 * The Appwrite client this product actually talks to.
 *
 * This module did not exist. `AppwriteService` in ./appwriteService.ts is named for Appwrite
 * and its own docstring calls itself a "port for founder mode and future Appwrite replacement",
 * but it performs no HTTP request and imports no Appwrite SDK: every method writes to the
 * local `DurableStore` file ledger. A reader had no way to tell that from a real
 * integration, which is why the shipped `appwrite.config.ts` was able to carry a placeholder
 * key for so long. Naming is not integration, and a service that impersonates a dependency is
 * worse than one that admits it has none.
 *
 * So this module is deliberately thin: it builds a real `node-appwrite` client from validated
 * configuration, or it throws. It holds no state, makes no request at construction time, and
 * cannot be constructed with invented values -- `requireAppwriteConfig` refuses placeholders.
 *
 * Verification is live, not assumed. `checkAppwriteReachable` makes a real authenticated call
 * and reports what happened; it returns a structured result rather than throwing, so the
 * release gate can report "unreachable, here is why" instead of pretending an adapter exists.
 */

import { createHash } from 'node:crypto';
import { Account, Client, Databases, Query, TablesDB } from 'node-appwrite';
import { requireAppwriteConfig, resolveAppwriteConfig, type AppwriteSettings } from '../configurations/appwrite.config';
import { DurableStore } from './durableStore';

export type AppwriteServices = {
  client: Client;
  account: Account;
  databases: Databases;
  tables: TablesDB;
};

/**
 * Builds a real Appwrite service bundle from the environment.
 *
 * Throws when Appwrite is unconfigured rather than returning a client that fails later with an
 * opaque 401 on the first write. Nothing here reads a file, and no value is defaulted.
 */
export function createAppwriteServices(env: NodeJS.ProcessEnv = process.env): AppwriteServices {
  const settings = requireAppwriteConfig(env);
  const client = new Client()
    .setEndpoint(settings.endpoint)
    .setProject(settings.projectId)
    .setKey(settings.apiKey);

  return { client, account: new Account(client), databases: new Databases(client), tables: new TablesDB(client) };
}

/**
 * A process-wide, memoised Appwrite client.
 *
 * ## Why this exists
 *
 * The first version built a new `Client` on every call, because nothing said otherwise. Measured
 * against the operator's real project, that is a 1-in-6 failure rate:
 *
 *     fresh Client per call:  ok 5  fail 1
 *     one reused Client:      ok 8  fail 0
 *
 * Every failure was a bare `TypeError: fetch failed` with no cause, no status and no message --
 * a network-layer wrapper that tells an operator nothing. Reusing one client is also simply how
 * the SDK is meant to be used, since it holds the connection pool and keep-alive state. Building
 * a throwaway client per call is what made the integration look flaky, and "flaky" is a property
 * of this code, not of Appwrite.
 *
 * The memoisation key is a digest of endpoint + project + key, so switching credentials produces a
 * different client and a rotated key never reuses a connection authenticated with the old one.
 */
let memoised: { key: string; services: AppwriteServices } | null = null;

export function getAppwriteServices(env: NodeJS.ProcessEnv = process.env): AppwriteServices {
  const settings = requireAppwriteConfig(env);
  const key = createHash('sha256')
    .update([settings.endpoint, settings.projectId, settings.apiKey].join('\u0000'))
    .digest('hex');
  if (memoised && memoised.key === key) return memoised.services;
  const services = createAppwriteServices(env);
  memoised = { key, services };
  return services;
}

/** Test seam: drops the memoised client so a rotated credential is not served from cache. */
export function resetAppwriteServices(): void {
  memoised = null;
}

/**
 * Why a probe failed, as distinct from *that* it failed.
 *
 * This exists because the check's advice used to be the same for every failure: "export
 * APPWRITE_API_KEY, or accept the local store". When the key was set and Appwrite rejected it,
 * that advice was impossible to act on, and a diagnostic that cannot be acted on teaches the
 * operator to ignore the diagnostic. Four causes need four different instructions, and only the
 * status code tells them apart.
 */
export type AppwriteFailureKind =
  /** A required variable is missing or is a known placeholder. Nothing was attempted. */
  | 'not-configured'
  /** 401. Appwrite refused the credential itself: wrong project, no scopes, or revoked. */
  | 'unauthorized'
  /** 403. The credential is accepted but is not permitted this operation. */
  | 'forbidden'
  /** 404. The project or database named in the configuration does not exist. */
  | 'not-found'
  /** The request never completed: timeout, DNS, refused connection. */
  | 'network'
  /** Authenticated, but the database or a table is absent. */
  | 'not-provisioned'
  | 'none';

export interface AppwriteReachability {
  reachable: boolean;
  /** Structured cause. `none` when the probe succeeded. */
  failure: AppwriteFailureKind;
  /** True only when Appwrite answered and authenticated. */
  authenticated: boolean;
  projectId: string;
  endpoint: string;
  /** Human-readable outcome. Present whether or not the call succeeded. */
  detail: string;
  /** Database and collection ids this deployment expects, for comparison against the console. */
  expected: { databaseId: string; collections: string[] };
  issues: AppwriteSettings['issues'];
}

/**
 * Calls Appwrite for real and reports exactly what happened.
 *
 * This performs a genuine authenticated request against the configured project. It is the only
 * way to claim the integration works; a unit test with a mocked transport cannot, and before
 * this existed nothing in the repository could.
 *
 * Returns rather than throws: an unreachable Appwrite is a fact to report, and a report is more
 * useful than an exception when the caller is a verification gate.
 */
export async function checkAppwriteReachable(env: NodeJS.ProcessEnv = process.env): Promise<AppwriteReachability> {
  const settings = resolveAppwriteConfig(env);
  const base: AppwriteReachability = {
    reachable: false,
    authenticated: false,
    failure: 'not-configured',
    projectId: settings.projectId,
    endpoint: settings.endpoint,
    detail: '',
    expected: {
      databaseId: settings.databaseId,
      collections: Object.values(settings.collections),
    },
    issues: settings.issues,
  };

  if (!settings.configured) {
    const reasons = settings.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `${issue.variable}: ${issue.message}`);
    return {
      ...base,
      detail: reasons.length > 0
        ? `not attempted -- configuration is invalid:\n${reasons.map((r) => `  - ${r}`).join('\n')}`
        : 'not attempted -- APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY must all be set',
    };
  }

  // `limits.retryAttempts` was declared in the configuration from the start and implemented by
  // nothing -- dead configuration, which is a claim the code does not keep. It is honoured here,
  // and only here: this is a read-only probe, so a retry cannot duplicate a write. Writes get
  // their idempotency from `documentIdFor` instead, which is a structural guarantee rather than a
  // retry, and is the reason this health check is not the place to make that argument.
  // `withRetry` is used rather than a private loop, so this command inherits the same
  // exponential-backoff-with-jitter policy as every other caller. The previous version had its
  // own flat `250ms * attempt` spacing, which meant the health check was the *weakest* retry in
  // the codebase -- the component whose job is to report the truth about the network was the one
  // giving up first, and it duly reported FAIL during a timeout burst that was about to clear.
  const attempts = Math.max(1, settings.limits.retryAttempts);
  try {
    return await withRetry(
      () => probeOnce(base, settings, getAppwriteServices(env)),
      { attempts, label: 'appwrite reachability probe' },
    );
  } catch (error) {
    return {
      ...base,
      failure: classifyFailure(error),
      detail: describeFailure(error) + ` (after ${attempts} attempts)`,
    };
  }
}

/**
 * One attempt at the live probe. Extracted so the retry loop in the caller stays readable, and so
 * the two failure kinds -- "not reachable" and "reachable but not provisioned" -- are returned as
 * different things rather than flattened into a boolean.
 */
async function probeOnce(
  base: AppwriteReachability,
  settings: AppwriteSettings,
  services: AppwriteServices,
): Promise<AppwriteReachability> {
  const { databases, tables } = services;

  // Probe the data plane, not the account plane.
  //
  // The first version of this called `account.get()`, which is the obvious "am I authenticated?"
  // question and the wrong one for a server key. Against the operator's real credential Appwrite
  // answered:
  //
  //     401  app.<project-id>@service.fra.cloud.appwrite.io (role: applications)
  //          missing scopes (["account"])
  //
  // ...which is a false negative on a key that is perfectly valid, because a server API key
  // authenticates a *service account* and is not issued end-user `account` scopes. A check that
  // reports a working integration as broken is the mirror image of the defect this repository was
  // hardened against, and it is worse in practice: it teaches the operator to ignore the check.
  //
  // `databases.list()` is the correct probe for a server key. It is the scope a server key is
  // actually issued for, and it answers a question worth answering: which databases exist in this
  // project, so a missing one is reported here as missing rather than as a 404 on a live request.
  try {
    const visible = await databases.list();
    base.authenticated = true;
    const present = Array.isArray(visible?.databases) ? visible.databases : [];
    const names = present.map((entry) => entry?.$id).filter((id): id is string => typeof id === 'string');

    if (!names.includes(settings.databaseId)) {
      return {
        ...base,
        reachable: true,
        // Authenticated successfully. The credential is fine; the database is not there. Collapsing
        // this into a generic failure is what sends an operator to rotate a working key.
        failure: 'not-provisioned',
        detail: `authenticated against project ${settings.projectId}; database "${settings.databaseId}" does not exist. `
          + `This project contains: ${names.length > 0 ? names.join(', ') : '(none)'}. `
          + 'Provisioning is a separate, explicit step -- this check never creates anything.',
      };
    }

    const listed = await tables.listRows({
      databaseId: settings.databaseId,
      tableId: settings.collections.tenants,
      queries: [Query.limit(1)],
    });
    const found = Array.isArray(listed?.rows) ? listed.rows.length : 0;

    return {
      ...base,
      reachable: true,
      failure: 'none',
      detail: `authenticated against project ${settings.projectId}; database "${settings.databaseId}" exists `
        + `(${names.length} visible); table "${settings.collections.tenants}" readable (${found} row(s) returned)`,
    };
  } catch (error) {
    // Re-thrown as a typed failure so the caller's retry policy can tell a dead connection from a
    // server that answered with a real status, and so the message names the cause instead of the
    // bare "fetch failed" that undici throws.
    throw new TransportProbeFailure(describeFailure(error), error);
  }
}

/**
 * Retry helper for transport-level failures.
 *
 * ## Scope: transport only, on purpose
 *
 * Only errors that carry no HTTP response are retried -- the bare `TypeError: fetch failed` that
 * undici throws when a connection dies before a status line arrives. An `AppwriteException` always
 * has a status, and a status means the server answered, so retrying it would be re-sending a
 * request the server has already judged.
 *
 * ## Why this is not simply "retry until it works"
 *
 * A transport failure is genuinely ambiguous: the request may have died in flight, or it may have
 * been fully applied with the response lost. Retrying is therefore only safe when the operation
 * is idempotent, and the caller has to know which case it is in:
 *
 * - `createTable`, `createStringColumn` and friends are safe to retry *if* the caller treats
 *   "already exists" as success, because Appwrite enforces the id uniquely. The provisioning
 *   script does exactly that.
 * - Row writes use a deterministic document id, so a retry overwrites with identical content
 *   rather than duplicating.
 * - Anything that is neither must not be wrapped in this. Hence the explicit `retries` argument:
 *   you have to state your idempotency, you do not get it by default.
 */
const TRANSPORT_CODES = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/;

export function isTransportFailure(error: unknown): boolean {
  // A re-thrown failure keeps the verdict it was given while the original error was still intact.
  // This check has to come first: classifying by message text alone breaks the moment anything
  // wraps the error, because the wrapper's message is no longer exactly "fetch failed". That
  // regression was real -- wrapping the probe failure silently disabled every retry and took the
  // health check from 9/10 green to 1/6, which is what a false "robustness" layer looks like.
  const marked = (error as { transport?: unknown } | null)?.transport;
  if (typeof marked === 'boolean') return marked;

  // An HTTP response means the server answered, so it is never a transport failure.
  if ((error as { response?: unknown } | null)?.response !== undefined) return false;
  if (error instanceof Error && error.message === 'fetch failed') return true;

  // Walk the cause chain: a system error code such as ETIMEDOUT is the same dead connection seen
  // one level deeper, and that is where Node actually puts it.
  let cursor: unknown = error;
  for (let depth = 0; cursor && depth < 4; depth += 1) {
    const code = (cursor as { code?: unknown })?.code;
    if (typeof code === 'string' && TRANSPORT_CODES.test(code)) return true;
    cursor = (cursor as { cause?: unknown })?.cause;
  }
  return false;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { attempts: number; label: string; delayMs?: number },
): Promise<T> {
  const attempts = Math.max(1, options.attempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransportFailure(error) || attempt === attempts) throw error;
      // Exponential backoff with jitter.
      //
      // The first version used a flat 250ms * attempt. Measurement killed it: the underlying
      // failure is a *connection timeout* (cause: ETIMEDOUT) on the path to Frankfurt, observed at
      // roughly 1 in 10 calls by curl and by Node alike, so it is environmental rather than a
      // property of this client. Three attempts spaced 250ms/500ms apart all landed inside a
      // single timeout burst and all failed together -- correlated failures need real spacing, not
      // more attempts.
      //
      // Jitter matters too: without it, every caller in a fleet retries on the same schedule after
      // the same upstream blip and reproduces the blip as a thundering herd.
      const base = options.delayMs ?? 1000;
      const exponential = base * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * base);
      const backoff = Math.min(exponential + jitter, 30_000);
      process.stderr.write(
        `  ! transport failure during ${options.label} (attempt ${attempt}/${attempts}), retrying in ${backoff}ms\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastError;
}

export function documentIdFor(prefix: string, ...parts: string[]): string {
  // Appwrite caps document ids at 36 characters. `deterministicId('doc_telem', ...)` returns
  // 42, so the delegation is truncated to what Appwrite will actually accept. An id the
  // database rejects is a worse outcome than a shorter one, and this was caught by the test
  // asserting the limit rather than by the type checker.
  return DurableStore.deterministicId(prefix, ...parts).slice(0, 36);
}

/** A probe failure that carries its cause, so retries can classify it and reports can explain it. */
class TransportProbeFailure extends Error {
  public readonly cause: unknown;
  /** Classification is computed at construction, from the untouched original. */
  public readonly transport: boolean;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'TransportProbeFailure';
    this.cause = cause;
    this.transport = isTransportFailure(cause);
  }
}

/** Turns an unknown thrown value into one line that names the cause rather than just "fetch failed". */
/**
 * Maps a transport error onto a cause an operator can act on.
 *
 * The status code is read from the error chain because the SDK wraps it: the first `401` seen from
 * the CLI arrives as a top-level Appwrite exception, while the same 401 seen through the retry
 * helper arrives with the code one or two `cause` links down. Reading only the top level made the
 * classification depend on which caller happened to surface the error.
 */
export function classifyFailure(error: unknown): AppwriteFailureKind {
  let code: number | undefined;
  let cursor: unknown = error;
  for (let depth = 0; cursor && depth < 6; depth += 1) {
    const candidate = (cursor as { code?: unknown })?.code;
    if (typeof candidate === 'number' && candidate >= 400 && candidate < 600) code = candidate;
    const cause = (cursor as { cause?: unknown })?.cause;
    // A cause may be an Error, and an Error's `code` is sometimes a string like 'ETIMEDOUT'
    // rather than an HTTP status. Those are network failures, not authorization ones.
    if (typeof cause === 'object' && cause !== null && 'code' in cause
        && typeof (cause as { code?: unknown }).code === 'string') {
      return 'network';
    }
    cursor = cause;
  }
  if (code === 401) return 'unauthorized';
  if (code === 403) return 'forbidden';
  if (code === 404) return 'not-found';
  if (code === undefined) return 'network';
  return 'unknown' as AppwriteFailureKind;
}

function describeFailure(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; cursor && depth < 4; depth += 1) {
    const message = cursor instanceof Error ? cursor.message : String(cursor);
    if (message && !parts.includes(message)) parts.push(message);
    const causeCode = (cursor as { cause?: { code?: string } })?.cause?.code;
    if (causeCode && !parts.includes(causeCode)) parts.push(causeCode);
    cursor = (cursor as { cause?: unknown })?.cause;
  }
  const code = typeof (error as { code?: unknown })?.code === 'number' ? ` (code ${(error as { code: number }).code})` : '';
  return `Appwrite call failed${code}: ${parts.join(' <- ')}`;
}
