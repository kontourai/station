/**
 * @vitest-environment jsdom
 *
 * archive#1094, amended by station#2301: a stream that terminal-stops
 * (401/403) must never become an ORPHAN — a connection that the dedup map no
 * longer owns but that the SDK's origin-scoped credential-change wake
 * (`packages/sdk/src/client/http.ts`) can still resume, double-applying
 * events alongside whatever stream a later call created. archive#1094 closed
 * the stream to achieve that; station#2301 keeps it PARKED and registered
 * instead, because closing is what made a fixed credential unable to revive
 * the feed at all. The invariant pinned here is the one that matters either
 * way: exactly one owner, and every event applied once. Uses the REAL
 * (unmocked) `fetchSSE` transport against a mocked global `fetch`, stubbing
 * only the sibling event-handler modules so application can be counted.
 */
import { notifyCredentialChanged } from '@kontourai/station-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handleOrchestrationEvent, settleSemanticDeliveryBuffer } = vi.hoisted(
  () => ({
    handleOrchestrationEvent: vi.fn(),
    settleSemanticDeliveryBuffer: vi.fn(),
  }),
);

vi.mock('../hooks/orchestration/eventHandlers', () => ({
  handleOrchestrationEvent,
  settleSemanticDeliveryBuffer,
}));

import {
  ensureOrchestrationEventStream,
  resetSessionReadModelRefreshForTests,
} from '../hooks/orchestration/ensureOrchestrationEventStream';

const APP_ORIGIN = 'https://ensure-orchestration-orphan-case.example.test';

function orchestrationEventFrame(id: string): string {
  return `id: ${id}\nevent: orchestration:event\ndata: ${JSON.stringify({
    event: {
      eventId: id,
      threadId: 'task:1',
      method: 'session.started',
      createdAt: '2026-07-29T00:00:00.000Z',
    },
  })}\n\n`;
}

/** A live SSE response that delivers exactly one frame, then stays open. */
function openSseResponseWithOneFrame(frame: string): Response {
  const bytes = new TextEncoder().encode(frame);
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
          return;
        }
        return new Promise<void>(() => undefined);
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('ensureOrchestrationEventStream — station#1094 terminal-orphan regression', () => {
  beforeEach(() => {
    handleOrchestrationEvent.mockReset();
    settleSemanticDeliveryBuffer.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a terminal-stopped stream is never orphaned: a remount opens no second stream, and the credential wake resumes the one owner exactly once', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      // First mount: 401 — terminal, the stream parks in place.
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      // The credential wake resumes THAT stream: it connects and delivers
      // exactly one event, then stays open.
      .mockResolvedValueOnce(
        openSseResponseWithOneFrame(orchestrationEventFrame('evt-live')),
      )
      // Only reached if a second, orphaned or duplicate stream exists.
      .mockResolvedValueOnce(
        openSseResponseWithOneFrame(orchestrationEventFrame('evt-live')),
      );
    vi.stubGlobal('fetch', fetchMock);

    ensureOrchestrationEventStream(APP_ORIGIN);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(settleSemanticDeliveryBuffer).toHaveBeenCalledWith(APP_ORIGIN, true);
    expect(settleSemanticDeliveryBuffer).not.toHaveBeenCalledWith(APP_ORIGIN);

    // A remount while parked finds the owner and opens nothing new.
    ensureOrchestrationEventStream(APP_ORIGIN);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The credential wake resumes the one owner.
    notifyCredentialChanged(APP_ORIGIN);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1),
    );

    // Nothing else is alive to reconnect or re-apply.
    ensureOrchestrationEventStream(APP_ORIGIN);
    notifyCredentialChanged(APP_ORIGIN);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1);
  });

  it('past the retry floor, a remount retries the SAME parked stream — still one owner', async () => {
    vi.useFakeTimers();
    const origin = 'https://ensure-orchestration-orphan-late.example.test';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      // The remount's retry of the one owner.
      .mockResolvedValueOnce(
        openSseResponseWithOneFrame(orchestrationEventFrame('evt-late')),
      )
      // Only reached if a second stream exists alongside it.
      .mockResolvedValueOnce(
        openSseResponseWithOneFrame(orchestrationEventFrame('evt-late')),
      );
    vi.stubGlobal('fetch', fetchMock);

    ensureOrchestrationEventStream(origin);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(31_000);
    ensureOrchestrationEventStream(origin);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1),
    );

    // A credential wake finds nothing else parked to resume.
    notifyCredentialChanged(origin);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1);
  });
});

