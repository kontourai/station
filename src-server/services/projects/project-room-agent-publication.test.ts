import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { EventBus } from '../orchestration/event-bus.js';
import {
  createProjectRoomAgentRuntime,
  type ProjectRoomAgentExecution,
} from './project-room-agent-module.js';
import { createProjectRoomAgentPublication } from './project-room-agent-publication.js';
import { createProjectRoomRuntime } from './project-room-store.js';

describe('Room completion observation lifecycle', () => {
  const temp = trackTempDirs();
  const cleanup: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.reverse()) await close();
    cleanup.length = 0;
  });
  function fixture() {
    const home = temp('room-publication-');
    const room = createProjectRoomRuntime(home);
    let revoked = false;
    let completed = false;
    let sessionId = '';
    let pause: Promise<void> | undefined;
    const authority = {
      scope: {
        stationId: 's',
        localProjectId: 'p',
        localProjectSlug: 'project',
        portableProjectId: 'portable',
      },
      requester: { kind: 'person' as const, id: 'owner', displayName: 'Owner' },
      executionRoot: home,
      assertCurrent() {
        if (revoked) throw new Error('revoked');
      },
      async refresh() {
        await pause;
        authority.assertCurrent();
      },
    };
    room.store.ensureRoom(authority.scope, authority.assertCurrent);
    const answer = vi.fn(async () =>
      completed ? { turnId: 'turn', text: 'Shared answer' } : null,
    );
    const execution: ProjectRoomAgentExecution = {
      async prepare() {
        return { label: 'Agent' };
      },
      async launch(capture) {
        sessionId = capture.sessionId;
      },
      answer,
      async cancel() {},
    };
    let runtime = createProjectRoomAgentRuntime(home, room.store, execution);
    const eventBus = new EventBus();
    let observer = createProjectRoomAgentPublication({
      eventBus,
      module: runtime.module,
    });
    cleanup.push(
      () => room.close(),
      () => runtime.close(),
      () => observer.close(),
    );
    return {
      authority,
      room,
      get runtime() {
        return runtime;
      },
      answer,
      get observer() {
        return observer;
      },
      async reopen() {
        await observer.close();
        runtime.close();
        runtime = createProjectRoomAgentRuntime(home, room.store, execution);
        observer = createProjectRoomAgentPublication({
          eventBus,
          module: runtime.module,
        });
      },
      complete() {
        completed = true;
      },
      revoke() {
        revoked = true;
      },
      pause(value: Promise<void>) {
        pause = value;
      },
      emit(threadId = sessionId, method = 'turn.completed') {
        eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
          event: { method, threadId },
        });
      },
      request() {
        return runtime.module.request(authority, {
          intentId: randomUUID(),
          agentId: 'agent',
          text: 'Answer',
        });
      },
    };
  }
  it('catches completion before registration and rearms only with fresh authority after reopen', async () => {
    const f = fixture();
    const handle = await f.request();
    f.complete();
    f.emit();
    await f.reopen();
    expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
    f.observer.watch(f.authority, handle.requestId);
    await vi.waitFor(() =>
      expect(
        f.runtime.module.inspect(f.authority, handle.requestId).state,
      ).toBe('published'),
    );
    await f.reopen();
    f.observer.watch(f.authority, handle.requestId);
    f.emit();
    expect(
      f.room.store.history(f.authority.scope).messages.map((m) => m.text),
    ).toEqual(['Shared answer']);
  });
  it.each(['revocation', 'cancel', 'close'])(
    'fences %s during asynchronous authority refresh before database use',
    async (reason) => {
      const f = fixture();
      const handle = await f.request();
      f.complete();
      let release!: () => void;
      f.pause(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      f.observer.watch(f.authority, handle.requestId);
      if (reason === 'revocation') f.revoke();
      if (reason === 'cancel')
        await f.runtime.module.cancel(f.authority, handle.requestId);
      const stopped = reason === 'close' ? f.observer.close() : undefined;
      release();
      await stopped;
      await vi.waitFor(() => expect(f.answer).not.toHaveBeenCalled());
      expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
    },
  );
  it('guards database access when shutdown races an in-flight selected-answer read', async () => {
    const f = fixture();
    const handle = await f.request();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.answer.mockImplementation(async () => {
      await paused;
      return { turnId: 'turn', text: 'Shared answer' };
    });
    f.observer.watch(f.authority, handle.requestId);
    await vi.waitFor(() => expect(f.answer).toHaveBeenCalledTimes(1));
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    try {
      const stopped = f.observer.close();
      release();
      await stopped;
      f.emit();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
    expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
  });
  it('caps live registrations and expires authority without extending it on events', async () => {
    const f = fixture();
    const clock = vi.spyOn(Date, 'now');
    const now = Date.now();
    try {
      clock.mockReturnValue(now);
      const handles: Awaited<ReturnType<typeof f.request>>[] = [];
      for (let n = 0; n < 129; n++) handles.push(await f.request());
      for (const handle of handles)
        f.observer.watch(f.authority, handle.requestId);
      await vi.waitFor(() => expect(f.answer).toHaveBeenCalledTimes(128));
      clock.mockReturnValue(now + 10 * 60_000);
      f.complete();
      f.emit();
      await f.observer.close();
      expect(f.room.store.history(f.authority.scope).messages).toEqual([]);
      await f.reopen();
      f.observer.watch(f.authority, handles[128].requestId);
      await vi.waitFor(() =>
        expect(
          f.runtime.module.inspect(f.authority, handles[128].requestId).state,
        ).toBe('published'),
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('coalesces terminal bursts, ignores token/private Session events, and never publishes private followups', async () => {
    const f = fixture();
    const handle = await f.request();
    f.observer.watch(f.authority, handle.requestId);
    await vi.waitFor(() => expect(f.answer).toHaveBeenCalledTimes(1));
    for (let n = 0; n < 1000; n++) {
      f.emit('private');
      f.emit(undefined, 'content.text-delta');
    }
    expect(f.answer).toHaveBeenCalledTimes(1);
    f.complete();
    for (let n = 0; n < 1000; n++) f.emit();
    await vi.waitFor(() =>
      expect(f.room.store.history(f.authority.scope).messages).toHaveLength(1),
    );
    expect(f.answer.mock.calls.length).toBeLessThanOrEqual(3);
    f.emit();
    expect(
      f.room.store.history(f.authority.scope).messages.map((m) => m.text),
    ).toEqual(['Shared answer']);
  });
});
