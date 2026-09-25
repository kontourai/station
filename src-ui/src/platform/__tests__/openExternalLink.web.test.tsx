/** @vitest-environment jsdom */

/**
 * The plain-web half of `openExternalLink` (gap G5): with NO Tauri runtime
 * marker the platform promise resolves the web adapter, so there is no native
 * host to ask. An http(s) link opens a new tab with no opener and shows no
 * notice; any other scheme is refused before `window.open` and shown. The
 * native half is `openExternalLink.native-refusal.test.tsx`.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => ({}),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn() }),
}));

import { NotificationContainer } from '../../components/notifications/NotificationContainer';
import { ToastProvider, toastStore } from '../../contexts/ToastContext';
import { openExternalLink } from '../openExternalLink';

function renderNotices() {
  return render(
    <ToastProvider>
      <NotificationContainer />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  act(() => toastStore.dismissAll());
  vi.restoreAllMocks();
});

describe('opening a link outside Station on the web', () => {
  test('an https link opens a new tab with no opener, and no notice', async () => {
    expect(Object.hasOwn(window, '__TAURI_INTERNALS__')).toBe(false);
    renderNotices();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let opened: boolean | undefined;
    await act(async () => {
      opened = await openExternalLink('https://github.com/o/r/pull/1');
    });
    expect(opened).toBe(true);
    expect(open).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/1',
      '_blank',
      'noopener,noreferrer',
    );
    expect(toastStore.getSnapshot()).toHaveLength(0);
  });

  test('a non-web scheme is refused before window.open, and shown', async () => {
    renderNotices();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let opened: boolean | undefined;
    await act(async () => {
      opened = await openExternalLink('javascript:alert(1)');
    });
    expect(opened).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Station only opens web \(http or https\) links/),
    ).toBeTruthy();
  });
});
