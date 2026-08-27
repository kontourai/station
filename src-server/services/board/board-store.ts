import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  BOARD_SCHEMA_VERSION,
  BOARD_WIDGET_SIZES,
  type Board,
  type BoardReference,
  type BoardTab,
  type BoardWidget,
  type BoardWidgetSize,
  isBoardReference,
  MAX_BOARD_TABS,
  MAX_BOARD_TEXT_BYTES,
  MAX_BOARD_WIDGETS,
} from '@kontourai/station-contracts/board';
import type { UIBlock } from '@kontourai/station-contracts/ui-block';
import { mutateJsonFile } from '../../domain/file-storage-helpers.js';

const MAX_STORE_BYTES = 512 * 1024;
const DEFAULT_TAB_ID = 'default';
const DEFAULT_TAB_TITLE = 'Board';

export class BoardUnavailableError extends Error {}
export class BoardCapacityError extends Error {}
export class BoardWidgetNotFoundError extends Error {}
export class BoardTabNotFoundError extends Error {}
/**
 * Fix round B1, layer (b): the LAST-resort containment backstop. Thrown by
 * {@link containedJoin} whenever a resolved path would land outside its
 * root — never falls through to a silent, escaped path. This is a
 * REDUNDANT check by design (layer (c)'s fixed per-id-segment prefix
 * already makes an escape impossible on its own), kept because layer (a)'s
 * `isBoardReference` regex and layer (c)'s prefixing are two MORE places a
 * future edit could regress; this is the one that can never regress
 * silently, because it re-derives containment from the actual resolved
 * path rather than trusting either upstream layer's classification.
 */
export class BoardReferenceInvalidError extends Error {}
/**
 * Slice 1 has no update-in-place (station#4079 design: generated-identity
 * collision diversion is slice 4). A `pin` naming an already-used widget
 * `name` fails closed rather than silently clobbering the existing widget —
 * unpin it first, or move it, to reuse a name.
 */
export class BoardWidgetNameConflictError extends Error {}

/** Input to {@link BoardStore.pin} — the block is already host-accepted (station#1399's pin-boundary gate runs before this store is ever called). */
export interface PinWidgetInput {
  readonly block: UIBlock;
  readonly name: string;
  readonly tabId?: string;
  readonly tabTitle?: string;
  readonly size?: BoardWidgetSize;
  /** Place after this widget's name within the target tab; omitted appends to the end. */
  readonly after?: string;
}

export interface MoveWidgetInput {
  readonly tabId?: string;
  readonly after?: string;
}

function text(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maxBytes &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function exactKeys(value: object, required: string[]): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key))
  );
}

function validTab(value: unknown): value is BoardTab {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Record<string, unknown>;
  return (
    exactKeys(tab, ['id', 'title', 'position']) &&
    text(tab.id, 160) &&
    text(tab.title, MAX_BOARD_TEXT_BYTES) &&
    typeof tab.position === 'number' &&
    Number.isInteger(tab.position) &&
    tab.position >= 0
  );
}

/**
 * Deliberately shallow: this store's ONLY writer is {@link BoardStore.pin},
 * which always persists an already host-accepted block (`board-provenance
 * .ts`'s `acceptBoardWidgetBlock`, station#1399's contract functions). A
 * full per-field UIBlock re-validation on every read would duplicate that
 * gate rather than trust the boundary that already ran it — this checks only
 * that the stored value still looks like the object shape the writer
 * produces, so an out-of-band-corrupted file fails closed instead of
 * crashing the read.
 */
function looksLikeUIBlock(value: unknown): value is UIBlock {
  if (!value || typeof value !== 'object') return false;
  const type = (value as Record<string, unknown>).type;
  return (
    type === 'card' || type === 'table' || type === 'code' || type === 'form'
  );
}

