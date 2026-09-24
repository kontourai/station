// @vitest-environment jsdom

/**
 * #90 D9, the seam `FloatOverChat.test.tsx` stands in for: the REAL live
 * view inside the floater. Who controls the surface reaches the pill from
 * the canvas's own stream (its state record's lease), so the floater opens
 * no second stream and fetches no lease of its own; and in host-controls
 * mode the canvas drops its own controller line and Take control, so the
 * page shows one of each.
 */

import {
  encodeLiveSurfaceRecord,
  type LiveSurfaceControlLease,
} from '@kontourai/station-contracts/live-surface';
import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({ settings: {} }),
}));
vi.mock('../../contexts/useOpenInRegion', () => ({
  useOpenBrowserSessionInRegion: () => null,
  describeOpenInRegionRefusal: (reason: string) => reason,
}));

import FloatOverChat from '../FloatOverChat';
import { resetFloatStoreForTests } from '../floatStore';

const SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';
const SURFACE = 'browser:0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77:g1';
const FRAMES = `/api/live-surfaces/${encodeURIComponent(SURFACE)}/frames`;
const LEASE = `/api/live-surfaces/${encodeURIComponent(SURFACE)}/lease`;
const INPUT = `/api/live-surfaces/${encodeURIComponent(SURFACE)}/input`;

const SESSION_VIEW: BrowserSessionView = {
  browserSessionId: SESSION,
  projectId: 'p-alpha',
  projectSlug: 'alpha',
  principalKey: 'operator',
  reach: 'operator',
  threadId: 'conversation-1',
  url: 'https://example.com/',
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  generation: 1,
  state: 'live',
  createdAt: '2026-09-22T12:00:00.000Z',
  updatedAt: '2026-09-22T12:00:00.000Z',
  history: { entries: [], total: 0 },
  activity: {
    agentDriven: true,
    lastDriver: { kind: 'agent', sessionId: 'agent-1' },
  },
  surfaceId: SURFACE,
};

const ME = { principal: 'human:local:me', device: 'device:mine' };

function lease(
  holder: LiveSurfaceControlLease['holder'],
): LiveSurfaceControlLease {
  return {
    surfaceId: SURFACE,
    epoch: 3,
    holder,
    expiresAt: holder ? 9e12 : null,
  };
}

let push: (holder: LiveSurfaceControlLease['holder']) => Promise<void>;
let pushFrame: () => Promise<void>;
const calls: string[] = [];

