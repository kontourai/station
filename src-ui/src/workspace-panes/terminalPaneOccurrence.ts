import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { decodeRelatedTerminalOpenRequest } from '@kontourai/station-contracts/workspace-pane-host-contract';
import {
  createWorkspaceTerminalPaneInstance,
  WORKSPACE_TERMINAL_PANE_INSTANCE_PATTERN,
} from '@kontourai/station-contracts/workspace-terminal-pane';
import { removeFencedRecord, removePaneFence } from '../regions/pane-fence';
import type { PaneRelationTarget } from '../regions/pane-relations';
import { isBoundedPaneText } from './pluginPaneOccurrence';

/**
 * A terminal session the host opened as a related pane for a plugin
 * (docs/design/terminal.md, "Plugins"). The id is `terminal-pane:<nonce>`;
 * which session it shows is this record, written once when the occurrence is
 * minted and removed with it. The record names a session; the server still
 * authorizes every attach against the viewer's own terminal grant.
 */

export const TERMINAL_PANE_ID = WORKSPACE_TERMINAL_PANE_INSTANCE_PATTERN;
const STATE_PREFIX = 'station:terminal-pane-state:v1';
/** At most this many terminal occurrences are stored; a further one is refused. */
export const MAX_TERMINAL_PANE_STATES = 32;
const MAX_STATE_BYTES = 2 * 1024;

export interface TerminalPaneState {
  version: 1;
  projectId: string;
  projectSlug: string;
  /** The session's `bindingKey`. */
  binding: string;
  terminalId: string;
}

type Storage = Pick<
  globalThis.Storage,
  'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'
>;

export function parseTerminalPaneState(
  value: unknown,
): TerminalPaneState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    !isBoundedPaneText(state.projectId, 256) ||
    !isBoundedPaneText(state.projectSlug, 256) ||
    typeof state.binding !== 'string' ||
    typeof state.terminalId !== 'string'
  )
    return null;
  // The binding and id obey the same bounds as the target that named them.
  const named = decodeRelatedTerminalOpenRequest({
    kind: 'terminal',
    binding: state.binding,
    terminalId: state.terminalId,
  });
  if (!named?.terminalId) return null;
  return {
    version: 1,
    projectId: state.projectId,
    projectSlug: state.projectSlug,
    binding: named.binding,
    terminalId: named.terminalId,
  };
}

function storageKey(id: string): string {
  return `${STATE_PREFIX}:${id}`;
}

export function readTerminalPaneState(
  storage: Pick<Storage, 'getItem'>,
  id: string,
): TerminalPaneState | null {
  if (!TERMINAL_PANE_ID.test(id)) return null;
  try {
    const raw = storage.getItem(storageKey(id));
    if (!raw || raw.length > MAX_STATE_BYTES) return null;
    return parseTerminalPaneState(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Stage a new occurrence's record: `prepare` writes it, refused (false,
 * nothing written) for a malformed id or record, an id already in use, past
 * the bound, or when storage throws. `rollback` removes what it wrote and the
 * occurrence's fence.
 */
export function createTerminalPaneStatePreparation(
  storage: Storage,
  id: string,
  state: TerminalPaneState,
): { prepare(): boolean; rollback(): void } {
  let written = false;
  return {
    prepare() {
      const parsed = parseTerminalPaneState(state);
      if (!TERMINAL_PANE_ID.test(id) || !parsed) return false;
      try {
        if (storage.getItem(storageKey(id)) !== null) return false;
        let count = 0;
        for (let index = 0; index < storage.length; index += 1)
          if (storage.key(index)?.startsWith(`${STATE_PREFIX}:`)) count += 1;
        if (count >= MAX_TERMINAL_PANE_STATES) return false;
        const raw = JSON.stringify(parsed);
        storage.setItem(storageKey(id), raw);
        written = storage.getItem(storageKey(id)) === raw;
        return written;
      } catch {
        return false;
      }
    },
    rollback() {
      if (written) removeTerminalPaneState(storage, id);
      else if (storage.getItem(storageKey(id)) === null)
        removePaneFence(storage, id);
      written = false;
    },
  };
}

export function removeTerminalPaneState(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  id: string,
): boolean {
  if (!TERMINAL_PANE_ID.test(id)) return false;
  return removeFencedRecord(storage, id, storageKey(id));
}

export function mintTerminalPaneId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `terminal-pane:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function terminalPaneTarget(
  state: Pick<TerminalPaneState, 'projectId' | 'binding' | 'terminalId'>,
): Extract<PaneRelationTarget, { kind: 'terminal' }> {
  return {
    kind: 'terminal',
    projectId: state.projectId,
    binding: state.binding,
    terminalId: state.terminalId,
  };
}

export function terminalPaneInstance(
  id: string,
  state: TerminalPaneState,
): WorkspacePaneInstance | null {
  return createWorkspaceTerminalPaneInstance(id, state.projectId);
}
