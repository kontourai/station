/**
 * @vitest-environment jsdom
 *
* archive#1094: a stream that terminal-stops (401/403) must
* be `.close`d, not just dropped from `ensureOrchestrationEventStream`'s
 * dedup map — otherwise it becomes an orphan that stays strongly referenced
 * by the SDK's origin-scoped credential-change wake registry
 * (`packages/sdk/src/client/http.ts`) and silently reactivates alongside
 * whatever live stream a later call created, double-applying events. This
 * test proves the fix using the REAL (unmocked) `fetchSSE` transport against
 * a mocked global `fetch`, only stubbing the sibling event-handler modules
 * so event application can be counted without a full `activeChatsStore`
 * fixture.
 */
import { notifyCredentialChanged } from '@kontourai/station-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handleOrchestrationEvent } = vi.hoisted(() => ({
  handleOrchestrationEvent: vi.fn(),
}));

vi.mock('../hooks/orchestration/eventHandlers', () => ({
  handleOrchestrationEvent,
}));

import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';

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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a terminal-stopped stream is closed, not orphaned: a later credential change does not wake it or double-apply events', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
// Stream #1 (first mount): 401 — terminal, must close+deregister.
      .mockResolvedValueOnce(new Response('', { status: 401 }))
// Stream #2 (remount after #1's dedup entry frees up): connects and
// delivers exactly one event, then stays open.
      .mockResolvedValueOnce(
        openSseResponseWithOneFrame(orchestrationEventFrame('evt-live')),
      )
// Only reached if the orphan bug is present: stream #1 reconnecting.
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    ensureOrchestrationEventStream(APP_ORIGIN);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
// Let the terminal catch handler's synchronous close+delete run
// before "remounting" — mirrors a real unmount/remount tick.
    await Promise.resolve();
    await Promise.resolve();

    ensureOrchestrationEventStream(APP_ORIGIN);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1),
    );

// The credential-change wake that resumes a genuinely blocked stream
// must NOT reach stream #1: it was closed, not parked.
    notifyCredentialChanged(APP_ORIGIN);
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
describe('ensureOrchestrationEventStream — session read-model freshness', () => {
  beforeEach(() => {
    handleOrchestrationEvent.mockReset();
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

// The mount-order trap this refresh has to survive: `ChatDock.tsx` creates
// the stream WITHOUT a client while `useOrchestration` creates it WITH one,
// and only the first call for an apiBase takes effect.
  it('still refreshes when the stream was created by the caller that has no client', async () => {
    const invalidateQueries = vi.fn();
// A prior call binds the app's one client...
    ensureOrchestrationEventStream(
      'https://ensure-orchestration-bound.example.test',
      {
        invalidateQueries,
      } as never,
    );
// The refresh is throttled to at most once a second; the preceding test
// fired one, so wait past that window rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          openSseResponseWithOneFrame(
            terminalFrame('evt-kill-2', 'session.exited'),
          ),
        ),
    );
//.and a DIFFERENT origin's stream, created with no client, still uses it.
    ensureOrchestrationEventStream(
      'https://ensure-orchestration-unbound.example.test',
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
});
