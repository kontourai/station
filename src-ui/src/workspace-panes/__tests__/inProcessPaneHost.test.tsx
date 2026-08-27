/**
 * @vitest-environment jsdom
 */

import type { WorkspacePaneHostContract } from '@kontourai/station-contracts/workspace-pane-host-contract';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: hoisted.navigate }),
}));

let isMobile = false;
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobile,
}));

import { bannerStore } from '../../contexts/banner-store';
import { toastStore } from '../../contexts/ToastContext';
import {
  BOARD_UNAVAILABLE_BANNER_ID,
  BOARD_UNAVAILABLE_NOTICE,
  type InProcessPaneHost,
  useInProcessWorkspacePaneHost,
} from '../inProcessPaneHost';

/**
 * The in-process adapter is the tier-2 half of the pane-host contract
 * (station#4201, `docs/design/pane-host-contract.md`): these tests prove
 * each contract member lands on the shell capability it maps — and, for
 * `confirm`, prove the design's central semantics: the SHELL renders its
 * own ConfirmModal when a pane calls `host.confirm(...)`; the pane receives
 * only a promise of the decision, never a component.
 */

let latest: InProcessPaneHost | null = null;

function Harness({
  projectSlug,
  active = true,
}: {
  projectSlug?: string;
  active?: boolean;
}) {
  latest = useInProcessWorkspacePaneHost({ projectSlug, active });
  // Mirrors a real mounter: the chrome renders only while the pane does.
  return <>{active ? latest.confirmChrome : null}</>;
}

function host(): WorkspacePaneHostContract {
  if (!latest) throw new Error('Harness has not rendered');
  return latest.host;
}

