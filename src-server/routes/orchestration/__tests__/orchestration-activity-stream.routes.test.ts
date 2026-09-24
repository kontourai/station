/**
 * #2309: every way a client can (re)join GET /events converges on the same
 * conversation activity mid-turn, through the real route, service and store:
 * connected throughout, a late no-cursor snapshot, a stale cursor replayed,
 * a stale cursor past the gap threshold (snapshot), and a cold restarted
 * process. (Ported from the independent verifier's probe.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD } from '../../../constants.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const USER = 'owner-user';
const root = 'stream-activity-root';
const child = `${root}:session:child`;

function registry() {
  return {
    register() {},
    get() {
      return undefined;
    },
    list() {
      return [];
    },
  } as any;
}

interface Frame {
  event?: string;
  data: string;
  id?: string;
}

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split('\n\n')) {
    const frame: Frame = { data: '' };
    let any = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        frame.event = line.slice(7);
        any = true;
      } else if (line.startsWith('data: ')) {
        frame.data += line.slice(6);
        any = true;
      } else if (line.startsWith('id: ')) frame.id = line.slice(4);
    }
    if (any) frames.push(frame);
  }
  return frames;
}

class StreamReader {
  private text = '';
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }
  async until(matcher: (text: string) => boolean, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!matcher(this.text)) {
      if (Date.now() > deadline) throw new Error(`timeout; got:\n${this.text}`);
      const next = await Promise.race([
        this.reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), 200)),
      ]);
      if (next === null) continue;
      if (next.done) break;
      this.text += this.decoder.decode(next.value, { stream: true });
    }
    return this.text;
  }
  frames() {
    return parseFrames(this.text);
  }
  async close() {
    await this.reader.cancel().catch(() => {});
  }
}

/** The activity a client holds after reading its frames in order. */
function clientActivity(frames: Frame[]): unknown {
  let activity: unknown;
  for (const frame of frames) {
    if (
      frame.event === 'orchestration:snapshot' ||
      frame.event === 'orchestration:caughtUp'
    ) {
      const { sessions } = JSON.parse(frame.data) as {
        sessions?: Array<{ threadId: string; conversationActivity?: unknown }>;
      };
      if (sessions)
        activity = sessions.find(
          (s) => s.threadId === root,
        )?.conversationActivity;
    } else if (frame.event === 'orchestration:event') {
      const parsed = JSON.parse(frame.data) as {
        conversation?: { conversationId: string; activity?: unknown };
      };
      if (
        parsed.conversation?.conversationId === root &&
        parsed.conversation.activity
      )
        activity = parsed.conversation.activity;
    }
  }
  return activity;
}

