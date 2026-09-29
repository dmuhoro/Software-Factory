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

  try {
    const { account, databases, tables } = createAppwriteServices(env);
    // get() with no preferences returns the authenticated server-side identity. It is the
    // cheapest call that proves endpoint, project id and key are all correct at once.
    const identity = await account.get();
    base.authenticated = true;

    // Then prove the data plane this product depends on actually exists. A reachable project
    // with no database still cannot serve a request, and that is the failure that matters.
    await databases.get(settings.databaseId);
    const listed = await tables.listRows({
      databaseId: settings.databaseId,
      tableId: settings.collections.tenants,
      queries: [Query.limit(1)],
    });
    const found = Array.isArray(listed?.rows) ? listed.rows.length : 0;

    return {
      ...base,
      reachable: true,
      detail: `authenticated as ${identity?.email ?? 'server key'}; database "${settings.databaseId}" found; `
        + `table "${settings.collections.tenants}" readable (${found} row(s) returned)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { code?: unknown })?.code === 'number' ? ` (code ${(error as { code: number }).code})` : '';
    return { ...base, detail: `Appwrite refused the call${code}: ${message}` };
  }
}

/**
 * Deterministic Appwrite document id for a tenant-scoped record.
 *
 * This deliberately delegates to `DurableStore.deterministicId` rather than hashing again.
 * ADR-001 fixes `[tenant_id, idempotency_key]` as the composite unique index, and that function
 * is its single implementation -- including the NUL separator, which is load-bearing because it
 * is what stops ['ab','c'] and ['a','bc'] hashing identically. A second hashing scheme here
 * would be a second answer to the same question, and the two would drift.
 *
 * The first version of this function introduced its own NUL join, which made this file read as
 * binary to `grep` exactly as `durableStore.ts` does, and duplicated a rule that already has a
 * canonical home. Delegating is both shorter and the only version that stays correct if the
 * canonical function ever changes.
 */
export function documentIdFor(prefix: string, ...parts: string[]): string {
  // Appwrite caps document ids at 36 characters. `deterministicId('doc_telem', ...)` returns
  // 42, so the delegation is truncated to what Appwrite will actually accept. An id the
  // database rejects is a worse outcome than a shorter one, and this was caught by the test
  // asserting the limit rather than by the type checker.
  return DurableStore.deterministicId(prefix, ...parts).slice(0, 36);
}
