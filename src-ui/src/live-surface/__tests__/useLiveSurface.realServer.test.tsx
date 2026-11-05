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
  // The release queued behind the lost answer still goes (its success then
  // clears the notice, as later input getting through always does).
  await waitFor(() =>
    expect(
      server!.requests.some((request) =>
        (request.body as { events?: { type?: string }[] }).events?.some(
          (event) => event.type === 'up',
        ),
      ),
    ).toBe(true),
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

// ---- fix round 5 -----------------------------------------------------------

/** The viewer id this viewer sent with its last request. */
const sentViewerId = (s: Server) =>
  [...s.requests]
    .reverse()
    .map(
      (request) =>
        (request.body as { viewerId?: string } | undefined)?.viewerId,
    )
    .find((id) => id !== undefined);

test("1: another controller presenting this viewer's id gains it nothing: its takeover is someone else's, and a press from before is not sent", async () => {
  server = await realLiveSurfaceServer();
  const a = viewer(server.transport());
  await settle();
  act(() => a.result.current.sendInput([text('mine')]));
  await waitFor(() => expect(server!.lease().epoch).toBe(1));
  const victimId = sentViewerId(server)!;
  expect(victimId).toBeDefined();
  const pressedIn = a.result.current.controlLineage();
  // Someone else claims, presenting the victim's viewer id.
  const thief = server.transport({ person: 'human:local:other' });
  await thief(
    `${REAL_API}/api/live-surfaces/${encodeURIComponent(REAL_SURFACE)}/lease`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'claim', viewerId: victimId }),
    },
  );
  await waitFor(() => expect(server!.lease().epoch).toBe(2));
  await settle();
  // The press made before the theft is not sent, and control stays theirs.
  act(() => a.result.current.sendInput([down], { lineage: pressedIn }));
  await settle();
  expect(server.producer.dispatched).not.toContainEqual(
    expect.objectContaining({ type: 'down' }),
  );
  expect(server.lease().holder).toEqual(
    expect.objectContaining({ principal: 'human:local:other' }),
  );
  a.unmount();
});

test('2: a release the host has not confirmed is tried again until it is', async () => {
  server = await realLiveSurfaceServer();
  let failures = 2;
  const a = viewer(
    server.transport({
      fail: (url, body) =>
        url.endsWith('/lease') &&
        (body as { action?: string }).action === 'release-pressed' &&
        failures-- > 0,
    }),
  );
  await settle();
  act(() => a.result.current.sendInput([down]));
  await waitFor(() => expect(server!.remotePressed()).toEqual(['button:left']));
  act(() => {
    a.result.current.releasePressed();
  });
  await waitFor(() => expect(server!.remotePressed()).toEqual([]), {
    timeout: 3_000,
  });
  a.unmount();
});

test('3: a different, older Station behind the same address is asked again on reconnect, and gets no new fields', async () => {
  server = await realLiveSurfaceServer();
  const a = viewer(server.transport());
  await settle();
  act(() => a.result.current.sendInput([text('new-station')]));
  await waitFor(() => expect(dispatchedText(server!)).toEqual(['new-station']));
  server.switchStation({
    environmentId: '11111111-1111-4111-8111-111111111111',
    epochCause: false,
  });
  server.dropStreams();
  await waitFor(() => expect(a.result.current.status).not.toBe('live'));
  // Typed while it reconnects: it never carries the old stream's viewer id
  // to whatever Station now answers (it is retired when that Station turns
  // out to be a different one: it was meant for the one being watched).
  act(() => a.result.current.sendInput([text('gap')]));
  await waitFor(() => expect(a.result.current.status).toBe('live'), {
    timeout: 5_000,
  });
  act(() => a.result.current.sendInput([text('old-station')]));
  await waitFor(() =>
    expect(dispatchedText(server!)).toEqual(
      expect.arrayContaining(['new-station', 'old-station']),
    ),
  );
  expect(server.rejected).toEqual([]);
  a.unmount();
});

