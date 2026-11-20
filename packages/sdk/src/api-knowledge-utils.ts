import { _getApiBase, getPluginHeaders } from './api-core';
import { envelopeError } from './client/api-error-message';
import { authenticatedFetch, rethrowDeadline } from './client/http';

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function knowledgeBase(
  projectSlug: string,
  namespace?: string,
): KnowledgeApiPath {
  const base: KnowledgeApiPath = `/api/projects/${encodeURIComponent(projectSlug)}/knowledge`;
  return namespace ? `${base}/ns/${encodeURIComponent(namespace)}` : base;
}

export type KnowledgeApiPath = `/api/${string}`;

interface KnowledgeJsonRequestOptions {
  method?: string;
  body?: unknown;
  errorPrefix: string;
  validateData?: (data: unknown) => boolean;
  responseMode?: 'data' | 'void';
}

export function requestKnowledgeJson(
  path: KnowledgeApiPath,
  options: KnowledgeJsonRequestOptions & { responseMode: 'void' },
): Promise<void>;
export function requestKnowledgeJson<T>(
  path: KnowledgeApiPath,
  options?: KnowledgeJsonRequestOptions & { responseMode?: 'data' },
): Promise<T>;
export async function requestKnowledgeJson<T>(
  path: KnowledgeApiPath,
  options?: KnowledgeJsonRequestOptions,
): Promise<T | undefined> {
  if (!path.startsWith('/api/')) {
    throw new Error(
      'Knowledge request path must be base-relative and start with /api/',
    );
  }
  const apiBase = await _getApiBase();
  const hasBody = options?.body !== undefined;
  const res = await authenticatedFetch(`${apiBase}${path}`, {
    method: options?.method,
    headers: getPluginHeaders(
      hasBody ? { 'Content-Type': 'application/json' } : undefined,
    ),
    body: hasBody ? JSON.stringify(options?.body) : undefined,
  });

  const prefix = options?.errorPrefix ?? 'Knowledge request failed';
  const invalid = `${prefix}: invalid response`;
  const fallback = res.ok
    ? invalid
    : `${prefix}: ${res.statusText || res.status}`;
  let json: unknown;
  try {
    json = await res.json();
  } catch (error) {
    rethrowDeadline(error);
    throw envelopeError(res, undefined, fallback);
  }
  if (!res.ok || !isJsonRecord(json) || json.success !== true) {
    throw envelopeError(res, json, fallback);
  }

  if (options?.responseMode === 'void') return;
  if (!('data' in json) || options?.validateData?.(json.data) === false) {
    throw envelopeError(res, undefined, invalid);
  }

  return json.data as T;
}

export function buildKnowledgeFilterQuery(
  filters: Record<string, any>,
): string {
  const params = new URLSearchParams();
  if (filters.tags?.length) params.set('tags', filters.tags.join(','));
  if (filters.after) params.set('after', filters.after);
  if (filters.before) params.set('before', filters.before);
  if (filters.pathPrefix) params.set('pathPrefix', filters.pathPrefix);
  if (filters.status) params.set('status', filters.status);
  if (filters.metadata) {
    for (const [key, value] of Object.entries(filters.metadata)) {
      params.set(`metadata.${key}`, String(value));
    }
  }
  return params.toString();
}
