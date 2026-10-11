/** @vitest-environment jsdom */

/**
 * The Browser pane's page tools (#90): a dialog held for the person in
 * control is answered from the pane; the control line says who drives (the
 * float-over-chat's rule and words) and hands control back; the console
 * drawer reads the page's console incrementally and says what was dropped;
 * a screenshot can be saved.
 *
 * The live canvas is replaced by a stand-in that reports a control state
 * the test sets, exactly as the real canvas reports its lease reading.
 */
import type {
  BrowserConsoleView,
  BrowserSessionView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LiveSurfaceControlState } from '../../../live-surface/LiveSurfaceCanvas';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

const controlHolder: { state: LiveSurfaceControlState | null } = {
  state: null,
};
vi.mock('../../../live-surface/LiveSurfaceCanvas', () => ({
  LiveSurfaceCanvas: (props: {
    onControlState?: (state: LiveSurfaceControlState) => void;
  }) => {
    const { onControlState } = props;
    useEffect(() => {
      if (controlHolder.state) onControlState?.(controlHolder.state);
    }, [onControlState]);
    return <div data-testid="live-canvas" />;
  },
}));

import { mergeConsoleRead } from '../BrowserConsoleDrawer';
import BrowserPane from '../BrowserPane';

const SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';
const SUMMARY = `GET /api/browser/sessions/${SESSION}?view=summary`;

function sessionView(
  overrides: Partial<BrowserSessionView> = {},
): BrowserSessionView {
  return {
    browserSessionId: SESSION,
    projectId: 'p-alpha',
    projectSlug: 'alpha',
    principalKey: 'operator',
    reach: 'operator',
    url: 'https://shop.example.com/cart',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    generation: 1,
    state: 'live',
    createdAt: '2026-09-22T12:00:00.000Z',
    updatedAt: '2026-09-22T12:00:00.000Z',
    history: { entries: [], total: 0 },
    activity: { agentDriven: false },
    surfaceId: 'browser:0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77:g1',
    ...overrides,
  };
}

type Answer = Response | { status?: number; body: unknown };
type Route = (body: unknown) => Answer;

function station(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const transport = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = `${url.pathname}${url.search}`;
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    if (!route)
      return new Response(JSON.stringify({ success: false, code: 'nope' }), {
        status: 599,
      });
    const answer = route(body);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
    });
  });
  return { transport, calls };
}

const ok = (data: unknown) => () => ({ body: { success: true, data } });
const ACCESS = ok({
  projectId: 'p-alpha',
  role: 'operator',
  operator: true,
  browser: 'ready',
});

