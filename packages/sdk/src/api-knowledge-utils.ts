import { _getApiBase, getPluginHeaders } from './api-core';

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
  allowFailure?: boolean;
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
  const res = await fetch(`${apiBase}${path}`, {
    method: options?.method,
    headers: getPluginHeaders(
      hasBody ? { 'Content-Type': 'application/json' } : undefined,
    ),
    body: hasBody ? JSON.stringify(options?.body) : undefined,
  });

  if (!res.ok) {
    if (options?.allowFailure) {
      return [] as T;
    }
    throw new Error(`${options?.errorPrefix}: ${res.statusText}`);
  }

  const json: unknown = await res.json();
  if (!isJsonRecord(json) || typeof json.success !== 'boolean') {
    if (options?.allowFailure) {
      return [] as T;
    }
    throw new Error(`${options?.errorPrefix}: invalid response`);
  }

  if (!json.success) {
    if (options?.allowFailure) {
      return [] as T;
    }
    if (typeof json.error === 'string') {
      throw new Error(json.error);
    }
    throw new Error(`${options?.errorPrefix}: invalid response`);
  }

  if (options?.responseMode === 'void') {
    return;
  }

  if (!('data' in json)) {
    if (options?.allowFailure) {
      return [] as T;
    }
    throw new Error(`${options?.errorPrefix}: invalid response`);
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