test('4: a claim answered late never moves the published lease back', async () => {
  server = await realLiveSurfaceServer();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const a = viewer(
    server.transport({
      delay: (url, body) =>
        url.endsWith('/lease') &&
        (body as { action?: string }).action === 'claim'
          ? gate
          : null,
    }),
  );
  const other = viewer(server.transport({ person: 'human:local:other' }));
  await settle();
  const claim = a.result.current.claimControl();
  await waitFor(() => expect(server!.lease().epoch).toBe(1));
  act(() => other.result.current.sendInput([text('other')]));
  await waitFor(() => expect(a.result.current.lease?.epoch).toBe(2));
  open();
  await act(async () => {
    await claim;
  });
  expect(a.result.current.lease).toEqual(
    expect.objectContaining({
      epoch: 2,
      holder: expect.objectContaining({ principal: 'human:local:other' }),
    }),
  );
  a.unmount();
  other.unmount();
});

test('6: a replacement stream (new stream params) keeps a held key down and stays the same viewer', async () => {
  server = await realLiveSurfaceServer({ viewerGraceMs: 200 });
  const shift: LiveSurfaceInput = {
    kind: 'key',
    type: 'down',
    key: 'Shift',
    code: 'ShiftLeft',
  };
  const transport = server.transport();
  const view = renderHook(
    ({ maxWidth }) =>
      useLiveSurface({
        apiBase: REAL_API,
        surfaceId: REAL_SURFACE,
        visibilityRef: createRef<Element>(),
        onFrame: () => {},
        transport: transport as never,
        params: { maxWidth },
      }),
    { initialProps: { maxWidth: 960 } },
  );
  await settle();
  act(() => view.result.current.sendInput([shift]));
  await waitFor(() =>
    expect(server!.remotePressed()).toEqual(['key:ShiftLeft']),
  );
  const before = sentViewerId(server);
  // The pane grows: the viewer asks for a larger picture on a new stream.
  view.rerender({ maxWidth: 1280 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  expect(server.remotePressed()).toEqual(['key:ShiftLeft']);
  act(() => view.result.current.sendInput([text('after')]));
  await waitFor(() => expect(dispatchedText(server!)).toEqual(['after']));
  expect(sentViewerId(server)).toBe(before);
  view.unmount();
});

// ---- fix round 6 -----------------------------------------------------------

const shiftDown: LiveSurfaceInput = {
  kind: 'key',
  type: 'down',
  key: 'Shift',
  code: 'ShiftLeft',
};
const shiftUp: LiveSurfaceInput = { ...shiftDown, type: 'up' };
const isRelease = (url: string, body: unknown) =>
  url.endsWith('/lease') &&
  (body as { action?: string } | undefined)?.action === 'release-pressed';
const releaseRequests = (s: Server) =>
  s.requests.filter((request) => isRelease(request.url, request.body)).length;

test('R6-1: a late answer to an earlier release never swallows the release of a later press of the same key', async () => {
  server = await realLiveSurfaceServer();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const a = viewer(
    server.transport({
      delay: (url, body) => (isRelease(url, body) ? gate : null),
    }),
  );
  await settle();
  act(() => a.result.current.sendInput([shiftDown]));
  await waitFor(() =>
    expect(server!.remotePressed()).toEqual(['key:ShiftLeft']),
  );
  // The page loses focus: the host is asked to release Shift (and does;
  // its answer is slow to come back).
  act(() => {
    a.result.current.releasePressed();
  });
  await waitFor(() => expect(server!.remotePressed()).toEqual([]));
  // Shift is pressed again before that answer arrives.
  act(() => a.result.current.sendInput([shiftDown]));
  await waitFor(() =>
    expect(server!.remotePressed()).toEqual(['key:ShiftLeft']),
  );
  open();
  await settle();
  // The physical release of the new press reaches the surface.
  act(() => a.result.current.sendInput([shiftUp]));
  await waitFor(() => expect(server!.remotePressed()).toEqual([]));
  a.unmount();
});

test("R6-2: a release answered stale while this viewer's own takeover is still on its way is tried again, not abandoned", async () => {
  server = await realLiveSurfaceServer();
  await server.agentClaim();
  let openStream!: () => void;
  const streamGate = new Promise<void>((resolve) => {
    openStream = resolve;
  });
  let openAnswer!: () => void;
  const answerGate = new Promise<void>((resolve) => {
    openAnswer = resolve;
  });
  let firstInput = true;
  const a = viewer(
    server.transport({
      // The stream reports nothing after its first record for now, and the
      // takeover's own answer is slow: the viewer still believes epoch 1.
      streamGate: () => streamGate,
      delay: (url) => {
        if (!url.endsWith('/input') || !firstInput) return null;
        firstInput = false;
        return answerGate;
      },
    }),
  );
  await settle();
  act(() => a.result.current.sendInput([shiftDown]));
  await waitFor(() =>
    expect(server!.remotePressed()).toEqual(['key:ShiftLeft']),
  );
  expect(server.lease().epoch).toBe(2);
  act(() => {
    a.result.current.releasePressed();
  });
  await waitFor(() => expect(server!.remotePressed()).toEqual([]), {
    timeout: 3_000,
  });
  openAnswer();
  openStream();
  await settle();
  expect(server.remotePressed()).toEqual([]);
  a.unmount();
});

test('R6-3: a release the producer failed to perform is not confirmed; the viewer asks again until it is', async () => {
  server = await realLiveSurfaceServer();
  const a = viewer(server.transport());
  await settle();
  act(() => a.result.current.sendInput([shiftDown]));
  await waitFor(() =>
    expect(server!.remotePressed()).toEqual(['key:ShiftLeft']),
  );
  // The surface refuses the first cancel.
  let refuse = true;
  server.producer.dispatchImpl = async (event) => {
    if (event.kind === 'key' && event.type === 'up' && refuse) {
      refuse = false;
      // Refused: the surface never saw the key go up.
      server!.producer.dispatched.pop();
      throw new Error('surface refused the key up');
    }
  };
  act(() => {
    a.result.current.releasePressed();
  });
  await waitFor(() => expect(server!.remotePressed()).toEqual([]), {
    timeout: 3_000,
  });
  expect(releaseRequests(server)).toBeGreaterThanOrEqual(2);
  a.unmount();
});

test('R6-4: many release calls make one request at a time, and an obligation still unconfirmed after many failures resumes on reconnect', async () => {
  // No heartbeat: nothing from the host prompts a retry, so every try below
  // is the worker's own.
  // ...and a long server grace, so the dropped stream below is not what
  // releases the key.
  server = await realLiveSurfaceServer({
    heartbeatMs: 60_000,
    viewerGraceMs: 10_000,
  });
  let inflight = 0;
  let maxInflight = 0;
  // One more failure than the old six-try limit allowed.
  let failures = 7;
  const base = server.transport({
    fail: (url, body) => isRelease(url, body) && failures-- > 0,
  });
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const counted = isRelease(String(input), body);
    if (counted) maxInflight = Math.max(maxInflight, ++inflight);
    try {
      return await base(input, init);
    } finally {
      if (counted) inflight -= 1;
    }
  }) as typeof base;
  const a = viewer(transport);
  await settle();
  act(() => a.result.current.sendInput([shiftDown]));
  await waitFor(() =>
    expect(server!.remotePressed()).toEqual(['key:ShiftLeft']),
  );
  act(() => {
    for (let call = 0; call < 8; call += 1) a.result.current.releasePressed();
  });
  // A seventh try, with no reconnect to prompt it: the worker never gave up.
  await waitFor(() => expect(releaseRequests(server!)).toBe(7), {
    timeout: 15_000,
  });
  expect(server.remotePressed()).toEqual(['key:ShiftLeft']);
  expect(maxInflight).toBe(1);
  // Back in touch with the host: the obligation is tried again at once.
  server.dropStreams();
  // Well inside the 5 s pause the worker is now in: the reconnect woke it.
  await waitFor(() => expect(server!.remotePressed()).toEqual([]), {
    timeout: 2_000,
  });
  expect(releaseRequests(server)).toBe(8);
  a.unmount();
}, 30_000);

