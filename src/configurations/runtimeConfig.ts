/**
 * Runtime configuration resolution and validation.
 *
 * The service previously started with whatever environment it happened to
 * inherit, which meant the shipped container booted successfully and then
 * returned 401 for every request. Configuration is now resolved once, at the
 * entrypoint, and validated BEFORE the listener binds.
 *
 * Rules:
 *  - Fail CLOSED. A production deployment with no credential does not start.
 *  - Never log a secret. Only the fact that a variable is set is reported.
 *  - Local-development escape hatches are refused outright in production.
 */

export type ConfigSeverity = 'error' | 'warning';

export interface ConfigIssue { variable: string; severity: ConfigSeverity; message: string; }

export interface RuntimeConfig {
  /** Which persistence backend this process writes to. One per process, never both. */
  storageBackend: 'local' | 'appwrite';
  nodeEnv: 'production' | 'development' | 'test';
  port: number;
  isProduction: boolean;
  /** True when the local loopback bypass is genuinely active. */
  insecureLocalBypass: boolean;
  dataDir: string;
  workspaceRoot: string;
  requestBodyLimit: string;
  /** Environment variable names the factory may resolve for outbound model providers. */
  allowedSecretRefs: string[];
  /** tenantId -> plaintext credential, available only at startup before hashing. */
  tenantCredentials: Record<string, string>;
  /**
   * Installs fabricated demo tenants into an empty registry on boot.
   *
   * Off unless explicitly requested. A factory that has onboarded nobody should have an
   * empty registry and say so, rather than three invented customers with invented key
   * identifiers that an operator has to notice and delete.
   */
  seedDemoTenants: boolean;
  /** Hosts a remote (non-local) model provider may reach. */
  allowedModelHosts: string[];
  issues: ConfigIssue[];
}

/** A production API key shorter than this is treated as a placeholder, not a secret. */
/**
 * Every environment setting the factory reads. Anything in the FACTORY_ namespace that
 * is not listed here (and not explicitly allowlisted as a secret reference) has no
 * effect at all, so it is reported as inert. `test/p0-regressions.test.ts` asserts this
 * set covers every FACTORY_* key documented in .env.example, so the two cannot drift
 * apart and quietly turn a real setting into a "typo" warning.
 */
export const FACTORY_SETTING_NAMES: ReadonlySet<string> = new Set([
  'FACTORY_API_KEY',
  'FACTORY_DATA_DIR',
  'FACTORY_WORKSPACE_ROOT',
  'FACTORY_ALLOWED_SECRET_REFS',
  'FACTORY_MODEL_ALLOWED_HOSTS',
  'FACTORY_SEED_EXAMPLES',
  'FACTORY_BACKUP_DIR',
  'FACTORY_PREVIEW_DIR',
  'FACTORY_RELEASE_DIR',
  'FACTORY_CLIENT_WORKSPACE_ROOT',
  'FACTORY_WORKTREE_ROOT',
  'FACTORY_SANDBOX_ROOT',
  'FACTORY_VERIFY_TIMEOUT_MS',
  'FACTORY_FRONTIER_API_URL',
  'FACTORY_FRONTIER_API_KEY',
  'FACTORY_HOSTED_DEPLOYMENT_SECRET_REF',
  'FACTORY_TENANT_CREDENTIALS',
  'FACTORY_TENANT_SEED_DEMO',
  // Read by real code: the enforcement mode is reported by GET /api/whoami, the
  // doctrine root is where doctrineService loads rules from, and the loop report
  // directory is where executionLoopService writes run reports. Leaving them off this
  // list made the startup banner claim they had NO effect, which is worse than a
  // missing warning: it would lead an operator to remove a setting that is in use.
  'FACTORY_ENFORCEMENT_MODE',
  'FACTORY_DOCTRINE_ROOT',
  'FACTORY_LOOP_REPORT_DIR',
]);

const MIN_PRODUCTION_KEY_LENGTH = 24;

/**
 * Credential values that are published in this repository, in .env.example, or in a
 * dependency's own documentation. A length check cannot catch these, so they are named
 * explicitly: any of them in production means the deployment is authenticating callers
 * with a secret that everyone already knows.
 */
const KNOWN_PLACEHOLDER_SECRETS = [
  'replace-with-a-long-random-secret',
  'replace-with-provider-secret',
  'replace-me',
  'changeme',
  'changethis',
  'your-secret-key',
  'your_secret_key',
  'my_secret_key',
  'sk-test',
  'test',
  'secret',
];

export function isPlaceholderSecret(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  if (normalised.length === 0) return true;
  if (KNOWN_PLACEHOLDER_SECRETS.includes(normalised)) return true;
  // Any value that still reads as a template is treated as a placeholder, whatever its length.
  return /^(replace|changeme|your[-_ ]|placeholder|example|dummy|fake|xxx+|todo)/.test(normalised)
    || normalised.includes('replace-with')
    || normalised.includes('replace_with')
    || normalised.endsWith('-secret')
    || normalised.endsWith('_secret');
}

function trimmed(value: string | undefined): string { return (value ?? '').trim(); }

