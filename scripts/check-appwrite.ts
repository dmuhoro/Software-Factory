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
 */

import { checkAppwriteReachable } from '../src/services/appwriteClient';
import { resolveAppwriteConfig } from '../src/configurations/appwrite.config';

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
  console.log('\n  This is the honest state, and it is better than the one this check replaced:');
  console.log('  an unconfigured integration that reports itself as unconfigured.');
  console.log('\n  To fix, either:');
  console.log('    - export APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY, or');
  console.log('    - accept that this deployment runs on the local durable store and the Appwrite');
  console.log('      adapter is unused. That is a supported mode; it is not a configured one.');
  return 1;
}

process.exit(await main());