test("R6-5: a stream reopened for new params verifies the Station before it presents this viewer's id", async () => {
  server = await realLiveSurfaceServer();
  const transport = server.transport();
  const view = renderHook(
    ({ maxWidth }) =>
      useLiveSurface({
        apiBase: REAL_API,
        surfaceId: REAL_SURFACE,
        visibilityRef: createRef<Element>(),
        onFrame: () => {},
        transport: transport as never,
        params: { maxWidth },
      }),
    { initialProps: { maxWidth: 960 } },
  );
  await settle();
  server.switchStation({
    environmentId: '22222222-2222-4222-8222-222222222222',
    epochCause: false,
  });
  view.rerender({ maxWidth: 1280 });
  await waitFor(() => expect(view.result.current.status).toBe('live'), {
    timeout: 5_000,
  });
  await settle();
  expect(server.rejected).toEqual([]);
  view.unmount();
});

test('R6-6: a restarted Station with the same id starts the viewer over at its epoch', async () => {
  server = await realLiveSurfaceServer();
  const restarted = await realLiveSurfaceServer();
  let switched = false;
  const before = server.transport();
  const after = restarted.transport();
  const transport = ((input: RequestInfo | URL, init?: RequestInit) =>
    (switched ? after : before)(input, init)) as typeof before;
  const a = viewer(transport);
  await settle();
  act(() => a.result.current.sendInput([text('before')]));
  await waitFor(() => expect(server!.lease().epoch).toBe(1));
  switched = true;
  server.dropStreams();
  await waitFor(() => expect(a.result.current.lease?.epoch).toBe(0), {
    timeout: 5_000,
  });
  act(() => a.result.current.sendInput([text('after')]));
  await waitFor(() =>
    expect(
      restarted.producer.dispatched
        .filter((event) => event.kind === 'text')
        .map((event) => (event as { text: string }).text),
    ).toEqual(['after']),
  );
  a.unmount();
  await restarted.dispose();
});

