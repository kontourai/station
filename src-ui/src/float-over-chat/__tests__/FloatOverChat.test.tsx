// @vitest-environment jsdom

/**
 * #90 D9: the float-over-chat against a fake Station's session list.
 *
 * The live view is replaced by a stand-in that reports a control state the
 * test chooses, through the SAME `onControlState` callback the real canvas
 * calls (the real canvas's side of that seam is pinned in
 * `FloatOverChat.canvas.test.tsx`). The region opener is a spy; the
 * opener's own placement is `openBrowserSessionInRegion.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({
  autoFloat: undefined as boolean | undefined,
  tone: 'agent' as 'you' | 'agent' | 'other' | 'none',
  claim: vi.fn(async () => {}),
  opener: vi.fn(),
  openerAvailable: true,
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({
    settings: { autoFloatAgentBrowserSessions: h.autoFloat },
  }),
}));
vi.mock('../../contexts/useOpenInRegion', () => ({
  useOpenBrowserSessionInRegion: () => (h.openerAvailable ? h.opener : null),
  describeOpenInRegionRefusal: (reason: string) => `Refused: ${reason}`,
}));
vi.mock('../../live-surface/LiveSurfaceCanvas', () => ({
  LiveSurfaceCanvas: (props: {
    surfaceId: string;
    hostControls?: boolean;
    inputRequiresLease?: boolean;
    onControlState?: (state: unknown) => void;
  }) => {
    const { onControlState } = props;
    useEffect(() => {
      onControlState?.({
        status: 'live',
        tone: h.tone,
        claimControl: h.claim,
      });
    }, [onControlState]);
    return (
      <div
        data-testid="float-canvas"
        data-surface={props.surfaceId}
        data-host-controls={String(Boolean(props.hostControls))}
        data-input-requires-lease={String(Boolean(props.inputRequiresLease))}
      />
    );
  },
}));

import FloatOverChat from '../FloatOverChat';
import {
  FLOAT_NARROW_WIDTH,
  FloatReadError as FloatReadErrorForTests,
  floatReadDelay,
} from '../FloatOverChatHost';
import { browserFloatSourceKey } from '../floatSource';
import { openFloat, resetFloatStoreForTests } from '../floatStore';
import { RECENT_AGENT_DRIVE_MS } from '../recentDriver';
import { announceShownSource } from '../shownSources';

const SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';
const OTHER = 'bs_11111111-2222-4333-8444-555555555555';
const SURFACE = 'browser:0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77:g1';
const AGENT = { kind: 'agent' as const, sessionId: 'agent-session-1' };

function session(
  overrides: Partial<BrowserSessionView> = {},
): BrowserSessionView {
  return {
    browserSessionId: SESSION,
    projectId: 'p-alpha',
    projectSlug: 'alpha',
    principalKey: 'operator',
    reach: 'operator',
    threadId: 'conversation-1',
    url: 'https://example.com/path',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    generation: 1,
    state: 'live',
    createdAt: '2026-09-22T12:00:00.000Z',
    updatedAt: '2026-09-22T12:00:00.000Z',
    history: { entries: [], total: 0 },
    activity: { agentDriven: true, lastDriver: AGENT },
    surfaceId: SURFACE,
    ...overrides,
  };
}

let sessions: BrowserSessionView[] = [];
/** How far the fake server's clock is from this device's. */
let serverSkewMs = 0;
/** Off: the fake server omits `serverNow` (an older server). */
let stampServerNow = true;
let client: QueryClient;
const released: Array<() => void> = [];

function rect(box: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * The chat body as a browser would lay it out: 900×700 by default, with the
 * composer stack docked below the floater's marker, 120px tall. The body is
 * the element the floater is rendered INTO, as `ChatDockBody` renders it: the
 * marker is its child, and the stack below the marker is the obstacle.
 */
function chatArea(
  size = { width: 900, height: 700 },
  composer = { height: 120 },
) {
  const area = document.createElement('div');
  document.body.appendChild(area);
  const layout = { size, composer };
  area.getBoundingClientRect = () => rect({ left: 0, top: 0, ...layout.size });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('float-over-chat__anchor')
        ? rect({
            left: 0,
            top: layout.size.height - layout.composer.height,
            width: layout.size.width,
            height: 0,
          })
        : rect({ left: 0, top: 0, width: 0, height: 0 });
    },
  );
  return { area, layout };
}

