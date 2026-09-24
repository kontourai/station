import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The bounds on a Codex host image read: a read that never settles is
 * abandoned at its deadline (so the notifications queued behind it drain),
 * the queue has a size bound, queued work for a closed session is discarded,
 * and server requests are not held behind the read.
 *
 * `lstat` of any path containing `hang` never settles — a stand-in for a
 * stalled filesystem (NFS, a FUSE mount) that a real temp dir cannot produce.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: ((path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) =>
      String(path).includes('hang')
        ? new Promise(() => {})
        : (actual.lstat as (...args: unknown[]) => unknown)(
            path,
            ...rest,
          )) as typeof actual.lstat,
  };
});

import {
  CodexAdapterTransport,
  createCodexSessionRecord,
  MAX_QUEUED_NOTIFICATIONS,
} from '../adapters/codex-adapter-transport.js';
import {
  addWorkspaceImageFile,
  HOST_IMAGE_READ_DEADLINE_MS,
  ModelImageCollector,
} from '../model-image-attachments.js';
import { ASYNC_EVENT_QUEUE_DEFAULT_CAPACITY } from '../sessions/async-event-queue.js';

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
}

let directory: string;
let workspace: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'codex-read-bounds-'));
  workspace = join(directory, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'hang.png'), 'unused');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function harness({ stubPublish = true } = {}) {
  const transport = new CodexAdapterTransport(
    () => new Date('2026-04-11T00:00:00Z'),
  );
  const record = createCodexSessionRecord({
    externalThreadId: 'thread-1',
    process: new FakeCodexProcess() as never,
    provider: 'codex',
    threadId: 'thread-1',
    model: 'gpt-5-codex',
    nowIso: () => '2026-04-11T00:00:00Z',
  });
  record.session = { ...record.session, cwd: workspace };
  transport.registerSession(record);
  transport.setCodexThreadId(record, 'codex-thread-1');
  const published: Array<{ method: string; [key: string]: unknown }> = [];
  if (stubPublish) {
    (transport as unknown as { publish: (event: never) => void }).publish = (
      event: never,
    ) => {
      published.push(event);
    };
  }
  const line = (message: unknown) =>
    transport.handleStdoutLine(record, JSON.stringify(message));
  const viewHangingImage = () =>
    line({
      method: 'item/completed',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        item: {
          type: 'imageView',
          id: 'view-1',
          path: join(workspace, 'hang.png'),
        },
      },
    });
  const completeTurn = () =>
    line({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      },
    });
  return {
    transport,
    record,
    published,
    line,
    viewHangingImage,
    completeTurn,
  };
}

const methods = (events: Array<{ method: string }>) =>
  events.map((event) => event.method);

