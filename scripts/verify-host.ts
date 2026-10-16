/**
 * `verify:host` — the executor-host preflight (ADR-014, Sprint 31 WP-4).
 *
 * ## Why this exists
 *
 * ADR-014 says the unattended loop runs on one operator-owned Linux host, privately. Three
 * of its decisions are properties of the *host*, not of the code: bubblewrap must be able
 * to create a container, the listener must not be on the open internet, and the runner
 * account must not be able to read the operator's credentials. A deployment that gets any
 * of these wrong still starts, still serves /health, and still looks fine — until a
 * sandboxed verification command is refused mid-run, or the API answers a request that
 * arrived from the open internet.
 *
 * This is the named command that answers "is this host the host ADR-014 describes?" before
 * work is submitted to it.
 *
 * ## It reuses the production check
 *
 * The bubblewrap decision is not re-implemented here. This calls `preflightSandbox` —
 * the same function the loop calls at the run boundary — so a preflight that passes here
 * is a preflight that will pass for a real run. A second, independent check of the same
 * fact would be a gate that could disagree with the product it gates.
 *
 * ## Fail closed
 *
 * Every required check that cannot run is a failure, not a skip. A preflight that cannot
 * determine whether the host is safe must refuse, because the thing it cannot determine is
 * whether the next unattended run is sandboxed.
 *
 * Usage:
 *   npx tsx scripts/verify-host.ts                     # full preflight
 *   npx tsx scripts/verify-host.ts --bind-only         # only the listener checks (CI)
 *
 * Exit codes: 0 every required check held; 1 a check failed; 2 the script could not run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { preflightSandbox, resolveSandboxBinary } from '../src/services/sandboxPreflightService';

interface CheckResult {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  remediation?: string;
}

const results: CheckResult[] = [];

function record(check: Omit<CheckResult, 'ok'> & { ok: boolean }): void {
  results.push(check);
  const tag = check.ok ? 'PASS' : check.required ? 'FAIL' : 'WARN';
  console.log(`  ${tag}  ${check.name} — ${check.detail}`);
  if (!check.ok && check.remediation) console.log(`        fix: ${check.remediation}`);
}

function section(title: string): void {
  console.log(`\n═══ ${title} ═══`);
}

/**
 * The sandbox check, delegated to the production preflight.
 *
 * The loop's own doctrine decides whether the sandbox is required. This preflight runs the
 * check in "enabled" mode regardless, because the executor host exists to run sandboxed
 * work: a host that cannot sandbox is not an executor host, even if today's doctrine
 * happens to have the sandbox off.
 */
function checkSandbox(): void {
  section('the host can create a sandboxed container (ADR-014 §5)');
  const resolved = resolveSandboxBinary('bwrap');
  const result = preflightSandbox({ enabled: true, backend: 'bwrap', bwrapBinary: resolved ?? 'bwrap', enableNetwork: false, writableDirs: [] });
  record({
    name: 'bubblewrap can create a container',
    ok: result.ok,
    required: true,
    detail: result.detail,
    remediation: result.remediation ?? 'install bubblewrap (for example: apt-get install -y bubblewrap)',
  });
}

/**
 * The bind policy, as a pure function.
 *
 * The parser in `runtimeConfig` validates *syntax* — it cannot know which deployment it is
 * in, and a pod binding 0.0.0.0 is normal. This is the *policy* half: on the executor host
 * (ADR-014 §4) the listener must be loopback or on the operator's tailnet, because the
 * operator reaches it over Tailscale and the open internet must not. Exported so a test can
 * assert the policy directly, rather than only through a script that also touches the
 * filesystem and the network.
 */
export function evaluateBindHost(raw: string | undefined): { ok: boolean; detail: string; remediation?: string } {
  const value = (raw ?? '').trim();
  if (value === '') {
    return {
      ok: false,
      detail: 'FACTORY_BIND_HOST is unset, so the service binds 0.0.0.0 — every interface, including the public one',
      remediation: 'set FACTORY_BIND_HOST=127.0.0.1 in the service environment and reach it over Tailscale',
    };
  }
  const isLoopback = value === 'localhost' || value === '127.0.0.1' || value === '::1' || value.startsWith('127.');
  // Tailscale's CGNAT range 100.64.0.0/10 is a private address on the operator's tailnet.
  const isTailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value);
  if (isLoopback || isTailnet) {
    return { ok: true, detail: `${value} is ${isLoopback ? 'loopback' : 'on the tailnet'}` };
  }
  return {
    ok: false,
    detail: `FACTORY_BIND_HOST=${value} is a public bind; the executor host must not answer the open internet`,
    remediation: 'set FACTORY_BIND_HOST=127.0.0.1 and reach it over Tailscale',
  };
}

