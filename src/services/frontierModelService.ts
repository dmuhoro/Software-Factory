import { DurableStore } from './durableStore';
import { egressJson, resolveSecretRef, validateProviderUrl } from '../utils/egressGuard';
import { LLMTracingService } from './llmTracingService';

export type ModelProviderKind = 'openai-compatible' | 'gemini-native' | 'local';
const MIN_MODEL_REQUEST_TIMEOUT_MS = 15_000;
const MAX_MODEL_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 120_000;

export interface ModelProvider {
  id: string; tenantId: string; kind: ModelProviderKind; baseUrl?: string; modelIds: string[]; secretRef?: string;
  enabled: boolean; timeoutMs?: number; createdAt: string;
  /** The price the operator declared for this provider, in US dollars per million input tokens.
   *  Declared, never assumed: a provider with no declared price has an unknown cost. */
  inputCostPerMillionTokens?: number;
  /** The price the operator declared for this provider, in US dollars per million output tokens. */
  outputCostPerMillionTokens?: number;
}
export interface ModelRequest { providerId: string; model: string; system: string; task: string; maxOutputTokens?: number; /** The run this call belongs to, so a run's cost can be totalled. */ runId?: string; }

/** The highest price this factory will accept as a declared rate, in dollars per million tokens.
 *  Above this, the declaration is a mistake rather than a price. */
const MAX_DECLARED_COST_PER_MILLION = 100_000;

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
  public static register(input: { tenantId: string; id: string; kind?: ModelProviderKind; baseUrl?: string; modelIds?: string[]; secretRef?: string; enabled?: boolean; timeoutMs?: number; inputCostPerMillionTokens?: number; outputCostPerMillionTokens?: number }): ModelProvider {
    const kind = input.kind ?? 'openai-compatible';
    if (!['openai-compatible', 'gemini-native', 'local'].includes(kind)) throw new Error('MODEL_PROVIDER_KIND_NOT_RECOGNIZED');
    const id = requireText(input.id, 'MODEL_PROVIDER_ID_REQUIRED', 64);
    if (kind === 'openai-compatible' && !input.baseUrl) throw new Error('MODEL_PROVIDER_BASE_URL_REQUIRED');
    // A local provider may be unauthenticated; a remote one must be reachable and permitted.
    if (input.baseUrl) validateProviderUrl(input.baseUrl, kind);
    if (input.secretRef !== undefined && input.secretRef !== '') resolveSecretRef(input.secretRef);
    let timeoutMs: number | undefined;
    if (input.timeoutMs !== undefined) {
      if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < MIN_MODEL_REQUEST_TIMEOUT_MS || input.timeoutMs > MAX_MODEL_REQUEST_TIMEOUT_MS) {
        throw new Error(`MODEL_PROVIDER_TIMEOUT_OUT_OF_RANGE:${MIN_MODEL_REQUEST_TIMEOUT_MS}-${MAX_MODEL_REQUEST_TIMEOUT_MS}`);
      }
      timeoutMs = input.timeoutMs;
    }
    // A declared price is either a real price or a mistake: it must be a finite, non-negative
    // number, and it must be declared for both directions or for neither. A half-declared price
    // would produce a cost that is wrong in a way nobody could see.
    const declaredCost = (value: number | undefined, code: string): number | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_DECLARED_COST_PER_MILLION) {
        throw new Error(code);
      }
      return value;
    };
    const inputCostPerMillionTokens = declaredCost(input.inputCostPerMillionTokens, 'MODEL_PROVIDER_INPUT_COST_OUT_OF_RANGE');
    const outputCostPerMillionTokens = declaredCost(input.outputCostPerMillionTokens, 'MODEL_PROVIDER_OUTPUT_COST_OUT_OF_RANGE');
    if ((inputCostPerMillionTokens === undefined) !== (outputCostPerMillionTokens === undefined)) {
      throw new Error('MODEL_PROVIDER_COST_DECLARATION_INCOMPLETE');
    }
    const modelIds = Array.isArray(input.modelIds)
      ? [...new Set(input.modelIds.filter((model): model is string => typeof model === 'string' && model.trim() !== '').map((model) => model.trim().slice(0, 128)))]
      : [];
    if (modelIds.length > 256) throw new Error('MODEL_PROVIDER_MODEL_LIST_TOO_LARGE');
    const provider: ModelProvider = { id, tenantId: input.tenantId, kind, baseUrl: input.baseUrl ? input.baseUrl.trim() : undefined, modelIds, secretRef: input.secretRef, enabled: input.enabled ?? true, timeoutMs, inputCostPerMillionTokens, outputCostPerMillionTokens, createdAt: new Date().toISOString() };
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
    const startMs = Date.now();
    const inputChars = system.length + task.length;
    let content = '';
    let status: 'success' | 'failure' = 'success';
    let errorCode: string | undefined;
    try {
      const result = await egressJson({
        baseUrl: provider.baseUrl,
        kind: provider.kind,
        pathname: '/chat/completions',
        method: 'POST',
        secret,
        timeoutMs: provider.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: task }], max_completion_tokens: maxOutputTokens }),
      });
      if (result.status !== 200) throw new Error(`MODEL_PROVIDER_REQUEST_FAILED:${result.status}`);
      const raw = result.body as { choices?: Array<{ message?: { content?: unknown } }> };
      const rawContent = raw?.choices?.[0]?.message?.content;
      content = typeof rawContent === 'string' ? rawContent : '';
      if (typeof content !== 'string') throw new Error('MODEL_PROVIDER_INVALID_RESPONSE');
      return { providerId: provider.id, model, content, raw };
    } catch (error) {
      status = 'failure';
      errorCode = error instanceof Error ? error.message : 'UNKNOWN';
      throw error;
    } finally {
      const latencyMs = Date.now() - startMs;
      LLMTracingService.record({
        tenantId,
        runId: input.runId,
        providerId: provider.id,
        model,
        latencyMs,
        inputChars,
        outputChars: content.length,
        status,
        errorCode,
        door: 'egress-guard',
        inputCostPerMillionTokens: provider.inputCostPerMillionTokens,
        outputCostPerMillionTokens: provider.outputCostPerMillionTokens,
      });
    }
  }
}
