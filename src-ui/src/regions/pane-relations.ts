/**
 * Pane relationships (docs/design/pane-relationships.md): which pane occurrence
 * opened another, for which of its selections, which exact target the opened
 * pane shows and whether the user kept it.
 *
 * A SIDE record, beside the region arrangement rather than inside it: the
 * arrangement stays the one owner of position and tab order, and a build that
 * does not know this record still reads every arrangement it wrote. Entries
 * describe display and navigation only. They never grant a read, admit a
 * pane, rebind its context or establish domain (Task/run/Session) ancestry,
 * and nothing here is consulted for authorization.
 *
 * Every entry carries the exact Station (`AuthorityObservation.environmentId`)
 * it was opened against. Pane state in this browser is origin-wide, so a
 * reader switching Stations sees the other Station's occurrences; they are
 * matched and restored only against their own Station.
 */

/** What a related pane shows. Identity only: never a read grant. */
export type PaneRelationTarget =
  | {
      readonly kind: 'file';
      readonly projectId: string;
      readonly projectSlug: string;
      readonly path: string;
      /** The session whose directory the file is read through, if any. */
      readonly thread: string | null;
    }
  | {
      readonly kind: 'plugin';
      /** The installed plugin that owns the descriptor. */
      readonly pluginId: string;
      readonly descriptorId: string;
      readonly modeId: string;
      /** The plugin's own bounded, opaque target key. */
      readonly key: string;
    };

/** The UI occurrence that opened a pane, at the selection it had then. */
export interface PaneOpener {
  /** The opener's region surface / occurrence id (e.g. `chat`). */
  readonly occurrenceId: string;
  /** The opener's own selection identity (a conversation, a directory). */
  readonly selection: string;
  /** What Up names: the opener's selection as the reader knows it. */
  readonly label: string;
}

export interface PaneRelation {
  /** The related pane's surface id — its occurrence in the arrangement. */
  readonly instanceId: string;
  readonly stateKey: string;
  readonly stationId: string;
  /** The opener installation generation (`builtin` for Station's panes). */
  readonly generation: string;
  readonly opener: PaneOpener;
  readonly target: PaneRelationTarget;
  /** Kept panes are ordinary tabs; unkept ones are one reusable preview. */
  readonly kept: boolean;
  /** Ordering for the bound; not a clock anything else reads. */
  readonly openedAt: number;
}

export interface PaneRelationsRecord {
  readonly version: typeof PANE_RELATIONS_VERSION;
  readonly entries: readonly PaneRelation[];
}

/**
 * What a read found. `unsupported` is a record a NEWER build wrote: it is not
 * applied and never overwritten, so this build cannot erase kept work it does
 * not understand. Anything else unreadable is `empty` and may be replaced.
 */
export type PaneRelationsRead =
  | { readonly status: 'ok'; readonly record: PaneRelationsRecord }
  | { readonly status: 'empty'; readonly record: PaneRelationsRecord }
  | { readonly status: 'unsupported'; readonly record: PaneRelationsRecord };

export const PANE_RELATIONS_VERSION = 1 as const;
export const PANE_RELATIONS_LIMIT = 48;
export const PANE_RELATIONS_STORAGE_KEY = 'station:pane-relations:v1';
export const BUILTIN_PANE_GENERATION = 'builtin';
const MAX_BYTES = 96 * 1024;

export const EMPTY_PANE_RELATIONS: PaneRelationsRecord = Object.freeze({
  version: PANE_RELATIONS_VERSION,
  entries: Object.freeze([]) as readonly PaneRelation[],
});

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function boundedText(value: unknown, max = 1024): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !hasControlCharacter(value)
  );
}

/** A closed projection: only the fields this version defines are kept. */
function parseTarget(value: unknown): PaneRelationTarget | null {
  if (!isRecordObject(value)) return null;
  if (value.kind === 'file') {
    if (
      !boundedText(value.projectId) ||
      !boundedText(value.projectSlug) ||
      !boundedText(value.path, 4096) ||
      !(value.thread === null || boundedText(value.thread))
    )
      return null;
    return {
      kind: 'file',
      projectId: value.projectId,
      projectSlug: value.projectSlug,
      path: value.path,
      thread: value.thread,
    };
  }
  if (value.kind === 'plugin') {
    if (
      !boundedText(value.pluginId, 256) ||
      !boundedText(value.descriptorId, 256) ||
      !boundedText(value.modeId, 128) ||
      !boundedText(value.key, 256)
    )
      return null;
    return {
      kind: 'plugin',
      pluginId: value.pluginId,
      descriptorId: value.descriptorId,
      modeId: value.modeId,
      key: value.key,
    };
  }
  return null;
}