type Reply = { status: number; body?: unknown };
let accessReply: Reply;
let sessionsReplies: Reply[];

function renderFloat(
  area: HTMLElement,
  chat: {
    id?: string;
    conversationId?: string;
    currentSessionId?: string;
    projectSlug?: string;
  } = {},
) {
  // RTL's cleanup detaches a container it was handed; a re-render after one
  // puts the chat body back where the queries look.
  if (!area.isConnected) document.body.appendChild(area);
  const transport = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/browser/projects/alpha/access')
      return Response.json(accessReply.body ?? { success: false }, {
        status: accessReply.status,
      });
    if (
      url.pathname === '/api/browser/sessions' &&
      url.searchParams.get('projectSlug') === 'alpha'
    ) {
      const reply = sessionsReplies.shift();
      if (reply)
        return Response.json(reply.body ?? { success: false }, {
          status: reply.status,
        });
      // As the server does: every reply is stamped with ITS clock now (a
      // server `serverSkewMs` away from this device's).
      return Response.json({
        success: true,
        data: sessions.map((entry) =>
          stampServerNow
            ? {
                ...entry,
                serverNow: new Date(Date.now() + serverSkewMs).toISOString(),
              }
            : entry,
        ),
      });
    }
    return Response.json({ success: false }, { status: 404 });
  });
  const view = render(
    <QueryClientProvider client={client}>
      <FloatOverChat
        session={{
          id: chat.id ?? 'tab-1',
          conversationId:
            'conversationId' in chat ? chat.conversationId : 'conversation-1',
          currentSessionId: chat.currentSessionId,
          projectSlug: 'projectSlug' in chat ? chat.projectSlug : 'alpha',
        }}
        transport={transport as never}
      />
    </QueryClientProvider>,
    { container: area },
  );
  return { ...view, transport };
}

function calls(
  transport: ReturnType<typeof renderFloat>['transport'],
  path: string,
) {
  return transport.mock.calls.filter(
    ([input]) => new URL(String(input)).pathname === path,
  ).length;
}

function player() {
  return screen.queryByRole('region', {
    name: 'Floating browser: example.com',
  });
}