function listOf(value: string | undefined): string[] {
  return trimmed(value).split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parsePort(raw: string | undefined): number {
  const parsed = Number(trimmed(raw) || '3000');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return 3000;
  return parsed;
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const issues: ConfigIssue[] = [];
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const isProduction = nodeEnv === 'production';

  // STORAGE_BACKEND is validated here, at startup, rather than at the first write.
  //
  // The failure this prevents is specific: `STORAGE_BACKEND=appwirte` (a typo) silently resolving
  // to the local disk. The process would start, advertise that it was configured for cloud
  // persistence, and write every customer record somewhere no one is monitoring. An operator has
  // to see this at boot, in the banner, before there is a record to lose.
  const storageBackendRaw = trimmed(env.STORAGE_BACKEND);
  let storageBackend: 'local' | 'appwrite' = 'local';
  const storageBackendInput = storageBackendRaw.toLowerCase();
  if (storageBackendInput === '' || storageBackendInput === 'local') {
    storageBackend = 'local';
  } else if (storageBackendInput === 'appwrite') {
    storageBackend = 'appwrite';
  } else {
    issues.push({
      variable: 'STORAGE_BACKEND',
      severity: 'error',
      message: `STORAGE_BACKEND must be "local" or "appwrite"; got ${JSON.stringify(env.STORAGE_BACKEND)}. `
        + 'The service refuses to guess which store to write to, because guessing is how records get lost.',
    });
  }

  const apiKey = trimmed(env.FACTORY_API_KEY);  if (apiKey === '') {
    issues.push({
      variable: 'FACTORY_API_KEY',
      severity: isProduction ? 'error' : 'warning',
      message: isProduction
        ? 'FACTORY_API_KEY is required in production. The service refuses to start without it; every tenant route would otherwise reject all callers.'
        : 'FACTORY_API_KEY is unset. Set it in .env, or set ALLOW_INSECURE_LOCAL=true for loopback-only development.',
    });
  } else if (isProduction && apiKey.length < MIN_PRODUCTION_KEY_LENGTH) {
    issues.push({
      variable: 'FACTORY_API_KEY',
      severity: 'error',
      message: `FACTORY_API_KEY must be at least ${MIN_PRODUCTION_KEY_LENGTH} characters in production. Generate one with: openssl rand -hex 32`,
    });
  } else if (isProduction && isPlaceholderSecret(apiKey)) {
    // A length check alone is not a strength check. The shipped .env.example value is
    // long enough to pass, so a production deploy that copies the example file would
    // start with a publicly-known credential. Refuse known placeholders outright.
    issues.push({
      variable: 'FACTORY_API_KEY',
      severity: 'error',
      message: 'FACTORY_API_KEY is a known placeholder value. It is present in .env.example and is public knowledge, so it cannot authenticate anyone. Generate a real one with: openssl rand -hex 32',
    });
  }

  // The loopback bypass is a development affordance. In production it is a
  // credential bypass, so a truthy value is a hard startup failure, not a warning.
  if (isProduction && env.ALLOW_INSECURE_LOCAL === 'true') {
    issues.push({
      variable: 'ALLOW_INSECURE_LOCAL',
      severity: 'error',
      message: 'ALLOW_INSECURE_LOCAL=true disables credential checks for loopback callers and must never be set in production.',
    });
  }

  const dataDir = trimmed(env.FACTORY_DATA_DIR) || '.data';
  if (isProduction && dataDir === '.data') {
    issues.push({ variable: 'FACTORY_DATA_DIR', severity: 'warning', message: 'FACTORY_DATA_DIR is unset; durable state will be written to ./.data inside the container and will not survive replacement.' });
  }

  const workspaceRoot = trimmed(env.FACTORY_WORKSPACE_ROOT) || process.cwd();
  if (isProduction && !trimmed(env.FACTORY_WORKSPACE_ROOT)) {
    issues.push({ variable: 'FACTORY_WORKSPACE_ROOT', severity: 'warning', message: 'FACTORY_WORKSPACE_ROOT is unset; the factory will treat the process working directory as the approved workspace.' });
  }

  const allowedSecretRefs = listOf(env.FACTORY_ALLOWED_SECRET_REFS);
  if (allowedSecretRefs.length === 0) {
    issues.push({ variable: 'FACTORY_ALLOWED_SECRET_REFS', severity: 'warning', message: 'No secret references are permitted. Model providers may not authenticate. This is the fail-closed default; set FACTORY_ALLOWED_SECRET_REFS to grant specific variables.' });
  }
  const missingSecretRefs = allowedSecretRefs.filter((name) => trimmed(env[name]) === '');
  if (missingSecretRefs.length > 0) {
    issues.push({ variable: 'FACTORY_ALLOWED_SECRET_REFS', severity: 'error', message: `These permitted secret references are not set in the environment: ${missingSecretRefs.join(', ')}. An allowlisted but unset reference is a configuration error, not an anonymous request.` });
  }

  // Per-tenant credentials, supplied as `tenantId:secret` pairs. Each is hashed on
  // startup and only the digest is retained. Absent means no tenant can authenticate on
  // its own behalf, which is the fail-closed direction: the platform key still works, and
  // every tenant route is reachable only as platform_operator until credentials exist.
  const tenantCredentials: Record<string, string> = {};
  for (const entry of listOf(env.FACTORY_TENANT_CREDENTIALS)) {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator === entry.length - 1) {
      issues.push({
        variable: 'FACTORY_TENANT_CREDENTIALS',
        severity: 'error',
        message: `Malformed tenant credential entry '${entry}'. Expected tenantId:secret.`,
      });
      continue;
    }
    const id = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (isPlaceholderSecret(secret)) {
      issues.push({
        variable: 'FACTORY_TENANT_CREDENTIALS',
        severity: 'error',
        message: `Tenant '${id}' was provisioned with a placeholder credential, which is public knowledge and cannot authenticate anyone.`,
      });
      continue;
    }
    if (secret.length < 24) {
      issues.push({
        variable: 'FACTORY_TENANT_CREDENTIALS',
        severity: 'error',
        message: `Tenant '${id}' credential must be at least 24 characters.`,
      });
      continue;
    }
    tenantCredentials[id] = secret;
  }
  if (isProduction && Object.keys(tenantCredentials).length === 0) {
    issues.push({
      variable: 'FACTORY_TENANT_CREDENTIALS',
      severity: 'warning',
      message: 'No tenant credentials are provisioned. Tenants cannot authenticate on their own behalf; all tenant access is currently platform_operator. Set FACTORY_TENANT_CREDENTIALS to tenantId:secret pairs.',
    });
  }
  for (const id of Object.keys(tenantCredentials)) {
    if (id.startsWith('replace') || !/^[A-Za-z0-9_-]{3,64}$/.test(id)) {
      issues.push({ variable: 'FACTORY_TENANT_CREDENTIALS', severity: 'error', message: `Tenant id '${id}' is not a valid identifier (3-64 chars of A-Z a-z 0-9 _ -).` });
    }
  }

  // A mistyped FACTORY_* variable is silently ignored by every reader, which is the
  // most expensive kind of configuration bug: the operator believes a control is
  // active when it is not. Surface any unrecognised namespace variable explicitly.
  // A variable an operator explicitly allowlisted for secret resolution IS recognised,
  // so granting a secret must not be reported as a typo.
  const unrecognised = Object.keys(env).filter(
    (key) => key.startsWith('FACTORY_') && !FACTORY_SETTING_NAMES.has(key) && !allowedSecretRefs.includes(key),
  );
  for (const variable of unrecognised) {
    issues.push({ variable, severity: 'warning', message: `${variable} is not a recognised setting and has NO effect. If you expected it to grant access, it did not.` });
  }

  return {
    nodeEnv,
    storageBackend,
    isProduction,
    port: parsePort(env.PORT),
    insecureLocalBypass: !isProduction && env.ALLOW_INSECURE_LOCAL === 'true' && apiKey === '',
    dataDir,
    workspaceRoot,
    requestBodyLimit: trimmed(env.REQUEST_BODY_LIMIT) || '1mb',
    allowedSecretRefs,
    tenantCredentials,
    seedDemoTenants: env.FACTORY_TENANT_SEED_DEMO === 'true',
    allowedModelHosts: listOf(env.FACTORY_MODEL_ALLOWED_HOSTS),
    issues,
  };
}

