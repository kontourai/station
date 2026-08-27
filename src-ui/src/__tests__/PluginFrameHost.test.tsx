/** @vitest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PluginFrameHost } from '../components/plugins/PluginFrameHost';
import {
  pluginConfirmBudget,
  pluginNavigationBudget,
  pluginToastBudget,
} from '../components/plugins/plugin-frame-budget';
import { toastStore } from '../contexts/ToastContext';

const FRAME_ORIGIN = 'https://plugins.example.test';
const fetchMock = vi.fn();
const { navigateMock, setLayoutMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  setLayoutMock: vi.fn(),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://station.example.test' }),
}));
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => ({ pluginFrameOrigin: FRAME_ORIGIN }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigationOptional: () => ({
    navigate: navigateMock,
    setLayout: setLayoutMock,
  }),
}));

vi.stubGlobal('fetch', fetchMock);

function ready() {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { method: 'plugin-host-ready' },
      origin: FRAME_ORIGIN,
      source: window,
    }),
  );
}

function renderHost(
  props: Partial<React.ComponentProps<typeof PluginFrameHost>> = {},
) {
  return {
    ...render(
      <PluginFrameHost
        plugin={{ name: 'demo', declaredSlug: 'demo-panel', granted: [] }}
        onObservation={vi.fn()}
        onFailure={vi.fn()}
        {...props}
      />,
    ),
    navigate: navigateMock,
    setLayout: setLayoutMock,
  };
}

function postNavigate(target: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { method: 'navigate', params: { target } },
      origin: FRAME_ORIGIN,
      source: window,
    }),
  );
}

/**
 * A pane-host contract message from the frame. `origin` is a parameter
 * because the refusal that matters most is the one that never runs: a
 * request from anywhere but the pinned frame origin must not be served.
 */
function postPaneHost(
  method: string,
  params?: unknown,
  origin: string = FRAME_ORIGIN,
) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { method, params },
      origin,
      source: window,
    }),
  );
}

/**
 * An `api-request` from the frame — a method the shell no longer implements
 * (station#4300). Kept so the regression test below can send the exact
 * message the deleted bridge answered.
 */
function postApiRequest(params: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { method: 'api-request', params },
      origin: FRAME_ORIGIN,
      source: window,
    }),
  );
}