/**
 * archive#1410 — pins the wire seam itself.
 *
 * The server hangs the provenance envelope on a SIBLING key of the SSE
 * frame's JSON (`{ event, provenance }`) and this module is the only place
 * that reads it back out. Nothing else in the stack would notice if that key
 * were renamed on one side: the envelope would simply stop arriving, every
 * card would quietly go missing, and every existing test would still pass
 * because they all hand the envelope to the handler directly. This test
 * drives a real frame through the real transport so a rename goes red here.
 */
describe('ensureOrchestrationEventStream — turn provenance sibling (station#1410)', () => {
  beforeEach(() => {
    handleOrchestrationEvent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const PROVENANCE_ORIGIN =
    'https://ensure-orchestration-provenance.example.test';

  it('parses the provenance sibling out of the frame and passes it to the handler', async () => {
    const provenance = {
      envelopeVersion: 1,
      sessionId: 'task:1',
      turnId: 'turn-7',
      outcome: 'completed',
    };
    const frame = `id: 12\nevent: orchestration:event\ndata: ${JSON.stringify({
      event: {
        eventId: 'evt-done',
        threadId: 'task:1',
        turnId: 'turn-7',
        method: 'turn.completed',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      provenance,
    })}\n\n`;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openSseResponseWithOneFrame(frame));
    vi.stubGlobal('fetch', fetchMock);

    ensureOrchestrationEventStream(PROVENANCE_ORIGIN);
    await vi.waitFor(() =>
      expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1),
    );

    const [, event, passedProvenance] =
      handleOrchestrationEvent.mock.calls[0] ?? [];
    expect(event).toMatchObject({ method: 'turn.completed', turnId: 'turn-7' });
    expect(passedProvenance).toEqual(provenance);
  });

  it('passes undefined when the frame carries no sibling', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        openSseResponseWithOneFrame(orchestrationEventFrame('evt-plain')),
      );
    vi.stubGlobal('fetch', fetchMock);

    ensureOrchestrationEventStream(
      'https://ensure-orchestration-provenance-absent.example.test',
    );
    await vi.waitFor(() =>
      expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1),
    );

    expect(handleOrchestrationEvent.mock.calls[0]?.[2]).toBeUndefined();
  });
});

