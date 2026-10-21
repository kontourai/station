/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { HtmlReply } from '../HtmlReply';

vi.mock('../../../platform/openExternalLink', () => ({
  openNativeExternalLink: vi.fn(async () => null),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.removeAttribute('style');
});
const page = {
  version: 1 as const,
  html: '<h1>Quarterly activity</h1>',
  height: 400,
};
const origin = 'https://sandbox.example';

test('refuses the app origin and loads HTML only after the isolated frame identifies itself', () => {
  const view = render(
    <HtmlReply page={page} frameOrigin={window.location.origin} theme="dark" />,
  );
  expect(screen.queryByTitle('Visual reply')).toBeNull();
  expect(
    screen.getByText('Visual replies require an isolated frame origin.'),
  ).toBeTruthy();
  view.rerender(<HtmlReply page={page} frameOrigin={origin} theme="dark" />);
  const frame = screen.getByTitle('Visual reply') as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const ready = (source: unknown, sender: string) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'html-reply-ready' },
          source: source as Window,
          origin: sender,
        }),
      );
    });
  ready(window, origin);
  ready(frame.contentWindow, 'https://evil.example');
  expect(post).not.toHaveBeenCalled();
  ready(frame.contentWindow, origin);
  expect(post).toHaveBeenCalledWith(
    { type: 'html-reply-load', html: page.html },
    origin,
  );
  post.mockClear();
  document.documentElement.style.setProperty('--k-bg', '#ffffff');
  view.rerender(<HtmlReply page={page} frameOrigin={origin} theme="light" />);
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'html-reply-theme',
      theme: 'light',
      tokens: expect.objectContaining({ background: '#ffffff' }),
    }),
    origin,
  );
});

test('requires confirmation for even an authenticated page link request and bounds zoom', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(<HtmlReply page={page} frameOrigin={origin} theme="dark" />);
  const frame = screen.getByTitle('Visual reply') as HTMLIFrameElement;
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin,
        data: { type: 'html-reply-link', url: 'https://example.com/' },
      }),
    );
  });
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByText('Open link from visual reply?')).toBeTruthy();
  expect(screen.getByText('Open link').hasAttribute('disabled')).toBe(true);
  act(() => vi.advanceTimersByTime(500));
  await act(async () => {
    fireEvent.click(screen.getByText('Open link'));
  });
  expect(open).toHaveBeenCalledWith(
    'https://example.com/',
    '_blank',
    'noopener,noreferrer',
  );
  for (let i = 0; i < 8; i++) fireEvent.click(screen.getByLabelText('Zoom in'));
  expect(screen.getByLabelText('Reset zoom').textContent).toBe('200%');
  expect(screen.getByLabelText('Zoom in').hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByLabelText('Reset zoom'));
  expect(screen.getByLabelText('Reset zoom').textContent).toBe('100%');
});

test('ignores gesture-less link messages and permanently mutes this reply after Cancel', () => {
  const activation = { isActive: false };
  vi.stubGlobal('navigator', { userActivation: activation });
  render(<HtmlReply page={page} frameOrigin={origin} theme="dark" />);
  const frame = screen.getByTitle('Visual reply');
  expect(frame).toBeInstanceOf(HTMLIFrameElement);
  if (!(frame instanceof HTMLIFrameElement))
    throw new Error('Missing visual reply frame');
  const request = () =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin,
          data: { type: 'html-reply-link', url: 'https://example.com/' },
        }),
      ),
    );
  request();
  expect(screen.queryByRole('dialog')).toBeNull();
  activation.isActive = true;
  request();
  expect(
    screen.getByRole('dialog', { name: 'Open link from visual reply?' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByText('Cancel'));
  request();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('re-sends resolved tokens on a palette change, not on a geometry write', async () => {
  const sheet = document.createElement('style');
  sheet.textContent =
    ':root{--k-bg:#0a0e13}:root[data-color-theme="latte"]{--k-bg:#eff1f5}';
  document.head.append(sheet);
  const root = document.documentElement;
  try {
    render(<HtmlReply page={page} frameOrigin={origin} theme="dark" />);
    const frame = screen.getByTitle('Visual reply') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'html-reply-ready' },
          source: frame.contentWindow,
          origin,
        }),
      );
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'html-reply-theme',
        tokens: expect.objectContaining({ background: '#0a0e13' }),
      }),
      origin,
    );
    post.mockClear();
    // Same light/dark setting, new palette: no rerender, only the root
    // attribute changes (MutationObserver delivers on a microtask).
    await act(async () => {
      root.setAttribute('data-color-theme', 'latte');
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'html-reply-theme',
        theme: 'dark',
        tokens: expect.objectContaining({ background: '#eff1f5' }),
      }),
      origin,
    );
    post.mockClear();
    // A keyboard-inset write is geometry, not theme.
    await act(async () => {
      root.style.setProperty('--visual-viewport-bottom-inset', '120px');
      await Promise.resolve();
    });
    expect(post).not.toHaveBeenCalled();
  } finally {
    sheet.remove();
    root.removeAttribute('data-color-theme');
    root.style.removeProperty('--visual-viewport-bottom-inset');
  }
});
