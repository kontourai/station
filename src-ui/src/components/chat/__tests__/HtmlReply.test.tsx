/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { stageHtmlReplyDocument } from '../../../platform/native/htmlReplyStagedDocument';
import { HtmlReply } from '../HtmlReply';

vi.mock('../../../platform/openExternalLink', () => ({
  openNativeExternalLink: vi.fn(async () => null),
}));

vi.mock('../../../platform/native/htmlReplyStagedDocument', () => ({
  stageHtmlReplyDocument: vi.fn(async () => undefined),
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

test('without a reachable distinct origin, renders in an opaque-origin sandbox that never loads by message', () => {
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  document.documentElement.style.setProperty('--k-bg', '#0a0e13');
  // A value that would close the declaration is dropped, never written.
  document.documentElement.style.setProperty('--k-text', 'red;}</style>');
  // The app's own origin is not distinct, and an empty origin is what the
  // server answers a client that cannot reach the loopback frame listener.
  for (const unreachable of [window.location.origin, '']) {
    const view = render(
      <HtmlReply page={page} frameOrigin={unreachable} theme="light" />,
    );
    const frame = screen.getByTitle('Visual reply') as HTMLIFrameElement;
    // No allow-same-origin: the frame's scripts cannot reach Station's origin.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBeNull();
    const document_ = frame.getAttribute('srcdoc') ?? '';
    expect(document_).toContain(page.html);
    expect(document_).toContain('--background:#0a0e13;');
    expect(document_).toContain('color-scheme:light');
    expect(document_).not.toContain('--foreground:');
    expect(document_).not.toContain('red;}');
    // The authored bytes still follow the page's own Content Security Policy.
    expect(document_.indexOf('Content-Security-Policy')).toBeLessThan(
      document_.indexOf(page.html),
    );
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const send = (data: unknown, sender: string) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data,
            source: frame.contentWindow,
            origin: sender,
          }),
        );
      });
    // A page claiming to be the proxy gets nothing posted back.
    send({ type: 'html-reply-ready' }, 'null');
    expect(post).not.toHaveBeenCalled();
    // Links are honoured only from the opaque frame itself.
    send(
      { type: 'html-reply-link', url: 'https://example.com/' },
      'https://evil.example',
    );
    expect(screen.queryByText('Open link from visual reply?')).toBeNull();
    send({ type: 'html-reply-link', url: 'https://example.com/' }, 'null');
    expect(screen.getByText('Open link from visual reply?')).toBeTruthy();
    view.unmount();
  }
});

test('staging upgrades the opaque frame to a scheme-served document and posts the theme to it', async () => {
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  document.documentElement.style.setProperty('--k-bg', '#0a0e13');
  const staged = `station-html-reply://localhost/${'A'.repeat(43)}?capability=${'B'.repeat(43)}`;
  vi.mocked(stageHtmlReplyDocument).mockResolvedValueOnce(staged);
  const view = render(<HtmlReply page={page} frameOrigin="" theme="light" />);
  // The srcdoc child paints immediately, before staging resolves.
  const frame = screen.getByTitle('Visual reply') as HTMLIFrameElement;
  expect(frame.getAttribute('srcdoc')).toBeTruthy();
  // Staging swaps the source; the sandbox stays scripts-only either way.
  await waitFor(() => expect(frame.getAttribute('src')).toBe(staged));
  expect(frame.getAttribute('srcdoc')).toBeNull();
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  // The staged load posts the theme by message, wildcard-targeted: a
  // sandboxed frame's opaque origin cannot be named.
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  act(() => {
    fireEvent.load(frame);
  });
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post.mock.calls[0]?.[0]?.type).toBe('html-reply-theme');
  expect(post.mock.calls[0]?.[1]).toBe('*');
  view.unmount();
});

test('a refused stage keeps the immediate srcdoc child and surfaces nothing', async () => {
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  document.documentElement.style.setProperty('--k-bg', '#0a0e13');
  vi.mocked(stageHtmlReplyDocument).mockRejectedValueOnce(
    new Error('shell refused'),
  );
  const view = render(<HtmlReply page={page} frameOrigin="" theme="light" />);
  const frame = screen.getByTitle('Visual reply') as HTMLIFrameElement;
  expect(frame.getAttribute('srcdoc')).toContain(page.html);
  await act(async () => {
    await Promise.resolve();
  });
  expect(frame.getAttribute('src')).toBeNull();
  expect(frame.getAttribute('srcdoc')).toContain(page.html);
  view.unmount();
});

test('loads HTML only after the isolated frame identifies itself', () => {
  const view = render(
    <HtmlReply page={page} frameOrigin={origin} theme="dark" />,
  );
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