function validWidget(value: unknown): value is BoardWidget {
  if (!value || typeof value !== 'object') return false;
  const widget = value as Record<string, unknown>;
  return (
    exactKeys(widget, [
      'id',
      'name',
      'tabId',
      'position',
      'size',
      'block',
      'revision',
      'generation',
      'pinnedAt',
    ]) &&
    text(widget.id, 160) &&
    text(widget.name, MAX_BOARD_TEXT_BYTES) &&
    text(widget.tabId, 160) &&
    typeof widget.position === 'number' &&
    Number.isInteger(widget.position) &&
    widget.position >= 0 &&
    (BOARD_WIDGET_SIZES as readonly string[]).includes(widget.size as string) &&
    looksLikeUIBlock(widget.block) &&
    typeof widget.revision === 'number' &&
    Number.isInteger(widget.revision) &&
    widget.revision >= 0 &&
    text(widget.generation, 160) &&
    text(widget.pinnedAt, 64)
  );
}

function validBoard(value: unknown, reference: BoardReference): value is Board {
  if (!value || typeof value !== 'object') return false;
  const board = value as Record<string, unknown>;
  return (
    exactKeys(board, ['schemaVersion', 'reference', 'tabs', 'widgets']) &&
    board.schemaVersion === BOARD_SCHEMA_VERSION &&
    JSON.stringify(board.reference) === JSON.stringify(reference) &&
    Array.isArray(board.tabs) &&
    board.tabs.length <= MAX_BOARD_TABS &&
    board.tabs.every(validTab) &&
    new Set((board.tabs as BoardTab[]).map((t) => t.id)).size ===
      board.tabs.length &&
    Array.isArray(board.widgets) &&
    board.widgets.length <= MAX_BOARD_WIDGETS &&
    board.widgets.every(validWidget) &&
    new Set((board.widgets as BoardWidget[]).map((w) => w.id)).size ===
      board.widgets.length &&
    new Set((board.widgets as BoardWidget[]).map((w) => w.name)).size ===
      board.widgets.length &&
    (board.widgets as BoardWidget[]).every((w) =>
      (board.tabs as BoardTab[]).some((t) => t.id === w.tabId),
    )
  );
}

function emptyBoard(reference: BoardReference): Board {
  return {
    schemaVersion: BOARD_SCHEMA_VERSION,
    reference,
    tabs: [],
    widgets: [],
  };
}

function widgetsForTab(
  widgets: readonly BoardWidget[],
  tabId: string,
): BoardWidget[] {
  return widgets
    .filter((w) => w.tabId === tabId)
    .sort((a, b) => a.position - b.position);
}

/** Dense, 0-based renormalization of one tab's widget positions. */
function renormalizeTabWidgets(
  widgets: readonly BoardWidget[],
  tabId: string,
): BoardWidget[] {
  const inTab = widgetsForTab(widgets, tabId);
  const nextPosition = new Map(inTab.map((w, index) => [w.id, index]));
  return widgets.map((w) =>
    w.tabId === tabId && w.position !== nextPosition.get(w.id)
      ? { ...w, position: nextPosition.get(w.id) as number }
      : w,
  );
}

function renormalizeTabs(tabs: readonly BoardTab[]): BoardTab[] {
  return tabs.map((tab, index) =>
    tab.position === index ? tab : { ...tab, position: index },
  );
}

/**
 * Inserts `widget` into `tabId`, positioned after the widget named `after`
 * (or appended when omitted/not found — station#4079 design: "Agent
 * vocabulary is presets and `after: <name>` — never pixels"), then
 * renormalizes the whole tab to dense 0-based positions.
 */
function insertAndRenormalize(
  widgets: readonly BoardWidget[],
  tabId: string,
  widget: BoardWidget,
  after: string | undefined,
): BoardWidget[] {
  const others = widgets.filter((w) => w.id !== widget.id);
  const inTab = widgetsForTab(others, tabId);
  const otherTabs = others.filter((w) => w.tabId !== tabId);
  const afterIndex = after ? inTab.findIndex((w) => w.name === after) : -1;
  const insertAt = afterIndex === -1 ? inTab.length : afterIndex + 1;
  const nextInTab = [
    ...inTab.slice(0, insertAt),
    widget,
    ...inTab.slice(insertAt),
  ].map((w, index) => ({ ...w, position: index }));
  return [...otherTabs, ...nextInTab];
}

