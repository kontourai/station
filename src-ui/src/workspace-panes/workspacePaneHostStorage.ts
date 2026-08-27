import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  isWorkspacePaneHostIdentitySegment,
  parseWorkspacePaneHostDocument,
  restoreWorkspacePaneHostDocument,
  type WorkspacePaneHostDocumentV1,
  type WorkspacePaneHostRestorationFailure,
  type WorkspacePaneHostScope,
  workspacePaneHostScopeMatches,
} from '@kontourai/station-contracts/workspace-pane-host';

export const WORKSPACE_PANE_HOST_STORAGE_PREFIX =
  'station:workspace-pane-host:v2';
export const MAX_WORKSPACE_PANE_HOST_STORAGE_BYTES = 64 * 1024;
const utf8 = new TextEncoder();

export interface WorkspacePaneHostStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

const liveDocuments = new WeakMap<
  object,
  Map<symbol, WorkspacePaneHostDocumentV1>
>();

export interface WorkspacePaneHostHydrationResult {
  document: WorkspacePaneHostDocumentV1 | null;
  failures: readonly WorkspacePaneHostRestorationFailure[];
}

/** Narrow extension point for code-owned dynamic builtins during recovery. */
export type WorkspacePaneHostRestoredInstanceAdmission = (
  candidate: unknown,
) => WorkspacePaneInstance | null;

function segment(value: string): string {
  if (!isWorkspacePaneHostIdentitySegment(value))
    throw new TypeError('Workspace Pane host identity segment is invalid');
  return encodeURIComponent(value);
}

/**
 * The key includes all exact owning identities; it is not a global pane
 * preference. An ambient host owns none, so its key names none: it is
 * per-device persistence and says so, rather than borrowing a synthetic
 * project or layout identity that no Project or layout answers to.
 */
export function workspacePaneHostStorageKey(
  scope: WorkspacePaneHostScope,
  documentId: string,
): string {
  switch (scope.kind) {
    case 'ambient':
      return `${WORKSPACE_PANE_HOST_STORAGE_PREFIX}:ambient:${segment(documentId)}`;
    case 'task':
      return `${WORKSPACE_PANE_HOST_STORAGE_PREFIX}:task:${segment(scope.taskId)}:${segment(scope.projectId)}:${segment(scope.layoutId)}:${segment(documentId)}`;
    case 'project':
      return `${WORKSPACE_PANE_HOST_STORAGE_PREFIX}:project:${segment(scope.projectId)}:${segment(scope.layoutId)}:${segment(documentId)}`;
    default: {
      const unreachable: never = scope;
      return unreachable;
    }
  }
}

/** Registers one mounted host so state reclamation cannot race live UI state. */
export function registerLiveWorkspacePaneHostDocument(
  storage: WorkspacePaneHostStorage,
  owner: symbol,
  document: WorkspacePaneHostDocumentV1,
): boolean {
  const normalized = parseWorkspacePaneHostDocument(document);
  if (!normalized) return false;
  let documents = liveDocuments.get(storage);
  if (!documents) {
    documents = new Map();
    liveDocuments.set(storage, documents);
  }
  documents.set(owner, normalized);
  return true;
}

export function unregisterLiveWorkspacePaneHostDocument(
  storage: WorkspacePaneHostStorage,
  owner: symbol,
): void {
  const documents = liveDocuments.get(storage);
  documents?.delete(owner);
  if (documents?.size === 0) liveDocuments.delete(storage);
}

/** Strict live and persisted documents; corrupt storage never protects an orphan. */
export function workspacePaneHostReferenceDocuments(
  storage: WorkspacePaneHostStorage,
): readonly WorkspacePaneHostDocumentV1[] {
  const documents = [...(liveDocuments.get(storage)?.values() ?? [])];
  if (typeof storage.length !== 'number' || !storage.key) return documents;
  for (let index = 0; index < storage.length; index += 1) {
    try {
      const key = storage.key(index);
      if (!key?.startsWith(`${WORKSPACE_PANE_HOST_STORAGE_PREFIX}:`)) continue;
      const raw = storage.getItem(key);
      if (
        !raw ||
        utf8.encode(raw).byteLength > MAX_WORKSPACE_PANE_HOST_STORAGE_BYTES
      )
        continue;
      const document = parseWorkspacePaneHostDocument(JSON.parse(raw));
      if (document) documents.push(document);
    } catch {
      // Corrupt unrelated host persistence is not reference authority.
    }
  }
  return documents;
}

export function hydrateWorkspacePaneHost(
  storage: WorkspacePaneHostStorage,
  scope: WorkspacePaneHostScope,
  documentId: string,
  knownInstances: readonly WorkspacePaneInstance[],
  admitRestoredInstance?: WorkspacePaneHostRestoredInstanceAdmission,
): WorkspacePaneHostHydrationResult {
  let raw: string | null;
  try {
    raw = storage.getItem(workspacePaneHostStorageKey(scope, documentId));
  } catch {
    return { document: null, failures: [{ code: 'invalid-document' }] };
  }
  if (
    !raw ||
    utf8.encode(raw).byteLength > MAX_WORKSPACE_PANE_HOST_STORAGE_BYTES
  )
    return {
      document: null,
      failures: raw ? [{ code: 'invalid-document' }] : [],
    };
  try {
    const parsed = JSON.parse(raw);
    const admitted =
      admitRestoredInstance &&
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { instances?: unknown }).instances)
        ? (parsed as { instances: unknown[] }).instances
            .map(admitRestoredInstance)
            .filter((instance): instance is WorkspacePaneInstance => !!instance)
        : [];
    const restored = restoreWorkspacePaneHostDocument(parsed, [
      ...knownInstances,
      ...admitted,
    ]);
    if (
      !restored.document ||
      !workspacePaneHostScopeMatches(restored.document.scope, scope) ||
      restored.document.id !== documentId
    ) {
      return { document: null, failures: [{ code: 'invalid-document' }] };
    }
    return restored;
  } catch {
    return { document: null, failures: [{ code: 'invalid-document' }] };
  }
}

/** Bounded write; runtime callbacks and local renderer failures cannot enter this serial adapter. */
export function persistWorkspacePaneHost(
  storage: WorkspacePaneHostStorage,
  document: WorkspacePaneHostDocumentV1,
): boolean {
  try {
    const normalized = parseWorkspacePaneHostDocument(document);
    if (!normalized) return false;
    const encoded = JSON.stringify(normalized);
    if (utf8.encode(encoded).byteLength > MAX_WORKSPACE_PANE_HOST_STORAGE_BYTES)
      return false;
    storage.setItem(
      workspacePaneHostStorageKey(normalized.scope, normalized.id),
      encoded,
    );
    return true;
  } catch {
    return false;
  }
}

export function removeWorkspacePaneHost(
  storage: WorkspacePaneHostStorage,
  scope: WorkspacePaneHostScope,
  documentId: string,
): boolean {
  try {
    storage.removeItem(workspacePaneHostStorageKey(scope, documentId));
    return true;
  } catch {
    return false;
  }
}
