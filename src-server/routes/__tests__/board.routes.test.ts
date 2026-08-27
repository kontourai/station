import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BoardStore } from '../../services/board/board-store.js';
import { type BoardRouteAuthorization, createBoardRoutes } from '../board.js';

const SESSION_REF = { kind: 'session', id: 'session-1' } as const;

interface BoardWidgetPayload {
  name: string;
  position: number;
  block: { attestationState?: string; provenanceDigest?: string };
}
interface BoardEnvelope {
  success: boolean;
  data: { widgets: BoardWidgetPayload[] };
}

async function readBoardEnvelope(res: Response): Promise<BoardEnvelope> {
  return (await res.json()) as BoardEnvelope;
}

/** Every board route test not specifically about B2 authorization gets this. */
const ALLOW_ALL: BoardRouteAuthorization = {
  canReadSession: () => true,
  taskExists: () => true,
};

async function appFor(authz: BoardRouteAuthorization = ALLOW_ALL) {
  const root = await mkdtemp(join(tmpdir(), 'station-board-routes-'));
  return { root, app: createBoardRoutes(new BoardStore(root), authz) };
}

describe('board routes', () => {
  test('GET reads an empty board for a reference with no rows yet', async () => {
    const { app } = await appFor();
    const res = await app.request('/?kind=session&id=session-1');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: { schemaVersion: 1, tabs: [], widgets: [] },
    });
  });

  test('GET without a reference is a 400, not a silent empty board', async () => {
    const { app } = await appFor();
    const res = await app.request('/');
    expect(res.status).toBe(400);
  });

  test('pin: a decorative block (prose card, no fields) pins freely with no derivedFrom', async () => {
    const { app } = await appFor();
    const res = await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: SESSION_REF,
        name: 'notes',
        block: { type: 'card', title: 'Notes', body: 'Just prose.' },
      }),
    });
    expect(res.status).toBe(200);
    const payload = await readBoardEnvelope(res);
    expect(payload.success).toBe(true);
    const widget = payload.data.widgets[0];
    expect(widget?.block.attestationState).toBe('decorative');
  });

  test('pin: a claiming card (fields) WITH derivedFrom is accepted and stamped attested', async () => {
    const { app } = await appFor();
    const res = await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: SESSION_REF,
        name: 'status',
        block: {
          type: 'card',
          title: 'Status',
          body: 'summary',
          fields: [{ label: 'state', value: 'green' }],
          derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call-1' }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const payload = await readBoardEnvelope(res);
    const widget = payload.data.widgets[0];
    expect(widget?.block.attestationState).toBe('attested');
    expect(typeof widget?.block.provenanceDigest).toBe('string');
  });

  /**
   * The headline provenance-boundary AC (station#4079 design: "Pinning a
   * claiming block requires its provenance to be present — the #1399
   * refusal applies at pin, not just at render"). A card with `fields`
   * (station#1399's exact claiming-block predicate) but no `derivedFrom` is
   * refused with the SAME typed error family `render_component` uses.
   *
   * Fix round C6: the message now names `board_pin`, not `render_component`
   * — this is the surface that actually refused it.
   */
  test('pin: a claiming card (fields) WITHOUT derivedFrom is refused — typed, not silently downgraded', async () => {
    const { app } = await appFor();
    const res = await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: SESSION_REF,
        name: 'status',
        block: {
          type: 'card',
          title: 'Status',
          body: 'summary',
          fields: [{ label: 'state', value: 'green' }],
        },
      }),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as { success: boolean; error: string };
    expect(payload).toMatchObject({
      success: false,
      code: 'board_provenance_refused',
    });
    expect(payload.error).toContain('board_pin:');
    expect(payload.error).not.toContain('render_component:');
    // Refused at pin: the board must remain untouched (no row was ever
    // created for the refused claim).
    const read = await app.request('/?kind=session&id=session-1');
    await expect(read.json()).resolves.toMatchObject({
      data: { widgets: [] },
    });
  });

  test('pin: a claiming block self-declaring "decorative" attestation is refused, not trusted', async () => {
    const { app } = await appFor();
    const res = await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: SESSION_REF,
        name: 'status',
        block: {
          type: 'card',
          title: 'Status',
          body: 'summary',
          fields: [{ label: 'state', value: 'green' }],
          attestationState: 'decorative',
        },
      }),
    });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: 'board_provenance_refused',
    });
  });

  test('a claiming table (rows) without derivedFrom is refused too', async () => {
    const { app } = await appFor();
    const res = await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: SESSION_REF,
        name: 'table',
        block: {
          type: 'table',
          columns: ['a'],
          rows: [['1']],
        },
      }),
    });
    expect(res.status).toBe(422);
  });

  test('unpin then move round-trip through the HTTP boundary', async () => {
    const { app } = await appFor();
    await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: SESSION_REF,
        name: 'a',
        block: { type: 'card', title: 'A', body: 'decorative' },
      }),
    });
    await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: SESSION_REF,
        name: 'b',
        block: { type: 'card', title: 'B', body: 'decorative' },
      }),
    });
    const moved = await app.request('/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference: SESSION_REF, name: 'a', after: 'b' }),
    });
    expect(moved.status).toBe(200);
    const movedBody = await readBoardEnvelope(moved);
    expect(
      movedBody.data.widgets
        .slice()
        .sort((x, y) => x.position - y.position)
        .map((w) => w.name),
    ).toEqual(['b', 'a']);

    const unpinned = await app.request('/unpin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference: SESSION_REF, name: 'b' }),
    });
    expect(unpinned.status).toBe(200);
    const unpinnedBody = await readBoardEnvelope(unpinned);
    expect(unpinnedBody.data.widgets.map((w) => w.name)).toEqual(['a']);
    expect(unpinnedBody.data.widgets[0]?.position).toBe(0);
  });

  test('unpin a widget that does not exist is a 404', async () => {
    const { app } = await appFor();
    const res = await app.request('/unpin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reference: SESSION_REF, name: 'nope' }),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: 'board_widget_not_found',
    });
  });
});

