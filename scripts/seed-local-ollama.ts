import { FrontierModelService } from '../src/services/frontierModelService';

// This script is run at startup (e.g. via `npm start` or a CI step) to ensure a local Ollama
// provider is always available for the platform_operator tenant (empty tenantId).  It also
// registers the same local provider for the default tenant so that the unattended loop
// (which defaults to tenant 'default') can resolve the model without an explicit --tenant flag.

export function seedLocalOllama() {
  // Register only if it does not already exist – FrontierModelService.get returns undefined
  const existing = FrontierModelService.get('', 'local-ollama');
  if (!existing) {
    FrontierModelService.register({
      tenantId: '', // platform_operator tenant (no isolation)
      id: 'local-ollama',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelIds: ['qwen2.5-coder:3b', 'gpt-oss:20b-cloud'],
      timeoutMs: 300_000, // 5 min – ample for large completions
    });
    console.log('✅ Seeded local Ollama provider for platform_operator tenant');
  } else {
    console.log('ℹ️ Local Ollama provider already present for platform_operator tenant');
  }

  // Register same provider for the 'default' tenant used by the unattended loop.
  const existingDefault = FrontierModelService.get('default', 'local-ollama');
  if (!existingDefault) {
    FrontierModelService.register({
      tenantId: 'default', // default tenant used by the unattended loop
      id: 'local-ollama',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelIds: ['qwen2.5-coder:3b', 'gpt-oss:20b-cloud'],
      timeoutMs: 300_000, // 5 min – ample for large completions
    });
    console.log('✅ Seeded local Ollama provider for default tenant');
  } else {
    console.log('ℹ️ Local Ollama provider already present for default tenant');
  }
}

// If the file is executed directly, run the seeding immediately.
if (import.meta.url.endsWith(process.argv[1])) {
  seedLocalOllama();
}