function parseOpener(value: unknown): PaneOpener | null {
  if (
    !isRecordObject(value) ||
    !boundedText(value.occurrenceId, 512) ||
    !boundedText(value.selection, 1024) ||
    !boundedText(value.label, 160)
  )
    return null;
  return {
    occurrenceId: value.occurrenceId,
    selection: value.selection,
    label: value.label,
  };
}

function parseEntry(value: unknown): PaneRelation | null {
  if (!isRecordObject(value)) return null;
  const opener = parseOpener(value.opener);
  const target = parseTarget(value.target);
  if (
    !opener ||
    !target ||
    !boundedText(value.instanceId, 512) ||
    !boundedText(value.stateKey, 512) ||
    !boundedText(value.stationId, 256) ||
    !boundedText(value.generation, 128) ||
    typeof value.kept !== 'boolean' ||
    typeof value.openedAt !== 'number' ||
    !Number.isSafeInteger(value.openedAt) ||
    value.openedAt < 0 ||
    // A pane is not its own opener.
    opener.occurrenceId === value.instanceId
  )
    return null;
  return {
    instanceId: value.instanceId,
    stateKey: value.stateKey,
    stationId: value.stationId,
    generation: value.generation,
    opener,
    target,
    kept: value.kept,
    openedAt: value.openedAt,
  };
}

/**
 * Entries whose opener chain returns to themselves. Openers outside the
 * record (Chat, a Files pane) end a chain; a loop through related panes is a
 * record no writer produces, so every entry on it is dropped rather than
 * trusted for Up.
 */
function cyclicEntries(entries: readonly PaneRelation[]): Set<string> {
  const byId = new Map(entries.map((entry) => [entry.instanceId, entry]));
  const cyclic = new Set<string>();
  for (const entry of entries) {
    const seen = new Set<string>([entry.instanceId]);
    let parent = byId.get(entry.opener.occurrenceId);
    while (parent) {
      if (seen.has(parent.instanceId)) {
        for (const id of seen) cyclic.add(id);
        break;
      }
      seen.add(parent.instanceId);
      parent = byId.get(parent.opener.occurrenceId);
    }
  }
  return cyclic;
}

/** Keeps the newest `PANE_RELATIONS_LIMIT` entries; transient ones go first. */
function bounded(entries: readonly PaneRelation[]): readonly PaneRelation[] {
  if (entries.length <= PANE_RELATIONS_LIMIT) return entries;
  const ranked = [...entries].sort(
    (a, b) => Number(b.kept) - Number(a.kept) || b.openedAt - a.openedAt,
  );
  const keep = new Set(
    ranked.slice(0, PANE_RELATIONS_LIMIT).map((entry) => entry.instanceId),
  );
  return entries.filter((entry) => keep.has(entry.instanceId));
}

/**
 * Read the stored record. Invalid entries, duplicate occurrences or state
 * keys, cycles and entries past the bound are dropped one by one; the rest
 * stand. An oversized or unparsable record is empty; a newer version is
 * `unsupported`.
 */
export function parsePaneRelations(raw: string | null): PaneRelationsRead {
  if (raw === null || raw.length === 0)
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  if (raw.length > MAX_BYTES)
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  }
  if (!isRecordObject(value))
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  if (
    typeof value.version === 'number' &&
    value.version > PANE_RELATIONS_VERSION
  )
    return { status: 'unsupported', record: EMPTY_PANE_RELATIONS };
  if (value.version !== PANE_RELATIONS_VERSION || !Array.isArray(value.entries))
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  const entries: PaneRelation[] = [];
  const instanceIds = new Set<string>();
  const stateKeys = new Set<string>();
  for (const candidate of value.entries.slice(0, PANE_RELATIONS_LIMIT * 2)) {
    const entry = parseEntry(candidate);
    if (
      !entry ||
      instanceIds.has(entry.instanceId) ||
      stateKeys.has(entry.stateKey)
    )
      continue;
    instanceIds.add(entry.instanceId);
    stateKeys.add(entry.stateKey);
    entries.push(entry);
  }
  const cyclic = cyclicEntries(entries);
  return {
    status: 'ok',
    record: {
      version: PANE_RELATIONS_VERSION,
      entries: bounded(
        entries.filter((entry) => !cyclic.has(entry.instanceId)),
      ),
    },
  };
}

export function serializePaneRelations(record: PaneRelationsRecord): string {
  return JSON.stringify({
    version: PANE_RELATIONS_VERSION,
    entries: record.entries,
  });
}

