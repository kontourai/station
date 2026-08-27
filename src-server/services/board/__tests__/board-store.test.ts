import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { BoardReference } from '@kontourai/station-contracts/board';
import type { UICardBlock } from '@kontourai/station-contracts/ui-block';
import { describe, expect, test } from 'vitest';
import {
  BoardCapacityError,
  BoardReferenceInvalidError,
  BoardStore,
  BoardTabNotFoundError,
  BoardWidgetNameConflictError,
  BoardWidgetNotFoundError,
  containedJoin,
} from '../board-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'station-board-store-'));
  return { root, store: new BoardStore(root) };
}

/**
 * A block already in the shape the pin-boundary gate (`acceptUIBlockProvenance`,
 * called by the route before `BoardStore` is ever reached) produces. Store
 * tests exercise persistence/ordinal/versioning behavior, not the provenance
 * gate itself — that boundary has its own dedicated coverage.
 */
function attestedCard(label: string): UICardBlock {
  return {
    type: 'card',
    title: label,
    body: `Body for ${label}`,
    fields: [{ label: 'status', value: 'ok' }],
    derivedFrom: [{ kind: 'toolCallId', toolCallId: `call-${label}` }],
    attestationState: 'attested',
    provenanceDigest: 'a'.repeat(64),
  };
}

function decorativeCard(label: string): UICardBlock {
  return {
    type: 'card',
    title: label,
    body: `Decorative body for ${label}`,
    attestationState: 'decorative',
  };
}

const SESSION_REF: BoardReference = { kind: 'session', id: 'session-1' };
const TASK_REF: BoardReference = {
  kind: 'task',
  id: 'task-1',
  projectId: 'project-1',
};

