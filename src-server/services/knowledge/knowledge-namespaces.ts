import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUILTIN_KNOWLEDGE_NAMESPACES,
  type KnowledgeNamespaceConfig,
} from '@kontourai/station-contracts/knowledge';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { expandTilde } from '../../utils/paths.js';
import { defaultKnowledgeStorageDir } from './knowledge-storage.js';

export function listKnowledgeNamespaces(
  projectSlug: string,
  storageAdapter?: IStorageAdapter,
): KnowledgeNamespaceConfig[] {
  if (!storageAdapter) return [...BUILTIN_KNOWLEDGE_NAMESPACES];
  try {
    const project = storageAdapter.getProject(projectSlug);
    const custom = project.knowledgeNamespaces ?? [];
    const seen = new Set<string>();
    const result: KnowledgeNamespaceConfig[] = [];
    for (const namespace of [...BUILTIN_KNOWLEDGE_NAMESPACES, ...custom]) {
      if (!seen.has(namespace.id)) {
        seen.add(namespace.id);
        result.push(namespace);
      }
    }
    return result;
  } catch {
    return [...BUILTIN_KNOWLEDGE_NAMESPACES];
  }
}

export function getKnowledgeNamespaceConfig(
  projectSlug: string,
  namespaceId: string,
  storageAdapter?: IStorageAdapter,
) {
  return listKnowledgeNamespaces(projectSlug, storageAdapter).find(
    (namespace) => namespace.id === namespaceId,
  );
}

const warnedLegacyKnowledgeDirs = new Set<string>();

function warnOnceAboutLegacyKnowledgeDir(
  configured: string,
  legacy: string,
  expanded: string,
): void {
  if (warnedLegacyKnowledgeDirs.has(legacy)) return;
  warnedLegacyKnowledgeDirs.add(legacy);
  console.warn(
    `[knowledge] Namespace storageDir "${configured}" now resolves to ${expanded}. ` +
      `Content was found at ${legacy}, written before tilde paths were expanded. ` +
      `Move it to keep it — its vector embeddings still exist and will otherwise ` +
      `return results for documents the list no longer shows.`,
  );
}

export function resolveKnowledgeStorageDir(
  projectSlug: string,
  namespaceId: string,
  dataDir: string,
  storageAdapter?: IStorageAdapter,
) {
  const namespace = getKnowledgeNamespaceConfig(
    projectSlug,
    namespaceId,
    storageAdapter,
  );
  // EXPAND. `storageDir` is a free-text field the user types, stored
  // verbatim, and this value is both READ from and WRITTEN to. Raw, a
  // namespace configured as `~/notes` resolved to `<server cwd>/~/notes` —
  // a literal `~` directory inside Station's install root. Of the whole
  // unexpanded-path class this is the only member that writes to the wrong
  // place rather than failing closed, so it silently created and populated
  // a directory the user never named (archive#3155).
  if (namespace?.storageDir) {
    const expanded = resolve(expandTilde(namespace.storageDir));
    // MIGRATION DISCLOSURE. Before this expansion a `~/notes` namespace
    // resolved to `<server cwd>/~/notes` — a literal `~` directory in the
    // install root — and wrote there. Moving the resolution moves reads AND
    // writes together, so existing content goes invisible with no error and
    // nothing in the UI to explain it. Worse, the vector store resolves
    // independently of storageDir, so its embeddings survive and RAG keeps
    // returning chunks for documents the list no longer shows.
    //
    // Warn rather than move: silently renaming a user's knowledge directory
    // from a read path that runs on every lookup is a destructive act. Naming
    // both paths lets the operator move it deliberately.
    const legacy = resolve(namespace.storageDir);
    if (legacy !== expanded && !existsSync(expanded) && existsSync(legacy)) {
      warnOnceAboutLegacyKnowledgeDir(namespace.storageDir, legacy, expanded);
    }
    return expanded;
  }
  return defaultKnowledgeStorageDir(dataDir, projectSlug, namespaceId);
}

export async function registerKnowledgeNamespace(
  projectSlug: string,
  namespace: KnowledgeNamespaceConfig,
  storageAdapter?: IStorageAdapter,
): Promise<void> {
  if (!storageAdapter) throw new Error('Storage adapter required');
  const revision = storageAdapter.projectRevision(projectSlug);
  const project = revision.value;
  const existing = project.knowledgeNamespaces ?? [];
  if (existing.some((entry) => entry.id === namespace.id)) return;
  project.knowledgeNamespaces = [...existing, namespace];
  project.updatedAt = new Date().toISOString();
  await revision.replace(project);
}

export async function removeKnowledgeNamespace(
  projectSlug: string,
  namespaceId: string,
  storageAdapter?: IStorageAdapter,
): Promise<void> {
  if (!storageAdapter) throw new Error('Storage adapter required');
  if (
    BUILTIN_KNOWLEDGE_NAMESPACES.some(
      (namespace) => namespace.id === namespaceId,
    )
  ) {
    throw new Error(`Cannot remove built-in namespace '${namespaceId}'`);
  }
  const revision = storageAdapter.projectRevision(projectSlug);
  const project = revision.value;
  project.knowledgeNamespaces = (project.knowledgeNamespaces ?? []).filter(
    (namespace) => namespace.id !== namespaceId,
  );
  project.updatedAt = new Date().toISOString();
  await revision.replace(project);
}

export async function updateKnowledgeNamespace(
  projectSlug: string,
  namespaceId: string,
  updates: Partial<KnowledgeNamespaceConfig>,
  storageAdapter?: IStorageAdapter,
): Promise<void> {
  if (!storageAdapter) throw new Error('Storage adapter required');
  const revision = storageAdapter.projectRevision(projectSlug);
  const project = revision.value;
  const namespaces = project.knowledgeNamespaces ?? [];
  const index = namespaces.findIndex(
    (namespace) => namespace.id === namespaceId,
  );

  if (index >= 0) {
    namespaces[index] = { ...namespaces[index], ...updates, id: namespaceId };
  } else {
    const builtin = BUILTIN_KNOWLEDGE_NAMESPACES.find(
      (namespace) => namespace.id === namespaceId,
    );
    if (!builtin) {
      throw new Error(`Namespace '${namespaceId}' not found`);
    }
    namespaces.push({ ...builtin, ...updates, id: namespaceId });
  }

  project.knowledgeNamespaces = namespaces;
  project.updatedAt = new Date().toISOString();
  await revision.replace(project);
}