/** Exact target identity: Station, Project, path and thread where they apply. */
export function paneTargetKey(
  stationId: string,
  target: PaneRelationTarget,
): string {
  switch (target.kind) {
    case 'file':
      return JSON.stringify([
        'file',
        stationId,
        target.projectId,
        target.projectSlug,
        target.path,
        target.thread,
      ]);
    case 'plugin':
      return JSON.stringify([
        'plugin',
        stationId,
        target.pluginId,
        target.descriptorId,
        target.modeId,
        target.key,
      ]);
  }
}

export function samePaneOpenerSelection(a: PaneOpener, b: PaneOpener): boolean {
  return a.occurrenceId === b.occurrenceId && a.selection === b.selection;
}

export function paneRelationOf(
  record: PaneRelationsRecord,
  instanceId: string,
): PaneRelation | undefined {
  return record.entries.find((entry) => entry.instanceId === instanceId);
}

/** A kept occurrence of this exact target on this Station, if one is placed. */
export function keptPaneForTarget(
  record: PaneRelationsRecord,
  stationId: string,
  target: PaneRelationTarget,
  isPlaced: (instanceId: string) => boolean,
): PaneRelation | undefined {
  const key = paneTargetKey(stationId, target);
  return record.entries.find(
    (entry) =>
      entry.kept &&
      entry.stationId === stationId &&
      paneTargetKey(entry.stationId, entry.target) === key &&
      isPlaced(entry.instanceId),
  );
}

/** The one transient preview this exact opener selection owns, if placed. */
export function transientPaneForOpener(
  record: PaneRelationsRecord,
  stationId: string,
  opener: PaneOpener,
  isPlaced: (instanceId: string) => boolean,
): PaneRelation | undefined {
  return record.entries.find(
    (entry) =>
      !entry.kept &&
      entry.stationId === stationId &&
      samePaneOpenerSelection(entry.opener, opener) &&
      isPlaced(entry.instanceId),
  );
}

export function withPaneRelation(
  record: PaneRelationsRecord,
  relation: PaneRelation,
): PaneRelationsRecord {
  const entries = record.entries.filter(
    (entry) =>
      entry.instanceId !== relation.instanceId &&
      entry.stateKey !== relation.stateKey,
  );
  return {
    version: PANE_RELATIONS_VERSION,
    entries: bounded([...entries, relation]),
  };
}

export function withoutPaneRelation(
  record: PaneRelationsRecord,
  instanceId: string,
): PaneRelationsRecord {
  if (!paneRelationOf(record, instanceId)) return record;
  return {
    version: PANE_RELATIONS_VERSION,
    entries: record.entries.filter((entry) => entry.instanceId !== instanceId),
  };
}

export function withKeptPane(
  record: PaneRelationsRecord,
  instanceId: string,
): PaneRelationsRecord {
  const current = paneRelationOf(record, instanceId);
  if (!current || current.kept) return record;
  return {
    version: PANE_RELATIONS_VERSION,
    entries: record.entries.map((entry) =>
      entry.instanceId === instanceId ? { ...entry, kept: true } : entry,
    ),
  };
}

/**
 * Drop entries for occurrences the arrangement no longer holds. Run on the
 * writes this module makes, never on a read: an arrangement still loading is
 * not evidence that a pane was closed.
 */
export function prunePaneRelations(
  record: PaneRelationsRecord,
  isPlaced: (instanceId: string) => boolean,
): PaneRelationsRecord {
  const entries = record.entries.filter((entry) => isPlaced(entry.instanceId));
  return entries.length === record.entries.length
    ? record
    : { version: PANE_RELATIONS_VERSION, entries };
}

/**
 * The transient previews to hide because their opener now shows another
 * selection: Security review's preview hides while Documentation review is
 * on screen and returns with Security review. Kept panes never hide. Neither
 * does a preview whose opener has published no selection (nothing says the
 * source changed), one opened on another Station (it renders its own
 * placeholder) or one `isProtected` names — a preview holding unsaved work
 * is never taken off screen by a source change.
 */
export function sourceHiddenPanes(
  record: PaneRelationsRecord,
  stationId: string | null,
  selections: ReadonlyMap<string, string>,
  isProtected: (instanceId: string) => boolean,
): string[] {
  if (stationId === null) return [];
  return record.entries
    .filter((entry) => {
      if (entry.kept || entry.stationId !== stationId) return false;
      const current = selections.get(entry.opener.occurrenceId);
      return (
        current !== undefined &&
        current !== entry.opener.selection &&
        !isProtected(entry.instanceId)
      );
    })
    .map((entry) => entry.instanceId);
}