// V3 a session killed mid-turn showed a red
// `Failed` chip (fed by this stream) beside a transcript that just stopped and
// no reason at all — the dock's failure banner reads the SHARED session
// read-model, whose cached copy still said `lifecycleState: 'running'` because
// nothing invalidated it when the session failed. The chip and the reason were
// reading two different sources.
// HELPER-LEVEL (#2310 review H2): every test below injects a QueryClient by
// hand, so these prove the refresh logic only. That production supplies one —
// `ChatDock` registering its `useQueryClient()` — is proven through the real
// mount in `ChatWorkspacePaneStreamQueryClient.test.tsx` (#2307).
describe('ensureOrchestrationEventStream — session read-model refresh (helper-level, injected QueryClient)', () => {
  beforeEach(() => {
    handleOrchestrationEvent.mockReset();
    // The throttle and client registrations are module-global; each test starts
    // from a quiet window with nothing bound (review L3), on fake clocks so
    // the window is advanced rather than waited out.
    resetSessionReadModelRefreshForTests();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function terminalFrame(id: string, method: string): string {
    return `id: ${id}\nevent: orchestration:event\ndata: ${JSON.stringify({
      event: {
        eventId: id,
        threadId: 'claude:1',
        method,
        createdAt: '2026-08-21T00:00:00.000Z',
        message: 'Claude Code process terminated by signal SIGKILL',
      },
    })}\n\n`;
  }

  it('invalidates the shared session read-model when a session-ending event arrives', async () => {
    const invalidateQueries = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          openSseResponseWithOneFrame(
            terminalFrame('evt-kill', 'runtime.error'),
          ),
        ),
    );

    ensureOrchestrationEventStream(
      'https://ensure-orchestration-readmodel.example.test',
      { invalidateQueries } as never,
    );
    await vi.waitFor(() =>
      expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['orchestration-sessions'],
      }),
    );
  });

  it('uses the shared client when a projection-update stream started without one', async () => {
    const invalidateQueries = vi.fn();
    let resolveResponse: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      ),
    );
    const origin =
      'https://ensure-orchestration-projection-fallback.example.test';
    ensureOrchestrationEventStream(origin);
    await vi.waitFor(() => expect(resolveResponse).toBeTypeOf('function'));
    ensureOrchestrationEventStream(origin, { invalidateQueries } as never);
    resolveResponse?.(
      openSseResponseWithOneFrame(
        'event: orchestration:session-projection-updated\ndata: {"threadId":"claude:1"}\n\n',
      ),
    );
    await vi.waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['orchestration-sessions'],
      }),
    );
  });

  // #2307: a client belongs to ONE authority's apiBase. Another apiBase's
  // stream — e.g. the previous authority's, still alive after a switch — must
  // not write into it.
  it("never refreshes a client registered for a different apiBase's stream", async () => {
    const invalidateQueries = vi.fn();
    const boundOrigin = 'https://ensure-orchestration-bound.example.test';
    const unboundOrigin = 'https://ensure-orchestration-unbound.example.test';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((input: RequestInfo | URL) =>
          String(input).startsWith(unboundOrigin)
            ? Promise.resolve(
                openSseResponseWithOneFrame(
                  terminalFrame('evt-kill-2', 'session.exited'),
                ),
              )
            : new Promise<Response>(() => undefined),
        ),
    );
    ensureOrchestrationEventStream(boundOrigin, {
      invalidateQueries,
    } as never);
    ensureOrchestrationEventStream(unboundOrigin);
    await vi.waitFor(() =>
      expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  // #2307: a docked and a full-screen Chat can both be mounted on one
  // authority's client; closing one must not unregister the other.
  it('keeps refreshing while another registration of the same client is live', async () => {
    const invalidateQueries = vi.fn();
    let resolveResponse: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      ),
    );
    const origin = 'https://ensure-orchestration-two-docks.example.test';
    const client = { invalidateQueries } as never;
    const releaseFirst = ensureOrchestrationEventStream(origin, client);
    ensureOrchestrationEventStream(origin, client);
    releaseFirst();
    await vi.waitFor(() => expect(resolveResponse).toBeTypeOf('function'));
    resolveResponse?.(
      openSseResponseWithOneFrame(
        terminalFrame('evt-kill-3', 'session.exited'),
      ),
    );
    await vi.waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['orchestration-sessions'],
      }),
    );
  });

  it('leaves the read-model alone for ordinary streaming frames', async () => {
    const invalidateQueries = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          openSseResponseWithOneFrame(
            terminalFrame('evt-delta', 'content.text-delta'),
          ),
        ),
    );

    ensureOrchestrationEventStream(
      'https://ensure-orchestration-readmodel-quiet.example.test',
      { invalidateQueries } as never,
    );
    await vi.waitFor(() =>
      expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1),
    );
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  // #2310: a Draft (nothing ever sent) sits outside "Active now". Its first
  // `turn.started` is the only moment that changes, so it must re-read the
  // projection — and a first turn that lands inside the throttle window of
  // some other session's terminal event must be deferred, not dropped, or the
  // promotion stays unseen until an unrelated refetch.
  it('re-reads the read-model on turn.started, deferring one that lands inside the window', async () => {
    const invalidateQueries = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          openSseResponseWithOneFrame(
            terminalFrame('evt-other-session-done', 'turn.completed') +
              terminalFrame('evt-first-turn', 'turn.started'),
          ),
        ),
    );

    ensureOrchestrationEventStream(
      'https://ensure-orchestration-readmodel-first-turn.example.test',
      { invalidateQueries } as never,
    );
    await vi.waitFor(() =>
      expect(handleOrchestrationEvent).toHaveBeenCalledTimes(2),
    );
    // The terminal event refreshed immediately; the turn.started fell inside
    // its window...
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    // ...and is deferred, not dropped: it fires once the window closes.
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenLastCalledWith({
      queryKey: ['orchestration-sessions'],
    });
  });

  it('re-reads the read-model on a lone turn.started', async () => {
    const invalidateQueries = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          openSseResponseWithOneFrame(
            terminalFrame('evt-lone-first-turn', 'turn.started'),
          ),
        ),
    );

    ensureOrchestrationEventStream(
      'https://ensure-orchestration-readmodel-lone-turn.example.test',
      { invalidateQueries } as never,
    );
    await vi.waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['orchestration-sessions'],
      }),
    );
  });
});
