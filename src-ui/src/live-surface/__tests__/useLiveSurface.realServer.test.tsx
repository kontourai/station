// @vitest-environment jsdom

/**
 * Viewer input against the REAL live-surface server (#90): the production
 * registry, lease, hub and routes, over the synthetic producer. Causality
 * and pressed state come from the server, so these prove the seams the
 * client used to infer:
 *
 * - A: which request caused an epoch (`epochCause`), including a renewal by
 *   another tab of the same person and device, which causes none;
 * - B: the server releasing what a viewer pressed (`release-pressed`, a lost
 *   answer, the viewer's stream closing, a change of control);
 * - C: bounded requests, after which the viewer reconciles to the newest
 *   lease the stream reported.
 */
import type { LiveSurfaceInput } from '@kontourai/station-contracts/live-surface';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test } from 'vitest';
import { useLiveSurface } from '../useLiveSurface';
import {
  REAL_API,
  REAL_SURFACE,
  realLiveSurfaceServer,
} from './fixtures/realLiveSurfaceServer';

type Server = Awaited<ReturnType<typeof realLiveSurfaceServer>>;
let server: Server | null = null;
afterEach(async () => {
  await server?.dispose();
  server = null;
});

function viewer(
  transport: ReturnType<Server['transport']>,
  options: { streamClosed?: boolean; requestTimeoutMs?: number } = {},
) {
  return renderHook(() =>
    useLiveSurface({
      apiBase: REAL_API,
      surfaceId: REAL_SURFACE,
      visibilityRef: createRef<Element>(),
      onFrame: () => {},
      transport: transport as never,
      // A viewer whose stream never opens learns only from its answers.
      paramsPending: options.streamClosed === true,
      ...(options.requestTimeoutMs
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    }),
  );
}

const down: LiveSurfaceInput = {
  kind: 'pointer',
  type: 'down',
  x: 10,
  y: 10,
  button: 'left',
};
const up: LiveSurfaceInput = {
  kind: 'pointer',
  type: 'up',
  x: 10,
  y: 10,
  button: 'left',
};
const text = (value: string): LiveSurfaceInput => ({
  kind: 'text',
  text: value,
});
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
const dispatchedText = (s: Server) =>
  s.producer.dispatched
    .filter((event) => event.kind === 'text')
    .map((event) => (event as { text: string }).text);

test("A: a claim that only renews control another tab of this device took is not this viewer's takeover (finding 1)", async () => {
  server = await realLiveSurfaceServer();
  await server.agentClaim();
  const a = viewer(server.transport(), { streamClosed: true });
  const b = viewer(server.transport());
  await settle();
  // A press made while the agent held control (A's held-back press).
  const pressedIn = a.result.current.controlLineage();
  // The other tab takes control: epoch 2, caused by its request.
  act(() => b.result.current.sendInput([text('from-b')]));
  await waitFor(() => expect(server!.lease().epoch).toBe(2));
  // This viewer's Take control only renews the same controller's hold.
  await act(async () => {
    await a.result.current.claimControl();
  });
  expect(server.lease().epoch).toBe(2);
  // The press goes out only in the control it was made in: it does not.
  act(() => a.result.current.sendInput([down], { lineage: pressedIn }));
  await settle();
  expect(server.producer.dispatched).not.toContainEqual(
    expect.objectContaining({ kind: 'pointer', type: 'down' }),
  );
  a.unmount();
  b.unmount();
});

test("A: this viewer's own takeover keeps the typing queued behind it", async () => {
  server = await realLiveSurfaceServer();
  await server.agentClaim();
  const a = viewer(server.transport());
  await settle();
  act(() => {
    a.result.current.sendInput([text('first')]);
  });
  act(() => {
    a.result.current.sendInput([text('second')]);
  });
  await waitFor(() =>
    expect(dispatchedText(server!)).toEqual(['first', 'second']),
  );
  a.unmount();
});

test('C: a claim that never answers is cut off, and the viewer reconciles to the newest lease (finding 2)', async () => {
  // An older host, where a stream record naming this device waits for this
  // viewer's own request: the bound is what ends that wait.
  server = await realLiveSurfaceServer({ epochCause: false });
  await server.agentClaim();
  const a = viewer(
    server.transport({
      hang: (url, body) =>
        url.endsWith('/lease') &&
        (body as { action?: string }).action === 'claim',
    }),
    { requestTimeoutMs: 100 },
  );
  const b = viewer(server.transport());
  await settle();
  const claim = a.result.current.claimControl();
  act(() => b.result.current.sendInput([text('from-b')]));
  await waitFor(() => expect(server!.lease().epoch).toBe(2));
  await act(async () => {
    await claim;
  });
  // The viewer's input goes at the epoch the stream reported, not a stale one.
  act(() => a.result.current.sendInput([text('from-a')]));
  await waitFor(() =>
    expect(dispatchedText(server!)).toEqual(['from-b', 'from-a']),
  );
  a.unmount();
  b.unmount();
});

/** A transport that loses its first input answer, held until `release()`. */
function losingFirstAnswer(s: Server) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const base = s.transport({
    loseAnswer: (url) => {
      if (!url.endsWith('/input') || !first) return false;
      first = false;
      return true;
    },
  });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const holdBack = String(input).endsWith('/input') && first;
    const answer = base(input, init);
    if (holdBack) {
      // Its rejection is the viewer's to handle once it is returned.
      answer.catch(() => {});
      await gate;
    }
    return answer;
  }) as typeof base;
  return { transport, release };
}