/**
 * Fix round B1, layer (b) — the pure containment primitive. Joins `root`
 * with `segments` and asserts the result is still WITHIN `root`, throwing
 * {@link BoardReferenceInvalidError} (never returning an escaped path) when
 * it is not. Exported and unit-tested directly with a RAW, unprefixed `..`
 * segment (bypassing layer (a)'s reference-level rejection AND layer (c)'s
 * fixed prefix, both applied only in {@link BoardStore.pathFor}) so this
 * function's own contribution is provable in isolation — see
 * `board-store.test.ts`'s "containedJoin refuses an escaping path" test and
 * its fault-injection companion.
 */
export function containedJoin(root: string, ...segments: string[]): string {
  const resolved = join(root, ...segments);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new BoardReferenceInvalidError(
      `Board reference resolves outside the board store root: ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Fix round B1, layer (c) — wraps an id-derived path segment with a FIXED
 * label prefix before `encodeURIComponent`, so the resulting segment can
 * NEVER equal the bare traversal tokens `.`/`..` regardless of what `value`
 * contains — even if layer (a)'s grammar check regressed. `encodeURIComponent`
 * already escapes `/`, `\`, and `:`; the prefix additionally rules out a
 * pure-dots value surviving as a bare component (`encodeURIComponent('..')`
 * is `'..'` verbatim — dots are never escaped).
 */
function boardIdSegment(label: string, value: string): string {
  return `${label}-${encodeURIComponent(value)}`;
}

/**
 * station#4079 slice 1 — the board's persisted store. One JSON file per
 * owning {@link BoardReference} (station#4079 design: "keyed on the durable
 * session/Task identity"), mirroring `session-summary-store.ts`'s
 * per-coordinate file layout. Mutation goes through
 * `mutateJsonFile` (`@kontourai/station-shared/json-file-storage`), the same
 * lock-serialized read/derive/publish primitive `SpatialBoardStore` uses —
 * every pin/unpin/move on one board file is serialized by that primitive's
 * per-path mutation lock, closing the CAS-less-read-modify-write class this
 * repo has hit three times before (station#1588/#1600/#1606).
 *
 * Chosen over the alternative "one shared JSON-store keyed by id"
 * (`conversation-acknowledgement-store.ts`'s `JsonFileStore` idiom): a board
 * can grow to `MAX_BOARD_WIDGETS` UI blocks, and every session/Task gets its
 * own file so one board's size and mutation rate never contends with
 * another's, matching `SpatialBoardStore`'s per-record CAS-oriented shape
 * (revision/generation tracked per WIDGET here, not per board, since the
 * design's two versioning axes are content-scoped) rather than a
 * single-shared-document idiom meant for many small independent keys.
 */
export class BoardStore {
  constructor(private readonly boardsDir: string) {}

  private pathFor(reference: BoardReference): string {
    // Layer (a) (isBoardReference) has already run in every public caller
    // below; this local re-check is intentionally paranoid (fail closed on
    // a reference that somehow reached pathFor without it — e.g. a future
    // internal caller that forgets the gate).
    if (!isBoardReference(reference)) {
      throw new BoardReferenceInvalidError('Invalid board reference.');
    }
    const segments =
      reference.kind === 'session'
        ? ['session', boardIdSegment('id', reference.id)]
        : [
            'task',
            boardIdSegment('project', reference.projectId),
            boardIdSegment('id', reference.id),
          ];
    // Layer (b): re-derive containment from the ACTUAL resolved path.
    return containedJoin(this.boardsDir, ...segments, 'board.json');
  }

  async read(reference: BoardReference): Promise<Board> {
    if (!isBoardReference(reference)) {
      throw new BoardReferenceInvalidError('Invalid board reference.');
    }
    const filePath = this.pathFor(reference);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyBoard(reference);
      }
      throw new BoardUnavailableError('Board store is unavailable.');
    }
    if (bytes.byteLength > MAX_STORE_BYTES) {
      throw new BoardUnavailableError('Board store is oversized.');
    }
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new BoardUnavailableError('Board store is not valid UTF-8.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new BoardUnavailableError('Board store is corrupt.');
    }
    if (!validBoard(parsed, reference)) {
      throw new BoardUnavailableError('Board store is corrupt or unavailable.');
    }
    return parsed;
  }

  private async update(
    reference: BoardReference,
    mutate: (board: Board) => Board,
  ): Promise<Board> {
    if (!isBoardReference(reference)) {
      throw new BoardReferenceInvalidError('Invalid board reference.');
    }
    const filePath = this.pathFor(reference);
    return mutateJsonFile<unknown>(
      filePath,
      emptyBoard(reference),
      (stored) => {
        if (!validBoard(stored, reference)) {
          throw new BoardUnavailableError(
            'Board store is corrupt or unavailable.',
          );
        }
        const next = mutate(stored);
        if (!validBoard(next, reference)) {
          throw new BoardUnavailableError('Board update is invalid.');
        }
        return next;
      },
      { maxBytes: MAX_STORE_BYTES, label: 'Board store' },
    ).then((value) => value as Board);
  }

  /**
   * Pins `input.block` — which MUST already have cleared the station#1399
   * provenance-accept gate (`board-provenance.ts#acceptBoardWidgetBlock`,
   * called by the route/tool boundary before this method is ever reached) —
   * onto the board, creating its owning tab on first use. Returns the
   * refreshed board and the created widget.
   */
  async pin(
    reference: BoardReference,
    input: PinWidgetInput,
  ): Promise<{ board: Board; widget: BoardWidget }> {
    if (!text(input.name, MAX_BOARD_TEXT_BYTES)) {
      throw new BoardUnavailableError('Board widget name is invalid.');
    }
    let created: BoardWidget | undefined;
    const board = await this.update(reference, (current) => {
      if (current.widgets.length >= MAX_BOARD_WIDGETS) {
        throw new BoardCapacityError('Board is at widget capacity.');
      }
      if (current.widgets.some((w) => w.name === input.name)) {
        throw new BoardWidgetNameConflictError(
          'Board widget name already exists.',
        );
      }
      const tabId = input.tabId ?? current.tabs[0]?.id ?? DEFAULT_TAB_ID;
      let tabs = current.tabs;
      if (!tabs.some((t) => t.id === tabId)) {
        if (tabs.length >= MAX_BOARD_TABS) {
          throw new BoardCapacityError('Board is at tab capacity.');
        }
        tabs = renormalizeTabs([
          ...tabs,
          {
            id: tabId,
            title: input.tabTitle ?? DEFAULT_TAB_TITLE,
            position: 0,
          },
        ]);
      }
      const widget: BoardWidget = {
        id: randomUUID(),
        name: input.name,
        tabId,
        position: 0,
        size: input.size ?? 'md',
        block: input.block,
        revision: 0,
        generation: randomUUID(),
        pinnedAt: new Date().toISOString(),
      };
      created = widget;
      const widgets = insertAndRenormalize(
        current.widgets,
        tabId,
        widget,
        input.after,
      );
      return { ...current, tabs, widgets };
    });
    return {
      board,
      widget: board.widgets.find((w) => w.id === created?.id) as BoardWidget,
    };
  }

  async unpin(reference: BoardReference, name: string): Promise<Board> {
    return this.update(reference, (current) => {
      const target = current.widgets.find((w) => w.name === name);
      if (!target) {
        throw new BoardWidgetNotFoundError('Board widget not found.');
      }
      const remaining = current.widgets.filter((w) => w.id !== target.id);
      const widgets = renormalizeTabWidgets(remaining, target.tabId);
      return { ...current, widgets };
    });
  }

  async move(
    reference: BoardReference,
    name: string,
    opts: MoveWidgetInput,
  ): Promise<Board> {
    return this.update(reference, (current) => {
      const target = current.widgets.find((w) => w.name === name);
      if (!target) {
        throw new BoardWidgetNotFoundError('Board widget not found.');
      }
      const destTabId = opts.tabId ?? target.tabId;
      if (opts.tabId && !current.tabs.some((t) => t.id === destTabId)) {
        throw new BoardTabNotFoundError('Board tab not found.');
      }
      const withoutTarget = renormalizeTabWidgets(
        current.widgets.filter((w) => w.id !== target.id),
        target.tabId,
      );
      const moved: BoardWidget = { ...target, tabId: destTabId };
      const widgets = insertAndRenormalize(
        withoutTarget,
        destTabId,
        moved,
        opts.after,
      );
      return { ...current, widgets };
    });
  }
}
