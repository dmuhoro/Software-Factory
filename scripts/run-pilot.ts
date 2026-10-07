import { FrontierModelService } from '../src/services/frontierModelService';
import { execFileSync } from 'child_process';
import path from 'path';

(async () => {
  // Register a local Ollama provider for the default tenant (empty string means platform_operator)
  const provider = FrontierModelService.register({
    tenantId: '',
    id: 'local-ollama',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelIds: ['qwen2.5-coder:3b', 'gpt-oss:20b-cloud'],
    timeoutMs: 300_000,
  });
  console.log('Registered provider', provider.id);

  // Register the same provider for the 'default' tenant the unattended loop uses
  const providerDefault = FrontierModelService.register({
    tenantId: 'default',
    id: 'local-ollama',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelIds: ['qwen2.5-coder:3b', 'gpt-oss:20b-cloud'],
    timeoutMs: 300_000,
  });
  console.log('Registered provider default', providerDefault.id);

  // Run the factory loop against Daftari with the pilot task document
  const daftariPath = path.resolve('..', 'Daftari');
  const taskPath = path.resolve('tasks', 'daftari-pilot-toast-i18n.md');
  const cmd = ['scripts/run-factory-loop.ts', '--repo', daftariPath, '--task', taskPath];
  console.log('Executing loop:', cmd.join(' '));
  try {
    const out = execFileSync('npx', ['tsx', ...cmd], { stdio: 'inherit' });
  } catch (e) {
    console.error('Loop execution failed', e);
    process.exit(1);
  }
})();
