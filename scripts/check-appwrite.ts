/**
 * Live Appwrite connectivity check.
 *
 * Run with: npm run appwrite:check
 *
 * This is the only command in the repository that can honestly claim the Appwrite integration
 * works, because it is the only one that makes a real authenticated call against the project.
 * Everything else -- the unit tests, the harnesses, the image gate -- runs without a credential
 * and therefore cannot distinguish "integrated" from "installed".
 *
 * It fails closed. Unconfigured is an exit code, not a warning, because the alternative is the
 * state this repository shipped: a configuration that looked complete and contacted nothing.
 *
 * The key is never printed. Only its presence, length-independent.
 *
 * It loads the repository `.env` itself. This was reported as broken twice: a correctly configured
 * `.env`, key present, and the check announcing `api key: (unset)`. It was reading `process.env`
 * only, so `npm run appwrite:check` worked for whoever remembered to `set -a && . ./.env` first
 * and failed for everyone who followed the documented command. An operator tool that silently
 * depends on an undocumented shell incantation is not a usable tool. Real environment variables
 * still win over the file, so CI and tests are unaffected.
 */

import { existsSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { checkAppwriteReachable } from '../src/services/appwriteClient';
import { resolveAppwriteConfig } from '../src/configurations/appwrite.config';

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolvePath(REPO_ROOT, '.env');

if (existsSync(ENV_FILE)) {
  loadDotenv({ path: ENV_FILE });
}

const GREEN = '[32m';
const RED = '[31m';
const YELLOW = '[33m';
const RESET = '[0m';

async function main(): Promise<number> {
  const settings = resolveAppwriteConfig();
  const result = await checkAppwriteReachable();

  console.log('\nAppwrite integration check');
  console.log('=========================');
  console.log(`  endpoint  : ${settings.endpoint || '(unset)'}`);
  console.log(`  project   : ${settings.projectId || '(unset)'}`);
  console.log(`  database  : ${result.expected.databaseId}`);
  console.log(`  api key   : ${settings.apiKey ? 'present (not shown)' : '(unset)'}`);

  if (settings.issues.length > 0) {
    console.log('\nConfiguration issues:');
    for (const issue of settings.issues) {
      const colour = issue.severity === 'error' ? RED : YELLOW;
      console.log(`  ${colour}${issue.severity.toUpperCase()}${RESET} ${issue.variable}: ${issue.message}`);
    }
  }

  console.log(`\n  tables expected: ${result.expected.collections.join(', ')}`);

  if (result.reachable && result.authenticated) {
    console.log(`\n${GREEN}PASS${RESET}  ${result.detail}`);
    console.log('\n  The integration is real: endpoint, project id and API key were accepted by');
    console.log('  Appwrite, and the database and table this product reads were found.');
    return 0;
  }

  console.log(`\n${RED}FAIL${RESET}  ${result.detail}`);

  // Advice that matches the cause. This used to print the same two suggestions for every failure,
  // including "export APPWRITE_API_KEY" when the key was already exported and Appwrite had just
  // rejected it. Advice an operator cannot act on is worse than no advice, because the next thing
  // they do is stop reading the output of this command -- which is the failure mode the probe's own
  // comment warns about when it explains why a valid key can look broken.
  const advice: Record<string, string[]> = {
    'not-configured': [
      'export APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY, or',
      'accept that this deployment runs on the local durable store and the Appwrite',
      'adapter is unused. That is a supported mode; it is not a configured one.',
    ],
    unauthorized: [
      `Appwrite received the key and refused it (401), so the variables are set correctly and the`,
      `credential is the problem. In order of likelihood:`,
      '',
      `  1. The key has no scopes assigned. Appwrite creates a key with an empty scope set, and an`,
      `     empty scope set is rejected on every data-plane call with exactly this error. Open the`,
      `     project console, then Overview > Integrations > API keys, edit this key, and grant the`,
      `     scopes this product needs to read and write tables in ${result.expected.databaseId}.`,
      '  2. The key belongs to a different project than the one in APPWRITE_PROJECT_ID.',
      '  3. The key was revoked or is still propagating after being created.',
      '',
      'Do not rotate the key again before checking its scopes; rotation cannot fix a missing grant.',
    ],
    forbidden: [
      'The key authenticated but is not permitted this operation (403), which means the key is',
      'valid and its scope set is too narrow. Add the missing scope for this project in the',
      'Appwrite console rather than replacing the credential.',
    ],
    'not-found': [
      'The endpoint answered but the project or database named here does not exist (404). Check',
      `APPWRITE_PROJECT_ID and APPWRITE_DATABASE_ID against the console. Provisioning is a`,
      'separate, explicit step; this check never creates anything.',
    ],
    network: [
      'The request never completed, so nothing can be concluded about the key. This endpoint has',
      'been intermittent from this host. Retry, and only treat it as a credential problem if it',
      'persists alongside a successful call to a known-good project.',
    ],
    'not-provisioned': [
      'The credential works. The database has not been provisioned in this project yet. Run the',
      'provisioner explicitly, and re-run this check.',
    ],
    unknown: [
      'Appwrite answered with a status this check does not classify. The raw detail above names it;',
      'read it before changing anything.',
    ],
  };

  console.log('');
  for (const line of advice[result.failure] ?? advice.unknown ?? []) console.log(`  ${line}`);
  return 1;
}

process.exit(await main());