describe('useInProcessWorkspacePaneHost', () => {
  beforeEach(() => {
    hoisted.navigate.mockClear();
    isMobile = false;
    latest = null;
    bannerStore.dismiss(BOARD_UNAVAILABLE_BANNER_ID);
  });

  test('host.confirm opens the SHELL ConfirmModal and resolves confirmed', async () => {
    render(<Harness projectSlug="demo" />);
    expect(screen.queryByRole('dialog')).toBeNull();

    let decision: Promise<string> | null = null;
    act(() => {
      decision = host().confirm({
        title: 'Confirm action',
        message: 'Proceed with "restart"?',
      });
    });

    // The shell's chrome, rendered by the placement — not by the pane.
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Confirm action');
    expect(dialog.textContent).toContain('Proceed with "restart"?');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(decision).resolves.toBe('confirmed');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('host.confirm resolves cancelled when the user dismisses', async () => {
    render(<Harness projectSlug="demo" />);
    let decision: Promise<string> | null = null;
    act(() => {
      decision = host().confirm({ title: 'Confirm action', message: 'Sure?' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(decision).resolves.toBe('cancelled');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a superseded confirm request settles as cancelled, never dangles', async () => {
    render(<Harness projectSlug="demo" />);
    let first: Promise<string> | null = null;
    let second: Promise<string> | null = null;
    act(() => {
      first = host().confirm({ title: 'First', message: 'one' });
    });
    act(() => {
      second = host().confirm({ title: 'Second', message: 'two' });
    });

    await expect(first).resolves.toBe('cancelled');
    expect(screen.getByRole('dialog').textContent).toContain('Second');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(second).resolves.toBe('confirmed');
  });

  test('a confirm outlived by the host unmount settles as cancelled', async () => {
    const { unmount } = render(<Harness projectSlug="demo" />);
    let pending: Promise<string> | null = null;
    act(() => {
      pending = host().confirm({ title: 'Outlived', message: 'still open?' });
    });
    expect(screen.getByRole('dialog').textContent).toContain('Outlived');

    // The pane is taken away while the dialog is still open -- navigated away
    // from, or replaced as the dock occupant. The awaiting pane must not be
    // left holding a promise that can never settle.
    act(() => {
      unmount();
    });

    // Races the pending promise so a REGRESSION fails as an assertion naming
    // the dangle, not as an opaque suite timeout.
    const settled = await Promise.race([
      pending as unknown as Promise<string>,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('DANGLED'), 50);
      }),
    ]);
    expect(settled).toBe('cancelled');
  });

  test('a confirm outlived by the PANE settles, and cannot resurface', async () => {
    // The mounter stays mounted -- the host hook sits above its guards, so
    // hooks cannot be conditional -- but one of its guards starts failing and
    // it stops rendering the pane and the chrome. The host's own unmount
    // never fires, so this is a different lifetime from the test above.
    const { rerender } = render(<Harness projectSlug="demo" active />);
    let pending: Promise<string> | null = null;
    act(() => {
      pending = host().confirm({ title: 'Outlived', message: 'still open?' });
    });
    expect(screen.getByRole('dialog').textContent).toContain('Outlived');

    act(() => {
      rerender(<Harness projectSlug="demo" active={false} />);
    });

    const settled = await Promise.race([
      pending as unknown as Promise<string>,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('DANGLED'), 50);
      }),
    ]);
    expect(settled).toBe('cancelled');

    // And the request is CLEARED, so the guard passing again cannot bring a
    // dead pane's dialog back -- answering it would run its closure.
    act(() => {
      rerender(<Harness projectSlug="demo" active />);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('navigate maps the project-workspace target onto the shell path grammar', () => {
    render(<Harness projectSlug="demo" />);

    host().navigate({
      kind: 'project-workspace',
      projectSlug: 'demo',
      taskSlug: 'my-task',
    });
    expect(hoisted.navigate).toHaveBeenCalledWith('/projects/demo', {
      task: 'my-task',
    });

    host().navigate({ kind: 'project-workspace', projectSlug: 'demo' });
    expect(hoisted.navigate).toHaveBeenLastCalledWith('/projects/demo', {});
  });

  test('notify lands on the toast store', () => {
    const show = vi.spyOn(toastStore, 'show').mockReturnValue('toast-id');
    try {
      render(<Harness projectSlug="demo" />);
      host().notify({ text: 'Saved', tone: 'info' });
      expect(show).toHaveBeenCalledWith('Saved');
    } finally {
      show.mockRestore();
    }
  });

  test("presentUnavailable('no-builder-run') presents D8's one notice and leaves for the project page", () => {
    render(<Harness projectSlug="demo" />);
    act(() => {
      host().presentUnavailable('no-builder-run');
    });

    const banner = bannerStore
      .getSnapshot()
      .find((item) => item.id === BOARD_UNAVAILABLE_BANNER_ID);
    expect(banner?.message).toBe(BOARD_UNAVAILABLE_NOTICE);
    // The redirect goes through the same target→route resolution every other
    // navigation uses, which always passes an explicit params object; `{}`
    // writes no query fields, exactly as omitting the argument did.
    expect(hoisted.navigate).toHaveBeenCalledWith('/projects/demo', {});
  });

  test('presentUnavailable without a bound project presents nothing', () => {
    render(<Harness />);
    act(() => {
      host().presentUnavailable('no-builder-run');
    });

    expect(
      bannerStore
        .getSnapshot()
        .some((item) => item.id === BOARD_UNAVAILABLE_BANNER_ID),
    ).toBe(false);
    expect(hoisted.navigate).not.toHaveBeenCalled();
  });

  test('facts.read reflects the shell mobile derivation; subscribe pushes on change', () => {
    const { rerender } = render(<Harness projectSlug="demo" />);
    expect(host().facts.read().device.isMobile).toBe(false);

    const listener = vi.fn();
    const unsubscribe = host().facts.subscribe(listener);

    isMobile = true;
    rerender(<Harness projectSlug="demo" />);
    expect(listener).toHaveBeenCalledWith({ device: { isMobile: true } });
    expect(host().facts.read().device.isMobile).toBe(true);

    unsubscribe();
    listener.mockClear();
    isMobile = false;
    rerender(<Harness projectSlug="demo" />);
    expect(listener).not.toHaveBeenCalled();
  });
});
