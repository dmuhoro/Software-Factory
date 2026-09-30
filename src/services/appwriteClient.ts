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

export interface AppwriteReachability {
  reachable: boolean;
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
  const attempts = Math.max(1, settings.limits.retryAttempts);
  let lastDetail = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outcome = await probeOnce(base, settings, getAppwriteServices(env));
    if (outcome.ok === true) return outcome.result;
    lastDetail = outcome.detail;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  return { ...base, detail: `${lastDetail} (after ${attempts} attempts)` };
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
): Promise<{ ok: true; result: AppwriteReachability } | { ok: false; detail: string }> {
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
        ok: true,
        result: {
          ...base,
          reachable: true,
          detail: `authenticated against project ${settings.projectId}; database "${settings.databaseId}" does not exist. `
            + `This project contains: ${names.length > 0 ? names.join(', ') : '(none)'}. `
            + 'Provisioning is a separate, explicit step -- this check never creates anything.',
        },
      };
    }

    const listed = await tables.listRows({
      databaseId: settings.databaseId,
      tableId: settings.collections.tenants,
      queries: [Query.limit(1)],
    });
    const found = Array.isArray(listed?.rows) ? listed.rows.length : 0;

    return {
      ok: true,
      result: {
        ...base,
        reachable: true,
        detail: `authenticated against project ${settings.projectId}; database "${settings.databaseId}" exists `
          + `(${names.length} visible); table "${settings.collections.tenants}" readable (${found} row(s) returned)`,
      },
    };
  } catch (error) {
    // Node's fetch wraps everything in a bare "fetch failed", naming neither cause nor host. A
    // verification command that reports only that is useless to whoever has to act on it, so the
    // cause chain is unwrapped.
    const parts: string[] = [];
    let cursor: unknown = error;
    for (let depth = 0; cursor && depth < 4; depth += 1) {
      const message = cursor instanceof Error ? cursor.message : String(cursor);
      if (message && !parts.includes(message)) parts.push(message);
      cursor = (cursor as { cause?: unknown })?.cause;
    }
    const code = typeof (error as { code?: unknown })?.code === 'number' ? ` (code ${(error as { code: number }).code})` : '';
    return { ok: false, detail: `Appwrite call failed${code}: ${parts.join(' <- ')}` };
  }
}

export function documentIdFor(prefix: string, ...parts: string[]): string {
  // Appwrite caps document ids at 36 characters. `deterministicId('doc_telem', ...)` returns
  // 42, so the delegation is truncated to what Appwrite will actually accept. An id the
  // database rejects is a worse outcome than a shorter one, and this was caught by the test
  // asserting the limit rather than by the type checker.
  return DurableStore.deterministicId(prefix, ...parts).slice(0, 36);
}
