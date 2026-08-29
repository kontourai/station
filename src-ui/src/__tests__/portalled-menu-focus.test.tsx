/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionStatusDot: () => <span data-testid="connection-status" />,
}));

import { HelpMenu } from '../components/header/HelpMenu';
import { OverflowMenu } from '../components/header/OverflowMenu';
import { useMenuFocus } from '../hooks/useMenuFocus';

/**
 * These menus are portalled to `document.body` so they can escape the mobile
 * toolbar's stacking context and its `overflow: hidden`. That fixes the
 * pointer bug and creates a keyboard one: the trigger stays in the toolbar
 * while the menu items land at the end of the document, so Tab walks straight
 * past an open menu into the rest of the app.
 *
 * The assertions below are about what a keyboard user experiences — focus
 * entering the menu and coming back afterwards — rather than that some hook
 * was called.
 */
function Harness({ isOpen }: { isOpen: boolean }) {
  return (
    <>
      <button type="button" data-testid="trigger">
        More actions
      </button>
      <OverflowMenu
        isOpen={isOpen}
        connStatus="connected"
        userInitials="ST"
        onClose={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenHelp={vi.fn()}
        onOpenProfile={vi.fn()}
      />
    </>
  );
}

describe('portalled header menus stay reachable from the keyboard', () => {
  /**
   * The menus stay mounted and toggle `isOpen`; they render null while closed.
   * Mounting one already open therefore skips the only transition that matters
   * and will pass against an effect that never re-runs.
   */
  test('moves focus into the menu when it opens, not merely when it mounts', () => {
    const view = render(<Harness isOpen={false} />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    view.rerender(<Harness isOpen />);

    // The menu's first item, whichever it is — Connections since archive#3311
    // put the demoted Profile last.
    expect(document.activeElement).toBe(screen.getByLabelText('Connections'));
  });

  test('returns focus to the trigger when it closes, without unmounting', () => {
    const view = render(<Harness isOpen={false} />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();

    view.rerender(<Harness isOpen />);
    expect(document.activeElement).not.toBe(trigger);

    view.rerender(<Harness isOpen={false} />);
    // Closing must not strand focus on <body>.
    expect(document.activeElement).toBe(trigger);
  });

  test('renders outside the header subtree', () => {
    // The whole point of the portal: rendered inside the toolbar it is trapped
    // under a stacking context no z-index can escape.
    const { container } = render(<Harness isOpen />);
    const menu = screen.getByLabelText('Connections').closest('div');
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  test('does not steal focus while closed', () => {
    render(<Harness isOpen={false} />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  test('survives repeated open and close cycles', () => {
    const view = render(<Harness isOpen={false} />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      view.rerender(<Harness isOpen />);
      expect(document.activeElement).toBe(screen.getByLabelText('Connections'));
      view.rerender(<Harness isOpen={false} />);
      expect(document.activeElement).toBe(trigger);
    }
  });
});

describe('portalled header menu click-away controls', () => {
  test('offers the desktop tray action and closes before invoking it', () => {
    const calls: string[] = [];
    render(
      <OverflowMenu
        isOpen
        connStatus="connected"
        userInitials="ST"
        onClose={() => calls.push('close')}
        onOpenConnections={vi.fn()}
        onOpenDesktopTrayMenu={() => {
          calls.push('tray');
        }}
        onOpenHelp={vi.fn()}
        onOpenProfile={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open desktop tray' }));
    expect(calls).toEqual(['close', 'tray']);
  });

  test('uses named buttons for the pointer dismissal surfaces', () => {
    const onCloseHelp = vi.fn();
    const onCloseOverflow = vi.fn();
    const helpView = render(
      <HelpMenu
        isOpen
        prompts={[{ label: 'Explain this', prompt: 'Explain this' }]}
        onClose={onCloseHelp}
        onSelectPrompt={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close help menu' }));
    expect(onCloseHelp).toHaveBeenCalledOnce();
    expect(
      screen
        .getByRole('button', { name: 'Close help menu' })
        .classList.contains('header-menu__dismiss-backdrop'),
    ).toBe(true);

    helpView.unmount();
    render(
      <OverflowMenu
        isOpen
        connStatus="connected"
        userInitials="ST"
        onClose={onCloseOverflow}
        onOpenConnections={vi.fn()}
        onOpenHelp={vi.fn()}
        onOpenProfile={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Close more actions menu' }),
    );

    expect(onCloseOverflow).toHaveBeenCalledOnce();
    expect(
      screen
        .getByRole('button', { name: 'Close more actions menu' })
        .classList.contains('header-menu__dismiss-backdrop'),
    ).toBe(true);
  });
});

/**
 * A menu can open with nothing focusable in it — an empty notification
 * popover, or one whose items have not arrived. Leaving focus on the trigger
 * then lets Tab move *behind* the open popover, so the container itself takes
 * focus as a fallback. An implementation that only ever focuses a descendant
 * passes every other test in this file and fails here.
 */
function EmptyMenu({ isOpen }: { isOpen: boolean }) {
  const ref = useMenuFocus<HTMLDivElement>(isOpen);
  if (!isOpen) return null;
  return createPortal(
    <div ref={ref} tabIndex={-1} data-testid="empty-menu">
      Nothing to show
    </div>,
    document.body,
  );
}

describe('a menu with no focusable content still takes focus', () => {
  test('focuses the container so Tab cannot walk behind it', () => {
    const view = render(
      <>
        <button type="button" data-testid="bell">
          Notifications
        </button>
        <EmptyMenu isOpen={false} />
      </>,
    );
    const bell = screen.getByTestId('bell');
    bell.focus();

    view.rerender(
      <>
        <button type="button" data-testid="bell">
          Notifications
        </button>
        <EmptyMenu isOpen />
      </>,
    );

    expect(document.activeElement).toBe(screen.getByTestId('empty-menu'));
  });
});

describe('an open menu does not stay open behind the app', () => {
  test('closes when focus leaves it', () => {
    // `tabIndex={-1}` allows programmatic focus but does not put the container
    // in tab order, and the portal sits at the end of the document — so Tab
    // out of an open menu lands in the app behind it. Dismissing on
    // focus-leave is what stops the popover hanging over content the user has
    // moved on to.
    const onClose = vi.fn();
    render(
      <>
        <button type="button" data-testid="after">
          Something else
        </button>
        <MenuWithClose onClose={onClose} />
      </>,
    );

    const menu = screen.getByTestId('empty-menu');
    expect(document.activeElement).toBe(menu);

    const after = screen.getByTestId('after');
    fireEvent.focusOut(menu, { relatedTarget: after });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('stays open while focus moves between its own items', () => {
    const onClose = vi.fn();
    render(<MenuWithItems onClose={onClose} />);

    const [first, second] = screen.getAllByRole('button');
    fireEvent.focusOut(first, { relatedTarget: second });

    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * archive#1245. `useMenuFocus` hand-rolled
 * `if (previouslyFocused?.isConnected) previouslyFocused.focus` — the exact
 * archive#1126 shape — and was the only one of the four bypasses that needed a
 * semantics call rather than a mechanical swap, because a menu is not a modal:
 * it dismisses on focusout by design (#1138 rejected this hook for ConfirmModal
 * for the mirror-image reason).
 *
 * The two behaviours below are what that call comes down to. The restore stays
 * synchronous — these menus stay mounted and merely render null, so a deferred
 * restore could land after the next menu opened.
 *
 * COVERAGE HONESTY: jsdom. It cannot see the shared module's other half — a
 * connected-but-unfocusable survivor, which jsdom reports as focused
 * successfully; that half is `tests/dialog-return-focus.spec.ts`, in Chromium.
 */
describe('a menu whose trigger did not survive (station#1245)', () => {
  test('falls back to the nearest surviving ancestor instead of <body>', () => {
    const list = document.createElement('div');
    const row = document.createElement('div');
    const trigger = document.createElement('button');
    row.append(trigger);
    list.append(row);
    document.body.append(list);
    trigger.focus();

    const view = render(<EmptyMenu isOpen={false} />);
    view.rerender(<EmptyMenu isOpen />);
    expect(document.activeElement).toBe(screen.getByTestId('empty-menu'));

    // A notification popover's trigger is a per-notification button, and the
    // popover can dismiss the notification it belongs to. Pre-fix, `.focus`
    // on the detached trigger was a silent no-op and focus stayed on <body>.
    row.remove();
    view.rerender(<EmptyMenu isOpen={false} />);

    expect(document.activeElement).toBe(list);
    expect(document.activeElement).not.toBe(document.body);
    expect(list.getAttribute('tabindex')).toBe('-1');
    list.remove();
  });

  test('does not yank focus back from wherever the user tabbed to', () => {
    const trigger = document.createElement('button');
    const after = document.createElement('button');
    document.body.append(trigger, after);
    trigger.focus();

    const view = render(<EmptyMenu isOpen={false} />);
    view.rerender(<EmptyMenu isOpen />);

    // Tabbing out of the menu is what dismisses it (`handleFocusOut`), so the
    // restore fires while focus is already on the user's target. The old copy
    // pulled it straight back to the trigger, which made Tab look inert; the
    // shared module leaves an already-claimed focus alone (#1206 gap 1).
    after.focus();
    view.rerender(<EmptyMenu isOpen={false} />);

    expect(document.activeElement).toBe(after);
    trigger.remove();
    after.remove();
  });
});

function MenuWithClose({ onClose }: { onClose: () => void }) {
  const ref = useMenuFocus<HTMLDivElement>(true, onClose);
  return createPortal(
    <div ref={ref} tabIndex={-1} data-testid="empty-menu">
      Nothing to show
    </div>,
    document.body,
  );
}

function MenuWithItems({ onClose }: { onClose: () => void }) {
  const ref = useMenuFocus<HTMLDivElement>(true, onClose);
  return createPortal(
    <div ref={ref} tabIndex={-1}>
      <button type="button">First</button>
      <button type="button">Second</button>
    </div>,
    document.body,
  );
}