describe('Codex host image read bounds', () => {
  test('a read that never settles is abandoned at its deadline with a marker', async () => {
    const collector = new ModelImageCollector();
    const outcome = await addWorkspaceImageFile(
      collector,
      join(workspace, 'hang.png'),
      { roots: [workspace], deadlineMs: 20 },
    );
    expect(outcome).toEqual({
      kind: 'omitted',
      marker: '[image not shown: the viewed image could not be read in time]',
    });
    expect(collector.result()).toBeUndefined();
  });

  test('a stalled read delays the turn terminal only until the deadline, then both publish in order', async () => {
    vi.useFakeTimers();
    const { published, viewHangingImage, completeTurn } = harness();
    viewHangingImage();
    completeTurn();
    await vi.advanceTimersByTimeAsync(HOST_IMAGE_READ_DEADLINE_MS - 1);
    expect(methods(published)).not.toContain('turn.completed');

    await vi.advanceTimersByTimeAsync(1);
    const order = methods(published);
    expect(order.indexOf('tool.completed')).toBeGreaterThan(-1);
    expect(order.indexOf('turn.completed')).toBeGreaterThan(
      order.indexOf('tool.completed'),
    );
    expect(
      published.find((event) => event.method === 'tool.completed'),
    ).toMatchObject({
      output: '[image not shown: the viewed image could not be read in time]',
    });
  });

  test('queued work for a session that closed meanwhile is discarded, not run', async () => {
    vi.useFakeTimers();
    const { transport, record, published, viewHangingImage, completeTurn } =
      harness();
    viewHangingImage();
    completeTurn();
    record.stopped = true;
    transport.unregisterSession(record);
    await vi.advanceTimersByTimeAsync(HOST_IMAGE_READ_DEADLINE_MS);
    expect(methods(published)).toEqual(['tool.started']);
  });

  test('the notification cap stays well below the downstream event queue capacity', () => {
    // A drain pushes up to the cap in one synchronous run; the event queue it
    // feeds clears itself and rejects its iterator past its capacity.
    expect(MAX_QUEUED_NOTIFICATIONS * 2).toBeLessThanOrEqual(
      ASYNC_EVENT_QUEUE_DEFAULT_CAPACITY,
    );
  });

  test('bursts past the cap through the REAL event queue: bounded, ordered, nothing dropped, no rejection', async () => {
    // No stubbed publish: events go through the transport's own bounded
    // AsyncEventQueue and are read back through `streamEvents()`.
    const { transport, record } = harness({ stubPublish: false });
    const collected: Array<{ method: string; [key: string]: unknown }> = [];
    let failure: unknown;
    const consuming = (async () => {
      try {
        for await (const event of transport.streamEvents()) {
          collected.push(event as never);
          if (event.method === 'turn.completed') return;
        }
      } catch (error) {
        failure = error;
      }
    })();

    const handleLine = transport.handleStdoutLine.bind(transport);
    let lines = 0;
    let maxDepth = 0;
    let microtaskRan = false;
    let microtaskRanBeforeFirstChunkEnd: boolean | undefined;
    // First chunk: one synchronous burst already past the cap.
    const firstChunkLines = MAX_QUEUED_NOTIFICATIONS + 76;
    transport.handleStdoutLine = (target, text) => {
      if (lines === 0)
        queueMicrotask(() => {
          microtaskRan = true;
        });
      handleLine(target, text);
      lines += 1;
      maxDepth = Math.max(maxDepth, record.queuedNotifications?.length ?? 0);
      if (lines === firstChunkLines)
        microtaskRanBeforeFirstChunkEnd = microtaskRan;
    };
    transport.handleProcess(record);

    const delta = (index: number) => ({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        itemId: 'message-1',
        delta: String(index % 10),
      },
    });
    const write = async (messages: unknown[]) => {
      const expected = lines + messages.length;
      (record.process.stdout as PassThrough).write(
        messages.map((message) => `${JSON.stringify(message)}\n`).join(''),
      );
      await vi.waitFor(() => expect(lines).toBe(expected));
      // Let the consumer take what was published before the next chunk.
      await new Promise((resolve) => setImmediate(resolve));
    };

    // Then realistic chunks of a few hundred lines, until the total is past
    // 10,000 — the old cap, whose single synchronous drain overflowed.
    const totalDeltas = 10_600;
    const imageView = {
      method: 'item/completed',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        item: {
          type: 'imageView',
          id: 'view-1',
          path: join(workspace, 'hang.png'),
        },
      },
    };
    let sent = 0;
    await write([
      imageView,
      ...Array.from({ length: firstChunkLines - 1 }, () => delta(sent++)),
    ]);
    while (sent < totalDeltas) {
      const size = Math.min(500, totalDeltas - sent);
      await write(Array.from({ length: size }, () => delta(sent++)));
    }
    await write([
      {
        method: 'turn/completed',
        params: {
          threadId: 'codex-thread-1',
          turn: { id: 'turn-1', status: 'completed' },
        },
      },
    ]);
    await vi.waitFor(
      () => {
        if (failure) throw failure;
        expect(collected.at(-1)?.method).toBe('turn.completed');
      },
      { timeout: 10_000 },
    );
    await consuming;

    expect(failure).toBeUndefined();
    expect(microtaskRanBeforeFirstChunkEnd).toBe(false);
    expect(maxDepth).toBeLessThanOrEqual(MAX_QUEUED_NOTIFICATIONS);
    const order = methods(collected);
    const toolCompleted = order.indexOf('tool.completed');
    expect(order.indexOf('tool.started')).toBeLessThan(toolCompleted);
    expect(toolCompleted).toBeLessThan(order.indexOf('content.text-delta'));
    const deltas = collected.filter(
      (event) => event.method === 'content.text-delta',
    );
    expect(deltas).toHaveLength(totalDeltas);
    // Not merely the right count: every delta, in the order it was sent.
    expect(deltas.map((event) => event.delta).join('')).toBe(
      Array.from({ length: totalDeltas }, (_, index) => index % 10).join(''),
    );
    expect(collected[toolCompleted]).toMatchObject({
      output: '[image not shown: the viewed image could not be read in time]',
    });
  }, 30_000);

  test('contract: a server approval request is not held behind a pending image read', async () => {
    vi.useFakeTimers();
    const { published, line, viewHangingImage } = harness();
    viewHangingImage();
    line({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        command: 'ls',
      },
    });
    // Published as it arrives: approvals bind by request/call id, not by
    // position, and must not wait on an unrelated file read.
    expect(methods(published)).toEqual(['tool.started', 'request.opened']);
    await vi.advanceTimersByTimeAsync(HOST_IMAGE_READ_DEADLINE_MS);
    expect(methods(published)).toEqual([
      'tool.started',
      'request.opened',
      'tool.completed',
    ]);
  });
});