/**
 * Let every queued microtask and timer callback run.
 *
 * A negative assertion about `fetch` MUST be made after this, and the reason
 * is a fault injection that passed: `authenticatedFetch` awaits before it
 * reaches the global `fetch`, so a synchronous `expect(fetchMock)
 * .not.toHaveBeenCalled()` runs BEFORE the call it is supposed to notice.
 * Re-adding the whole api-request bridge left this file green with four
 * unhandled rejections and 23 passing tests.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

type PaneHostReply = { method?: string; params?: Record<string, unknown> };

function refusalsFor(post: { mock: { calls: unknown[][] } }): PaneHostReply[] {
  return post.mock.calls
    .map((call) => call[0] as PaneHostReply)
    .filter((payload) => payload?.method === 'pane-host/refused');
}

function postToast(message: string) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { method: 'toast', params: { message } },
      origin: FRAME_ORIGIN,
      source: window,
    }),
  );
}

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
  navigateMock.mockReset();
  setLayoutMock.mockReset();
  // Module state: the budgets deliberately outlive a mount, so a leftover
  // one would silently starve the next test's requests.
  pluginToastBudget.reset();
  pluginNavigationBudget.reset();
  pluginConfirmBudget.reset();
  toastStore.clear();
  toastStore.clearHistory();
});

beforeEach(() => {
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get: () => window,
  });
});

describe('PluginFrameHost boundary', () => {
  test('connects transport before src assignment and tears it down on unmount', () => {
    const { container, unmount } = renderHost();
    const frame = container.querySelector('iframe')!;
    const post = vi.spyOn(window, 'postMessage');
    expect(frame.getAttribute('src')).toBe(`${FRAME_ORIGIN}/plugin-host/frame`);
    unmount();
    expect(post).toHaveBeenCalledWith(
      { method: 'teardown', params: {} },
      FRAME_ORIGIN,
    );
  });

  test('rejects spoofed sources and never transfers a shell nonce or credential', async () => {
    // Seed the nonce where `resolveCspNonce` actually reads it (the marker
    // element). Seeding the old `window.__STATION_CSP_NONCE__` global left
    // this regression test powerless: that carrier was removed, so the
    // assertion would pass even if someone wired `resolveCspNonce()` in here
    // tomorrow (station#4287 review).
    const cspMarker = document.createElement('script');
    cspMarker.nonce = 'shell-nonce';
    cspMarker.setAttribute('data-station-csp-nonce', '');
    document.head.appendChild(cspMarker);
    fetchMock.mockResolvedValue(new Response('bytes'));
    renderHost();
    const post = vi.spyOn(window, 'postMessage');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { method: 'plugin-host-ready' },
        origin: FRAME_ORIGIN,
        source: null,
      }),
    );
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => ready());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    for (const [payload] of post.mock.calls) {
      expect(JSON.stringify(payload)).not.toMatch(
        /authorization|bearer|credential|shell-nonce/i,
      );
    }
    delete (window as any).__STATION_CSP_NONCE__;
  });

  test('refuses ungranted navigation requests at the host', () => {
    const navigation = renderHost();
    // '/agents' is a real registered surface: only the missing grant refuses
    // it, so this cannot pass merely because the target was unroutable.
    postNavigate('/agents');
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.setLayout).not.toHaveBeenCalled();
  });

  test('routes a granted navigation request to the navigation seam (#3323)', () => {
    const navigation = renderHost({
      plugin: {
        name: 'demo',
        declaredSlug: 'demo-panel',
        granted: ['navigation.dock'],
      },
    });
    postNavigate('/agents');
    // Routed through the pane-host contract now: the frame's path string is
    // decoded to `{ kind: 'app-surface', surfaceId: 'agents' }` and the SHELL
    // resolves the route from its own registry. `{}` writes no query fields.
    expect(navigation.navigate).toHaveBeenCalledWith('/agents', {});
  });

  test("never persists a plugin navigation as the user's last-viewed layout", () => {
    const navigation = renderHost({
      plugin: {
        name: 'demo',
        declaredSlug: 'demo-panel',
        granted: ['navigation.dock'],
      },
    });
    postNavigate('/projects/apollo/layouts/coding');
    // The shell goes exactly where setLayout would have sent it — and the
    // File Preview fields are explicitly cleared, because plain `navigate`
    // starts from the live URL and would otherwise carry a preview intent
    // across the project switch (setLayout's clearing side effect, kept).
    expect(navigation.navigate).toHaveBeenCalledWith(
      '/projects/apollo/layouts/coding',
      { previewPath: null, previewLineStart: null, previewLineEnd: null },
    );
    // ...but `setLayout` writes lastProject/lastProjectLayout to localStorage
    // unconditionally, which would let a plugin repoint what `/` restores to
    // on every future launch — outliving the plugin's own removal. A frame is
    // not the user, so its choice is not recorded as the user's.
    expect(navigation.setLayout).not.toHaveBeenCalled();
  });

  test('rejects every navigation target outside the allowlist', () => {
    const navigation = renderHost({
      plugin: {
        name: 'demo',
        declaredSlug: 'demo-panel',
        granted: ['navigation.dock'],
      },
    });
    for (const target of [
      'https://evil.example/steal',
      '//evil.example/steal',
      'javascript:alert(1)',
      '/agents?redirect=https://evil.example',
      '/agents#/../../etc',
      '/projects/../../settings/layouts/x',
      '/not-a-registered-surface',
      '/agents/extra',
      42,
      null,
    ]) {
      postNavigate(target);
    }
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.setLayout).not.toHaveBeenCalled();
  });

  test('routes a plugin toast into the ToastStore attributed to the plugin', () => {
    renderHost();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { method: 'toast', params: { message: 'Feed refreshed' } },
        origin: FRAME_ORIGIN,
        source: window,
      }),
    );
    const live = toastStore.getSnapshot();
    expect(live).toHaveLength(1);
    // The plugin name prefix keeps a frame from impersonating Station chrome.
    expect(live[0]?.message).toBe('demo: Feed refreshed');
  });

  test('drops malformed or empty toast payloads without showing anything', () => {
    renderHost();
    for (const params of [undefined, {}, { message: 42 }, { message: '   ' }]) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { method: 'toast', params },
          origin: FRAME_ORIGIN,
          source: window,
        }),
      );
    }
    expect(toastStore.getSnapshot()).toHaveLength(0);
  });

  test('caps a plugin toast flood that varies its message every time', () => {
    renderHost();
    // `toastStore.show` collapses byte-identical repeats only, so a varying
    // suffix defeated it entirely and inserted unbounded live toasts.
    for (let index = 0; index < 25; index += 1) postToast(`tick ${index}`);
    expect(toastStore.getSnapshot()).toHaveLength(3);
    expect(toastStore.getSnapshot().map((toast) => toast.message)).toEqual([
      'demo: tick 0',
      'demo: tick 1',
      'demo: tick 2',
    ]);
  });

  test('refills one toast token per interval and never past the burst', () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      renderHost();
      for (let index = 0; index < 5; index += 1) postToast(`first ${index}`);
      expect(toastStore.getSnapshot()).toHaveLength(3);

      // One interval buys exactly one more.
      vi.setSystemTime(start + 10_000);
      postToast('after one interval');
      postToast('still capped');
      expect(toastStore.getSnapshot().map((toast) => toast.message)).toContain(
        'demo: after one interval',
      );
      expect(toastStore.getSnapshot()).toHaveLength(4);

      // A long idle cannot bank more than the burst.
      vi.setSystemTime(start + 10_000_000);
      for (let index = 0; index < 5; index += 1) postToast(`later ${index}`);
      expect(toastStore.getSnapshot()).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  test('budgets each plugin separately', () => {
    const first = renderHost();
    for (let index = 0; index < 5; index += 1) postToast(`noisy ${index}`);
    expect(toastStore.getSnapshot()).toHaveLength(3);
    first.unmount();

    renderHost({
      plugin: { name: 'quiet', declaredSlug: 'quiet-panel', granted: [] },
    });
    postToast('one word');
    expect(toastStore.getSnapshot().map((toast) => toast.message)).toContain(
      'quiet: one word',
    );
  });

  test('caps a plugin navigation loop and reports it once per interval', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const navigation = renderHost({
      plugin: {
        name: 'demo',
        declaredSlug: 'demo-panel',
        granted: ['navigation.dock'],
      },
    });
    // `navigation.dock` is auto-granted with no consent prompt, so an
    // unbounded loop here is a shell the user cannot steer, available to every
    // installed plugin.
    for (let index = 0; index < 8; index += 1) postNavigate('/agents');
    expect(navigation.navigate).toHaveBeenCalledTimes(2);
    // Silent to the frame, reported once to the host — reporting every refusal
    // would let the loop turn the report into the flood.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('navigation rate');
    // The user sees the refusal too: a legitimate third click dying
    // console-only is the silent no-op #3323 exists to fix. Host-issued, so
    // it spends no plugin toast token, and bounded to once per interval.
    const refusalToasts = toastStore
      .getSnapshot()
      .filter((toast) => toast.message.includes('navigation was ignored'));
    expect(refusalToasts).toHaveLength(1);
  });

  test('refills one navigation token per interval, capped at the burst', () => {
    vi.useFakeTimers();
    try {
      const navigation = renderHost({
        plugin: {
          name: 'demo',
          declaredSlug: 'demo-panel',
          granted: ['navigation.dock'],
        },
      });
      for (let index = 0; index < 5; index += 1) postNavigate('/agents');
      expect(navigation.navigate).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(30_000);
      postNavigate('/agents');
      expect(navigation.navigate).toHaveBeenCalledTimes(3);

      // Idle time cannot bank more than the burst.
      vi.advanceTimersByTime(30_000 * 20);
      for (let index = 0; index < 5; index += 1) postNavigate('/agents');
      expect(navigation.navigate).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a confirm does not survive the frame document being replaced (#4201)', async () => {
    const { rerender } = renderHost({
      plugin: {
        name: 'demo',
        declaredSlug: 'demo-panel',
        granted: ['ui.confirm'],
      },
    });
    const post = vi.spyOn(window, 'postMessage');

    act(() => {
      postPaneHost('pane-host/confirm', {
        id: 'c1',
        title: 'Restart',
        message: 'Restart the runner?',
      });
    });
    expect(screen.getByRole('dialog').textContent).toContain(
      'Restart the runner?',
    );

    // The bridge effect re-runs and tears the plugin document down. A new
    // `granted` identity is the realistic trigger: it arrives from the
    // plugin-meta query, so any registry refresh re-identities it. The
    // placement stays mounted and `active` never flips, so neither of the
    // other two lifetime boundaries fires.
    act(() => {
      rerender(
        <PluginFrameHost
          plugin={{
            name: 'demo',
            declaredSlug: 'demo-panel',
            granted: ['ui.confirm'],
          }}
          onObservation={vi.fn()}
          onFailure={vi.fn()}
        />,
      );
    });

    // The dialog belonged to a document that no longer exists. Leaving it up
    // would let the user answer a question for a dead frame -- and a reloaded
    // plugin reusing id 'c1' would take that answer as the reply to whatever
    // it asked next.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).toHaveBeenCalledWith(
      {
        method: 'pane-host/confirm-result',
        params: { id: 'c1', decision: 'cancelled' },
      },
      FRAME_ORIGIN,
    );
  });

  test('a frame confirm shows the SHELL modal and answers the frame (#4201)', async () => {
    renderHost({
      plugin: {
        name: 'demo',
        declaredSlug: 'demo-panel',
        granted: ['ui.confirm'],
      },
    });
    const post = vi.spyOn(window, 'postMessage');

    act(() => {
      postPaneHost('pane-host/confirm', {
        id: 'c1',
        title: 'Restart',
        message: 'Restart the runner?',
      });
    });

    // Station's own ConfirmModal, in the SHELL's document -- not a dialog
    // drawn inside the iframe wearing Station's authority. The frame never
    // receives a component, only the decision.
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('demo: Restart');
    expect(dialog.textContent).toContain('Restart the runner?');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        {
          method: 'pane-host/confirm-result',
          params: { id: 'c1', decision: 'confirmed' },
        },
        FRAME_ORIGIN,
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a confirm request from a foreign origin is never served', () => {
    renderHost();
    const post = vi.spyOn(window, 'postMessage');

    // `act` is what gives this test its power: without it a dialog the host
    // WRONGLY opened would not have rendered by the time the assertion runs,
    // so the test would pass whether or not the origin pin held. Proven by
    // fault injection -- serving the contract before the pin passed until
    // this flush was added.
    act(() => {
      postPaneHost(
        'pane-host/confirm',
        { id: 'evil', title: 'Grant access', message: 'Allow?' },
        'https://evil.example',
      );
    });

    // Not refused with a reply either: a message that failed the origin pin
    // is not a conversation, and answering it would confirm the protocol to
    // whoever sent it.
    expect(screen.queryByRole('dialog')).toBeNull();
    // Reads as a second independent check but is not one on its own: on the
    // refusal path nothing posts, so the loop body never runs and it passes
    // either way. Pinned as an explicit emptiness assertion instead, so what
    // it proves is what it says.
    const paneHostReplies = post.mock.calls.filter(([payload]) =>
      JSON.stringify(payload).includes('pane-host/'),
    );
    expect(paneHostReplies).toEqual([]);
  });

  test('a NOTIFY from a foreign origin is never served either', () => {
    // The origin pin is one shared line, so this is the same code path — but
    // a future reorder that only moves the fast paths would leave the confirm
    // test green while this one reds.
    renderHost();
    const post = vi.spyOn(window, 'postMessage');

    act(() => {
      postPaneHost(
        'pane-host/notify',
        { text: 'trust me' },
        'https://evil.example',
      );
    });

    expect(
      post.mock.calls.filter(([payload]) =>
        JSON.stringify(payload).includes('pane-host/'),
      ),
    ).toEqual([]);
    expect(document.body.textContent).not.toContain('trust me');
  });

  test('an unrecognised pane-host message is refused, not silently dropped', () => {
    renderHost();
    const post = vi.spyOn(window, 'postMessage');

    postPaneHost('pane-host/exfiltrate', {});

    // Silence is how #3308 and #3323 both stayed broken: the capability was
    // advertised, the message went nowhere, and nothing said so.
    expect(post).toHaveBeenCalledWith(
      {
        method: 'pane-host/refused',
        params: {
          method: 'pane-host/exfiltrate',
          reason: 'method is not a pane-host capability',
        },
      },
      FRAME_ORIGIN,
    );
  });

  test('a granted frame can navigate by contract target, not only by path', () => {
    const navigation = renderHost({
      plugin: {
        name: 'demo',
        declaredSlug: 'demo-panel',
        granted: ['navigation.dock'],
      },
    });

    postPaneHost('pane-host/navigate', {
      target: { kind: 'app-surface', surfaceId: 'agents' },
    });

    // The same destination the documented `target: '/agents'` string reaches,
    // through the same contract member -- one vocabulary, two encodings.
    expect(navigation.navigate).toHaveBeenCalledWith('/agents', {});
  });

  test('the toast budget refuses a flood raised as a contract notify', () => {
    renderHost();
    // Acceptance 3: a pane must not be able to spend more of the user's
    // attention by being in a different tier, and the namespaced spelling of
    // the intent must not be a way around the bound the legacy one has.
    for (let index = 0; index < 25; index += 1) {
      postPaneHost('pane-host/notify', { text: `tick ${index}` });
    }
    expect(toastStore.getSnapshot()).toHaveLength(3);
  });

  test('does not fetch or transfer bytes when the shared authorization fails', async () => {
    const onFailure = vi.fn();
    renderHost({ authorize: () => false, onFailure });
    act(() => ready());
    await waitFor(() => expect(onFailure).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * station#4300 deleted the frame's `api-request` bridge. The shell no longer
 * performs `/api/**` requests on a plugin frame's behalf under the operator's
 * credential: the method has no handler, and nothing in the pane-host contract
 * replaces it.
 *
 * This is the regression that has to survive the deletion. The bridge's own
 * corpus went with it, so without a test that sends the exact message it
 * answered, re-adding the handler — or a new one under any name that reaches
 * `authenticatedFetch` from a frame message — would be invisible.
 */
