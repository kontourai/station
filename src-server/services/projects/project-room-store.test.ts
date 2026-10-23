import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import {
  createProjectRoomRuntime,
  ProjectRoomStore,
} from './project-room-store.js';

const scope = {
  stationId: 'station',
  localProjectId: 'incarnation',
  portableProjectId: 'portable',
  localProjectSlug: 'project',
};
const actor = { id: 'person', kind: 'person' as const, displayName: 'Person' };
const current = () => {};
describe('ProjectRoomStore durable boundaries', () => {
  let home: string;
  let a: ReturnType<typeof createProjectRoomRuntime>;
  let b: ReturnType<typeof createProjectRoomRuntime>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'project-room-'));
    a = createProjectRoomRuntime(home);
    b = createProjectRoomRuntime(home);
    a.store.ensureRoom(scope, current);
  });
  afterEach(() => {
    a.close();
    b.close();
    rmSync(home, { recursive: true, force: true });
  });
  it('deduplicates across connections and reopen, rejects changed intent, and preserves reply identity', () => {
    const input = { intentId: randomUUID(), text: 'hello' };
    const first = a.store.append(scope, actor, input, current);
    expect(
      b.store.append(
        scope,
        { ...actor, displayName: 'Renamed' },
        input,
        current,
      ),
    ).toEqual(first);
    expect(() =>
      b.store.append(scope, actor, { ...input, text: 'changed' }, current),
    ).toThrow('conflict');
    const reply = b.store.append(
      scope,
      actor,
      { intentId: randomUUID(), text: 'reply', replyTo: first.messageId },
      current,
    );
    a.close();
    a = createProjectRoomRuntime(home);
    expect(a.store.history(scope).messages).toEqual([first, reply]);
    expect(reply.seq).toBe(2);
    expect(a.store.history(scope, 0, 1).nextAfter).toBe(1);
    expect(a.store.history(scope, 1).checkpoint.lastSeq).toBe(2);
  });
  it('isolates recreated Projects and does not treat slug as authority', () => {
    const old = a.store.append(
      scope,
      actor,
      { intentId: randomUUID(), text: 'old' },
      current,
    );
    const replacement = { ...scope, localProjectId: 'new-incarnation' };
    expect(b.store.ensureRoom(replacement, current).roomId).not.toBe(
      old.roomId,
    );
    expect(b.store.history(replacement).messages).toEqual([]);
    expect(() =>
      b.store.append(
        replacement,
        actor,
        { intentId: randomUUID(), text: 'cross', replyTo: old.messageId },
        current,
      ),
    ).toThrow('not_found');
    expect(
      a.store.history({ ...scope, localProjectSlug: 'renamed' }).messages[0],
    ).toEqual(old);
  });
  it('rolls back admission faults and serializes competing sequence and note CAS writes', () => {
    const input = { intentId: randomUUID(), text: 'refused' };
    expect(() =>
      a.store.append(scope, actor, input, () => {
        throw new Error('revoked');
      }),
    ).toThrow('revoked');
    expect(b.store.history(scope).checkpoint.lastSeq).toBe(0);
    const first = b.store.append(scope, actor, input, current);
    expect(first.seq).toBe(1);
    expect(
      a.store.append(
        scope,
        actor,
        { intentId: randomUUID(), text: 'next' },
        current,
      ).seq,
    ).toBe(2);
    const note = {
      expectedRevision: 0,
      markdown: 'Pinned decision',
      sourceMessageIds: [first.messageId],
    };
    expect(a.store.updateNote(scope, actor, note, current).revision).toBe(1);
    expect(() => b.store.updateNote(scope, actor, note, current)).toThrow(
      'conflict',
    );
    expect(() =>
      b.store.updateNote(scope, actor, { ...note, expectedRevision: 1 }, () => {
        throw new Error('revoked');
      }),
    ).toThrow('revoked');
    expect(a.store.getNote(scope)?.revision).toBe(1);
  });
  it('enforces UTF-8 input and history byte bounds without dropping messages', () => {
    expect(() =>
      a.store.append(
        scope,
        actor,
        { intentId: randomUUID(), text: '😀'.repeat(4097) },
        current,
      ),
    ).toThrow();
    expect(() =>
      a.store.updateNote(
        scope,
        actor,
        {
          expectedRevision: 0,
          markdown: '😀'.repeat(2049),
          sourceMessageIds: [],
        },
        current,
      ),
    ).toThrow();
    for (let i = 0; i < 40; i++)
      a.store.append(
        scope,
        actor,
        { intentId: randomUUID(), text: 'x'.repeat(16384) },
        current,
      );
    const page = b.store.history(scope, 0, 100);
    expect(
      Buffer.byteLength(JSON.stringify(page.messages)),
    ).toBeLessThanOrEqual(512 * 1024);
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.length).toBeLessThan(40);
    expect(b.store.history(scope, page.nextAfter!).messages.at(-1)?.seq).toBe(
      40,
    );
  });
  it('refuses a competing connection during final admission and rolls back the losing admission', () => {
    const db = openPrivateSqlite(
      join(home, 'security', 'project-rooms.sqlite'),
      'Project rooms',
    );
    const competing = new ProjectRoomStore(db);
    db.exec('PRAGMA busy_timeout=0');
    const input = { intentId: randomUUID(), text: 'competing writer' };
    try {
      expect(() =>
        a.store.append(
          scope,
          actor,
          { intentId: randomUUID(), text: 'revoked writer' },
          () => {
            expect(() =>
              competing.append(scope, actor, input, current),
            ).toThrow(/locked/);
            throw new Error('revoked at admission');
          },
        ),
      ).toThrow('revoked at admission');
      expect(competing.append(scope, actor, input, current).seq).toBe(1);
      expect(
        b.store.history(scope).messages.map((message) => message.text),
      ).toEqual(['competing writer']);
    } finally {
      db.close();
    }
  });
  it('retains started effects as ambiguous across restart and never silently replays them', () => {
    const input = {
      intentId: randomUUID(),
      text: 'Please discuss',
      agentId: 'agent',
    };
    const request = a.store.reserveRequest(scope, actor, input, current);
    expect(b.store.reserveRequest(scope, actor, input, current)).toEqual(
      request,
    );
    expect(() =>
      b.store.reserveRequest(
        scope,
        actor,
        { ...input, text: 'different' },
        current,
      ),
    ).toThrow('conflict');
    a.store.markStarted(scope, request.requestId, current);
    b.store.bindSession(scope, request.requestId, 'session', current);
    a.close();
    a = createProjectRoomRuntime(home);
    expect(a.store.getRequest(scope, request.requestId).state).toBe('started');
    expect(() =>
      a.store.markStarted(scope, request.requestId, current),
    ).toThrow('conflict');
    expect(a.store.listPendingRequests(scope)).toHaveLength(1);
    a.store.markUncertain(scope, request.requestId, current);
    const reply = b.store.append(
      scope,
      { id: 'agent', displayName: 'Agent', kind: 'agent' },
      { intentId: randomUUID(), text: 'Result' },
      current,
    );
    expect(
      a.store.finishPublished(
        scope,
        request.requestId,
        reply.messageId,
        current,
      ).publishedMessageId,
    ).toBe(reply.messageId);
    expect(b.store.listPendingRequests(scope)).toEqual([]);
  });
});
