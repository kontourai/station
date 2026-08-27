import {
  parseWorkspaceFilePreviewPaneState,
  WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID,
  WORKSPACE_FILE_PREVIEW_PANE_SOURCE_ID,
  type WorkspaceFilePreviewPaneState,
} from '@kontourai/station-contracts/workspace-file-preview';
import { toWorkspacePaneStateKey } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostOpenPreparation } from './WorkspacePaneHostOpenContext';
import { workspacePaneHostReferenceDocuments } from './workspacePaneHostStorage';

export const FILE_PREVIEW_PANE_STATE_STORAGE_PREFIX =
  'station:file-preview-pane-state:v1';
export const MAX_FILE_PREVIEW_PANE_STATE_BYTES = 4 * 1024;
export const MAX_FILE_PREVIEW_PANE_STATE_ENTRIES = 24;

const utf8 = new TextEncoder();

export interface FilePreviewPaneStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export function filePreviewPaneStateStorageKey(stateKey: string): string {
  return `${FILE_PREVIEW_PANE_STATE_STORAGE_PREFIX}:${encodeURIComponent(toWorkspacePaneStateKey(stateKey))}`;
}

function storageKeys(storage: FilePreviewPaneStateStorage): string[] {
  if (typeof storage.length !== 'number' || !storage.key) return [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${FILE_PREVIEW_PANE_STATE_STORAGE_PREFIX}:`))
      keys.push(key);
  }
  return keys;
}

const FILE_PREVIEW_IDENTITY_PATTERN = /^file-preview:[0-9a-f]{32}$/;

function storedStateKey(storageKey: string): string | null {
  try {
    const prefix = `${FILE_PREVIEW_PANE_STATE_STORAGE_PREFIX}:`;
    if (!storageKey.startsWith(prefix)) return null;
    return toWorkspacePaneStateKey(
      decodeURIComponent(storageKey.slice(prefix.length)),
    );
  } catch {
    return null;
  }
}

function inspectStoredState(
  storage: FilePreviewPaneStateStorage,
  storageKey: string,
): { stateKey: string; state: WorkspaceFilePreviewPaneState } | null {
  try {
    const stateKey = storedStateKey(storageKey);
    const raw = storage.getItem(storageKey);
    if (
      !stateKey ||
      !raw ||
      utf8.encode(raw).byteLength > MAX_FILE_PREVIEW_PANE_STATE_BYTES
    )
      return null;
    const state = parseWorkspaceFilePreviewPaneState(JSON.parse(raw));
    return state ? { stateKey, state } : null;
  } catch {
    return null;
  }
}

function referencedFilePreviewStateKeys(
  storage: FilePreviewPaneStateStorage,
  states: ReadonlyMap<string, WorkspaceFilePreviewPaneState>,
): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const document of workspacePaneHostReferenceDocuments(storage)) {
    for (const instance of document.instances) {
      const stateKey = String(instance.stateKey);
      const state = states.get(stateKey);
      const context = instance.boundContext;
      if (
        state &&
        instance.descriptorId === WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID &&
        String(instance.instanceId) === stateKey &&
        FILE_PREVIEW_IDENTITY_PATTERN.test(stateKey) &&
        context?.projectId === state.projectSlug &&
        context.sourceId === WORKSPACE_FILE_PREVIEW_PANE_SOURCE_ID &&
        context.workspaceId === undefined &&
        context.taskId === undefined &&
        context.sessionId === undefined &&
        context.runId === undefined &&
        Object.keys(context).length === 2
      )
        referenced.add(stateKey);
    }
  }
  return referenced;
}

/** Reclaims only corrupt or host-unreferenced records after the cap is reached. */
function reclaimFilePreviewPaneStateCapacity(
  storage: FilePreviewPaneStateStorage,
): void {
  const valid = new Map<string, WorkspaceFilePreviewPaneState>();
  const storageKeyByStateKey = new Map<string, string>();
  for (const key of storageKeys(storage)) {
    const inspected = inspectStoredState(storage, key);
    if (!inspected) {
      try {
        storage.removeItem(key);
      } catch {
        /* optional browser storage */
      }
      continue;
    }
    valid.set(inspected.stateKey, inspected.state);
    storageKeyByStateKey.set(inspected.stateKey, key);
  }
  const referenced = referencedFilePreviewStateKeys(storage, valid);
  for (const [stateKey, key] of storageKeyByStateKey) {
    if (referenced.has(stateKey)) continue;
    try {
      storage.removeItem(key);
    } catch {
      /* optional browser storage */
    }
  }
}

/** One corrupt state is removed in isolation; unrelated pane state survives. */
export function readFilePreviewPaneState(
  storage: FilePreviewPaneStateStorage,
  stateKey: string,
): WorkspaceFilePreviewPaneState | null {
  const key = filePreviewPaneStateStorageKey(stateKey);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    if (utf8.encode(raw).byteLength > MAX_FILE_PREVIEW_PANE_STATE_BYTES)
      throw new Error('state exceeds byte bound');
    const state = parseWorkspaceFilePreviewPaneState(JSON.parse(raw));
    if (!state) throw new Error('state is invalid');
    return state;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* storage is optional */
    }
    return null;
  }
}

export function writeFilePreviewPaneState(
  storage: FilePreviewPaneStateStorage,
  stateKey: string,
  state: WorkspaceFilePreviewPaneState,
): boolean {
  const key = filePreviewPaneStateStorageKey(stateKey);
  try {
    const normalized = parseWorkspaceFilePreviewPaneState(state);
    if (!normalized) return false;
    const encoded = JSON.stringify(normalized);
    if (utf8.encode(encoded).byteLength > MAX_FILE_PREVIEW_PANE_STATE_BYTES)
      return false;
    let keys = storageKeys(storage);
    if (
      !keys.includes(key) &&
      keys.length >= MAX_FILE_PREVIEW_PANE_STATE_ENTRIES
    ) {
      reclaimFilePreviewPaneStateCapacity(storage);
      keys = storageKeys(storage);
    }
    if (
      !keys.includes(key) &&
      keys.length >= MAX_FILE_PREVIEW_PANE_STATE_ENTRIES
    )
      return false;
    storage.setItem(key, encoded);
    return true;
  } catch {
    return false;
  }
}

export function createFilePreviewPaneStatePreparation(
  storage: FilePreviewPaneStateStorage,
  stateKey: string,
  state: WorkspaceFilePreviewPaneState,
): WorkspacePaneHostOpenPreparation {
  return {
    prepare: () => writeFilePreviewPaneState(storage, stateKey, state),
    rollback: () => {
      removeFilePreviewPaneState(storage, stateKey);
    },
  };
}

export function removeFilePreviewPaneState(
  storage: FilePreviewPaneStateStorage,
  stateKey: string,
): boolean {
  try {
    storage.removeItem(filePreviewPaneStateStorageKey(stateKey));
    return true;
  } catch {
    return false;
  }
}

/** Removes only after strict live and persisted host references have cleared. */
export function removeUnreferencedFilePreviewPaneState(
  storage: FilePreviewPaneStateStorage,
  stateKey: string,
): boolean {
  const key = filePreviewPaneStateStorageKey(stateKey);
  const inspected = inspectStoredState(storage, key);
  if (!inspected || inspected.stateKey !== stateKey) return false;
  const referenced = referencedFilePreviewStateKeys(
    storage,
    new Map([[stateKey, inspected.state]]),
  );
  return referenced.has(stateKey)
    ? false
    : removeFilePreviewPaneState(storage, stateKey);
}