function control(
  overrides: Partial<LiveSurfaceControlState> = {},
): LiveSurfaceControlState {
  return {
    status: 'live',
    tone: 'none',
    claimControl: vi.fn(async () => {}),
    releaseControl: vi.fn(async () => {}),
    keepControlAlive: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderPane(routes: Record<string, Route>) {
  const fake = station({
    'GET /api/browser/projects/alpha/access': ACCESS,
    ...routes,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BrowserPane
        projectSlug="alpha"
        target={{ kind: 'session', browserSessionId: SESSION }}
        onAttach={vi.fn()}
        transport={fake.transport as never}
      />
    </QueryClientProvider>,
  );
  return fake;
}

/** Choose an item from the ⋯ menu once the session has enabled it. */
async function chooseFromMenu(name: string) {
  fireEvent.click(
    await screen.findByRole('button', { name: 'More browser actions' }),
  );
  let item = await screen.findByRole('menuitem', { name });
  if ((item as HTMLButtonElement).disabled) {
    // Opened before the session loaded: reopen once it has.
    fireEvent.keyDown(document, { key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    fireEvent.click(
      await screen.findByRole('button', { name: 'More browser actions' }),
    );
    item = await screen.findByRole('menuitem', { name });
  }
  expect((item as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(item);
}

/** Click a tool once the session has loaded and enabled it. */
async function clickWhenEnabled(name: string) {
  const button = (await screen.findByRole('button', {
    name,
  })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  controlHolder.state = null;
});

describe('a dialog held for the person in control', () => {
  test("a prompt is shown with the page's host and message, pre-filled, and the typed answer is sent", async () => {
    controlHolder.state = control({ tone: 'you' });
    let answered = false;
    const fake = renderPane({
      [SUMMARY]: () => ({
        body: {
          success: true,
          data: sessionView(
            answered
              ? {}
              : {
                  pendingDialog: {
                    dialogId: 'd3',
                    type: 'prompt',
                    message: 'Coupon code?',
                    defaultPrompt: 'SAVE10',
                    openedAt: '2026-09-22T12:00:01.000Z',
                  },
                },
          ),
        },
      }),
      [`POST /api/browser/sessions/${SESSION}/dialog`]: () => {
        answered = true;
        return { body: { success: true, data: sessionView() } };
      },
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('shop.example.com says')).toBeTruthy();
    expect(within(dialog).getByText('Coupon code?')).toBeTruthy();
    const input = within(dialog).getByRole('textbox', {
      name: 'Your answer',
    }) as HTMLInputElement;
    expect(input.value).toBe('SAVE10');
    // It takes focus: the page is waiting on it.
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'WELCOME' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(
      fake.calls.find((call) => call.path.endsWith('/dialog'))?.body,
    ).toEqual({ dialogId: 'd3', accept: true, promptText: 'WELCOME' });
  });

  test('a confirm offers Cancel, which dismisses it (and so does Escape); an alert offers only OK', async () => {
    controlHolder.state = control({ tone: 'you' });
    let dialog: BrowserSessionView['pendingDialog'] = {
      dialogId: 'd1',
      type: 'confirm',
      message: 'Remove item?',
      openedAt: '2026-09-22T12:00:01.000Z',
    };
    const fake = renderPane({
      [SUMMARY]: () => ({
        body: {
          success: true,
          data: sessionView(dialog ? { pendingDialog: dialog } : {}),
        },
      }),
      [`POST /api/browser/sessions/${SESSION}/dialog`]: () => {
        dialog =
          dialog?.dialogId === 'd1'
            ? {
                dialogId: 'd2',
                type: 'alert',
                message: 'Removed.',
                openedAt: '2026-09-22T12:00:02.000Z',
              }
            : undefined;
        return {
          body: {
            success: true,
            data: sessionView(dialog ? { pendingDialog: dialog } : {}),
          },
        };
      },
    });
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.keyDown(confirm, { key: 'Escape' });
    const alert = await screen.findByText('Removed.');
    const alertDialog = alert.closest('[role="alertdialog"]') as HTMLElement;
    expect(
      within(alertDialog).queryByRole('button', { name: 'Cancel' }),
    ).toBeNull();
    fireEvent.click(within(alertDialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(
      fake.calls
        .filter((call) => call.path.endsWith('/dialog'))
        .map((call) => call.body),
    ).toEqual([
      { dialogId: 'd1', accept: false },
      { dialogId: 'd2', accept: true },
    ]);
  });
});

describe('the control line and the hand-back', () => {
  test('a person holding control after an agent drove can hand it back; the release goes through the canvas', async () => {
    const state = control({ tone: 'you' });
    controlHolder.state = state;
    renderPane({
      [SUMMARY]: ok(sessionView({ activity: { agentDriven: true } })),
    });
    expect(await screen.findByText('You are in control')).toBeTruthy();
    // No separate Take control: a click on the page takes it.
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
    // The chip says "You" and opens the hand-back.
    const chip = await screen.findByRole('button', {
      name: 'You are in control. Control options',
    });
    expect(chip.textContent).toBe('You');
    fireEvent.click(chip);
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Hand back to agent' }),
    );
    expect(state.releaseControl).toHaveBeenCalledTimes(1);
  });

  test('no agent ever drove: the same action is plain "Release control"; and it waits while a dialog is open', async () => {
    controlHolder.state = control({ tone: 'you' });
    renderPane({
      [SUMMARY]: ok(
        sessionView({
          pendingDialog: {
            dialogId: 'd1',
            type: 'alert',
            message: 'hi',
            openedAt: '2026-09-22T12:00:01.000Z',
          },
        }),
      ),
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'You are in control. Control options',
      }),
    );
    const release = (await screen.findByRole('menuitem', {
      name: 'Release control',
    })) as HTMLButtonElement;
    expect(release.disabled).toBe(true);
    expect(release.title).toMatch(/dialog first/);
  });

  test.each([
    { coarse: false, action: 'Click' },
    { coarse: true, action: 'Tap' },
  ])(
    'recent Agent activity shows a $action takeover hint without claiming control',
    async ({ coarse, action }) => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: coarse && query === '(pointer: coarse)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      const state = control({ tone: 'none' });
      controlHolder.state = state;
      renderPane({
        [SUMMARY]: ok(
          sessionView({
            serverNow: '2026-09-22T12:00:03.000Z',
            activity: {
              agentDriven: true,
              lastDriver: { kind: 'agent', sessionId: 'agent-1' },
              lastAgentInputAt: '2026-09-22T12:00:01.000Z',
            },
          }),
        ),
      });
      expect(await screen.findByText('An agent is driving')).toBeTruthy();
      // One word on the chip, and the page says how to take over.
      expect(
        screen.getByText(`${action} anywhere to take over from the agent`),
      ).toBeTruthy();
      expect(
        screen.getByTitle(
          `An agent is driving. ${action} the page to take over.`,
        ),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
      expect(
        screen.queryByRole('button', { name: /Control options/ }),
      ).toBeNull();
      expect(state.claimControl).not.toHaveBeenCalled();
    },
  );
});

describe('the console drawer', () => {
  const entry = (
    seq: number,
    level: 'error' | 'warning' | 'info' | 'debug',
    text: string,
    extra: object = {},
  ) => ({ seq, at: 1, level, source: 'console' as const, text, ...extra });

  test('reads incrementally, shows levels and locations, filters by level, and says how many were dropped', async () => {
    controlHolder.state = control();
    const first: BrowserConsoleView = {
      entries: [
        entry(8, 'info', 'booted', {
          url: 'https://shop.example.com/app.js',
          line: 12,
        }),
        entry(9, 'error', 'TypeError: x is undefined', {
          source: 'exception',
        }),
      ],
      dropped: 7,
      latestSeq: 9,
      generation: 1,
      capturing: true,
    };
    const fake = renderPane({
      [SUMMARY]: ok(sessionView()),
      [`GET /api/browser/sessions/${SESSION}/console`]: ok(first),
      [`GET /api/browser/sessions/${SESSION}/console?after=9`]: ok({
        entries: [entry(10, 'warning', 'slow request')],
        dropped: 7,
        latestSeq: 10,
        generation: 1,
        capturing: true,
      }),
    });
    await clickWhenEnabled('Console');
    const list = await screen.findByRole('list', { name: 'Console messages' });
    expect(within(list).getByText('booted')).toBeTruthy();
    expect(
      within(list).getByText('https://shop.example.com/app.js:12'),
    ).toBeTruthy();
    expect(within(list).getByText('Uncaught')).toBeTruthy();
    expect(
      screen.getByText(
        '7 older messages were dropped: the console keeps the latest 500.',
      ),
    ).toBeTruthy();
    // The next read asks only for what is newer, and appends it.
    await waitFor(
      () => expect(within(list).getByText('slow request')).toBeTruthy(),
      { timeout: 3_000 },
    );
    expect(
      fake.calls.some((call) => call.path.endsWith('/console?after=9')),
    ).toBe(true);
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Show console level' }),
      {
        target: { value: 'error' },
      },
    );
    const filtered = screen.getByRole('list', { name: 'Console messages' });
    expect(within(filtered).queryByText('booted')).toBeNull();
    expect(
      within(filtered).getByText('TypeError: x is undefined'),
    ).toBeTruthy();
    // Clear is an icon button; it hides what was logged so far.
    fireEvent.click(screen.getByRole('button', { name: 'Clear console' }));
    expect(await screen.findByText('No errors yet.')).toBeTruthy();
  });
});

describe('screenshots', () => {
  test('a screenshot of the page is offered to save under a descriptive file name', async () => {
    controlHolder.state = control();
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:shot-1';
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    renderPane({
      [SUMMARY]: ok(sessionView()),
      [`GET /api/browser/sessions/${SESSION}/screenshot`]: () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    });
    await chooseFromMenu('Screenshot');
    const save = (await screen.findByRole('link', {
      name: 'Save image',
    })) as HTMLAnchorElement;
    expect(save.getAttribute('href')).toBe('blob:shot-1');
    expect(save.getAttribute('download')).toMatch(
      /^browser-shop\.example\.com-\d{8}-\d{6}\.png$/,
    );
    expect(created[0]?.type).toBe('image/png');
    expect(
      screen.getByRole('img', { name: 'Screenshot of shop.example.com' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:shot-1'),
    );
  });

  test('a refused screenshot says why', async () => {
    controlHolder.state = control();
    renderPane({
      [SUMMARY]: ok(sessionView()),
      [`GET /api/browser/sessions/${SESSION}/screenshot`]: () => ({
        status: 504,
        body: { success: false, code: 'page-busy' },
      }),
    });
    await chooseFromMenu('Screenshot');
    expect(
      await screen.findByText('The page did not respond in time.'),
    ).toBeTruthy();
  });
});

describe('the toolbar', () => {
  test('the pane marks a coarse pointer and a narrow window for its CSS, each on its own', async () => {
    controlHolder.state = control();
    vi.stubGlobal('matchMedia', (query: string) => ({
      // The shared mobile query is the narrow one; the pointer query is coarse.
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderPane({
      [SUMMARY]: () => ({ body: { success: true, data: sessionView() } }),
    });
    await screen.findByTestId('live-canvas');
    const pane = document.querySelector('.browser-pane');
    expect(pane?.hasAttribute('data-coarse')).toBe(true);
    expect(pane?.hasAttribute('data-narrow')).toBe(false);
  });

  test('a fine pointer in a wide window carries neither mark', async () => {
    controlHolder.state = control();
    renderPane({
      [SUMMARY]: () => ({ body: { success: true, data: sessionView() } }),
    });
    await screen.findByTestId('live-canvas');
    const pane = document.querySelector('.browser-pane');
    expect(pane?.hasAttribute('data-coarse')).toBe(false);
    expect(pane?.hasAttribute('data-narrow')).toBe(false);
  });

  test('Close session lives in the ⋯ menu, last and on its own, and closes the session', async () => {
    controlHolder.state = control();
    let closed = false;
    const fake = renderPane({
      [SUMMARY]: () => ({
        body: {
          success: true,
          data: sessionView(closed ? { state: 'closed' } : {}),
        },
      }),
      [`DELETE /api/browser/sessions/${SESSION}`]: () => {
        closed = true;
        return {
          body: { success: true, data: sessionView({ state: 'closed' }) },
        };
      },
    });
    await screen.findByTestId('live-canvas');
    // Not a toolbar button.
    expect(screen.queryByRole('button', { name: 'Close session' })).toBeNull();
    fireEvent.click(
      await screen.findByRole('button', { name: 'More browser actions' }),
    );
    const menu = await screen.findByRole('menu', {
      name: 'More browser actions',
    });
    // The order a person reads: Screenshot, Viewport, Sessions, Agent access,
    // Local servers; then a separator; then Close session, last.
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Screenshot',
      'Viewport: Desktop',
      'Sessions',
      'Agent access',
      'Local servers',
      'Close session',
    ]);
    const close = items.at(-1)!;
    expect(close.previousElementSibling?.tagName).toBe('HR');
    fireEvent.click(close);
    await waitFor(() =>
      expect(
        fake.calls.some(
          (call) =>
            call.method === 'DELETE' &&
            call.path === `/api/browser/sessions/${SESSION}`,
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('the ⋯ menu ends above the chat dock, so its last row is never under it', async () => {
    // A landscape phone: 420px tall, the dock's bar over the bottom 53px.
    const DOCK = 53;
    const VIEWPORT = 420;
    const TRIGGER_BOTTOM = 125;
    const rect = (top: number, height: number) =>
      ({
        top,
        bottom: top + height,
        left: 816,
        right: 860,
        width: 44,
        height,
        x: 816,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const innerHeight = vi
      .spyOn(window, 'innerHeight', 'get')
      .mockReturnValue(VIEWPORT);
    const rects = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        // Six 44px rows and a separator: taller than the room below.
        if (this.getAttribute('role') === 'menu') return rect(0, 309);
        return rect(TRIGGER_BOTTOM - 44, 44);
      });
    document.documentElement.style.setProperty('--dock-slot-size', `${DOCK}px`);
    try {
      controlHolder.state = control();
      renderPane({
        [SUMMARY]: () => ({ body: { success: true, data: sessionView() } }),
      });
      await screen.findByTestId('live-canvas');
      fireEvent.click(
        await screen.findByRole('button', { name: 'More browser actions' }),
      );
      const menu = await screen.findByRole('menu', {
        name: 'More browser actions',
      });
      await waitFor(() => expect(menu.style.top).not.toBe(''));
      const top = Number.parseFloat(menu.style.top);
      const maxHeight = Number.parseFloat(menu.style.maxHeight);
      expect(top).toBeGreaterThanOrEqual(TRIGGER_BOTTOM);
      expect(top + maxHeight).toBeLessThanOrEqual(VIEWPORT - DOCK);
      // 420 - 53 (dock) - 125 (trigger) - 4 (gap) - 8 (edge).
      expect(maxHeight).toBe(230);
    } finally {
      document.documentElement.style.removeProperty('--dock-slot-size');
      rects.mockRestore();
      innerHeight.mockRestore();
    }
  });

  test('the Console button counts errors logged since it was last opened, and opening it clears the count', async () => {
    controlHolder.state = control();
    let reads = 0;
    renderPane({
      [SUMMARY]: ok(sessionView()),
      [`GET /api/browser/sessions/${SESSION}/console`]: () => {
        reads += 1;
        return {
          body: {
            success: true,
            data: {
              entries: [
                {
                  seq: 1,
                  at: 1,
                  level: 'error',
                  source: 'console',
                  text: 'old',
                },
              ],
              dropped: 0,
              latestSeq: 1,
              generation: 1,
              capturing: true,
            },
          },
        };
      },
      [`GET /api/browser/sessions/${SESSION}/console?after=1`]: ok({
        entries: [
          { seq: 2, at: 2, level: 'error', source: 'exception', text: 'boom' },
          { seq: 3, at: 3, level: 'info', source: 'console', text: 'fine' },
          { seq: 4, at: 4, level: 'error', source: 'browser', text: '404' },
        ],
        dropped: 0,
        latestSeq: 4,
        generation: 1,
        capturing: true,
      }),
      [`GET /api/browser/sessions/${SESSION}/console?after=4`]: ok({
        entries: [],
        dropped: 0,
        latestSeq: 4,
        generation: 1,
        capturing: true,
      }),
    });
    // The error already there when the pane looked is not new; the two
    // errors after it are.
    const badged = await screen.findByRole(
      'button',
      { name: 'Console, 2 unseen errors' },
      { timeout: 8_000 },
    );
    expect(reads).toBe(1);
    fireEvent.click(badged);
    expect(await screen.findByRole('button', { name: 'Console' })).toBeTruthy();
  }, 15_000);
});

describe('the console across a reopen (a new browser generation)', () => {
  const read = (
    generation: number,
    seqs: number[],
    level: 'error' | 'info' = 'info',
  ): BrowserConsoleView => ({
    entries: seqs.map((seq) => ({
      seq,
      at: seq,
      level,
      source: 'console' as const,
      text: `g${generation}#${seq}`,
    })),
    dropped: 0,
    latestSeq: seqs.at(-1) ?? 0,
    generation,
    capturing: true,
  });

  test('entries of two generations never mix: a read from a new one replaces what is held', () => {
    const held = read(1, [4, 5]);
    expect(
      mergeConsoleRead(held, read(1, [6])).entries.map((e) => e.text),
    ).toEqual(['g1#4', 'g1#5', 'g1#6']);
    expect(
      mergeConsoleRead(held, read(2, [1])).entries.map((e) => e.text),
    ).toEqual(['g2#1']);
  });

  test('after a reopen, every error the new browser logs is unseen, and old ones are gone', async () => {
    controlHolder.state = control();
    let fullReads = 0;
    renderPane({
      [SUMMARY]: ok(sessionView()),
      // The first full read is generation 1; after the reopen, generation 2.
      [`GET /api/browser/sessions/${SESSION}/console`]: () => {
        fullReads += 1;
        return {
          body: {
            success: true,
            data:
              fullReads === 1
                ? read(1, [1, 2, 3], 'error')
                : read(2, [1], 'error'),
          },
        };
      },
      // The cursor belonged to generation 1; the server answers with 2.
      [`GET /api/browser/sessions/${SESSION}/console?after=3`]: ok(
        read(2, [1], 'error'),
      ),
      [`GET /api/browser/sessions/${SESSION}/console?after=1`]: ok(
        read(2, [], 'error'),
      ),
    });
    // Generation 2's one error is new, although its seq (1) is below the old
    // baseline (3).
    expect(
      await screen.findByRole(
        'button',
        { name: 'Console, 1 unseen error' },
        { timeout: 8_000 },
      ),
    ).toBeTruthy();
    expect(fullReads).toBe(2);
  }, 15_000);
});
