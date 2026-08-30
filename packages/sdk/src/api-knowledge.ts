import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import { _getApiBase, apiErrorMessage, getPluginHeaders } from './api-core';
import {
  buildKnowledgeFilterQuery,
  knowledgeBase,
  requestKnowledgeJson,
} from './api-knowledge-utils';
import { authenticatedFetch, StationHttpError } from './client/http';
export async function fetchKnowledgeNamespaces(
  projectSlug: string,
): Promise<any[]> {
  return requestKnowledgeJson(
    `/api/projects/${encodeURIComponent(projectSlug)}/knowledge/namespaces`,
    { errorPrefix: 'Failed to fetch namespaces' },
  );
}

export async function fetchKnowledgeDocs(
  projectSlug: string,
  namespace?: string,
): Promise<any[]> {
  return requestKnowledgeJson(knowledgeBase(projectSlug, namespace), {
    errorPrefix: 'Failed to fetch knowledge docs',
  });
}

export async function searchKnowledge(
  projectSlug: string,
  query: string,
  namespace?: string,
  topK?: number,
): Promise<any[]> {
  return requestKnowledgeJson(
    `${knowledgeBase(projectSlug, namespace)}/search`,
    {
      method: 'POST',
      body: { query, topK },
      errorPrefix: 'Knowledge search failed',
    },
  );
}

export async function uploadKnowledge(
  projectSlug: string,
  filename: string,
  content: string,
  namespace?: string,
  metadata?: Record<string, any>,
): Promise<any> {
  return requestKnowledgeJson(
    `${knowledgeBase(projectSlug, namespace)}/upload`,
    {
      method: 'POST',
      body: {
        filename,
        content,
        ...(metadata && { metadata }),
      },
      errorPrefix: 'Knowledge upload failed',
    },
  );
}

export async function deleteKnowledgeDoc(
  projectSlug: string,
  docId: string,
  namespace?: string,
): Promise<void> {
  await requestKnowledgeJson(
    `${knowledgeBase(projectSlug, namespace)}/${encodeURIComponent(docId)}`,
    {
      method: 'DELETE',
      errorPrefix: 'Knowledge delete failed',
      responseMode: 'void',
    },
  );
}

export async function bulkDeleteKnowledgeDocs(
  projectSlug: string,
  ids: string[],
  namespace?: string,
): Promise<void> {
  await requestKnowledgeJson(
    `${knowledgeBase(projectSlug, namespace)}/bulk-delete`,
    {
      method: 'POST',
      body: { ids },
      errorPrefix: 'Knowledge bulk delete failed',
    },
  );
}

export async function fetchKnowledgeDocContent(
  projectSlug: string,
  docId: string,
  namespace?: string,
): Promise<string> {
  const data = await requestKnowledgeJson<{ content: string }>(
    `${knowledgeBase(projectSlug, namespace)}/${encodeURIComponent(docId)}/content`,
    { errorPrefix: 'Failed to fetch doc content' },
  );
  return data.content;
}

export async function fetchKnowledgeStatus(projectSlug: string): Promise<any> {
  return requestKnowledgeJson(
    `/api/projects/${encodeURIComponent(projectSlug)}/knowledge/status`,
    { errorPrefix: 'Failed to fetch knowledge status' },
  );
}

export async function scanKnowledgeDirectory(
  projectSlug: string,
  options?: {
    extensions?: string[];
    includePatterns?: string[];
    excludePatterns?: string[];
  },
): Promise<any> {
  return requestKnowledgeJson(`${knowledgeBase(projectSlug)}/scan`, {
    method: 'POST',
    body: options ?? {},
    errorPrefix: 'Knowledge scan failed',
  });
}

export async function fetchProjectConversations(
  projectSlug: string,
  limit = 10,
): Promise<any[]> {
  return requestKnowledgeJson(
    `/api/projects/${encodeURIComponent(projectSlug)}/conversations?limit=${limit}`,
    {
      errorPrefix: 'Failed to fetch project conversations',
      allowFailure: true,
    },
  );
}

export async function addProjectLayoutFromPlugin(
  projectSlug: string,
  plugin: string,
): Promise<any> {
  return requestKnowledgeJson(
    `/api/projects/${encodeURIComponent(projectSlug)}/layouts/from-plugin`,
    {
      method: 'POST',
      body: { plugin },
      errorPrefix: 'Failed to add layout from plugin',
    },
  );
}

