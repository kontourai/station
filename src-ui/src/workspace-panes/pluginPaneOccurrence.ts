import {
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { removeFencedRecord, removePaneFence } from '../regions/pane-fence';
import {
  type PaneRelationTarget,
  RELATED_TARGET_SCOPE_KEYS,
} from '../regions/pane-relations';

/**
 * A plugin pane the HOST minted for a related open
 * (docs/design/pane-relationships.md, `PaneRelatedPanesHost.open`). Its id is
 * `plugin-pane:<nonce>`, and what it shows — which installed plugin, which of
 * that plugin's descriptors and modes, the plugin's own opaque target key and
 * the opener's captured scope — is this record, written once when the
 * occurrence is minted and removed with it.
 *
 * The record names; it never authorizes. Rendering re-derives the descriptor
 * from the Project's server catalog and admits the renderer against the live
 * plugin registry every time (`RegionPluginPane`), and a plugin whose
 * installed generation is no longer the recorded one renders an unavailable
 * placeholder. The captured scope is a selector the server still authorizes
 * on every read.
 */

export const PLUGIN_PANE_ID = /^plugin-pane:[0-9a-f]{32}$/;
const PLUGIN_PANE_STATE_PREFIX = 'station:plugin-pane-state:v1';
/** At most this many plugin occurrences are stored; a further one is refused. */
export const MAX_PLUGIN_PANE_STATES = 48;
const MAX_PLUGIN_PANE_STATE_BYTES = 4 * 1024;

const SCOPE_KEYS = RELATED_TARGET_SCOPE_KEYS;

export type PluginPaneScope = Partial<
  Record<(typeof SCOPE_KEYS)[number], string>
>;

export interface PluginPaneState {
  version: 1;
  projectId: string;
  projectSlug: string;
  pluginId: string;
  /** The installed contribution the occurrence was opened under. */
  generation: string;
  descriptorId: string;
  modeId: string;
  key: string;
  title?: string;
  /** The opener's captured scope: at most the opener's own identity fields. */
  scope?: PluginPaneScope;
}

export interface PluginPaneStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A non-empty string of at most `max` characters with no control character. */
export function isBoundedPaneText(
  value: unknown,
  max: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !hasControlCharacter(value)
  );
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScope(value: unknown): PluginPaneScope | null {
  if (!isRecordObject(value)) return null;
  const scope: PluginPaneScope = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(SCOPE_KEYS as readonly string[]).includes(key)) return null;
    if (!isBoundedPaneText(entry, 256)) return null;
    scope[key as (typeof SCOPE_KEYS)[number]] = entry;
  }
  return scope;
}

/** Closed: only the fields this version defines survive a read. */
export function parsePluginPaneState(value: unknown): PluginPaneState | null {
  if (!isRecordObject(value)) return null;
  if (
    value.version !== 1 ||
    !isBoundedPaneText(value.projectId, 256) ||
    !isBoundedPaneText(value.projectSlug, 256) ||
    !isBoundedPaneText(value.pluginId, 256) ||
    !isBoundedPaneText(value.generation, 512) ||
    !isBoundedPaneText(value.descriptorId, 256) ||
    !isBoundedPaneText(value.modeId, 128) ||
    !isBoundedPaneText(value.key, 256) ||
    !(value.title === undefined || isBoundedPaneText(value.title, 160))
  )
    return null;
  const scope = value.scope === undefined ? undefined : parseScope(value.scope);
  if (scope === null) return null;
  return {
    version: 1,
    projectId: value.projectId,
    projectSlug: value.projectSlug,
    pluginId: value.pluginId,
    generation: value.generation,
    descriptorId: value.descriptorId,
    modeId: value.modeId,
    key: value.key,
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(scope !== undefined && Object.keys(scope).length > 0 ? { scope } : {}),
  };
}

function storageKey(id: string): string {
  return `${PLUGIN_PANE_STATE_PREFIX}:${id}`;
}

function storedCount(storage: PluginPaneStateStorage): number {
  let count = 0;
  for (let index = 0; index < storage.length; index += 1)
    if (storage.key(index)?.startsWith(`${PLUGIN_PANE_STATE_PREFIX}:`))
      count += 1;
  return count;
}

export function readPluginPaneState(
  storage: Pick<PluginPaneStateStorage, 'getItem'>,
  id: string,
): PluginPaneState | null {
  if (!PLUGIN_PANE_ID.test(id)) return null;
  try {
    const raw = storage.getItem(storageKey(id));
    if (!raw || raw.length > MAX_PLUGIN_PANE_STATE_BYTES) return null;
    return parsePluginPaneState(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Stage a NEW occurrence's record. `prepare` writes it and is refused —
 * false, nothing written — for a malformed id or record, an id that already
 * has one, past the bound or the size limit, or when storage throws. The
 * caller then opens nothing. `rollback` removes what `prepare` wrote and the
 * occurrence's fence with it.
 */
export function createPluginPaneStatePreparation(
  storage: PluginPaneStateStorage,
  id: string,
  state: PluginPaneState,
): { prepare(): boolean; rollback(): void } {
  let written = false;
  return {
    prepare() {
      const parsed = parsePluginPaneState(state);
      if (!PLUGIN_PANE_ID.test(id) || !parsed) return false;
      try {
        if (storage.getItem(storageKey(id)) !== null) return false;
        if (storedCount(storage) >= MAX_PLUGIN_PANE_STATES) return false;
        const raw = JSON.stringify(parsed);
        if (raw.length > MAX_PLUGIN_PANE_STATE_BYTES) return false;
        storage.setItem(storageKey(id), raw);
        written = storage.getItem(storageKey(id)) === raw;
        return written;
      } catch {
        return false;
      }
    },
    rollback() {
      if (written) removePluginPaneState(storage, id);
      // Nothing of ours was written; the fence goes only with no record
      // under it, so a record that was there already keeps its fence.
      else if (storage.getItem(storageKey(id)) === null)
        removePaneFence(storage, id);
      written = false;
    },
  };
}

/**
 * Remove an occurrence's record, and with it the occurrence's Station fence —
 * the fence only once the record is gone (`removeFencedRecord`). True when
 * the record is gone.
 */
export function removePluginPaneState(
  storage: Pick<PluginPaneStateStorage, 'getItem' | 'setItem' | 'removeItem'>,
  id: string,
): boolean {
  if (!PLUGIN_PANE_ID.test(id)) return false;
  return removeFencedRecord(storage, id, storageKey(id));
}

export function mintPluginPaneId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `plugin-pane:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The exact related target a stored record is: what a relation naming this
 * occurrence must agree with before the occurrence is focused or closed.
 */
export function pluginPaneTarget(
  state: PluginPaneState,
): Extract<PaneRelationTarget, { kind: 'plugin' }> {
  return {
    kind: 'plugin',
    projectId: state.projectId,
    scope: state.scope ?? {},
    pluginId: state.pluginId,
    generation: state.generation,
    descriptorId: state.descriptorId,
    modeId: state.modeId,
    key: state.key,
  };
}

/**
 * The occurrence's identity as a region holds it: the plugin's descriptor,
 * the occurrence id as its state key, and the recorded Project and scope.
 * Deliberately no `contribution`: what may render it is the Project
 * catalog's server-issued contribution, attached where it renders.
 */
export function pluginPaneInstance(
  id: string,
  state: PluginPaneState,
): WorkspacePaneInstance | null {
  if (!PLUGIN_PANE_ID.test(id)) return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: state.descriptorId,
    instanceId: id,
    stateKey: id,
    boundContext: { projectId: state.projectId, ...state.scope },
  });
}
