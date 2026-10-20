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
 * and nothing here is consulted for authorization. Which Station may read an
 * occurrence is its own fence (`pane-fence.ts`), not this record, so nothing
 * here dropping, bounding or failing to parse can unfence a pane.
 *
 * The record is shared by every tab of this origin. Its writer
 * (`PaneRelationsContext`) only ever changes it inside an exclusive lock after
 * a fresh read, so two tabs cannot lose each other's entries.
 */

/**
 * The context a related plugin occurrence is opened in, beyond its Project:
 * at most the opener's own identity fields, the selector its reads keep
 * naming. Part of the target's identity, so a kept occurrence of one Session's
 * report is never the occurrence another Session's open focuses.
 */
export const RELATED_TARGET_SCOPE_KEYS = [
  'taskId',
  'sessionId',
  'runId',
  'workspaceId',
  'sourceId',
] as const;

export type RelatedTargetScope = Readonly<
  Partial<Record<(typeof RELATED_TARGET_SCOPE_KEYS)[number], string>>
>;

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
      /** The Project the occurrence is bound to. */
      readonly projectId: string;
      /** The opener's captured scope; `{}` when it captured none. */
      readonly scope: RelatedTargetScope;
      /** The installed plugin that owns the descriptor. */
      readonly pluginId: string;
      /** The installation it was opened under. */
      readonly generation: string;
      readonly descriptorId: string;
      readonly modeId: string;
      /** The plugin's own bounded, opaque target key. */
      readonly key: string;
    };

/**
 * What the opener was showing when it opened the pane, typed so Up can return
 * to EXACTLY that through the shell's canonical navigation:
 *
 * - `conversation`: a chat, by its durable conversation id (the navigation
 *   `chat` selection, which also cold-opens a closed conversation) and, when
 *   it has one, the execution session it was showing.
 * - `files`: a Files pane, with the Project it was bound to when it opened.
 * - `route`: a routed page (an app path and query, never an origin).
 * - `plugin-occurrence`: a plugin pane, by the Project it was bound to and,
 *   when it was a tab of one, the Project layout; the occurrence itself is
 *   the opener's `occurrenceId`. Plugins publish no selection: one reusable
 *   preview per opening occurrence.
 */
export type PaneOpenerSource =
  | {
      readonly kind: 'conversation';
      readonly conversationId: string | null;
      readonly threadId: string | null;
      readonly projectSlug: string | null;
    }
  | {
      readonly kind: 'files';
      readonly projectId: string;
      readonly projectSlug: string;
    }
  | {
      readonly kind: 'route';
      readonly pathname: string;
      readonly search: string;
    }
  | {
      readonly kind: 'plugin-occurrence';
      readonly projectSlug: string;
      readonly layoutSlug: string | null;
    };

/** The UI occurrence that opened a pane, at the selection it had then. */
export interface PaneOpener {
  /** The opener's region surface / occurrence id (e.g. `chat`). */
  readonly occurrenceId: string;
  /** What Up names. */
  readonly label: string;
  readonly source: PaneOpenerSource;
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
  /** Ordering only; not a clock anything else reads. */
  readonly openedAt: number;
}