/**
 * Fix round B1 (independent review, BLOCKING): a BoardReference id/projectId
 * equal to '..' survived `encodeURIComponent` as a whole path component and
 * resolved OUTSIDE `boardsDir`. Both of the reviewer's exact reproductions
 * must now be refused at the schema-validation layer (400
 * `board_reference_invalid`), before ANY store I/O — and no directory is
 * ever created outside the board store root.
 */
describe('board routes — reference grammar (B1 fix round)', () => {
  test("reviewer repro 1: a session id of '..' is refused (400), not path-escaped", async () => {
    const { app, root } = await appFor();
    const res = await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: { kind: 'session', id: '..' },
        name: 'a',
        block: { type: 'card', title: 'A', body: 'x' },
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      code: 'board_reference_invalid',
    });
    // The parent of boardsDir must never gain a board.json — the exact
    // escape the reviewer reproduced (`<parent-of-boardsDir>/board.json`).
    const parentOfRoot = dirname(root);
    expect(existsSync(join(parentOfRoot, 'board.json'))).toBe(false);
    // boardsDir exists (mkdtemp created it) but gained NO children — a
    // refused pin never creates so much as a subdirectory.
    await expect(readdir(root)).resolves.toHaveLength(0);
  });

  test("reviewer repro 2: a task pair of ('..', '..') is refused (400), not path-escaped", async () => {
    const { app, root } = await appFor();
    const res = await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: { kind: 'task', id: '..', projectId: '..' },
        name: 'a',
        block: { type: 'card', title: 'A', body: 'x' },
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      code: 'board_reference_invalid',
    });
    const grandparentOfRoot = dirname(dirname(root));
    expect(existsSync(join(grandparentOfRoot, 'board.json'))).toBe(false);
    await expect(readdir(root)).resolves.toHaveLength(0);
  });

  /**
   * Delta review micro-round, item 1 (LOW): GET built the reference from
   * query params and authorized it BEFORE shape-validating — unlike POST,
   * which refines first (`validate(pinSchema)`'s zod `.refine(isBoardReference,
   * ...)` runs before the handler body). No live traversal was possible
   * (`store.read`'s own `isBoardReference` re-check backstopped it), but it
   * sent an unvalidated, unbounded query-string value into
   * `canReadSession`/`taskExists` first and answered a DIFFERENT error code
   * (404 `board_reference_unresolvable`) than POST's 400
   * `board_reference_invalid` for the identical garbage reference — an
   * inconsistent taxonomy across the same route family. GET now
   * shape-validates first, exactly matching POST's order and error code.
   */
  test('taxonomy: GET with a traversal reference is refused 400 board_reference_invalid — SAME code as POST, not 404', async () => {
    const { app, root } = await appFor();
    const res = await app.request('/?kind=session&id=..');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      code: 'board_reference_invalid',
    });
    // Never reached the store: no board.json outside boardsDir, and
    // boardsDir itself gained no children.
    const parentOfRoot = dirname(root);
    expect(existsSync(join(parentOfRoot, 'board.json'))).toBe(false);
    await expect(readdir(root)).resolves.toHaveLength(0);
  });

  test('taxonomy: GET with a traversal task pair is refused 400 board_reference_invalid', async () => {
    const { app } = await appFor();
    const res = await app.request('/?kind=task&id=..&projectId=..');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'board_reference_invalid',
    });
  });

  test('a bare "." session id is refused too', async () => {
    const { app } = await appFor();
    const res = await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: { kind: 'session', id: '.' },
        name: 'a',
        block: { type: 'card', title: 'A', body: 'x' },
      }),
    });
    expect(res.status).toBe(400);
  });

  test('a legitimate colon-bearing session id (real production shape) is accepted', async () => {
    const { app } = await appFor();
    const res = await app.request('/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: { kind: 'session', id: 'user-1:1735689600000:abc123def' },
        name: 'a',
        block: { type: 'card', title: 'A', body: 'x' },
      }),
    });
    expect(res.status).toBe(200);
  });

  test('unpin/move also refuse the traversal reference before touching the store', async () => {
    const { app, root } = await appFor();
    const unpinRes = await app.request('/unpin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: { kind: 'session', id: '..' },
        name: 'a',
      }),
    });
    expect(unpinRes.status).toBe(400);
    await expect(unpinRes.json()).resolves.toMatchObject({
      code: 'board_reference_invalid',
    });
    const moveRes = await app.request('/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: { kind: 'session', id: '..' },
        name: 'a',
      }),
    });
    expect(moveRes.status).toBe(400);
    await expect(moveRes.json()).resolves.toMatchObject({
      code: 'board_reference_invalid',
    });
    await expect(readdir(root)).resolves.toHaveLength(0);
  });
});