test('B: a lost answer for an applied press: the release queued behind it is not lost, the server releases the press (finding 3)', async () => {
  server = await realLiveSurfaceServer();
  const { transport, release } = losingFirstAnswer(server);
  const a = viewer(transport);
  await settle();
  act(() => a.result.current.sendInput([down]));
  await waitFor(() => expect(server!.remotePressed()).toEqual(['button:left']));
  // The finger lifts while the press's answer is still on its way back.
  act(() => a.result.current.sendInput([up]));
  release();
  await waitFor(() =>
    expect(a.result.current.inputNotice).toBe('input-failed'),
  );
  await waitFor(() => expect(server!.remotePressed()).toEqual([]));
  a.unmount();
});

test('B: on an older host a release queued behind a lost answer still goes', async () => {
  server = await realLiveSurfaceServer({ epochCause: false });
  const { transport, release } = losingFirstAnswer(server);
  const a = viewer(transport);
  await settle();
  act(() => a.result.current.sendInput([down]));
  await waitFor(() => expect(server!.remotePressed()).toEqual(['button:left']));
  act(() => a.result.current.sendInput([up]));
  release();
  await waitFor(() => expect(server!.remotePressed()).toEqual([]));
  a.unmount();
});

test('B: release-pressed releases what this viewer holds', async () => {
  server = await realLiveSurfaceServer();
  const a = viewer(server.transport());
  await settle();
  act(() => a.result.current.sendInput([down]));
  await waitFor(() => expect(server!.remotePressed()).toEqual(['button:left']));
  let handled = false;
  act(() => {
    handled = a.result.current.releasePressed();
  });
  expect(handled).toBe(true);
  await waitFor(() => expect(server!.remotePressed()).toEqual([]));
  a.unmount();
});

test('B: a viewer whose stream closes has its presses released by the server', async () => {
  server = await realLiveSurfaceServer();
  const a = viewer(server.transport());
  await settle();
  act(() => a.result.current.sendInput([down]));
  await waitFor(() => expect(server!.remotePressed()).toEqual(['button:left']));
  a.unmount();
  await waitFor(() => expect(server!.remotePressed()).toEqual([]));
});

test('B: after someone else takes control, the release of a press from before is not sent (it would take control back)', async () => {
  server = await realLiveSurfaceServer();
  const a = viewer(server.transport());
  const other = viewer(server.transport({ person: 'human:local:other' }));
  await settle();
  act(() => a.result.current.sendInput([down]));
  await waitFor(() => expect(server!.remotePressed()).toEqual(['button:left']));
  act(() => other.result.current.sendInput([text('other')]));
  await waitFor(() =>
    expect(server!.lease().holder).toEqual(
      expect.objectContaining({ principal: 'human:local:other' }),
    ),
  );
  await settle();
  // The server released A's press at the handoff.
  expect(server.remotePressed()).toEqual([]);
  const sentBefore = server.requests.length;
  act(() => a.result.current.sendInput([up]));
  await settle();
  expect(server.requests.length).toBe(sentBefore);
  expect(server.lease().holder).toEqual(
    expect.objectContaining({ principal: 'human:local:other' }),
  );
  a.unmount();
  other.unmount();
});

test('C: an input request that never answers is cut off and what is queued behind it still drains', async () => {
  server = await realLiveSurfaceServer();
  let hangFirst = true;
  const a = viewer(
    server.transport({
      hang: (url) => {
        if (!url.endsWith('/input') || !hangFirst) return false;
        hangFirst = false;
        return true;
      },
    }),
    { requestTimeoutMs: 100 },
  );
  await settle();
  act(() => a.result.current.sendInput([text('lost')]));
  await settle();
  await waitFor(() =>
    expect(a.result.current.inputNotice).toBe('input-failed'),
  );
  act(() => a.result.current.sendInput([text('after')]));
  await waitFor(() => expect(dispatchedText(server!)).toEqual(['after']));
  a.unmount();
});