describe('BoardStore', () => {
  test('board existence <=> rows exist: an unpinned reference reads an empty board', async () => {
    const { store } = await fixture();
    await expect(store.read(SESSION_REF)).resolves.toEqual({
      schemaVersion: 1,
      reference: SESSION_REF,
      tabs: [],
      widgets: [],
    });
  });

  test('pin creates a default tab and stamps both versioning axes', async () => {
    const { store } = await fixture();
    const { board, widget } = await store.pin(SESSION_REF, {
      block: attestedCard('a'),
      name: 'a',
    });
    expect(board.tabs).toHaveLength(1);
    expect(widget.tabId).toBe(board.tabs[0]?.id);
    expect(widget.position).toBe(0);
    expect(widget.revision).toBe(0);
    expect(typeof widget.generation).toBe('string');
    expect(widget.generation.length).toBeGreaterThan(0);
    expect(widget.block.attestationState).toBe('attested');
  });

  test('pin refuses a duplicate widget name (no update-in-place until slice 4)', async () => {
    const { store } = await fixture();
    await store.pin(SESSION_REF, { block: attestedCard('a'), name: 'a' });
    await expect(
      store.pin(SESSION_REF, { block: attestedCard('a2'), name: 'a' }),
    ).rejects.toBeInstanceOf(BoardWidgetNameConflictError);
  });

  test('ordinal renormalization: pin/unpin keeps dense, gap-free positions per tab', async () => {
    const { store } = await fixture();
    await store.pin(SESSION_REF, { block: decorativeCard('a'), name: 'a' });
    await store.pin(SESSION_REF, { block: decorativeCard('b'), name: 'b' });
    const afterThree = (
      await store.pin(SESSION_REF, { block: decorativeCard('c'), name: 'c' })
    ).board;
    expect(afterThree.widgets.map((w) => [w.name, w.position]).sort()).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);

    // Unpin the middle widget: the remaining two must renormalize to 0,1 —
    // no gap left where "b" was.
    const afterUnpin = await store.unpin(SESSION_REF, 'b');
    expect(afterUnpin.widgets.map((w) => [w.name, w.position]).sort()).toEqual([
      ['a', 0],
      ['c', 1],
    ]);
  });

  test('pin with after: <name> inserts at the named position, not appended blindly', async () => {
    const { store } = await fixture();
    await store.pin(SESSION_REF, { block: decorativeCard('a'), name: 'a' });
    await store.pin(SESSION_REF, { block: decorativeCard('b'), name: 'b' });
    const { board } = await store.pin(SESSION_REF, {
      block: decorativeCard('c'),
      name: 'c',
      after: 'a',
    });
    const order = board.widgets
      .slice()
      .sort((x, y) => x.position - y.position)
      .map((w) => w.name);
    expect(order).toEqual(['a', 'c', 'b']);
  });

  test('move: after: <name> repositions within a tab and renormalizes densely', async () => {
    const { store } = await fixture();
    await store.pin(SESSION_REF, { block: decorativeCard('a'), name: 'a' });
    await store.pin(SESSION_REF, { block: decorativeCard('b'), name: 'b' });
    await store.pin(SESSION_REF, { block: decorativeCard('c'), name: 'c' });
    const board = await store.move(SESSION_REF, 'a', { after: 'c' });
    const order = board.widgets
      .slice()
      .sort((x, y) => x.position - y.position)
      .map((w) => w.name);
    expect(order).toEqual(['b', 'c', 'a']);
    // Dense: positions are exactly 0..n-1 with no gaps.
    expect(board.widgets.map((w) => w.position).sort()).toEqual([0, 1, 2]);
  });

  test('move across tabs renormalizes BOTH the source and destination tab', async () => {
    const { store } = await fixture();
    await store.pin(SESSION_REF, {
      block: decorativeCard('a'),
      name: 'a',
      tabId: 'tab-1',
    });
    await store.pin(SESSION_REF, {
      block: decorativeCard('b'),
      name: 'b',
      tabId: 'tab-1',
    });
    await store.pin(SESSION_REF, {
      block: decorativeCard('c'),
      name: 'c',
      tabId: 'tab-2',
      tabTitle: 'Second tab',
    });
    const board = await store.move(SESSION_REF, 'a', { tabId: 'tab-2' });
    const tab1 = board.widgets.filter((w) => w.tabId === 'tab-1');
    const tab2 = board.widgets.filter((w) => w.tabId === 'tab-2');
    expect(tab1.map((w) => w.position)).toEqual([0]); // "b" renormalized from 1 -> 0
    expect(tab2.map((w) => w.name).sort()).toEqual(['a', 'c']);
    expect(tab2.map((w) => w.position).sort()).toEqual([0, 1]);
  });

  test('move to an unknown tab is refused', async () => {
    const { store } = await fixture();
    await store.pin(SESSION_REF, { block: decorativeCard('a'), name: 'a' });
    await expect(
      store.move(SESSION_REF, 'a', { tabId: 'does-not-exist' }),
    ).rejects.toBeInstanceOf(BoardTabNotFoundError);
  });

  test('unpin/move on an unknown widget name is refused', async () => {
    const { store } = await fixture();
    await expect(store.unpin(SESSION_REF, 'nope')).rejects.toBeInstanceOf(
      BoardWidgetNotFoundError,
    );
    await expect(store.move(SESSION_REF, 'nope', {})).rejects.toBeInstanceOf(
      BoardWidgetNotFoundError,
    );
  });

  test('generation differs across delete/recreate under the same name', async () => {
    const { store } = await fixture();
    const first = await store.pin(SESSION_REF, {
      block: decorativeCard('a'),
      name: 'a',
    });
    const firstGeneration = first.widget.generation;
    await store.unpin(SESSION_REF, 'a');
    const second = await store.pin(SESSION_REF, {
      block: decorativeCard('a'),
      name: 'a',
    });
    expect(second.widget.generation).not.toBe(firstGeneration);
    // Content revision restarts at 0 for the newly-created widget row —
    // slice 1 has no update-in-place, so a re-pin is a fresh creation.
    expect(second.widget.revision).toBe(0);
  });

  test('task and session references persist to independent boards', async () => {
    const { store } = await fixture();
    await store.pin(SESSION_REF, { block: decorativeCard('s'), name: 's' });
    await store.pin(TASK_REF, { block: decorativeCard('t'), name: 't' });
    const sessionBoard = await store.read(SESSION_REF);
    const taskBoard = await store.read(TASK_REF);
    expect(sessionBoard.widgets.map((w) => w.name)).toEqual(['s']);
    expect(taskBoard.widgets.map((w) => w.name)).toEqual(['t']);
  });

  test('concurrent pins to the same board serialize rather than clobber', async () => {
    const { store } = await fixture();
    const outcomes = await Promise.allSettled([
      store.pin(SESSION_REF, { block: decorativeCard('a'), name: 'a' }),
      store.pin(SESSION_REF, { block: decorativeCard('b'), name: 'b' }),
      store.pin(SESSION_REF, { block: decorativeCard('c'), name: 'c' }),
    ]);
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    const board = await store.read(SESSION_REF);
    expect(board.widgets).toHaveLength(3);
    expect(board.widgets.map((w) => w.position).sort()).toEqual([0, 1, 2]);
  });

  test('widget capacity is enforced', async () => {
    const { root } = await fixture();
    const store = new BoardStore(root);
    // Exercise the refusal path without actually pinning 200 widgets: same
    // technique as SpatialBoardStore's capacity test family — construct via
    // repeated pin is too slow for a focused unit test, so this proves the
    // guard fires by depleting a store configured with the real ceiling
    // through direct repetition is impractical; instead verify the boundary
    // behavior on a store already AT capacity is asserted via a smaller,
    // deterministic loop bound to the real MAX below.
    const { MAX_BOARD_WIDGETS } = await import(
      '@kontourai/station-contracts/board'
    );
    for (let i = 0; i < MAX_BOARD_WIDGETS; i += 1) {
      await store.pin(SESSION_REF, {
        block: decorativeCard(`w${i}`),
        name: `w${i}`,
      });
    }
    await expect(
      store.pin(SESSION_REF, { block: decorativeCard('over'), name: 'over' }),
    ).rejects.toBeInstanceOf(BoardCapacityError);
  }, 30_000);

  test('restart survival: a new BoardStore instance over the same directory reads the pinned board intact', async () => {
    const { root, store: first } = await fixture();
    const { widget } = await first.pin(SESSION_REF, {
      block: attestedCard('a'),
      name: 'a',
      size: 'lg',
    });

    // Simulate a full server restart: discard the first store instance and
    // build a fresh one over the same home-dir path, exactly as
    // runtime-routes.ts constructs a fresh BoardStore on every boot.
    const second = new BoardStore(root);
    const board = await second.read(SESSION_REF);

    expect(board.widgets).toHaveLength(1);
    const reloaded = board.widgets[0]!;
    expect(reloaded.id).toBe(widget.id);
    expect(reloaded.name).toBe('a');
    expect(reloaded.size).toBe('lg');
    expect(reloaded.generation).toBe(widget.generation);
    expect(reloaded.revision).toBe(0);
    // Attestation state survives verbatim from the store's persisted bytes —
    // it is never re-minted on rehydrate (station#1399's serve-path
    // sanitization guards the READ-FOR-DISPLAY paths, not this store, but
    // the invariant this probe cares about is that the reload does not
    // fabricate a DIFFERENT attestation state than what was pinned).
    expect(reloaded.block.attestationState).toBe('attested');
    expect((reloaded.block as UICardBlock).provenanceDigest).toBe(
      'a'.repeat(64),
    );
  });
});