/** A poll: refetch, then let React Query's batched notify (a macrotask) land. */
async function refetch() {
  await act(async () => {
    await client.refetchQueries();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function openPill() {
  fireEvent.click(
    screen.getByRole('button', { name: /^Floating browser controls/ }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetFloatStoreForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  sessions = [session()];
  accessReply = {
    status: 200,
    body: {
      success: true,
      data: {
        projectId: 'p-alpha',
        role: 'operator',
        principalKey: 'operator',
        operator: true,
        browser: 'ready',
      },
    },
  };
  sessionsReplies = [];
  serverSkewMs = 0;
  stampServerNow = true;
  h.autoFloat = undefined;
  h.tone = 'agent';
  h.claim.mockClear();
  h.opener.mockReset();
  h.openerAvailable = true;
});

afterEach(() => {
  for (const release of released.splice(0)) release();
  cleanup();
  vi.restoreAllMocks();
  client.clear();
  document.body.innerHTML = '';
});

describe('auto-float', () => {
  test('a live session an agent drives in this Project floats over the chat, with the canvas in host-controls mode', async () => {
    const { area } = chatArea();
    renderFloat(area);
    const canvas = await screen.findByTestId('float-canvas');
    expect(canvas.dataset.surface).toBe(SURFACE);
    expect(canvas.dataset.hostControls).toBe('true');
    // Nothing reaches the page until an explicit Take control (#90 D9 B2);
    // that the canvas honours it is `LiveSurfaceCanvas.test.tsx`'s.
    expect(canvas.dataset.inputRequiresLease).toBe('true');
    // It is mounted INSIDE the chat body it floats over.
    expect(area.contains(player())).toBe(true);
  });

  test('turning the setting off stops it (the tests above run with it unset: on by default)', async () => {
    h.autoFloat = false;
    const { area } = chatArea();
    const { transport } = renderFloat(area);
    // Long enough for a read, its batched notify and the float to land, had
    // any been started (the same flush `refetch()` needs).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(player()).toBeNull();
    // With nothing floating and auto-float off, the list is not even read.
    expect(transport).not.toHaveBeenCalled();
  });

  test('only a live session whose latest driver is an agent, in this Project, floats', async () => {
    sessions = [
      session({
        activity: { agentDriven: true, lastDriver: { kind: 'operator' } },
      }),
      session({
        browserSessionId: OTHER,
        projectSlug: 'beta',
        projectId: 'p-beta',
      }),
    ];
    const { area } = chatArea();
    const { transport } = renderFloat(area);
    await waitFor(() => expect(transport).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(player()).toBeNull();
    // The same session once an agent drives it again: it floats.
    sessions = [session()];
    await refetch();
    await waitFor(() => expect(player()).not.toBeNull());
  });

  test('a chat without a Project floats nothing and reads nothing', async () => {
    const { area } = chatArea();
    const { transport } = renderFloat(area, { projectSlug: undefined });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(player()).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  test('a session the user closed in this conversation is never floated there again, even after a reload', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    fireEvent.click(
      screen.getByRole('button', { name: 'Close floating browser' }),
    );
    expect(player()).toBeNull();
    // The agent keeps driving it: still not re-floated here.
    sessions = [session({ updatedAt: '2026-09-22T12:05:00.000Z' })];
    await refetch();
    expect(player()).toBeNull();
    // A reload: memory is gone, the device's record is not.
    cleanup();
    resetFloatStoreForTests();
    renderFloat(area);
    await refetch();
    expect(player()).toBeNull();
    // Another conversation never dismissed its own.
    cleanup();
    sessions = [session({ threadId: 'conversation-2' })];
    renderFloat(area, { id: 'tab-2', conversationId: 'conversation-2' });
    await screen.findByTestId('float-canvas');
  });

  test('a session closed before the chat gets its conversation id stays closed after it does (SF1)', async () => {
    // A brand-new chat: keyed by its tab id until the server names the
    // conversation. The agent's browser session carries that tab id.
    sessions = [session({ threadId: 'tab-1' })];
    const { area } = chatArea();
    const { rerender, transport } = renderFloat(area, {
      conversationId: undefined,
    });
    await screen.findByTestId('float-canvas');
    openPill();
    fireEvent.click(
      screen.getByRole('button', { name: 'Close floating browser' }),
    );
    expect(player()).toBeNull();
    // The first reply lands: the chat now has its conversation id.
    rerender(
      <QueryClientProvider client={client}>
        <FloatOverChat
          session={{
            id: 'tab-1',
            conversationId: 'conversation-1',
            projectSlug: 'alpha',
          }}
          transport={transport as never}
        />
      </QueryClientProvider>,
    );
    await refetch();
    expect(player()).toBeNull();
    // Recorded under the conversation now, so a reload keeps it too.
    expect(
      JSON.parse(
        window.localStorage.getItem('station:float-over-chat:dismissed:v1') ??
          'null',
      ),
    ).toEqual({ 'conversation-1': [browserFloatSourceKey(SESSION)] });
  });

  test('the floater goes away with its session, and that is not a dismissal', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    sessions = [session({ state: 'closed', surfaceId: undefined })];
    await refetch();
    expect(player()).toBeNull();
    sessions = [session()];
    await refetch();
    await screen.findByTestId('float-canvas');
  });
});

describe('hidden while the same source is in a pane', () => {
  test('a pane showing the session hides the floater and unmounts its live view; closing the pane brings it back', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    let release = () => {};
    act(() => {
      release = announceShownSource(browserFloatSourceKey(SESSION));
    });
    released.push(release);
    expect(player()).toBeNull();
    expect(screen.queryByTestId('float-canvas')).toBeNull();
    act(() => release());
    expect(await screen.findByTestId('float-canvas')).toBeTruthy();
  });

  test('a pane showing ANOTHER session does not hide it', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    act(() => {
      released.push(announceShownSource(browserFloatSourceKey(OTHER)));
    });
    expect(player()).not.toBeNull();
  });

  test('auto-float skips a session a pane already shows, and floats the next one instead', async () => {
    // The newest agent session is on screen in a pane; an older one an agent
    // also drives is shown nowhere. The one floater is for the one nobody
    // can see — not a hidden float of the one everybody can.
    sessions = [
      session({ updatedAt: '2026-09-22T12:10:00.000Z' }),
      session({
        browserSessionId: OTHER,
        url: 'https://other.example/',
        surfaceId: 'browser:11111111-2222-4333-8444-555555555555:g1',
      }),
    ];
    act(() => {
      released.push(announceShownSource(browserFloatSourceKey(SESSION)));
    });
    const { area } = chatArea();
    renderFloat(area);
    const canvas = await screen.findByTestId('float-canvas');
    expect(canvas.dataset.surface).toBe(
      'browser:11111111-2222-4333-8444-555555555555:g1',
    );
    expect(player()).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Floating browser: other.example' }),
    ).toBeTruthy();
  });
});

describe('the control indicator', () => {
  test('an agent holding the lease tints the dot and the pill says so, with Take control', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    const dot = screen.getByRole('button', {
      name: 'Floating browser controls. An agent is driving.',
    });
    expect(dot.dataset.tone).toBe('agent');
    openPill();
    expect(
      within(
        screen.getByRole('toolbar', { name: 'Floating browser' }),
      ).getByText('An agent is driving'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  test('holding control yourself: no Take control, and the dot is not the agent tint', async () => {
    h.tone = 'you';
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    const dot = screen.getByRole('button', {
      name: 'Floating browser controls. You are in control.',
    });
    expect(dot.dataset.tone).toBe('you');
    openPill();
    expect(
      within(
        screen.getByRole('toolbar', { name: 'Floating browser' }),
      ).getByText('You are in control'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
  });
});

/**
 * A session whose agent's last input the server recorded `agoMs` before it
 * sent the list. `skewMs` is how far the SERVER's clock is from this
 * device's: every server timestamp carries it, as a skewed server would.
 */
function drivenAgo(agoMs: number, skewMs = 0): BrowserSessionView {
  serverSkewMs = skewMs;
  const serverNow = Date.now() + skewMs;
  return session({
    activity: {
      agentDriven: true,
      lastDriver: AGENT,
      lastAgentInputAt: new Date(serverNow - agoMs).toISOString(),
    },
  });
}

function pillText() {
  return screen
    .getByRole('toolbar', { name: 'Floating browser' })
    .querySelector('.float-over-chat__controller')?.textContent;
}

describe('who is driving, when no one holds the lease (owner decision, D9)', () => {
  test('an agent that just acted reads as driving, and Take control still works', async () => {
    h.tone = 'none';
    sessions = [drivenAgo(1_000)];
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    const dot = screen.getByRole('button', {
      name: 'Floating browser controls. An agent is driving.',
    });
    expect(dot.dataset.tone).toBe('agent');
    openPill();
    expect(pillText()).toBe('An agent is driving');
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  test('the window lapses on its own: back to "No one is in control" with no new event', async () => {
    h.tone = 'none';
    // Inside the window by 2 s when rendered. The lapse must land BEFORE the
    // list's next poll (5 s after mount), so only the lapse timer can have
    // re-derived it: a poll re-render would read the clock afresh and hide
    // a missing timer.
    sessions = [drivenAgo(RECENT_AGENT_DRIVE_MS - 2_000)];
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    expect(pillText()).toBe('An agent is driving');
    await waitFor(() => expect(pillText()).toBe('No one is in control'), {
      timeout: 3_500,
    });
    expect(
      screen.getByRole('button', {
        name: 'Floating browser controls. No one is in control.',
      }),
    ).toBeTruthy();
  });

  test.each([
    ['60 s ahead of', 60_000],
    ['60 s behind', -60_000],
  ])(
    'a server clock %s this device: still driving for the window, and it lapses on time',
    async (_how, skewMs) => {
      h.tone = 'none';
      // Same shape as the lapse test: 2 s of window left when the list arrives.
      sessions = [drivenAgo(RECENT_AGENT_DRIVE_MS - 2_000, skewMs)];
      const { area } = chatArea();
      renderFloat(area);
      await screen.findByTestId('float-canvas');
      openPill();
      expect(pillText()).toBe('An agent is driving');
      const shownAt = performance.now();
      await waitFor(() => expect(pillText()).toBe('No one is in control'), {
        timeout: 3_500,
      });
      // Not early either: it held for a good part of the 2 s it had left.
      expect(performance.now() - shownAt).toBeGreaterThan(500);
    },
  );

  test('an agent input 2 s ago, then a person taking over: neither the pill nor the narrow notice says an agent is driving (L1)', async () => {
    h.tone = 'none';
    const tookOver = drivenAgo(2_000);
    sessions = [
      {
        ...tookOver,
        activity: { ...tookOver.activity!, lastDriver: { kind: 'operator' } },
      },
    ];
    // Already floating in this chat (a person's session no longer
    // auto-floats, and the question is what the open floater says).
    const floated = () =>
      openFloat('conversation-1', {
        kind: 'browser',
        browserSessionId: SESSION,
        surfaceId: SURFACE,
      });
    floated();
    const wide = chatArea();
    renderFloat(wide.area);
    await screen.findByTestId('float-canvas');
    openPill();
    expect(pillText()).toBe('No one is in control');
    cleanup();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    resetFloatStoreForTests();
    client.clear();
    floated();
    const narrow = chatArea({ width: 320, height: 600 }, { height: 100 });
    renderFloat(narrow.area);
    const region = await screen.findByRole('region', {
      name: 'Floating browser: example.com',
    });
    expect(region.textContent).toContain('A browser is open at example.com.');
  });

  test('remounting from cached data judges it by when it ARRIVED, not by the remount (L2)', async () => {
    h.tone = 'none';
    sessions = [drivenAgo(RECENT_AGENT_DRIVE_MS - 1_500)];
    const first = chatArea();
    const view = renderFloat(first.area);
    await screen.findByTestId('float-canvas');
    expect(
      screen.getByRole('button', {
        name: 'Floating browser controls. An agent is driving.',
      }),
    ).toBeTruthy();
    view.unmount();
    cleanup();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    // Past the window while unmounted; the query client keeps the list.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    renderFloat(chatArea().area);
    await screen.findByTestId('float-canvas');
    expect(
      screen.getByRole('button', {
        name: 'Floating browser controls. No one is in control.',
      }),
    ).toBeTruthy();
  });

  test('a server that sends no serverNow never shows an agent driving from the window (L2)', async () => {
    h.tone = 'none';
    stampServerNow = false;
    sessions = [drivenAgo(1_000)];
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    expect(pillText()).toBe('No one is in control');
  });

  test('a person holding the lease is who is in control, whatever the agent did a moment ago', async () => {
    h.tone = 'you';
    sessions = [drivenAgo(1_000)];
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    expect(pillText()).toBe('You are in control');
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
  });

  test.each([
    ['just now', 1_000, 'An agent is driving', 'An agent is driving a browser'],
    [
      'past the window',
      RECENT_AGENT_DRIVE_MS + 5_000,
      'No one is in control',
      'A browser is open',
    ],
  ])(
    'the pill and the narrow notice agree for an agent that acted %s',
    async (_when, agoMs, pill, notice) => {
      h.tone = 'none';
      sessions = [drivenAgo(agoMs)];
      const wide = chatArea();
      renderFloat(wide.area);
      await screen.findByTestId('float-canvas');
      openPill();
      expect(pillText()).toBe(pill);
      cleanup();
      document.body.innerHTML = '';
      vi.restoreAllMocks();
      resetFloatStoreForTests();
      client.clear();
      const narrow = chatArea({ width: 320, height: 600 }, { height: 100 });
      renderFloat(narrow.area);
      const region = await screen.findByRole('region', {
        name: 'Floating browser: example.com',
      });
      expect(region.textContent).toContain(`${notice} at example.com.`);
    },
  );
});

describe('pill actions', () => {
  test('Open in right panel opens the Browser pane attached to this session and steps aside, without dismissing it', async () => {
    h.opener.mockReturnValue({
      ok: true,
      region: 'right',
      surfaceId: 'browser-preview:x',
      existing: false,
    });
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open in right panel' }),
    );
    expect(h.opener).toHaveBeenCalledWith(
      { projectId: 'p-alpha', browserSessionId: SESSION },
      { region: 'right' },
    );
    expect(player()).toBeNull();
    // The pane now shows it: polls keep the floater away while it does.
    let release = () => {};
    act(() => {
      release = announceShownSource(browserFloatSourceKey(SESSION));
    });
    released.push(release);
    await refetch();
    expect(player()).toBeNull();
    // Closing that pane is not "never float this here": an agent still
    // driving it, shown nowhere, floats again.
    act(() => release());
    await refetch();
    expect(await screen.findByTestId('float-canvas')).toBeTruthy();
  });

  test('a pane that never shows the handed-off session does not keep it from floating for good', async () => {
    h.opener.mockReturnValue({
      ok: true,
      region: 'right',
      surfaceId: 'browser-preview:x',
      existing: false,
    });
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open in right panel' }),
    );
    await refetch();
    expect(player()).toBeNull();
    // Past the grace period with no pane having shown it.
    const later = Date.now() + 16_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await refetch();
    expect(await screen.findByTestId('float-canvas')).toBeTruthy();
  });

  test('a device without a right region falls back to the pane’s own placement', async () => {
    h.opener
      .mockReturnValueOnce({ ok: false, reason: 'region-unavailable' })
      .mockReturnValueOnce({
        ok: true,
        region: 'bottom',
        surfaceId: 'browser-preview:x',
        existing: false,
      });
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open in right panel' }),
    );
    expect(h.opener).toHaveBeenLastCalledWith({
      projectId: 'p-alpha',
      browserSessionId: SESSION,
    });
    expect(player()).toBeNull();
  });

  test('a refused open says why and keeps the floater', async () => {
    h.opener.mockReturnValue({ ok: false, reason: 'refused' });
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open in right panel' }),
    );
    expect(screen.getByRole('status').textContent).toBe('Refused: refused');
    expect(player()).not.toBeNull();
  });

  test('with no region model mounted, Open in right panel is disabled rather than inert', async () => {
    h.openerAvailable = false;
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    const open = screen.getByRole('button', {
      name: 'Open in right panel',
    }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
  });
});

describe('placement, keyboard and narrow widths', () => {
  function frameOf() {
    const section = player() as HTMLElement;
    return {
      x: Number.parseFloat(section.style.left),
      y: Number.parseFloat(section.style.top),
      width: Number.parseFloat(section.style.width),
      height: Number.parseFloat(section.style.height),
    };
  }

  test('opens top-right at 320 wide for a 16:10 page, 12px from the edges', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    expect(frameOf()).toEqual({
      x: 900 - 12 - 320,
      y: 12,
      width: 320,
      height: 200,
    });
  });

  test('the composer is measured live: moved down onto it, the player stops above it, and follows it when it grows', async () => {
    const { area, layout } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    const handle = screen.getByRole('button', {
      name: /^Move floating browser/,
    });
    for (let i = 0; i < 60; i += 1)
      fireEvent.keyDown(handle, { key: 'ArrowDown' });
    const parked = frameOf();
    // 700 tall, composer 120: the player's bottom stops 12px above it.
    expect(parked.y + parked.height).toBe(700 - 120 - 12);
    // A draft grows the composer to 300: the player moves up with it.
    layout.composer = { ...layout.composer, height: 300 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const lifted = frameOf();
    expect(lifted.y + lifted.height).toBe(700 - 300 - 12);
  });

  test('keyboard: focus opens the pill, Escape closes it and returns focus to the dot', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    const dot = screen.getByRole('button', {
      name: /^Floating browser controls/,
    });
    act(() => dot.focus());
    expect(dot.getAttribute('aria-expanded')).toBe('true');
    const handle = screen.getByRole('button', {
      name: /^Move floating browser/,
    });
    act(() => handle.focus());
    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(dot.getAttribute('aria-expanded')).toBe('false');
    // It names no element that is not there.
    expect(dot.getAttribute('aria-controls')).toBeNull();
    expect(document.activeElement).toBe(dot);
    expect(
      screen.queryByRole('toolbar', { name: 'Floating browser' }),
    ).toBeNull();
  });

  test('keyboard: Enter or Space on the focused dot keeps the pill open (focus already opened it)', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    const dot = screen.getByRole('button', {
      name: /^Floating browser controls/,
    });
    act(() => dot.focus());
    expect(dot.getAttribute('aria-expanded')).toBe('true');
    // A button's Enter and Space ARE a click: jsdom does not synthesize one
    // from the key, so the click is what is fired.
    fireEvent.keyDown(dot, { key: 'Enter' });
    fireEvent.click(dot);
    expect(dot.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(dot, { key: ' ' });
    fireEvent.click(dot);
    expect(dot.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByRole('toolbar', { name: 'Floating browser' }),
    ).toBeTruthy();
    // aria-controls names the pill only while it exists.
    expect(dot.getAttribute('aria-controls')).toBe(
      screen.getByRole('toolbar', { name: 'Floating browser' }).id,
    );
  });

  test('a chat too tight for the minimum shows a smaller player, but never REMEMBERS the smaller size: room back, size back', async () => {
    const { area, layout } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    const handle = screen.getByRole('button', {
      name: /^Move floating browser/,
    });
    // The user moves it off the right edge and sizes it to 400 (Shift+Right,
    // five steps from 320; the right edge anchors a fresh player).
    for (let i = 0; i < 10; i += 1)
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    for (let i = 0; i < 5; i += 1)
      fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(frameOf().width).toBe(400);
    // The dock shrinks: 260 tall, 120 of it composer. The player shrinks too.
    layout.size = { width: 900, height: 260 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const tight = frameOf();
    expect(tight.width).toBeLessThan(240);
    // Moving it in the tight chat, and even shrinking it, does not store a
    // size below the minimum, nor lose the 400 the user chose.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    const afterMove = JSON.parse(
      window.localStorage.getItem('station:float-over-chat:frame:v1') ?? 'null',
    );
    expect(afterMove.width).toBe(400);
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    const afterShrink = JSON.parse(
      window.localStorage.getItem('station:float-over-chat:frame:v1') ?? 'null',
    );
    expect(afterShrink.width).toBeGreaterThanOrEqual(240);
    // Room returns: so does a size the user chose, not the tight one.
    layout.size = { width: 900, height: 700 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(frameOf().width).toBeGreaterThanOrEqual(240);
  });

  test('keyboard: arrows move it one step and Shift+arrows resize it aspect-locked; the place is kept for this device', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    const handle = screen.getByRole('button', {
      name: /^Move floating browser/,
    });
    const start = frameOf();
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(frameOf()).toEqual({ ...start, x: start.x - 16 });
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(frameOf().width).toBe(304);
    expect(frameOf().height).toBe(190);
    const stored = JSON.parse(
      window.localStorage.getItem('station:float-over-chat:frame:v1') ?? 'null',
    );
    expect(stored).toEqual({
      width: 304,
      position: { x: start.x - 16, y: 12 },
    });
    // A reload keeps the place.
    cleanup();
    resetFloatStoreForTests();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    expect(frameOf()).toMatchObject({ x: start.x - 16, width: 304 });
  });

  test('the pill’s controls carry the 44px target rule (structural: jsdom lays nothing out)', async () => {
    const { area } = chatArea();
    renderFloat(area);
    await screen.findByTestId('float-canvas');
    openPill();
    for (const name of [
      /^Move floating browser/,
      /^Open in right panel$/,
      /^Close floating browser$/,
      /^Take control$/,
    ]) {
      const control = screen.getByRole('button', { name });
      expect(control.className, String(name)).toMatch(
        /float-over-chat__(handle|action)/,
      );
    }
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../FloatOverChat.css'),
      'utf8',
    );
    expect(css).toMatch(
      /\.float-over-chat__handle \{[^}]*height: 44px;[^}]*min-width: 44px;/,
    );
    expect(css).toMatch(
      /\.float-over-chat__action \{[^}]*min-height: 44px;[^}]*min-width: 44px;/,
    );
  });

  test(`below ${FLOAT_NARROW_WIDTH}px the chat gets a notice with the same actions instead of a player`, async () => {
    sessions = [
      session({
        activity: {
          agentDriven: true,
          lastDriver: AGENT,
          lastAgentInputAt: new Date().toISOString(),
        },
      }),
    ];
    const { area } = chatArea({ width: 320, height: 600 }, { height: 100 });
    renderFloat(area);
    const notice = await screen.findByRole('region', {
      name: 'Floating browser: example.com',
    });
    expect(notice.className).toBe('float-over-chat__narrow');
    expect(notice.textContent).toContain(
      'An agent is driving a browser at example.com. The chat is too narrow to float it here.',
    );
    // It stays off the composer stack too: its height is bounded to the rows
    // above it (600 − 100 composer − 2 × 12), and it scrolls within them.
    expect(notice.style.maxHeight).toBe('476px');
    // No live view: nothing streams to a player nobody could use.
    expect(screen.queryByTestId('float-canvas')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(
      screen.queryByRole('region', { name: 'Floating browser: example.com' }),
    ).toBeNull();
  });
});

describe('which sessions float here, and how the list is read', () => {
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  test('only a session opened from THIS conversation floats; one with no thread, or another chat’s, never does', async () => {
    sessions = [
      session({ threadId: undefined }),
      session({ browserSessionId: OTHER, threadId: 'another-chat' }),
    ];
    const { area } = chatArea();
    const { transport } = renderFloat(area);
    await waitFor(() =>
      expect(calls(transport, '/api/browser/sessions')).toBeGreaterThan(0),
    );
    await settle();
    expect(player()).toBeNull();
    // The execution session under this chat is this chat's thread too.
    sessions = [session({ threadId: 'exec-7' })];
    cleanup();
    renderFloat(area, { currentSessionId: 'exec-7' });
    expect(await screen.findByTestId('float-canvas')).toBeTruthy();
  });

  test('another principal’s session never floats to this viewer, even when the list shows it', async () => {
    sessions = [session({ principalKey: 'project-admin:someone-else' })];
    const { area } = chatArea();
    const { transport } = renderFloat(area);
    await waitFor(() =>
      expect(calls(transport, '/api/browser/sessions')).toBeGreaterThan(0),
    );
    await settle();
    expect(player()).toBeNull();
  });

  test.each([
    [403, 'not the operator or a Project admin'],
    [404, 'no browser on this Station'],
  ])(
    'an access answer of %i (%s) means the list is never read and nothing floats',
    async (status) => {
      accessReply = { status, body: { success: false, code: 'x' } };
      const { area } = chatArea();
      const { transport } = renderFloat(area);
      await waitFor(() =>
        expect(
          calls(transport, '/api/browser/projects/alpha/access'),
        ).toBeGreaterThan(0),
      );
      await settle();
      expect(calls(transport, '/api/browser/sessions')).toBe(0);
      expect(player()).toBeNull();
    },
  );

  test('a transient failure of the list is not the end: the next read that succeeds floats it', async () => {
    sessionsReplies = [{ status: 500 }, { status: 502 }];
    const { area } = chatArea();
    const { transport } = renderFloat(area);
    await waitFor(() =>
      expect(calls(transport, '/api/browser/sessions')).toBe(1),
    );
    await settle();
    expect(player()).toBeNull();
    await refetch();
    expect(player()).toBeNull();
    await refetch();
    expect(await screen.findByTestId('float-canvas')).toBeTruthy();
  });

  test('the read schedule: a 403 or 404 stops, anything else backs off to a minute, a success keeps its cadence', () => {
    const forbidden = new FloatReadErrorForTests(403);
    expect(floatReadDelay(forbidden, 1, 5_000)).toBe(false);
    expect(floatReadDelay(new FloatReadErrorForTests(404), 1, 5_000)).toBe(
      false,
    );
    const flaky = new FloatReadErrorForTests(503);
    expect(floatReadDelay(flaky, 1, 5_000)).toBe(5_000);
    expect(floatReadDelay(flaky, 2, 5_000)).toBe(10_000);
    expect(floatReadDelay(flaky, 3, 5_000)).toBe(20_000);
    expect(floatReadDelay(flaky, 10, 5_000)).toBe(60_000);
    // A network failure (no status at all) is transient too.
    expect(floatReadDelay(new TypeError('fetch failed'), 1, false)).toBe(5_000);
    expect(floatReadDelay(null, 0, 5_000)).toBe(5_000);
    expect(floatReadDelay(null, 0, false)).toBe(false);
  });
});
