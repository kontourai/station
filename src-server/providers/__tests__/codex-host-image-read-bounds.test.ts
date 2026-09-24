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

function harness() {
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
  (transport as unknown as { publish: (event: never) => void }).publish = (
    event: never,
  ) => {
    published.push(event);
  };
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

  test('a synchronous burst past the cap never queues more than the cap, and keeps order', async () => {
    const { transport, record, published } = harness();
    // Observe the queue after EVERY line, through the real readline path:
    // one stdout chunk makes readline emit all of its lines inside a single
    // callback, before any microtask can run.
    const handleLine = transport.handleStdoutLine.bind(transport);
    let maxDepth = 0;
    let lines = 0;
    let microtaskRan = false;
    let microtaskRanBeforeLastLine: boolean | undefined;
    const burst = MAX_QUEUED_NOTIFICATIONS + 50;
    transport.handleStdoutLine = (target, text) => {
      if (lines === 0)
        queueMicrotask(() => {
          microtaskRan = true;
        });
      handleLine(target, text);
      lines += 1;
      maxDepth = Math.max(maxDepth, record.queuedNotifications?.length ?? 0);
      if (lines === burst + 2) microtaskRanBeforeLastLine = microtaskRan;
    };
    transport.handleProcess(record);

    const chunk = [
      {
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
      },
      ...Array.from({ length: burst }, () => ({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'codex-thread-1',
          turnId: 'turn-1',
          itemId: 'message-1',
          delta: 'x',
        },
      })),
      {
        method: 'turn/completed',
        params: {
          threadId: 'codex-thread-1',
          turn: { id: 'turn-1', status: 'completed' },
        },
      },
    ]
      .map((message) => `${JSON.stringify(message)}\n`)
      .join('');
    (record.process.stdout as PassThrough).write(chunk);
    await vi.waitFor(() => expect(lines).toBe(burst + 2));

    // It really was one synchronous burst.
    expect(microtaskRanBeforeLastLine).toBe(false);
    // The bound held — and was actually reached.
    expect(maxDepth).toBe(MAX_QUEUED_NOTIFICATIONS);
    // Order: the image tool settles (with the deadline's note) before any
    // later notification, and nothing was dropped.
    const order = methods(published);
    const toolCompleted = order.indexOf('tool.completed');
    expect(order.indexOf('tool.started')).toBeLessThan(toolCompleted);
    expect(toolCompleted).toBeLessThan(order.indexOf('content.text-delta'));
    expect(toolCompleted).toBeLessThan(order.indexOf('turn.completed'));
    expect(order.filter((m) => m === 'content.text-delta')).toHaveLength(burst);
    expect(order.at(-1)).toBe('turn.completed');
    expect(published[toolCompleted]).toMatchObject({
      output: '[image not shown: the viewed image could not be read in time]',
    });
  });

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