/**
 * The listener must not be on the open internet (ADR-014 §4).
 *
 * The API binds to whatever FACTORY_BIND_HOST says. On the executor host that must be a
 * loopback or otherwise private address, with the operator reaching it over the tailnet.
 * A public bind on the executor host is the exact exposure ADR-014 exists to prevent.
 */
function checkBind(): void {
  section('the listener is not on the open internet (ADR-014 §4)');
  const verdict = evaluateBindHost(process.env.FACTORY_BIND_HOST);
  record({ name: 'FACTORY_BIND_HOST is set to a private address', ok: verdict.ok, required: true, detail: verdict.detail, remediation: verdict.remediation });
}

/** The runner account must exist and must not be root or privileged (ADR-014 §2). */
function checkRunner(): void {
  section('the loop runs as a dedicated unprivileged user (ADR-014 §2)');
  const user = process.env.FACTORY_RUNNER_USER || 'runner';
  let entry: string | undefined;
  try {
    entry = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim();
  } catch {
    entry = undefined;
  }
  if (!entry) {
    record({
      name: `user '${user}' exists`,
      ok: false,
      required: true,
      detail: `no passwd entry for '${user}'`,
      remediation: 'run software_factory/host/provision-executor-host.sh, or create the runner account',
    });
    return;
  }
  record({ name: `user '${user}' exists`, ok: true, required: true, detail: entry.split(':')[0] });

  const uid = Number(entry.split(':')[2]);
  const gid = Number(entry.split(':')[3]);
  if (uid === 0) {
    record({ name: 'the runner is not root', ok: false, required: true, detail: `'${user}' has uid 0; a run that escapes the sandbox would own the host`, remediation: 'give the runner an unprivileged uid' });
  } else {
    record({ name: 'the runner is not root', ok: true, required: true, detail: `uid ${uid} gid ${gid}` });
  }

  // A runner in the sudo group can escalate; ADR-014 §2 says it has no sudo.
  let groups = '';
  try {
    groups = execFileSync('id', ['-nG', user], { encoding: 'utf8' }).trim();
  } catch {
    groups = '';
  }
  const privileged = groups.split(/\s+/).filter((g) => g === 'sudo' || g === 'wheel' || g === 'root');
  if (privileged.length > 0) {
    record({ name: 'the runner cannot sudo', ok: false, required: true, detail: `'${user}' is in privileged group(s): ${privileged.join(', ')}`, remediation: 'remove the runner from the sudo/wheel group' });
  } else {
    record({ name: 'the runner cannot sudo', ok: true, required: true, detail: groups ? `groups: ${groups}` : 'no privileged groups' });
  }
}

/** The credential file must be mode 600 and readable only by the operator (ADR-014 §3). */
function checkSecrets(): void {
  section('credentials are unreadable by the runner (ADR-014 §3)');
  const candidates = [process.env.FACTORY_HOST_SECRETS_FILE, '/etc/software-factory/secrets.env'].filter(Boolean) as string[];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    record({
      name: 'a credential file exists and is mode 600',
      ok: false,
      required: true,
      detail: `no credential file found (looked at ${candidates.join(', ')})`,
      remediation: 'install the credentials at /etc/software-factory/secrets.env, mode 600, owner root — systemd grants them to the service, the runner cannot read them',
    });
    return;
  }
  const mode = fs.statSync(found).mode & 0o777;
  const uid = fs.statSync(found).uid;
  if (mode !== 0o600) {
    record({ name: 'a credential file exists and is mode 600', ok: false, required: true, detail: `${found} is mode ${mode.toString(8)}, not 600`, remediation: `chmod 600 ${found}` });
  } else if (uid !== 0) {
    record({ name: 'a credential file exists and is mode 600', ok: false, required: true, detail: `${found} is owned by uid ${uid}, not root; the runner must not be able to grant it to itself`, remediation: `chown root:root ${found}` });
  } else {
    record({ name: 'a credential file exists and is mode 600', ok: true, required: true, detail: `${found} mode 600 owner root` });
  }
}