/**
 * Fix round B2 (independent review, BLOCKING): `routes/board.ts` bound no
 * authority predicate at all — any caller could read or mutate any other
 * caller's board. Mirrors `attachments.routes.test.ts`'s fake-authority
 * style: a request carries a "principal" via `Authorization: Bearer <id>`,
 * and the fake `canReadSession`/`taskExists` answer only for what that
 * principal owns.
 */
describe('board routes — authorization (B2 fix round)', () => {
  const OWNER = 'owner-a';
  const OTHER = 'owner-b';

  function principalOf(request: Request): string {
    return (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  }

  function scopedAuthz(
    readableSessions: Record<string, string[]>,
    existingTasks: Array<{ projectId: string; id: string }>,
  ): BoardRouteAuthorization {
    return {
      canReadSession: (sessionId, request) =>
        (readableSessions[principalOf(request)] ?? []).includes(sessionId),
      taskExists: (projectId, taskId) =>
        existingTasks.some((t) => t.projectId === projectId && t.id === taskId),
    };
  }

  function authedRequest(body: unknown, principal: string): RequestInit {
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${principal}`,
      },
      body: JSON.stringify(body),
    };
  }

  test('happy path unchanged: the owning principal reads and pins their own session board', async () => {
    const authz = scopedAuthz({ [OWNER]: ['session-owned'] }, []);
    const { app } = await appFor(authz);
    const ref = { kind: 'session', id: 'session-owned' } as const;

    const pinRes = await app.request(
      '/pin',
      authedRequest(
        {
          reference: ref,
          name: 'a',
          block: { type: 'card', title: 'A', body: 'x' },
        },
        OWNER,
      ),
    );
    expect(pinRes.status).toBe(200);

    const getRes = await app.request('/?kind=session&id=session-owned', {
      headers: { authorization: `Bearer ${OWNER}` },
    });
    expect(getRes.status).toBe(200);
    const body = await readBoardEnvelope(getRes);
    expect(body.data.widgets).toHaveLength(1);
  });

  test("cross-session denial: a caller authorized for session A cannot read session B's board", async () => {
    const authz = scopedAuthz(
      { [OWNER]: ['session-a'], [OTHER]: ['session-b'] },
      [],
    );
    const { app } = await appFor(authz);

    // OTHER pins their own board first.
    await app.request(
      '/pin',
      authedRequest(
        {
          reference: { kind: 'session', id: 'session-b' },
          name: 'secret',
          block: { type: 'card', title: 'Secret', body: 'x' },
        },
        OTHER,
      ),
    );

    // OWNER (authorized only for session-a) tries to read session-b.
    const res = await app.request('/?kind=session&id=session-b', {
      headers: { authorization: `Bearer ${OWNER}` },
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: 'board_reference_unresolvable',
    });
  });

  test("cross-session denial: a caller authorized for session A cannot pin/unpin/move session B's board", async () => {
    const authz = scopedAuthz(
      { [OWNER]: ['session-a'], [OTHER]: ['session-b'] },
      [],
    );
    const { app } = await appFor(authz);

    const pinRes = await app.request(
      '/pin',
      authedRequest(
        {
          reference: { kind: 'session', id: 'session-b' },
          name: 'x',
          block: { type: 'card', title: 'X', body: 'x' },
        },
        OWNER,
      ),
    );
    expect(pinRes.status).toBe(404);

    const unpinRes = await app.request(
      '/unpin',
      authedRequest(
        { reference: { kind: 'session', id: 'session-b' }, name: 'x' },
        OWNER,
      ),
    );
    expect(unpinRes.status).toBe(404);

    const moveRes = await app.request(
      '/move',
      authedRequest(
        { reference: { kind: 'session', id: 'session-b' }, name: 'x' },
        OWNER,
      ),
    );
    expect(moveRes.status).toBe(404);

    // The board that session-b's actual owner would see stays empty — the
    // denied caller never mutated it.
    const verify = await app.request('/?kind=session&id=session-b', {
      headers: { authorization: `Bearer ${OTHER}` },
    });
    const verifyBody = await readBoardEnvelope(verify);
    expect(verifyBody.data.widgets).toHaveLength(0);
  });

  test('an unresolvable (nonexistent) session reference is refused before any store I/O', async () => {
    const authz = scopedAuthz({ [OWNER]: ['session-a'] }, []);
    const { app, root } = await appFor(authz);
    const res = await app.request('/?kind=session&id=session-does-not-exist', {
      headers: { authorization: `Bearer ${OWNER}` },
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: 'board_reference_unresolvable',
    });
    // No board directory was ever created for a reference that never
    // resolved.
    await expect(readdir(root)).resolves.toHaveLength(0);
  });

  test('a Task reference resolves purely on existence (mirrors the sibling SpatialBoardResolver)', async () => {
    const authz = scopedAuthz({}, [{ projectId: 'proj-1', id: 'task-1' }]);
    const { app } = await appFor(authz);

    const existing = await app.request(
      '/?kind=task&id=task-1&projectId=proj-1',
    );
    expect(existing.status).toBe(200);

    const missing = await app.request(
      '/?kind=task&id=task-does-not-exist&projectId=proj-1',
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      code: 'board_reference_unresolvable',
    });

    // A stale reference (task exists, but under a different project) is
    // also unresolvable, mirroring the sibling resolver's stale/current
    // distinction.
    const stale = await app.request(
      '/?kind=task&id=task-1&projectId=some-other-project',
    );
    expect(stale.status).toBe(404);
  });
});