test("R6-2b: a release refused as stale only because this viewer's own takeover moved the epoch goes again, so the press is not left down", async () => {
  server = await realLiveSurfaceServer({ viewerGraceMs: 10_000 });
  await server.agentClaim();
  let openStream!: () => void;
  const streamGate = new Promise<void>((resolve) => {
    openStream = resolve;
  });
  // The takeover is applied; its answer is held back, then lost.
  let loseAnswer!: () => void;
  const answerGate = new Promise<void>((_resolve, reject) => {
    loseAnswer = () => reject(new TypeError('network connection was lost'));
  });
  answerGate.catch(() => {});
  let firstInput = true;
  const a = viewer(
    server.transport({
      // The stream says nothing new, and the takeover's answer is lost.
      streamGate: () => streamGate,
      delay: (url) => {
        if (!url.endsWith('/input') || !firstInput) return null;
        firstInput = false;
        return answerGate;
      },
    }),
  );
  await settle();
  act(() => a.result.current.sendInput([shiftDown]));
  await waitFor(() =>
    expect(server!.remotePressed()).toEqual(['key:ShiftLeft']),
  );
  act(() => a.result.current.sendInput([shiftUp]));
  loseAnswer();
  await waitFor(() => expect(server!.remotePressed()).toEqual([]), {
    timeout: 3_000,
  });
  openStream();
  await settle();
  expect(server.remotePressed()).toEqual([]);
  a.unmount();
});
