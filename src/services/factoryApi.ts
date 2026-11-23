import type { IndustryNiche } from '../models/tenant';
import type { SystemHealthStats } from '../types';

export interface FactoryHealthResponse {
  status?: SystemHealthStats['status'];
  name?: string;
  version?: string;
  uptimeSeconds?: number;
  systemHealth?: {
    memory?: {
      heapUsedMb?: number;
      heapTotalMb?: number;
      rssMb?: number;
      memoryPressureScore?: number;
    };
  };
  checks?: Record<string, string>;
  checkDetails?: SystemHealthStats['checkDetails'];
  recovery?: SystemHealthStats['recovery'];
}

export interface TelemetryRequest {
  tenantId: string;
  niche: IndustryNiche;
  eventType: string;
  metadata: {
    sourceSystem: string;
    clientVersion: string;
    idempotencyKey: string;
  };
  payload: unknown;
}

export async function getFactoryHealth(signal?: AbortSignal): Promise<FactoryHealthResponse> {
  const response = await fetch('/api/factory/health', { signal });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`Health endpoint returned HTTP ${response.status}`);
  }
  return body as FactoryHealthResponse;
}

export async function ingestTelemetry(request: TelemetryRequest, signal?: AbortSignal): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await fetch('/api/telemetry/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': request.tenantId,
      'X-Industry-Niche': request.niche,
    },
    body: JSON.stringify(request),
    signal,
  });
  const body = await readJson(response);
  return { response, body: body as Record<string, any> };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Factory API returned a non-JSON response');
  }
}
