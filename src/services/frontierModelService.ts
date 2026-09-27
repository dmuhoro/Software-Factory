import { DurableStore } from './durableStore';
import { egressJson, resolveSecretRef, validateProviderUrl } from '../utils/egressGuard';

export type ModelProviderKind = 'openai-compatible' | 'gemini-native' | 'local';
export interface ModelProvider { id: string; tenantId: string; kind: ModelProviderKind; baseUrl?: string; modelIds: string[]; secretRef?: string; enabled: boolean; createdAt: string; }
export interface ModelRequest { providerId: string; model: string; system: string; task: string; maxOutputTokens?: number; }

/** Maximum task size accepted by a model provider. Bounded to protect the egress budget. */
const MAX_TASK_CHARS = 200_000;
const MAX_SYSTEM_CHARS = 20_000;
const MAX_OUTPUT_TOKENS = 32_000;

function tenantOf(value: Record<string, unknown>): string { return String(value.tenantId ?? ''); }
function requireText(value: unknown, code: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code);
  if (value.length > max) throw new Error(`${code}:TOO_LARGE`);
  return value;
}

/**
 * Frontier model providers reach external, OpenAI-compatible inference endpoints.
 *
 * SECURITY: the previous implementation resolved `process.env[secretRef]` and sent
 * the result to a caller-supplied `baseUrl`. That let any API key holder exfiltrate
 * every secret in the process environment. Registration now validates the URL and
 * the secret reference; every actual request re-validates at the socket boundary.
 */
export class FrontierModelService {
  public static register(input: { tenantId: string; id: string; kind?: ModelProviderKind; baseUrl?: string; modelIds?: string[]; secretRef?: string; enabled?: boolean }): ModelProvider {
    const kind = input.kind ?? 'openai-compatible';
    if (!['openai-compatible', 'gemini-native', 'local'].includes(kind)) throw new Error('MODEL_PROVIDER_KIND_NOT_RECOGNIZED');
    const id = requireText(input.id, 'MODEL_PROVIDER_ID_REQUIRED', 64);
    if (kind === 'openai-compatible' && !input.baseUrl) throw new Error('MODEL_PROVIDER_BASE_URL_REQUIRED');
    // A local provider may be unauthenticated; a remote one must be reachable and permitted.
    if (input.baseUrl) validateProviderUrl(input.baseUrl, kind);
    if (input.secretRef !== undefined && input.secretRef !== '') resolveSecretRef(input.secretRef);
    const modelIds = Array.isArray(input.modelIds)
      ? [...new Set(input.modelIds.filter((model): model is string => typeof model === 'string' && model.trim() !== '').map((model) => model.trim().slice(0, 128)))]
      : [];
    if (modelIds.length > 256) throw new Error('MODEL_PROVIDER_MODEL_LIST_TOO_LARGE');
    const provider: ModelProvider = { id, tenantId: input.tenantId, kind, baseUrl: input.baseUrl ? input.baseUrl.trim() : undefined, modelIds, secretRef: input.secretRef, enabled: input.enabled ?? true, createdAt: new Date().toISOString() };
    DurableStore.upsert('modelProviders', `${input.tenantId}:${id}`, provider as unknown as Record<string, unknown>);
    return provider;
  }

  public static list(tenantId: string): ModelProvider[] { return DurableStore.list('modelProviders').filter((item) => tenantOf(item) === tenantId) as unknown as ModelProvider[]; }

  public static get(tenantId: string, id: string): ModelProvider | undefined { return DurableStore.get('modelProviders', `${tenantId}:${id}`) as unknown as ModelProvider | undefined; }

  public static async discover(tenantId: string, id: string): Promise<ModelProvider> {
    const provider = this.get(tenantId, id);
    if (!provider) throw new Error('MODEL_PROVIDER_NOT_FOUND');
    if (provider.kind !== 'openai-compatible' || !provider.baseUrl) return provider;
    const secret = resolveSecretRef(provider.secretRef);
    const result = await egressJson({ baseUrl: provider.baseUrl, kind: provider.kind, pathname: '/models', method: 'GET', secret, timeoutMs: 15_000 });
    if (result.status !== 200) throw new Error(`MODEL_PROVIDER_DISCOVERY_FAILED:${result.status}`);
    const body = result.body as { data?: Array<{ id?: string }> };
    const updated = { ...provider, modelIds: (body.data ?? []).map((item) => item.id).filter((item): item is string => Boolean(item)).slice(0, 256) };
    DurableStore.upsert('modelProviders', `${tenantId}:${id}`, updated as unknown as Record<string, unknown>);
    return updated;
  }

  public static async request(tenantId: string, input: ModelRequest): Promise<{ providerId: string; model: string; content: string; raw: unknown }> {
    const provider = this.get(tenantId, input.providerId);
    if (!provider || !provider.enabled) throw new Error('MODEL_PROVIDER_NOT_AVAILABLE');
    if (!provider.baseUrl) throw new Error('MODEL_PROVIDER_REQUEST_UNSUPPORTED');
    if (provider.kind === 'gemini-native') throw new Error('MODEL_PROVIDER_REQUEST_UNSUPPORTED');
    const secret = resolveSecretRef(provider.secretRef);
    const model = requireText(input.model, 'MODEL_PROVIDER_MODEL_REQUIRED', 128);
    const system = requireText(input.system, 'MODEL_PROVIDER_SYSTEM_PROMPT_REQUIRED', MAX_SYSTEM_CHARS);
    const task = requireText(input.task, 'MODEL_PROVIDER_TASK_REQUIRED', MAX_TASK_CHARS);
    const maxOutputTokens = Math.min(Math.max(Number(input.maxOutputTokens) || 4000, 1), MAX_OUTPUT_TOKENS);
    const result = await egressJson({
      baseUrl: provider.baseUrl,
      kind: provider.kind,
      pathname: '/chat/completions',
      method: 'POST',
      secret,
      timeoutMs: 120_000,
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: task }], max_completion_tokens: maxOutputTokens }),
    });
    if (result.status !== 200) throw new Error(`MODEL_PROVIDER_REQUEST_FAILED:${result.status}`);
    const raw = result.body as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('MODEL_PROVIDER_INVALID_RESPONSE');
    return { providerId: provider.id, model, content, raw };
  }
}
