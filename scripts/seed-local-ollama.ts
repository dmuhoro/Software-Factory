import { FrontierModelService } from '../src/services/frontierModelService';

// This script is run at startup (e.g. via `npm start` or a CI step) to ensure a local Ollama
// provider is always available for the platform_operator tenant (empty tenantId).

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
    console.log('✅ Seeded local Ollama provider');
  } else {
    console.log('ℹ️ Local Ollama provider already present');
  }
}

// If the file is executed directly, run the seeding immediately.
if (import.meta.url.endsWith(process.argv[1])) {
  seedLocalOllama();
}
