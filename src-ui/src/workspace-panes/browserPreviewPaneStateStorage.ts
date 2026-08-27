import {
  parseWorkspaceBrowserPreviewPaneState,
  type WorkspaceBrowserPreviewPaneState,
} from '@kontourai/station-contracts/workspace-browser-preview';
import { toWorkspacePaneStateKey } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostOpenPreparation } from './WorkspacePaneHostOpenContext';

export const BROWSER_PREVIEW_PANE_STATE_STORAGE_PREFIX =
  'station:browser-preview-pane-state:v1';
export const MAX_BROWSER_PREVIEW_PANE_STATE_BYTES = 4 * 1024;
export const MAX_BROWSER_PREVIEW_PANE_STATE_ENTRIES = 12;

const utf8 = new TextEncoder();

export interface BrowserPreviewPaneStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export function browserPreviewPaneStateStorageKey(stateKey: string): string {
  return `${BROWSER_PREVIEW_PANE_STATE_STORAGE_PREFIX}:${encodeURIComponent(toWorkspacePaneStateKey(stateKey))}`;
}

function storageKeys(storage: BrowserPreviewPaneStateStorage): string[] {
  if (typeof storage.length !== 'number' || !storage.key) return [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${BROWSER_PREVIEW_PANE_STATE_STORAGE_PREFIX}:`)) {
      keys.push(key);
    }
  }
  return keys;
}

function clearInvalidState(
  storage: BrowserPreviewPaneStateStorage,
  key: string,
): void {
  try {
    storage.removeItem(key);
  } catch {
    /* browser storage is optional */
  }
}

/** One malformed record is removed in isolation; unrelated pane state survives. */
export function readBrowserPreviewPaneState(
  storage: BrowserPreviewPaneStateStorage,
  stateKey: string,
): WorkspaceBrowserPreviewPaneState | null {
  const key = browserPreviewPaneStateStorageKey(stateKey);
  try {
    const raw = storage.getItem(key);
    if (
      !raw ||
      utf8.encode(raw).byteLength > MAX_BROWSER_PREVIEW_PANE_STATE_BYTES
    ) {
      throw new Error('state is absent or exceeds the byte bound');
    }
    const state = parseWorkspaceBrowserPreviewPaneState(JSON.parse(raw));
    if (!state) throw new Error('state is invalid');
    return state;
  } catch {
    clearInvalidState(storage, key);
    return null;
  }
}

function reclaimCapacity(storage: BrowserPreviewPaneStateStorage): void {
  for (const key of storageKeys(storage)) {
    try {
      const raw = storage.getItem(key);
      if (
        !raw ||
        utf8.encode(raw).byteLength > MAX_BROWSER_PREVIEW_PANE_STATE_BYTES
      ) {
        clearInvalidState(storage, key);
        continue;
      }
      if (!parseWorkspaceBrowserPreviewPaneState(JSON.parse(raw))) {
        clearInvalidState(storage, key);
      }
    } catch {
      clearInvalidState(storage, key);
    }
  }
}

export function writeBrowserPreviewPaneState(
  storage: BrowserPreviewPaneStateStorage,
  stateKey: string,
  state: WorkspaceBrowserPreviewPaneState,
): boolean {
  const key = browserPreviewPaneStateStorageKey(stateKey);
  try {
    const normalized = parseWorkspaceBrowserPreviewPaneState(state);
    if (!normalized) return false;
    const encoded = JSON.stringify(normalized);
    if (
      utf8.encode(encoded).byteLength > MAX_BROWSER_PREVIEW_PANE_STATE_BYTES
    ) {
      return false;
    }
    let keys = storageKeys(storage);
    if (
      !keys.includes(key) &&
      keys.length >= MAX_BROWSER_PREVIEW_PANE_STATE_ENTRIES
    ) {
      reclaimCapacity(storage);
      keys = storageKeys(storage);
    }
    if (
      !keys.includes(key) &&
      keys.length >= MAX_BROWSER_PREVIEW_PANE_STATE_ENTRIES
    ) {
      return false;
    }
    storage.setItem(key, encoded);
    return true;
  } catch {
    return false;
  }
}

export function removeBrowserPreviewPaneState(
  storage: BrowserPreviewPaneStateStorage,
  stateKey: string,
): boolean {
  try {
    storage.removeItem(browserPreviewPaneStateStorageKey(stateKey));
    return true;
  } catch {
    return false;
  }
}

export function createBrowserPreviewPaneStatePreparation(
  storage: BrowserPreviewPaneStateStorage,
  stateKey: string,
  state: WorkspaceBrowserPreviewPaneState,
): WorkspacePaneHostOpenPreparation {
  return {
    prepare: () => writeBrowserPreviewPaneState(storage, stateKey, state),
    rollback: () => removeBrowserPreviewPaneState(storage, stateKey),
  };
}