function transport() {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/browser/projects/alpha/access')
      return Response.json({
        success: true,
        data: {
          projectId: 'p-alpha',
          role: 'operator',
          principalKey: 'operator',
          operator: true,
          browser: 'ready',
        },
      });
    if (url.pathname === INPUT)
      return Response.json({
        success: true,
        data: {
          ok: true,
          accepted: 1,
          lease: lease({ kind: 'human', ...ME }),
        },
      });
    if (url.pathname === '/api/browser/sessions')
      return Response.json({ success: true, data: [SESSION_VIEW] });
    if (url.pathname === FRAMES) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      init?.signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {}
      });
      push = async (holder) => {
        await act(async () => {
          controller.enqueue(
            encodeLiveSurfaceRecord({
              kind: 'state',
              state: {
                surfaceId: SURFACE,
                lease: lease(holder),
                effectiveParams: {
                  maxFps: 10,
                  quality: 70,
                  maxWidth: 1280,
                  maxHeight: 1280,
                },
                viewer: ME,
              },
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      pushFrame = async () => {
        await act(async () => {
          controller.enqueue(
            encodeLiveSurfaceRecord({
              kind: 'frame',
              header: {
                surfaceId: SURFACE,
                seq: 1,
                epoch: 3,
                codec: 'png',
                width: 1280,
                height: 800,
                deviceScaleFactor: 1,
                capturedAt: 1,
              },
              body: new Uint8Array([1]),
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      return new Response(stream, { status: 200 });
    }
    if (url.pathname === LEASE)
      return Response.json({
        success: true,
        data: { ok: true, lease: lease({ kind: 'human', ...ME }) },
      });
    return Response.json({ success: false }, { status: 404 });
  });
}

function chatArea() {
  const area = document.createElement('div');
  document.body.appendChild(area);
  area.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 900,
      height: 700,
      right: 900,
      bottom: 700,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return area;
}

beforeEach(() => {
  // A frame must be drawn before the live view takes any input at all, so
  // the "sends nothing" below is about the lease, not an undrawn canvas.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1280, height: 800, close() {} })),
  );
  vi.spyOn(
    HTMLCanvasElement.prototype,
    'getBoundingClientRect',
  ).mockReturnValue({
    left: 0,
    top: 0,
    width: 320,
    height: 200,
    right: 320,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  window.localStorage.clear();
  resetFloatStoreForTests();
  calls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('the agent indicator comes from the live view’s own lease, and Take control claims through it', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <FloatOverChat
        session={{
          id: 'tab-1',
          conversationId: 'conversation-1',
          projectSlug: 'alpha',
        }}
        transport={transport() as never}
      />
    </QueryClientProvider>,
    { container: chatArea() },
  );
  await screen.findByTestId('live-surface-canvas');
  await push({ kind: 'agent', principal: 'agent:x', sessionId: 'agent-1' });
  await pushFrame();
  const dot = await screen.findByRole('button', {
    name: 'Floating browser controls. An agent is driving.',
  });
  expect(dot.dataset.tone).toBe('agent');
  // Host controls: the canvas's own line and button are not drawn too.
  expect(
    screen.queryByText(
      'An agent is in control. Click or type to take control from it.',
    ),
  ).toBeNull();
  // B2: the floater is under the pointer and in the tab order by accident as
  // often as on purpose, so NOTHING goes to the page — not a hover, a wheel,
  // a click or a key — until Take control.
  const canvas = screen.getByTestId('live-surface-canvas');
  const keyboard = screen.getByLabelText(
    'Keyboard input for Browser: example.com',
  ) as HTMLTextAreaElement;
  expect(keyboard.tabIndex).toBe(-1);
  fireEvent.pointerMove(canvas, { clientX: 5, clientY: 5, pointerId: 1 });
  fireEvent.wheel(canvas, { clientX: 5, clientY: 5, deltaY: 50 });
  fireEvent.pointerDown(canvas, {
    clientX: 5,
    clientY: 5,
    button: 0,
    pointerId: 1,
  });
  fireEvent.pointerUp(canvas, {
    clientX: 5,
    clientY: 5,
    button: 0,
    pointerId: 1,
  });
  fireEvent.keyDown(keyboard, { key: 'Enter', code: 'Enter' });
  fireEvent.input(keyboard, { target: { value: 'x' } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls).not.toContain(`POST ${INPUT}`);
  fireEvent.click(dot);
  expect(
    within(screen.getByRole('toolbar', { name: 'Floating browser' })).getByText(
      'An agent is driving',
    ),
  ).toBeTruthy();
  const take = screen.getAllByRole('button', { name: 'Take control' });
  expect(take).toHaveLength(1);
  await act(async () => {
    fireEvent.click(take[0] as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls).toContain(`POST ${LEASE}`);
  // One stream for the surface: the pill read the canvas's, it opened none.
  expect(calls.filter((call) => call === `GET ${FRAMES}`)).toHaveLength(1);
  // The claim's lease is now the viewer's own: the indicator follows it.
  expect(
    screen.getByRole('button', {
      name: 'Floating browser controls. You are in control.',
    }).dataset.tone,
  ).toBe('you');
  // Now it is this viewer's to drive: the keyboard is reachable, and a click
  // reaches the page (the same gesture that sent nothing above).
  expect(keyboard.tabIndex).toBe(0);
  fireEvent.pointerDown(canvas, {
    clientX: 5,
    clientY: 5,
    button: 0,
    pointerId: 1,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls).toContain(`POST ${INPUT}`);
});