/**
 * Fix round B1 (independent review, BLOCKING): a `BoardReference` id/
 * projectId equal to `..` survived `encodeURIComponent` as a whole path
 * component and resolved OUTSIDE `boardsDir` (verified live:
 * `<parent-of-boardsDir>/board.json`). Three defense layers now exist
 * (`board-store.ts`'s `pathFor`); this block unit-tests layer (b) —
 * `containedJoin` — IN ISOLATION, calling it directly with RAW segments
 * that bypass both layer (a) (`isBoardReference`, applied only by
 * `pathFor`/`read`/`update`) and layer (c) (`boardIdSegment`'s fixed
 * prefix, applied only by `pathFor`). This is deliberate: layer (c) alone
 * already makes a `..` id impossible to escape with (a prefixed segment
 * can never equal a bare `..`), so a reference-level test through
 * `store.read`/`store.pin` cannot isolate layer (b)'s own contribution —
 * only a direct, unprefixed call to the primitive can.
 */
describe('containedJoin — B1 fix round, layer (b) containment primitive', () => {
  test('refuses a raw task-shaped ".." pair (bypassing layers (a) and (c))', async () => {
    const { root } = await fixture();
    // Mirrors the reviewer's exact task-pair reproduction at the primitive
    // level: two literal ".." segments, unprefixed.
    let refused = false;
    let escapedTo: string | undefined;
    try {
      escapedTo = containedJoin(root, 'task', '..', '..');
    } catch (error) {
      refused = error instanceof BoardReferenceInvalidError;
    }
    // If containedJoin ever stops refusing this, the failure below names
    // the exact absolute path it escaped to.
    expect({ refused, escapedTo }).toEqual({
      refused: true,
      escapedTo: undefined,
    });
  });

  test('refuses a raw single ".." beyond the root (session-shaped)', async () => {
    const { root } = await fixture();
    let refused = false;
    let escapedTo: string | undefined;
    try {
      escapedTo = containedJoin(root, '..');
    } catch (error) {
      refused = error instanceof BoardReferenceInvalidError;
    }
    expect({ refused, escapedTo }).toEqual({
      refused: true,
      escapedTo: undefined,
    });
  });

  test('accepts an ordinary nested segment and resolves inside root', async () => {
    const { root } = await fixture();
    const result = containedJoin(root, 'session', 'id-abc123', 'board.json');
    expect(result).toBe(join(root, 'session', 'id-abc123', 'board.json'));
    const rel = relative(root, result);
    expect(rel.startsWith('..')).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
  });
});

