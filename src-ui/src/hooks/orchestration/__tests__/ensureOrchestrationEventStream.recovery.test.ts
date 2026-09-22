// @vitest-environment jsdom
import {
  notifyCredentialChanged,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * station#2301 — the stream must come back.
 *
 * Unlike `ensureOrchestrationEventStream.test.ts`, the SDK here is REAL: the
 * abort, the terminal park and the credential wake all run through
 * `fetchSSE` itself, and "a new connection" means a new request reached
 * `fetch`. Asserting that a registry entry disappeared is not enough — the
 * defect was that nothing ever connected again.
 *
 * Every test uses its own apiBase and counts only its own requests: the
 * module's recovery listeners are document-wide, so streams from earlier
 * tests stay registered and may react to a later test's events.
 */

const applyOrchestrationSnapshot = vi.fn();
vi.mock('../snapshotHandlers', () => ({
  applyOrchestrationSnapshot: (...args: unknown[]) =>
    applyOrchestrationSnapshot(...args),
}));
vi.mock('../eventHandlers', () => ({
  handleOrchestrationEvent: vi.fn(),
  settleSemanticDeliveryBuffer: vi.fn(),
}));

import { ensureOrchestrationEventStream } from '../ensureOrchestrationEventStream';

const encoder = new TextEncoder();

/**
 * A response that delivers `body` and then stays open until its request is
 * aborted — a healthy, idle stream.
 */
function openSseResponse(body: string, signal?: AbortSignal | null): Response {
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          if (body) controller.enqueue(encoder.encode(body));
          return;
        }
        return new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              controller.error(new Error('aborted'));
              resolve();
            },
            { once: true },
          );
        });
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const SNAPSHOT =
  'id: 5\nevent: orchestration:snapshot\ndata: {"sessions":[]}\n\n';

let fetchMock: ReturnType<typeof vi.fn>;
function requestsTo(apiBase: string) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input instanceof Request ? input.url : input).startsWith(apiBase),
  );
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function pagehide(persisted: boolean) {
  window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
}

beforeEach(() => {
  applyOrchestrationSnapshot.mockClear();
  fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    openSseResponse(SNAPSHOT, init?.signal),
  );
  vi.stubGlobal('fetch', fetchMock);
  setClientCredentialResolver(() => ({
    origin: 'http://recovery.test',
    credential: 'test-credential',
  }));
});

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

describe('ensureOrchestrationEventStream recovery (station#2301)', () => {
  test('a stream ended by a non-persisted pagehide is replaced by the next ensure', async () => {
    const apiBase = 'http://recovery.test/pagehide';
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);

    pagehide(false);
    await settle();

    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test('an ensure in the same tick as the abort already replaces the stream', async () => {
    const apiBase = 'http://recovery.test/same-tick';
    ensureOrchestrationEventStream(apiBase);
    await settle();

    // No await between them: the dead connection's loop has not wound down
    // yet, so only its abort signal can tell the registry it is gone.
    pagehide(false);
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test('a live stream still dedups: a second ensure opens nothing', async () => {
    const apiBase = 'http://recovery.test/live';
    ensureOrchestrationEventStream(apiBase);
    await settle();
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);
  });

  test('the page becoming visible again re-ensures an ended stream with no remount', async () => {
    const apiBase = 'http://recovery.test/visible';
    ensureOrchestrationEventStream(apiBase);
    await settle();
    pagehide(false);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);

    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test('a stream stopped by a 401 is re-armed by a credential change, as the SAME stream', async () => {
    const apiBase = 'http://recovery.test/terminal';
    fetchMock.mockImplementationOnce(
      async () => new Response('', { status: 401 }),
    );
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);

    notifyCredentialChanged('http://recovery.test');
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);

    // It resumed in place: a later ensure finds it live and opens nothing.
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test("a replacement stream's first snapshot is a reconnect fallback, so what the dead one missed is caught up", async () => {
    const apiBase = 'http://recovery.test/catch-up';
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(applyOrchestrationSnapshot).toHaveBeenLastCalledWith(
      { sessions: [] },
      expect.objectContaining({ apiBase, isReconnectFallback: false }),
    );

    pagehide(false);
    await settle();
    ensureOrchestrationEventStream(apiBase);
    await settle();

    expect(requestsTo(apiBase)).toHaveLength(2);
    expect(applyOrchestrationSnapshot).toHaveBeenLastCalledWith(
      { sessions: [] },
      expect.objectContaining({ apiBase, isReconnectFallback: true }),
    );
  });
});