export interface PaneRelationsRecord {
  readonly version: 1;
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

export const PANE_RELATIONS_LIMIT = 48;
export const PANE_RELATIONS_STORAGE_KEY = 'station:pane-relations:v1';
export const BUILTIN_PANE_GENERATION = 'builtin';
const MAX_BYTES = 96 * 1024;

export const EMPTY_PANE_RELATIONS: PaneRelationsRecord = Object.freeze({
  version: 1 as const,
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

function nullableText(value: unknown, max = 512): value is string | null {
  return value === null || boundedText(value, max);
}

/** An app-relative route: `/…` with no origin, fragment, backslash or traversal. */
function isOpenerRoute(pathname: unknown, search: unknown): boolean {
  return (
    boundedText(pathname, 2048) &&
    pathname.startsWith('/') &&
    !pathname.startsWith('//') &&
    !/[?#\\]/.test(pathname) &&
    !pathname.split('/').includes('..') &&
    typeof search === 'string' &&
    search.length <= 2048 &&
    !hasControlCharacter(search) &&
    !search.includes('#') &&
    (search === '' || search.startsWith('?'))
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
      !nullableText(value.thread, 1024)
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
    const scope = parseTargetScope(value.scope);
    if (
      !scope ||
      !boundedText(value.projectId, 256) ||
      !boundedText(value.pluginId, 256) ||
      !boundedText(value.generation, 512) ||
      !boundedText(value.descriptorId, 256) ||
      !boundedText(value.modeId, 128) ||
      !boundedText(value.key, 256)
    )
      return null;
    return {
      kind: 'plugin',
      projectId: value.projectId,
      scope,
      pluginId: value.pluginId,
      generation: value.generation,
      descriptorId: value.descriptorId,
      modeId: value.modeId,
      key: value.key,
    };
  }
  return null;
}

/** Closed: only the defined keys, each bounded text. */
export function parseTargetScope(value: unknown): RelatedTargetScope | null {
  if (!isRecordObject(value)) return null;
  const scope: Partial<
    Record<(typeof RELATED_TARGET_SCOPE_KEYS)[number], string>
  > = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(RELATED_TARGET_SCOPE_KEYS as readonly string[]).includes(key))
      return null;
    if (!boundedText(entry, 256)) return null;
    scope[key as (typeof RELATED_TARGET_SCOPE_KEYS)[number]] = entry;
  }
  return scope;
}

function parseSource(value: unknown): PaneOpenerSource | null {
  if (!isRecordObject(value)) return null;
  if (value.kind === 'conversation') {
    if (
      !nullableText(value.conversationId) ||
      !nullableText(value.threadId) ||
      !nullableText(value.projectSlug, 256) ||
      (value.conversationId === null && value.threadId === null)
    )
      return null;
    return {
      kind: 'conversation',
      conversationId: value.conversationId,
      threadId: value.threadId,
      projectSlug: value.projectSlug,
    };
  }
  if (value.kind === 'files') {
    if (
      !boundedText(value.projectId, 256) ||
      !boundedText(value.projectSlug, 256)
    )
      return null;
    return {
      kind: 'files',
      projectId: value.projectId,
      projectSlug: value.projectSlug,
    };
  }
  if (value.kind === 'route') {
    if (!isOpenerRoute(value.pathname, value.search)) return null;
    return {
      kind: 'route',
      pathname: value.pathname as string,
      search: value.search as string,
    };
  }
  if (value.kind === 'plugin-occurrence') {
    if (
      !boundedText(value.projectSlug, 256) ||
      !nullableText(value.layoutSlug, 256)
    )
      return null;
    return {
      kind: 'plugin-occurrence',
      projectSlug: value.projectSlug,
      layoutSlug: value.layoutSlug,
    };
  }
  return null;
}

function parseOpener(value: unknown): PaneOpener | null {
  if (
    !isRecordObject(value) ||
    !boundedText(value.occurrenceId, 512) ||
    !boundedText(value.label, 160)
  )
    return null;
  const source = parseSource(value.source);
  if (!source) return null;
  return { occurrenceId: value.occurrenceId, label: value.label, source };
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
    !boundedText(value.generation, 512) ||
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

/**
 * Read the stored record. Invalid entries, duplicate occurrences or state
 * keys and cycles are dropped one by one; the rest stand. A record holding
 * more entries than the bound — which no writer of this build produces — is
 * `unsupported` rather than cut, so nothing here chooses which entries to
 * lose. An oversized or unparsable record is empty; a newer version is
 * `unsupported`.
 */
export function parsePaneRelations(raw: string | null): PaneRelationsRead {
  if (raw === null || raw.length === 0 || raw.length > MAX_BYTES)
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  }
  if (!isRecordObject(value))
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  if (typeof value.version === 'number' && value.version > 1)
    return { status: 'unsupported', record: EMPTY_PANE_RELATIONS };
  if (value.version !== 1 || !Array.isArray(value.entries))
    return { status: 'empty', record: EMPTY_PANE_RELATIONS };
  if (value.entries.length > PANE_RELATIONS_LIMIT)
    return { status: 'unsupported', record: EMPTY_PANE_RELATIONS };
  const entries: PaneRelation[] = [];
  const instanceIds = new Set<string>();
  const stateKeys = new Set<string>();
  for (const candidate of value.entries) {
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
      version: 1,
      entries: entries.filter((entry) => !cyclic.has(entry.instanceId)),
    },
  };
}

export function serializePaneRelations(record: PaneRelationsRecord): string {
  return JSON.stringify({ version: 1, entries: record.entries });
}

/**
 * The opener selection an entry belongs to: one reusable preview per exact
 * selection, and the key source changes compare. Derived from the typed
 * source, so it cannot disagree with where Up returns.
 */
export function openerSelectionKey(opener: PaneOpener): string {
  const { source } = opener;
  switch (source.kind) {
    case 'conversation':
      return source.threadId !== null
        ? `thread:${source.threadId}`
        : `conversation:${source.conversationId}`;
    case 'files':
      return `files:${source.projectId}`;
    case 'route':
      return `route:${source.pathname}${source.search}`;
    case 'plugin-occurrence':
      return `plugin-occurrence:${source.projectSlug}/${source.layoutSlug ?? ''}`;
  }
}

function sameOpenerSelection(a: PaneOpener, b: PaneOpener): boolean {
  return (
    a.occurrenceId === b.occurrenceId &&
    openerSelectionKey(a) === openerSelectionKey(b)
  );
}

/**
 * Exact target identity: Station, Project, path and thread for a file; for a
 * plugin pane also every captured scope field and the installation, so an
 * occurrence bound to another Session, run or plugin installation is never
 * the one an open focuses.
 */
function paneTargetKey(stationId: string, target: PaneRelationTarget): string {
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
        target.projectId,
        ...RELATED_TARGET_SCOPE_KEYS.map((key) => target.scope[key] ?? null),
        target.pluginId,
        target.generation,
        target.descriptorId,
        target.modeId,
        target.key,
      ]);
  }
}