/**
 * The reviewer's TWO exact reproductions, at the STORE layer (defense in
 * depth beyond the route's zod `.refine(isBoardReference, ...)` — this is
 * `read`/`update`'s OWN independent `isBoardReference` call, layer (a)).
 */
describe('BoardStore — reference grammar refusal (B1 fix round)', () => {
  test("reviewer repro 1: a session id of '..' is refused, never resolves outside boardsDir", async () => {
    const { store, root } = await fixture();
    await expect(
      store.read({ kind: 'session', id: '..' }),
    ).rejects.toBeInstanceOf(BoardReferenceInvalidError);
    // The escape target the reviewer verified live never gained a file.
    const escapedPath = join(root, '..', 'board.json');
    await expect(access(escapedPath)).rejects.toThrow();
  });

  test("reviewer repro 2: a task pair of ('..', '..') is refused, never resolves outside boardsDir", async () => {
    const { store } = await fixture();
    await expect(
      store.read({ kind: 'task', id: '..', projectId: '..' }),
    ).rejects.toBeInstanceOf(BoardReferenceInvalidError);
    await expect(
      store.pin(
        { kind: 'task', id: '..', projectId: '..' },
        {
          block: { type: 'card', title: 'x', body: 'x' } as UICardBlock,
          name: 'x',
        },
      ),
    ).rejects.toBeInstanceOf(BoardReferenceInvalidError);
  });

  test('a legitimate colon-bearing session id (real production shape, per orchestration-service.ts) round-trips', async () => {
    const { store } = await fixture();
    const ref: BoardReference = {
      kind: 'session',
      id: 'user-1:1735689600000:abc123def',
    };
    await store.pin(ref, {
      block: { type: 'card', title: 'x', body: 'x' } as UICardBlock,
      name: 'x',
    });
    const board = await store.read(ref);
    expect(board.widgets).toHaveLength(1);
  });
});