const LAYOUT_LIFECYCLE_STATES = new Set([
  'draft',
  'installable',
  'installed',
  'disabled',
  'update_available',
  'removed',
]);

function isBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string' && value.length <= maximumLength;
}

function isLayoutCatalogItem(value: unknown): value is LayoutCatalogItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const sourceIdentity = item.sourceIdentity as
    | Record<string, unknown>
    | undefined;
  const lifecycle = item.lifecycle as Record<string, unknown> | undefined;
  return (
    isBoundedString(item.id, 512) &&
    (item.source === 'builtin' || item.source === 'plugin') &&
    isBoundedString(item.name, 512) &&
    isBoundedString(item.slug, 512) &&
    isBoundedString(item.type, 512) &&
    (item.icon === undefined || isBoundedString(item.icon, 128)) &&
    (item.description === undefined ||
      isBoundedString(item.description, 4_096)) &&
    (item.plugin === undefined || isBoundedString(item.plugin, 512)) &&
    typeof item.visible === 'boolean' &&
    typeof item.installable === 'boolean' &&
    typeof item.enabled === 'boolean' &&
    !!item.policy &&
    typeof item.policy === 'object' &&
    !!sourceIdentity &&
    isBoundedString(sourceIdentity.id, 512) &&
    ['builtin', 'local', 'remote'].includes(String(sourceIdentity.kind)) &&
    !!lifecycle &&
    isBoundedString(lifecycle.itemId, 512) &&
    LAYOUT_LIFECYCLE_STATES.has(String(lifecycle.state)) &&
    (item.tabCount === undefined ||
      (Number.isSafeInteger(item.tabCount) &&
        Number(item.tabCount) >= 0 &&
        Number(item.tabCount) <= 1_000))
  );
}

export async function fetchAvailableLayouts(
  signal?: AbortSignal,
): Promise<LayoutCatalogItem[]> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/layouts/available`,
    { headers: getPluginHeaders(), signal },
  );
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      `Failed to fetch available layouts: ${response.statusText}`,
    );
  }
  const json = (await response.json()) as {
    success?: boolean;
    data?: unknown;
    error?: unknown;
  };
  if (!json.success) {
    throw new Error(
      String(apiErrorMessage(json, 'Failed to fetch available layouts')),
    );
  }
  if (!Array.isArray(json.data)) {
    throw new Error('Failed to fetch available layouts: invalid catalog');
  }
  return json.data.slice(0, 1_000).filter(isLayoutCatalogItem);
}

export async function updateKnowledgeNamespace(
  projectSlug: string,
  namespaceId: string,
  data: Record<string, any>,
): Promise<any> {
  return requestKnowledgeJson(
    `/api/projects/${encodeURIComponent(projectSlug)}/knowledge/namespaces/${encodeURIComponent(namespaceId)}`,
    {
      method: 'PUT',
      body: data,
      errorPrefix: 'Failed to update namespace',
      responseMode: 'void',
    },
  );
}

export async function fetchKnowledgeTree(
  projectSlug: string,
  namespace: string,
): Promise<any> {
  return requestKnowledgeJson(`${knowledgeBase(projectSlug, namespace)}/tree`, {
    errorPrefix: 'Failed to fetch tree',
  });
}

export async function fetchKnowledgeFiltered(
  projectSlug: string,
  namespace: string,
  filters: Record<string, any>,
): Promise<any[]> {
  const qs = buildKnowledgeFilterQuery(filters);
  const url =
    `${knowledgeBase(projectSlug, namespace)}${qs ? `?${qs}` : ''}` as const;
  return requestKnowledgeJson(url, {
    errorPrefix: 'Failed to fetch filtered docs',
  });
}

export async function updateKnowledgeDoc(
  projectSlug: string,
  docId: string,
  updates: { content?: string; metadata?: Record<string, any> },
  namespace?: string,
): Promise<any> {
  return requestKnowledgeJson(
    `${knowledgeBase(projectSlug, namespace)}/${encodeURIComponent(docId)}`,
    {
      method: 'PUT',
      body: updates,
      errorPrefix: 'Failed to update doc',
    },
  );
}
