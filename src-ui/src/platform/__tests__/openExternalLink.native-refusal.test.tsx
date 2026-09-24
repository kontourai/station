/** @vitest-environment jsdom */

/**
 * A refused external open is VISIBLE (#2480). The desktop host's
 * `open_external_link` admits only its reviewed allowlist, and before this a
 * refusal resolved `false` into callers that ignored it — "Open on GitHub"
 * and a chat link did nothing at all in the Station app.
 *
 * Driven through the REAL native adapter: the Tauri runtime marker is set so
 * `nativePlatformPromise` selects `TauriNativePlatformAdapter`, and only the
 * IPC boundary (`@tauri-apps/api/core`'s `invoke`) is stubbed, rejecting the
 * command the way the host's allowlist does. The notice is read from the real
 * toast renderer.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  // Before any module evaluates: `nativePlatformPromise` picks its adapter
  // from this marker once, at import.
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  });
  return {
    invoke: vi.fn(async (command: string, _args?: unknown) => {
      if (command === 'open_external_link')
        throw new Error('open_external_link: URL is not allowed');
      return undefined;
    }),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => ipc.invoke(command, args),
}));
vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestContextQuery: () => ({ data: undefined }),
}));
vi.mock('../../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => ({}),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn() }),
}));

import { ChatMarkdownAnchor } from '../../components/chat/ChatMarkdownAnchor';
import { MarkdownLinkContext } from '../../components/chat/MarkdownLinkContext';
import { NotificationContainer } from '../../components/notifications/NotificationContainer';
import { ToastProvider, toastStore } from '../../contexts/ToastContext';
import {
  displayedExternalLink,
  openExternalLink,
  trackedRefusalNoticeCount,
} from '../openExternalLink';

const PR_URL = 'https://github.com/kontourai/station/pull/2049';
const writeText = vi.fn(async (_text: string) => {});

function renderNotices(children?: React.ReactNode) {
  return render(
    <ToastProvider>
      {children}
      <NotificationContainer />
    </ToastProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  act(() => toastStore.dismissAll());
  vi.clearAllMocks();
});

describe('a refused native open is shown, with the link and a Copy action', () => {
  test('"Open on GitHub" (openExternalLink): the host refuses, the reader sees why and can copy the link', async () => {
    renderNotices();
    const open = vi.spyOn(window, 'open');
    let opened: boolean | undefined;
    await act(async () => {
      opened = await openExternalLink(PR_URL);
    });
    expect(opened).toBe(false);
    expect(ipc.invoke).toHaveBeenCalledWith('open_external_link', {
      url: PR_URL,
    });
    // The native host owns external navigation: no webview fallback.
    expect(open).not.toHaveBeenCalled();
    const notice = await screen.findByText(
      /The Station app cannot open this link\./,
    );
    expect(notice.textContent).toContain(PR_URL);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PR_URL));
    // A copy that worked says so (delta review LOW: it was silent).
    expect(await screen.findByText('Link copied')).toBeTruthy();
  });

  // Delta review LOW: the notice's action skipped the toast store's de-dup
  // and never auto-dismisses, so every click on a refused link stacked
  // another. One live notice per link; a long link is shortened for reading
  // while Copy still copies the whole of it.
  test('one live notice per link, a long link shortened on screen and copied whole', async () => {
    renderNotices();
    const long = `https://github.com/kontourai/station/pull/2049?${'q=1&'.repeat(40)}end=1`;
    await act(async () => {
      await openExternalLink(long);
      await openExternalLink(long);
      await openExternalLink(long);
    });
    const notices = await screen.findAllByText(
      /The Station app cannot open this link\./,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).not.toContain(long);
    expect(notices[0]?.textContent).toContain('…');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(long));
    // Round-4 L4: the notice is gone (its action dismissed it), and so is the
    // module's record of it — the map holds live notices only.
    await waitFor(() => expect(trackedRefusalNoticeCount()).toBe(0));
  });

  // Round-4 L4: a UTF-16 slice through a surrogate pair printed half a
  // character; the shortening counts code points.
  test('a long link is shortened by code points, never splitting a character', () => {
    const url = `https://x.test/${'a'.repeat(44)}😀${'b'.repeat(40)}`;
    expect(url.slice(0, 60)).toMatch(/[\uD800-\uDBFF]$/);
    const shown = displayedExternalLink(url);
    expect(shown).toContain('😀…');
    expect(shown).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  test('a chat link the host refuses is shown too, not dropped', async () => {
    renderNotices(
      <MarkdownLinkContext.Provider
        value={{
          projectSlug: 'station',
          projectId: 'project-uuid',
          dockProjectSlug: 'station',
          openPathInMain: null,
        }}
      >
        <ChatMarkdownAnchor href="https://example.test/docs">
          docs
        </ChatMarkdownAnchor>
      </MarkdownLinkContext.Provider>,
    );
    fireEvent.click(screen.getByRole('link', { name: /docs/ }));
    const notice = await screen.findByText(
      /The Station app cannot open this link\./,
    );
    expect(notice.textContent).toContain('https://example.test/docs');
  });

  test('a non-web scheme is refused before any host is asked, and says so', async () => {
    renderNotices();
    const open = vi.spyOn(window, 'open');
    let opened: boolean | undefined;
    await act(async () => {
      opened = await openExternalLink('javascript:alert(1)');
    });
    expect(opened).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(ipc.invoke).not.toHaveBeenCalledWith(
      'open_external_link',
      expect.anything(),
    );
    expect(
      await screen.findByText(/Station only opens web \(http or https\) links/),
    ).toBeTruthy();
  });
});
