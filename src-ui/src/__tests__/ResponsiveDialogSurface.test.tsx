/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act, StrictMode, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../components/ResponsiveDialogSurface';

class FakeViewport extends EventTarget {
  height = 700;
  offsetTop = 0;
}

function setMobileViewport(matches: boolean, viewport = new FakeViewport()) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      media: '(max-width: 768px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
  return viewport;
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.history.replaceState({}, '', '/dialog-test');
});

describe('ResponsiveDialogSurface', () => {
  test('provides one accessible 44px close-control contract', () => {
    const onClick = vi.fn();
    render(
      <ResponsiveDialogCloseButton label="Close example" onClick={onClick} />,
    );

    const close = screen.getByRole('button', { name: 'Close example' });
    expect(close.classList.contains('responsive-dialog-close')).toBe(true);
    expect(close.getAttribute('type')).toBe('button');
    expect(close.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    fireEvent.click(close);
    expect(onClick).toHaveBeenCalledOnce();
  });

  test('contains a phone dialog in the visual viewport without focusing its input', async () => {
    const viewport = setMobileViewport(true);
    const initialFocusRef = { current: null as HTMLInputElement | null };

    const { container } = render(
      <ResponsiveDialogSurface
        ariaLabel="Phone picker"
        initialFocusRef={initialFocusRef}
        initialFocusPolicy="desktop"
        onClose={vi.fn()}
      >
        <input ref={initialFocusRef} aria-label="Search" />
      </ResponsiveDialogSurface>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Phone picker' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(screen.getByLabelText('Search'));

    viewport.height = 480;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      const overlay = container.querySelector<HTMLElement>(
        '.responsive-surface-overlay',
      )!;
      expect(
        overlay.style.getPropertyValue('--responsive-visual-viewport-height'),
      ).toBe('480px');
      expect(
        overlay.style.getPropertyValue('--responsive-visual-viewport-top'),
      ).toBe('12px');
    });
  });

  test('owns desktop focus, keyboard containment, Escape, and backdrop dismissal', () => {
    setMobileViewport(false);
    const onClose = vi.fn();
    const initialFocusRef = { current: null as HTMLInputElement | null };
    const { container } = render(
      <ResponsiveDialogSurface
        ariaLabel="Desktop picker"
        initialFocusRef={initialFocusRef}
        initialFocusPolicy="desktop"
        onClose={onClose}
      >
        <input ref={initialFocusRef} aria-label="Search" />
        <button type="button">Done</button>
      </ResponsiveDialogSurface>,
    );

    const search = screen.getByLabelText('Search');
    const done = screen.getByRole('button', { name: 'Done' });
    expect(document.activeElement).toBe(search);

    done.focus();
    expect(fireEvent.keyDown(done, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.pointerDown(
      container.querySelector<HTMLElement>('.responsive-surface-overlay')!,
    );
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('renders an alert dialog with the same modal keyboard and close contract', () => {
    setMobileViewport(false);
    const onClose = vi.fn();
    render(
      <ResponsiveDialogSurface
        ariaLabel="Destructive confirmation"
        role="alertdialog"
        onClose={onClose}
      >
        <button type="button">Cancel</button>
        <button type="button">Delete</button>
      </ResponsiveDialogSurface>,
    );

    const alertDialog = screen.getByRole('alertdialog', {
      name: 'Destructive confirmation',
    });
    expect(alertDialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const remove = screen.getByRole('button', { name: 'Delete' });
    remove.focus();
    expect(fireEvent.keyDown(remove, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('restores the trigger after the dialog unmounts', async () => {
    setMobileViewport(false);

    function Harness() {
      const [open, setOpen] = useState(false);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open && (
            <ResponsiveDialogSurface
              ariaLabel="Restoring picker"
              initialFocusRef={inputRef}
              initialFocusPolicy="desktop"
              onClose={() => setOpen(false)}
            >
              <input ref={inputRef} aria-label="Search" />
            </ResponsiveDialogSurface>
          )}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    fireEvent.click(trigger);
    const search = screen.getByLabelText('Search');
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  /**
   * archive#1126. The shape of every delete confirm in the app: the button that
   * opened the dialog lives on the row the confirm removes, so by the time the
   * dialog restores focus its return target is detached. The `isConnected`
   * guard correctly declines to focus a detached node, and before this fix
   * nothing else was focused — `document.activeElement` fell back to `<body>`
   * and the next Tab restarted from the top of the document.
   *
   * The chain has to be captured while the trigger is still attached: React
   * removes the row on its own, which nulls the trigger's `parentElement`, so
   * there is nothing left to walk at unmount time.
   */
  function DeleteRowHarness({
    triggerLabel = 'Delete row-2',
  }: {
    triggerLabel?: string;
  }) {
    const [rows, setRows] = useState(['row-1', 'row-2', 'row-3']);
    const [confirming, setConfirming] = useState<string | null>(null);
    return (
      <main>
        <h1>Connections</h1>
        <div data-testid="row-list">
          {rows.map((row) => (
            <div key={row} data-testid={`row-${row}`}>
              <span>{row}</span>
              <button type="button" onClick={() => setConfirming(row)}>
                Delete {row}
              </button>
            </div>
          ))}
        </div>
        {confirming && (
          <ResponsiveDialogSurface
            ariaLabel="Confirm delete"
            initialFocusPolicy="always"
            onClose={() => setConfirming(null)}
          >
            <button
              type="button"
              onClick={() => {
                setRows((current) => current.filter((r) => r !== confirming));
                setConfirming(null);
              }}
            >
              Confirm
            </button>
          </ResponsiveDialogSurface>
        )}
        <p>{triggerLabel}</p>
      </main>
    );
  }

  test('falls back to the nearest surviving ancestor when the trigger is deleted', async () => {
    setMobileViewport(false);
    render(<DeleteRowHarness />);

    const trigger = screen.getByRole('button', { name: 'Delete row-2' });
    const list = screen.getByTestId('row-list');
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.queryByTestId('row-row-2')).toBeNull();

    await waitFor(() => expect(document.activeElement).toBe(list));
    expect(document.activeElement).not.toBe(document.body);
    // The container is made programmatically focusable, never tabbable: adding
    // it to the tab order would put a stop on every list in the app.
    expect(list.getAttribute('tabindex')).toBe('-1');
  });

  test('still restores the trigger itself when it survives the dialog', async () => {
    setMobileViewport(false);
    render(<DeleteRowHarness />);

    const trigger = screen.getByRole('button', { name: 'Delete row-2' });
    const list = screen.getByTestId('row-list');
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(
      document.querySelector<HTMLElement>('.responsive-surface-panel')!,
      { key: 'Escape' },
    );

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    // The surviving trigger is the first link in the chain, so no ancestor is
    // touched at all.
    expect(list.hasAttribute('tabindex')).toBe(false);
  });

  /**
   * The whole ancestry can go — a confirm that swaps the route, or a list whose
   * own container is replaced. `<body>` is then the only surviving "ancestor",
   * and focusing it is the very thing #1126 is about, so the walk stops short of
   * it: the outcome is the pre-fix one (nothing focused) rather than a worse one
   * (`<body>` focused *and* carrying a `tabindex` this component wrote onto a
   * node it does not own). Without this case the body stop is unfalsifiable —
   * every other harness has a surviving ancestor that is found first.
   */
  test('never focuses or marks document.body when nothing in the chain survives', async () => {
    setMobileViewport(false);

    function ReplaceEverythingHarness() {
      const [replaced, setReplaced] = useState(false);
      const [confirming, setConfirming] = useState(false);
      if (replaced) return <section data-testid="after">Gone</section>;
      return (
        <section data-testid="before">
          <button type="button" onClick={() => setConfirming(true)}>
            Delete everything
          </button>
          {confirming && (
            <ResponsiveDialogSurface
              ariaLabel="Confirm delete"
              initialFocusPolicy="always"
              onClose={() => setConfirming(false)}
            >
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setReplaced(true);
                }}
              >
                Confirm
              </button>
            </ResponsiveDialogSurface>
          )}
        </section>
      );
    }

    render(<ReplaceEverythingHarness />);
    const trigger = screen.getByRole('button', { name: 'Delete everything' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.queryByTestId('before')).toBeNull();

    // Give the restoration rAF the same room the other cases get.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.body.hasAttribute('tabindex')).toBe(false);
    expect(document.documentElement.hasAttribute('tabindex')).toBe(false);
  });

  /**
   * archive#1206 gap 1. The fallback made the rAF fire on essentially every
   * close (some ancestor almost always survives), so it started winning races
   * it used to lose: before #1187 the detached trigger meant nothing happened
   * and whoever else moved focus in that frame kept it. A confirm that deletes
   * its own row *and* opens a follow-up dialog is the probed shape — the
   * fallback landed on the container behind the new dialog, which is worse than
   * `<body>`: the panel's Tab containment is an `onKeyDown` on the panel, so
   * with focus outside it the modal is no longer a trap, and nothing says so.
   */
  test('never pulls focus out of a dialog that is still open', async () => {
    setMobileViewport(false);

    function FollowUpHarness() {
      const [rows, setRows] = useState(['row-1', 'row-2']);
      const [confirming, setConfirming] = useState<string | null>(null);
      const [renaming, setRenaming] = useState(false);
      const renameRef = useRef<HTMLInputElement>(null);
      return (
        <main>
          <div data-testid="row-list">
            {rows.map((row) => (
              <div key={row} data-testid={`row-${row}`}>
                <button type="button" onClick={() => setConfirming(row)}>
                  Delete {row}
                </button>
              </div>
            ))}
          </div>
          {confirming && (
            <ResponsiveDialogSurface
              ariaLabel="Confirm delete"
              initialFocusPolicy="always"
              onClose={() => setConfirming(null)}
            >
              <button
                type="button"
                onClick={() => {
                  setRows((current) => current.filter((r) => r !== confirming));
                  setConfirming(null);
                  setRenaming(true);
                }}
              >
                Confirm
              </button>
            </ResponsiveDialogSurface>
          )}
          {renaming && (
            <ResponsiveDialogSurface
              ariaLabel="Rename what is left"
              initialFocusPolicy="always"
              initialFocusRef={renameRef}
              onClose={() => setRenaming(false)}
            >
              <input ref={renameRef} aria-label="New name" />
            </ResponsiveDialogSurface>
          )}
        </main>
      );
    }

    render(<FollowUpHarness />);
    const trigger = screen.getByRole('button', { name: 'Delete row-2' });
    const list = screen.getByTestId('row-list');
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.queryByTestId('row-row-2')).toBeNull();

    const renameField = screen.getByLabelText('New name');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(document.activeElement).toBe(renameField);
    // Nor may the container behind the open dialog be marked focusable: the
    // stray attribute is the visible tell that the walk ran at all.
    expect(list.hasAttribute('tabindex')).toBe(false);

    // Leave the shared dialog-history stack as this test found it — a dialog
    // still open at teardown orphans its marker, and the next test's
    // `history.back` then lands on that marker instead of its own entry.
    fireEvent.keyDown(renameField, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('New name')).toBeNull());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  test('keeps a system blocker non-dismissible and its actions on the shared row contract', () => {
    setMobileViewport(true);
    const onClose = vi.fn();
    const { container } = render(
      <ResponsiveDialogSurface
        ariaLabel="Installing plugin"
        dismissible={false}
        layer="system"
        onClose={onClose}
      >
        <p>Installing…</p>
        <ResponsiveSurfaceActions className="feature-actions">
          <button type="button">Background</button>
        </ResponsiveSurfaceActions>
      </ResponsiveDialogSurface>,
    );

    const overlay = container.querySelector<HTMLElement>(
      '.responsive-surface-overlay',
    )!;
    expect(overlay.dataset.responsiveLayer).toBe('system');
    expect(
      container
        .querySelector('.feature-actions')
        ?.classList.contains('responsive-surface-actions'),
    ).toBe(true);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.pointerDown(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('browser Back dismisses the dialog without navigating its page', async () => {
    setMobileViewport(true);

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <ResponsiveDialogSurface
          ariaLabel="History picker"
          onClose={() => setOpen(false)}
        >
          <p>Dialog content</p>
        </ResponsiveDialogSurface>
      ) : (
        <p>Closed</p>
      );
    }

    render(<Harness />);
    expect(screen.getByRole('dialog', { name: 'History picker' })).toBeTruthy();

    window.history.back();

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'History picker' }),
      ).toBeNull(),
    );
    expect(window.location.pathname).toBe('/dialog-test');
  });

  test('stacked dialogs dismiss one history layer at a time', async () => {
    setMobileViewport(false);

    function Harness() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      if (!outerOpen) return <p>All closed</p>;
      return (
        <ResponsiveDialogSurface
          ariaLabel="Outer dialog"
          onClose={() => setOuterOpen(false)}
        >
          <button type="button" onClick={() => setInnerOpen(true)}>
            Open inner
          </button>
          {innerOpen && (
            <ResponsiveDialogSurface
              ariaLabel="Inner dialog"
              onClose={() => setInnerOpen(false)}
            >
              <p>Inner content</p>
            </ResponsiveDialogSurface>
          )}
        </ResponsiveDialogSurface>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open inner' }));
    expect(screen.getByRole('dialog', { name: 'Inner dialog' })).toBeTruthy();

    window.history.back();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Inner dialog' })).toBeNull(),
    );
    expect(screen.getByRole('dialog', { name: 'Outer dialog' })).toBeTruthy();

    window.history.back();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Outer dialog' })).toBeNull(),
    );
  });

  test('ordinary close removes its history layer', async () => {
    setMobileViewport(false);

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <ResponsiveDialogSurface
          ariaLabel="Close picker"
          onClose={() => setOpen(false)}
        >
          <button type="button" onClick={() => setOpen(false)}>
            Close now
          </button>
        </ResponsiveDialogSurface>
      ) : null;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Close now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(window.history.state.__stationDialog).toBeUndefined(),
    );
    expect(window.location.pathname).toBe('/dialog-test');
  });

  test('ordinary close on an unchanged URL folds its layer by travelling back', async () => {
    setMobileViewport(false);
    const back = vi.spyOn(window.history, 'back');

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <ResponsiveDialogSurface
          ariaLabel="Steady picker"
          onClose={() => setOpen(false)}
        >
          <button type="button" onClick={() => setOpen(false)}>
            Close now
          </button>
        </ResponsiveDialogSurface>
      ) : null;
    }

    render(<Harness />);
    await waitFor(() =>
      expect(window.history.state.__stationDialog).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(window.history.state.__stationDialog).toBeUndefined(),
    );

    // The layer is the newest entry and nothing moved the URL underneath it,
    // so folding it must not cost the page a history entry.
    expect(back).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/dialog-test');
  });

  test('a URL changed while the dialog is open survives its ordinary close', async () => {
    setMobileViewport(false);
    const back = vi.spyOn(window.history, 'back');

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <ResponsiveDialogSurface
          ariaLabel="Param picker"
          onClose={() => setOpen(false)}
        >
          <button
            type="button"
            onClick={() => {
              // The shape `navigationStore.updateParams` writes: a
              // `replaceState` onto whichever entry is live — here the
              // dialog's own — spreading the existing state, so the layer's
              // marker rides along with the new URL.
              const url = new URL(window.location.href);
              url.searchParams.set('chat', 'session-new');
              window.history.replaceState(
                {
                  ...(window.history.state ?? {}),
                  __stationNavigationIndex: 0,
                },
                '',
                url.toString(),
              );
              setOpen(false);
            }}
          >
            Pick and close
          </button>
        </ResponsiveDialogSurface>
      ) : null;
    }

    window.history.replaceState({}, '', '/dialog-test?chat=session-old');
    render(<Harness />);
    await waitFor(() =>
      expect(window.history.state.__stationDialog).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pick and close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(window.history.state.__stationDialog).toBeUndefined(),
    );

    expect(new URLSearchParams(window.location.search).get('chat')).toBe(
      'session-new',
    );
    // Travelling back here would land on the entry underneath, which still
    // holds the pre-dialog URL, silently undoing the selection.
    expect(back).not.toHaveBeenCalled();
    expect(window.history.state.__stationNavigationIndex).toBe(0);
  });

  test('browser Back still leaves the entry underneath after a URL change', async () => {
    setMobileViewport(false);

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <ResponsiveDialogSurface
          ariaLabel="Back picker"
          onClose={() => setOpen(false)}
        >
          <p>Open</p>
        </ResponsiveDialogSurface>
      ) : null;
    }

    window.history.replaceState({}, '', '/dialog-test?chat=session-old');
    render(<Harness />);
    await waitFor(() =>
      expect(window.history.state.__stationDialog).toBeTruthy(),
    );

    const url = new URL(window.location.href);
    url.searchParams.set('chat', 'session-new');
    window.history.replaceState(
      { ...(window.history.state ?? {}) },
      '',
      url.toString(),
    );

    // Back is the user asking for the entry underneath; it keeps the
    // pre-dialog URL, and the dialog closes without any further travel.
    window.history.back();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Back picker' })).toBeNull(),
    );
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('chat')).toBe(
        'session-old',
      ),
    );
    expect(window.history.state.__stationDialog).toBeUndefined();
  });

  test('route navigation closes a dialog and skips its orphaned history entry', async () => {
    setMobileViewport(false);

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <ResponsiveDialogSurface
          ariaLabel="Navigating picker"
          onClose={() => setOpen(false)}
        >
          <p>Open</p>
        </ResponsiveDialogSurface>
      ) : null;
    }

    render(<Harness />);
    await act(async () => {
      window.history.pushState({}, '', '/after-dialog');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/dialog-test'));
  });

  test('StrictMode owns one history entry during effect replay', async () => {
    setMobileViewport(false);
    const pushState = vi.spyOn(window.history, 'pushState');

    render(
      <StrictMode>
        <ResponsiveDialogSurface ariaLabel="Strict picker" onClose={vi.fn()}>
          <p>Stable</p>
        </ResponsiveDialogSurface>
      </StrictMode>,
    );

    await waitFor(() => expect(pushState).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog', { name: 'Strict picker' })).toBeTruthy();
  });

  test('route-owned dialogs do not add a duplicate history entry', async () => {
    setMobileViewport(false);
    const pushState = vi.spyOn(window.history, 'pushState');

    render(
      <ResponsiveDialogSurface
        ariaLabel="Route picker"
        historyMode="route"
        onClose={vi.fn()}
      >
        <p>Route owns this entry</p>
      </ResponsiveDialogSurface>,
    );

    await Promise.resolve();
    expect(pushState).not.toHaveBeenCalled();
  });

  test('desktop anchoring exposes trigger geometry as overlay vars', () => {
    setMobileViewport(false);
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    anchor.getBoundingClientRect = () =>
      ({ top: 600, left: 40, right: 120, bottom: 632 }) as DOMRect;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1440,
    });

    const { container } = render(
      <ResponsiveDialogSurface
        ariaLabel="Anchored picker"
        anchorRef={{ current: anchor }}
        onClose={vi.fn()}
      >
        <p>Anchored</p>
      </ResponsiveDialogSurface>,
    );

    const overlay = container.querySelector<HTMLElement>(
      '.responsive-surface-overlay',
    )!;
    expect(
      screen
        .getByRole('dialog', { name: 'Anchored picker' })
        .getAttribute('aria-modal'),
    ).toBe('true');
    expect(overlay.hasAttribute('data-anchored')).toBe(true);
    expect(overlay.style.getPropertyValue('--responsive-anchor-top')).toBe(
      '600px',
    );
    expect(overlay.style.getPropertyValue('--responsive-anchor-left')).toBe(
      '40px',
    );
    expect(overlay.style.getPropertyValue('--responsive-anchor-right')).toBe(
      '1320px',
    );
    anchor.remove();
  });

  test('window resize re-measures the anchor; a detached anchor clears it', async () => {
    setMobileViewport(false);
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    let top = 600;
    anchor.getBoundingClientRect = () =>
      ({ top, left: 40, right: 120, bottom: top + 32 }) as DOMRect;

    const { container } = render(
      <ResponsiveDialogSurface
        ariaLabel="Live-anchored picker"
        anchorRef={{ current: anchor }}
        onClose={vi.fn()}
      >
        <p>Anchored</p>
      </ResponsiveDialogSurface>,
    );
    const overlay = container.querySelector<HTMLElement>(
      '.responsive-surface-overlay',
    )!;
    expect(overlay.style.getPropertyValue('--responsive-anchor-top')).toBe(
      '600px',
    );

    top = 480;
    fireEvent.resize(window);
    await waitFor(() =>
      expect(overlay.style.getPropertyValue('--responsive-anchor-top')).toBe(
        '480px',
      ),
    );

    anchor.remove();
    fireEvent.resize(window);
    await waitFor(() => {
      expect(overlay.hasAttribute('data-anchored')).toBe(false);
      expect(overlay.style.getPropertyValue('--responsive-anchor-top')).toBe(
        '',
      );
    });
  });

  test('mobile ignores the anchor and keeps sheet geometry', () => {
    setMobileViewport(true);
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);

    const { container } = render(
      <ResponsiveDialogSurface
        ariaLabel="Sheet picker"
        anchorRef={{ current: anchor }}
        onClose={vi.fn()}
      >
        <p>Sheet</p>
      </ResponsiveDialogSurface>,
    );

    const overlay = container.querySelector<HTMLElement>(
      '.responsive-surface-overlay',
    )!;
    expect(
      screen
        .getByRole('dialog', { name: 'Sheet picker' })
        .getAttribute('aria-modal'),
    ).toBe('true');
    expect(overlay.hasAttribute('data-anchored')).toBe(false);
    expect(overlay.style.getPropertyValue('--responsive-anchor-top')).toBe('');
    anchor.remove();
  });
});