export function sameRelationTarget(
  stationId: string,
  a: PaneRelationTarget,
  b: PaneRelationTarget,
): boolean {
  return paneTargetKey(stationId, a) === paneTargetKey(stationId, b);
}

export function paneRelationOf(
  record: PaneRelationsRecord,
  instanceId: string,
): PaneRelation | undefined {
  return record.entries.find((entry) => entry.instanceId === instanceId);
}

/** The kept occurrence of this exact target on this Station, if one exists. */
export function keptPaneForTarget(
  record: PaneRelationsRecord,
  stationId: string,
  target: PaneRelationTarget,
): PaneRelation | undefined {
  const key = paneTargetKey(stationId, target);
  return record.entries.find(
    (entry) =>
      entry.kept &&
      entry.stationId === stationId &&
      paneTargetKey(entry.stationId, entry.target) === key,
  );
}

/** The one transient preview this exact opener selection owns, if any. */
export function transientPaneForOpener(
  record: PaneRelationsRecord,
  stationId: string,
  opener: PaneOpener,
): PaneRelation | undefined {
  return record.entries.find(
    (entry) =>
      !entry.kept &&
      entry.stationId === stationId &&
      sameOpenerSelection(entry.opener, opener),
  );
}

export type PaneRelationsWrite =
  | { readonly ok: true; readonly record: PaneRelationsRecord }
  | { readonly ok: false; readonly reason: 'capacity' };

/**
 * Add (or replace, by occurrence or state key) one entry. At the bound a NEW
 * entry is refused — nothing is evicted to make room, because every entry
 * still in the record belongs to an occurrence that still exists
 * (`prunePaneRelations` runs first).
 */
export function withPaneRelation(
  record: PaneRelationsRecord,
  relation: PaneRelation,
  replacing?: string,
): PaneRelationsWrite {
  const entries = record.entries.filter(
    (entry) =>
      entry.instanceId !== relation.instanceId &&
      entry.stateKey !== relation.stateKey &&
      entry.instanceId !== replacing,
  );
  if (entries.length >= PANE_RELATIONS_LIMIT)
    return { ok: false, reason: 'capacity' };
  return { ok: true, record: { version: 1, entries: [...entries, relation] } };
}

export function withoutPaneRelation(
  record: PaneRelationsRecord,
  instanceId: string,
): PaneRelationsRecord {
  if (!paneRelationOf(record, instanceId)) return record;
  return {
    version: 1,
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
    version: 1,
    entries: record.entries.map((entry) =>
      entry.instanceId === instanceId ? { ...entry, kept: true } : entry,
    ),
  };
}

/**
 * Drop entries whose occurrence no longer EXISTS in durable, origin-wide
 * storage (`exists`: its own state and fence are still stored). Never by
 * whether this tab happens to place it: another tab may be showing it.
 */
export function prunePaneRelations(
  record: PaneRelationsRecord,
  exists: (instanceId: string) => boolean,
): PaneRelationsRecord {
  const entries = record.entries.filter((entry) => exists(entry.instanceId));
  return entries.length === record.entries.length
    ? record
    : { version: 1, entries };
}

/**
 * The transient previews to hide because their opener now shows another
 * selection: Security review's preview hides while Documentation review is
 * on screen and returns with Security review. Kept panes never hide. Neither
 * does a preview whose opener has published no selection (nothing says the
 * source changed), one opened on another Station (its fence keeps it
 * unread), or one `isProtected` names — a preview holding unsaved work is
 * never taken off screen by a source change.
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
        current !== openerSelectionKey(entry.opener) &&
        !isProtected(entry.instanceId)
      );
    })
    .map((entry) => entry.instanceId);
}