describe('the api-request bridge is gone (station#4300)', () => {
  test('an api-request reaches nothing: no fetch, no reply, no refusal', async () => {
    // The most permissive grant set the product can produce, aimed at a path
    // those grants used to cover, so this cannot pass because the request
    // would have been refused on its merits — under the old bridge this exact
    // message was ALLOWED and performed.
    renderHost({
      plugin: {
        name: 'demo',
        declaredSlug: 'demo-panel',
        granted: [
          'plugin.server',
          'network.fetch',
          'navigation.dock',
          'ui.confirm',
        ],
      },
    });
    const post = vi.spyOn(window, 'postMessage');

    postApiRequest({ id: 1, path: '/api/plugins/demo/ping', method: 'GET' });
    postApiRequest({
      id: 2,
      permission: 'plugin.server',
      path: '/api/settings',
      method: 'GET',
    });
    postApiRequest({
      id: 3,
      permission: 'network.fetch',
      path: '/api/plugins/demo/fetch',
      method: 'POST',
    });

    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    // Not answered on its own channel...
    expect(
      post.mock.calls
        .map(([payload]) => (payload as PaneHostReply)?.method)
        .filter((method) => method === 'api-response'),
    ).toEqual([]);
    // ...and not refused on the contract's channel either. An unrecognised
    // uplink method is not the adapter's, so it is neither served nor
    // answered — the same treatment any undefined method gets.
    expect(refusalsFor(post)).toEqual([]);
  });

  test('the frame transport still serves the contract it does implement', async () => {
    // The negative above would also pass if the message listener were broken
    // outright. A live pane-host member through the same transport is what
    // makes it a claim about `api-request` specifically.
    const navigation = renderHost({
      plugin: {
        name: 'demo',
        declaredSlug: 'demo-panel',
        granted: ['navigation.dock'],
      },
    });
    postApiRequest({ id: 4, path: '/api/plugins/demo/ping' });
    postNavigate('/agents');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigation.navigate).toHaveBeenCalledWith('/agents', {});
  });
});