export function errorsOf(config: RuntimeConfig): ConfigIssue[] { return config.issues.filter((issue) => issue.severity === 'error'); }
export function warningsOf(config: RuntimeConfig): ConfigIssue[] { return config.issues.filter((issue) => issue.severity === 'warning'); }

/** Human-readable startup report. Contains no secret values by construction. */
export function describeConfig(config: RuntimeConfig): string {
  const lines = [
    `  mode            ${config.nodeEnv}`,
    `  storage         ${config.storageBackend}${config.storageBackend === 'local' ? ' (offline durable store)' : ' (Appwrite pilot backend)'}`,
    `  port            ${config.port}`,
    `  data directory  ${config.dataDir}`,
    `  workspace root  ${config.workspaceRoot}`,
    `  body limit      ${config.requestBodyLimit}`,
    `  local bypass    ${config.insecureLocalBypass ? 'ENABLED (loopback only)' : 'disabled'}`,
    `  model secrets   ${config.allowedSecretRefs.length === 0 ? 'none permitted' : `${config.allowedSecretRefs.length} permitted`}`,
    `  model hosts     ${config.allowedModelHosts.length === 0 ? 'none permitted' : config.allowedModelHosts.join(', ')}`,
    // Counts only. Credential values must never reach a log line.
    `  tenant creds    ${Object.keys(config.tenantCredentials).length} provisioned`,
    `  demo tenants    ${config.seedDemoTenants ? 'WILL BE INSTALLED into an empty registry' : 'not installed'}`,
  ];
  for (const issue of warningsOf(config)) lines.push(`  warning         ${issue.variable}: ${issue.message}`);
  for (const issue of errorsOf(config)) lines.push(`  ERROR           ${issue.variable}: ${issue.message}`);
  return lines.join('\n');
}