/** The hardened unit must be installed, and must carry every directive ADR-014 §6 names. */
function checkUnit(): void {
  section('the service is a hardened systemd unit (ADR-014 §6)');
  const unitPath = process.env.FACTORY_UNIT_PATH || '/etc/systemd/system/software-factory-executor.service';
  if (!fs.existsSync(unitPath)) {
    record({
      name: 'the executor unit is installed',
      ok: false,
      required: true,
      detail: `${unitPath} does not exist`,
      remediation: 'run software_factory/host/provision-executor-host.sh to install the unit',
    });
    return;
  }
  record({ name: 'the executor unit is installed', ok: true, required: true, detail: unitPath });
  const unit = fs.readFileSync(unitPath, 'utf8');
  const required = ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'Restart=on-failure'];
  const missing = required.filter((directive) => !unit.includes(directive));
  if (missing.length > 0) {
    record({ name: 'the unit carries every hardening directive', ok: false, required: true, detail: `missing: ${missing.join(', ')}`, remediation: 'reinstall the unit from software_factory/host/software-factory-executor.service' });
  } else {
    record({ name: 'the unit carries every hardening directive', ok: true, required: true, detail: required.join(', ') });
  }
}

/** The workspace the loop commits into must be owned by the runner and writable by it. */
function checkWorkspace(): void {
  section('the workspace is owned by the runner');
  const workspace = process.env.FACTORY_WORKSPACE_ROOT;
  if (!workspace) {
    record({ name: 'FACTORY_WORKSPACE_ROOT is set', ok: false, required: true, detail: 'FACTORY_WORKSPACE_ROOT is unset; the loop has nowhere approved to commit', remediation: 'set FACTORY_WORKSPACE_ROOT to the runner-owned workspace (default: /home/runner/workspace)' });
    return;
  }
  if (!fs.existsSync(workspace)) {
    record({ name: 'the workspace exists', ok: false, required: true, detail: `${workspace} does not exist`, remediation: `mkdir -p ${workspace} && chown runner:runner ${workspace}` });
    return;
  }
  const stat = fs.statSync(workspace);
  record({ name: 'the workspace exists', ok: true, required: true, detail: `${workspace} owned by uid ${stat.uid}` });
  try {
    fs.accessSync(workspace, fs.constants.W_OK);
    record({ name: 'the workspace is writable', ok: true, required: true, detail: 'writable by this user' });
  } catch {
    record({ name: 'the workspace is writable', ok: false, required: true, detail: `${workspace} is not writable by uid ${process.getuid?.() ?? '?'}`, remediation: `chown the workspace to the runner (uid of '${process.env.FACTORY_RUNNER_USER || 'runner'}')` });
  }
}

/** The single-writer property: two processes must not own the ledger (NC-2). */
function checkSingleWriter(): void {
  section('the ledger has one writer (NC-2)');
  const dataDir = process.env.FACTORY_DATA_DIR;
  if (!dataDir) {
    record({ name: 'FACTORY_DATA_DIR is set', ok: false, required: true, detail: 'FACTORY_DATA_DIR is unset; the durable ledger has no home', remediation: 'set FACTORY_DATA_DIR to the runner-owned data directory' });
    return;
  }
  const probe = path.join(dataDir, '.writer-probe');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // A second writer on the same ledger silently drops the first's records. The only
    // honest claim is that this host runs one executor service; the unit enforces that
    // with a single instance and no clustering. Here we only prove the ledger is
    // reachable and this process could claim it.
    fs.writeFileSync(probe, String(process.pid));
    fs.unlinkSync(probe);
    record({ name: 'the ledger directory is writable by the executor', ok: true, required: true, detail: dataDir });
  } catch (error) {
    record({ name: 'the ledger directory is writable by the executor', ok: false, required: true, detail: `cannot write ${dataDir}: ${error instanceof Error ? error.message : String(error)}`, remediation: `chown the data directory to the runner` });
  }
}

function main(): number {
  const bindOnly = process.argv.includes('--bind-only');
  console.log(`verify:host — executor-host preflight (ADR-014) on ${os.hostname()}`);
  if (bindOnly) {
    checkBind();
  } else {
    checkSandbox();
    checkBind();
    checkRunner();
    checkSecrets();
    checkUnit();
    checkWorkspace();
    checkSingleWriter();
  }

  const failedRequired = results.filter((check) => check.required && !check.ok);
  const passed = results.filter((check) => check.ok).length;
  console.log(`\n════ VERIFY HOST: ${passed} passed, ${failedRequired.length} required check(s) failed ════`);
  if (failedRequired.length > 0) {
    console.log('This host is not the host ADR-014 describes. The loop must not be run here until every failure above is fixed.');
    return 1;
  }
  return 0;
}

// Only run the preflight when this file is the entry point. A test imports the module to
// assert `evaluateBindHost` directly, and must not have the filesystem and systemd checks
// fire on import.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('verify-host.ts')) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`verify:host could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
