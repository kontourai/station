/** @vitest-environment jsdom */

/**
 * The app-wide guard against the WebView's own context menu (Reload, and
 * Inspect Element in nightly and dev builds). Mounted for real and driven
 * with real `contextmenu` events on the document, with the Tauri runtime
 * marker present or absent.
 */

import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { selectTextAt } from './selection-stub';

const copied = vi.hoisted(() => [] as string[]);
vi.mock('../hooks/useCopyToClipboardToast', () => ({
  useCopyToClipboardToast: () => async (text: string) => {
    copied.push(text);
    return true;
  },
}));

const { NativeContextMenuGuard } = await import(
  '../components/NativeContextMenuGuard'
);

function setTauri(on: boolean) {
  if (on) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
  } else {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  }
}

function rightClick(target: Element, init: MouseEventInit = {}): boolean {
  const event = createEvent.contextMenu(target, {
    button: 2,
    clientX: 40,
    clientY: 50,
    ...init,
  });
  fireEvent(target, event);
  return event.defaultPrevented;
}

function renderPage(onLinkClick = vi.fn()) {
  render(
    <>
      <NativeContextMenuGuard />
      <p data-testid="plain">Plain text</p>
      <input aria-label="Field" />
      <a
        href="https://example.com/docs"
        onClick={(event) => {
          event.preventDefault();
          onLinkClick();
        }}
      >
        Docs
      </a>
    </>,
  );
  return { onLinkClick };
}

beforeEach(() => {
  copied.length = 0;
});

afterEach(() => {
  cleanup();
  setTauri(false);
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe('in the desktop and mobile apps', () => {
  beforeEach(() => setTauri(true));

  test('an unclaimed right-click opens no WebView menu', () => {
    renderPage();
    expect(rightClick(screen.getByTestId('plain'))).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('an editable field keeps the native menu', () => {
    renderPage();
    expect(rightClick(screen.getByRole('textbox', { name: 'Field' }))).toBe(
      false,
    );
  });

  test('selected text keeps the native menu', () => {
    renderPage();
    const plain = screen.getByTestId('plain');
    selectTextAt(plain, { left: 0, top: 0, right: 100, bottom: 100 });
    expect(rightClick(plain)).toBe(false);
  });

  test('a selection elsewhere does not hand empty space to the native menu', () => {
    renderPage();
    const plain = screen.getByTestId('plain');
    selectTextAt(plain, { left: 300, top: 300, right: 400, bottom: 320 });
    expect(rightClick(plain)).toBe(true);
  });

  test('the keyboard menu key acts on a selection inside the focused target', () => {
    renderPage();
    const plain = screen.getByTestId('plain');
    selectTextAt(plain, { left: 300, top: 300, right: 400, bottom: 320 });
    expect(rightClick(plain, { button: 0, clientX: 0, clientY: 0 })).toBe(
      false,
    );
  });

  test('Shift+right-click reaches the native menu (Inspect Element)', () => {
    renderPage();
    expect(rightClick(screen.getByTestId('plain'), { shiftKey: true })).toBe(
      false,
    );
  });

  test('a menu a control already opened is left alone', () => {
    renderPage();
    const plain = screen.getByTestId('plain');
    plain.addEventListener('contextmenu', (event) => event.preventDefault());
    rightClick(plain);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('a web link gets Open link and Copy link, and Open is a click on it', () => {
    const { onLinkClick } = renderPage();
    expect(rightClick(screen.getByText('Docs'))).toBe(true);
    screen.getByRole('menu', { name: 'Link actions' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open link' }));
    expect(onLinkClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    rightClick(screen.getByText('Docs'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(copied).toEqual(['https://example.com/docs']);
  });

  test('an app-internal link gets no link menu (nothing to copy it to)', () => {
    render(
      <>
        <NativeContextMenuGuard />
        <a href={`${window.location.origin}/projects/alpha`}>Alpha</a>
      </>,
    );
    expect(rightClick(screen.getByText('Alpha'))).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('a checkbox is not a text field: no WebView menu', () => {
    render(
      <>
        <NativeContextMenuGuard />
        <input type="checkbox" aria-label="Pick" />
      </>,
    );
    expect(rightClick(screen.getByRole('checkbox', { name: 'Pick' }))).toBe(
      true,
    );
  });

  test('the terminal keeps the native menu xterm drives', () => {
    render(
      <>
        <NativeContextMenuGuard />
        <div className="xterm">
          <div data-testid="rows">$ ls</div>
        </div>
      </>,
    );
    expect(rightClick(screen.getByTestId('rows'))).toBe(false);
  });

  test('Escape and a click away close the link menu', () => {
    renderPage();
    rightClick(screen.getByText('Docs'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    rightClick(screen.getByText('Docs'));
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('in a browser tab', () => {
  test('the browser keeps its own menu everywhere', () => {
    renderPage();
    expect(rightClick(screen.getByTestId('plain'))).toBe(false);
    expect(rightClick(screen.getByText('Docs'))).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
