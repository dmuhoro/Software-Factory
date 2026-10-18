#!/usr/bin/env tsx
/**
 * `npm run register:model-providers`
 *
 * Registers cloud model providers at startup so the unattended loop can dial them.
 *
 * Reads provider configuration from environment variables and registers each one through
 * `FrontierModelService.register()`, which validates the base URL against
 * `FACTORY_MODEL_ALLOWED_HOSTS` and the secret reference against
 * `FACTORY_ALLOWED_SECRET_REFS` — fail closed. A provider whose host or secret reference is
 * not permitted is not registered, and the script exits non-zero.
 *
 * Environment:
 *   FACTORY_MODEL_PROVIDERS   comma-separated provider IDs to register (e.g. deepseek,together,mistral,nvidia,openai)
 *   {ID}_BASE_URL             OpenAI-compatible base URL for provider {ID} (required, remote kinds)
 *   {ID}_SECRET_REF           env var NAME holding provider {ID}'s API key (must be in FACTORY_ALLOWED_SECRET_REFS)
 *   {ID}_MODEL_IDS            comma-separated model IDs the provider serves (default: [])
 *   {ID}_KIND                 provider kind: openai-compatible | gemini-native | local (default: openai-compatible)
 *
 * Example (.env, server-side only — never committed):
 *   FACTORY_MODEL_PROVIDERS=deepseek,together,mistral,nvidia,openai
 *   FACTORY_ALLOWED_SECRET_REFS=DEEPSEEK_API_KEY,TOGETHER_API_KEY,MISTRAL_API_KEY,NVIDIA_API_KEY,OPENAI_API_KEY
 *   FACTORY_MODEL_ALLOWED_HOSTS=api.deepseek.com,api.together.xyz,api.mistral.ai,integrate.api.nvidia.com,api.openai.com
 *   DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
 *   DEEPSEEK_SECRET_REF=DEEPSEEK_API_KEY
 *   DEEPSEEK_MODEL_IDS=deepseek-chat,deepseek-coder
 *   ...
 */

import { FrontierModelService } from '../src/services/frontierModelService';

type ProviderKind = 'openai-compatible' | 'gemini-native' | 'local';

interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  baseUrl?: string;
  secretRef?: string;
  modelIds: string[];
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function providerConfig(id: string): ProviderConfig | undefined {
  const upper = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const baseUrl = process.env[`${upper}_BASE_URL`];
  const secretRef = process.env[`${upper}_SECRET_REF`];
  const modelIds = envList(`${upper}_MODEL_IDS`);
  const kindRaw = process.env[`${upper}_KIND`] ?? 'openai-compatible';
  const kind = ['openai-compatible', 'gemini-native', 'local'].includes(kindRaw)
    ? (kindRaw as ProviderKind)
    : 'openai-compatible';
  if (!baseUrl && kind !== 'local') return undefined;
  return { id, kind, baseUrl: baseUrl?.trim() || undefined, secretRef: secretRef?.trim() || undefined, modelIds };
}

async function main(): Promise<void> {
  const providerIds = envList('FACTORY_MODEL_PROVIDERS');
  if (providerIds.length === 0) {
    console.log('FACTORY_MODEL_PROVIDERS is unset: no cloud providers registered. The loop uses doctrine defaults only.');
    process.exit(0);
  }

  const errors: string[] = [];
  for (const id of providerIds) {
    const config = providerConfig(id);
    if (!config) {
      errors.push(`${id}: missing ${id.toUpperCase()}_BASE_URL for remote provider`);
      continue;
    }
    try {
      FrontierModelService.register({
        tenantId: 'factory',
        id: config.id,
        kind: config.kind,
        baseUrl: config.baseUrl,
        modelIds: config.modelIds,
        secretRef: config.secretRef,
        enabled: true,
      });
      console.log(`registered  ${config.id}/${config.modelIds.join(',') || '(no models declared)'}  kind=${config.kind}  baseUrl=${config.baseUrl ?? '(local, unauthenticated)'}`);
    } catch (error) {
      errors.push(`${id}: ${(error as Error).message}`);
    }
  }

  if (errors.length > 0) {
    console.log('\nRefusing to start: the following providers could not be registered (fail closed):');
    for (const error of errors) console.log(`  - ${error}`);
    process.exit(1);
  }

  console.log(`\n${providerIds.length} provider(s) registered. Cloud model egress is wired through the egress guard.`);
}

main().catch((error) => {
  console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