describe('conversation activity through GET /events (#2309)', () => {
  let tmp: string;
  let eventStore: EventStore;
  let eventBus: EventBus;
  let service: OrchestrationService;
  const services: OrchestrationService[] = [];

  function makeService() {
    const s = new OrchestrationService({
      adapterRegistry: registry(),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() } as any,
    });
    services.push(s);
    return s;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'orchestration-activity-stream-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    eventBus = new EventBus();
    service = makeService();
    const createdAt = '2026-09-22T09:00:00.000Z';
    for (const threadId of [root, child]) {
      if (threadId === child)
        eventStore.reserveNextConversationSession({
          conversationId: root,
          predecessorSessionId: root,
          proposedSessionId: child,
          createdAt,
        });
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt,
        updatedAt: createdAt,
      });
      eventStore.appendEvent({
        eventId: `${threadId}-configured`,
        provider: 'claude',
        threadId,
        createdAt,
        method: 'session.configured',
        sessionId: threadId,
        metadata: { agentSlug: 'claude', userId: USER },
      } as CanonicalRuntimeEvent);
    }
  });

  afterEach(async () => {
    for (const s of services.splice(0)) await s.shutdown().catch(() => {});
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** What the service's publish does: durable append, then bus emit. */
  function publish(event: CanonicalRuntimeEvent) {
    eventStore.appendEvent(event);
    eventBus.emit('orchestration:event', { event });
  }

  function app(s: OrchestrationService) {
    return createOrchestrationRoutes(s, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => USER,
    });
  }

  const midTurn: CanonicalRuntimeEvent[] = [
    {
      eventId: 'e-turn',
      provider: 'claude',
      threadId: child,
      turnId: 'child-turn',
      createdAt: '2026-09-22T09:00:01.000Z',
      method: 'turn.started',
      prompt: 'work',
    } as CanonicalRuntimeEvent,
    {
      eventId: 'e-tool-a',
      provider: 'claude',
      threadId: child,
      turnId: 'child-turn',
      createdAt: '2026-09-22T09:00:02.000Z',
      method: 'tool.started',
      itemId: 'call-a',
      toolCallId: 'call-a',
      toolName: 'Bash',
    } as CanonicalRuntimeEvent,
    {
      eventId: 'e-tool-b',
      provider: 'claude',
      threadId: child,
      turnId: 'child-turn',
      createdAt: '2026-09-22T09:00:03.000Z',
      method: 'tool.started',
      itemId: 'call-b',
      toolCallId: 'call-b',
      toolName: 'Read',
    } as CanonicalRuntimeEvent,
    {
      eventId: 'e-tool-a-done',
      provider: 'claude',
      threadId: child,
      turnId: 'child-turn',
      createdAt: '2026-09-22T09:00:04.000Z',
      method: 'tool.completed',
      itemId: 'call-a',
      toolCallId: 'call-a',
      toolName: 'Bash',
      status: 'success',
    } as CanonicalRuntimeEvent,
  ];

  test('connected-throughout, late no-cursor, stale-cursor replay, stale-cursor snapshot, and a restarted process all hold the same activity mid-turn', async () => {
    const res = await app(service).request('/events');
    expect(res.status).toBe(200);
    const clientA = new StreamReader(res.body!);
    await clientA.until((t) => t.includes('orchestration:caughtUp'));
    const cursorBeforeTurn = eventStore.headGlobalSequence();

    for (const event of midTurn) {
      publish(event);
      await new Promise((r) => setTimeout(r, 0));
    }
    await clientA.until((t) => t.includes('e-tool-a-done'));
    const activityA = clientActivity(clientA.frames()) as any;
    await clientA.close();
    expect(activityA).toMatchObject({
      conversationId: root,
      openTurn: { turnId: 'child-turn', threadId: child },
      runningTools: [{ name: 'Read', callId: 'call-b' }],
      lastTool: { name: 'Bash', callId: 'call-a', outcome: 'success' },
    });

    // B: no cursor, after the fact.
    const resB = await app(service).request('/events');
    const clientB = new StreamReader(resB.body!);
    await clientB.until((t) => t.includes('orchestration:caughtUp'));
    await clientB.close();
    expect(
      clientB.frames().some((f) => f.event === 'orchestration:snapshot'),
    ).toBe(true);
    expect(clientActivity(clientB.frames())).toEqual(activityA);

    // C: stale cursor inside the replay window.
    const resC = await app(service).request('/events', {
      headers: { 'Last-Event-ID': String(cursorBeforeTurn) },
    });
    const clientC = new StreamReader(resC.body!);
    await clientC.until((t) => t.includes('orchestration:caughtUp'));
    await clientC.close();
    expect(
      clientC.frames().some((f) => f.event === 'orchestration:snapshot'),
    ).toBe(false);
    expect(clientActivity(clientC.frames())).toEqual(activityA);

    // E: a restarted process (cold projection) with no cursor.
    const restarted = makeService();
    const resE = await app(restarted).request('/events');
    const clientE = new StreamReader(resE.body!);
    await clientE.until((t) => t.includes('orchestration:caughtUp'));
    await clientE.close();
    expect(clientActivity(clientE.frames())).toEqual(activityA);

    // D: stale cursor past the gap threshold: snapshot path. Bulk traffic
    // on an unrelated thread (no lineage) moves the head, not the activity.
    for (let i = 0; i < ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 5; i += 1)
      eventStore.appendEvent({
        eventId: `bulk-${i}`,
        provider: 'claude',
        threadId: 'unrelated-thread',
        createdAt: '2026-09-22T09:00:05.000Z',
        method: 'content.text-delta',
        itemId: 'x',
        delta: 'x',
      } as CanonicalRuntimeEvent);
    const resD = await app(service).request('/events', {
      headers: { 'Last-Event-ID': String(cursorBeforeTurn) },
    });
    const clientD = new StreamReader(resD.body!);
    await clientD.until((t) => t.includes('orchestration:caughtUp'));
    await clientD.close();
    expect(
      clientD.frames().some((f) => f.event === 'orchestration:snapshot'),
    ).toBe(true);
    expect(clientActivity(clientD.frames())).toEqual(activityA);
  }, 60_000);

  test('a restarted service rebuilds settled child outcomes without reviving running work', async () => {
    const at = '2026-09-24T00:00:00.000Z';
    for (const event of [
      {
        eventId: 'restart-child-upsert',
        provider: 'claude',
        threadId: root,
        createdAt: at,
        method: 'child-work.updated',
        delta: {
          kind: 'upsert',
          item: {
            producer: 'engine-subagent',
            reporterThreadId: root,
            childId: 'restart-child',
            status: 'running',
            title: 'Explore',
          },
        },
      },
      {
        eventId: 'restart-child-settle',
        provider: 'claude',
        threadId: root,
        createdAt: at,
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: root,
          childId: 'restart-child',
          status: 'completed',
          result: { summary: 'Done.' },
        },
      },
    ] as CanonicalRuntimeEvent[]) {
      (service as any).publishCanonicalEvent(event);
    }
    await service.shutdown();
    eventStore.close();
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    eventBus = new EventBus();
    const restarted = makeService();
    const response = await app(restarted).request('/events');
    const reader = new StreamReader(response.body!);
    await reader.until((text) => text.includes('orchestration:caughtUp'));
    const snapshot = reader
      .frames()
      .find((frame) => frame.event === 'orchestration:snapshot');
    await reader.close();
    const sessions = JSON.parse(snapshot!.data).sessions as Array<{
      threadId: string;
      childWork?: {
        children?: {
          running?: unknown[];
          settled?: Array<{ childId: string; status: string }>;
        };
      };
    }>;
    expect(
      sessions.find((row) => row.threadId === root)?.childWork?.children,
    ).toMatchObject({
      running: [],
      settled: [{ childId: 'restart-child', status: 'completed' }],
    });
  });
});
