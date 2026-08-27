// @vitest-environment jsdom

/**
 * station#1245 — the return-focus restore that a module boundary hid.
 *
 * `ConnectionManagerModalContent` hand-rolled
 * `if (previousFocus?.isConnected) previousFocus.focus()` and could not import
 * the app's copy of the fix, so it kept the station#1126 defect through two
 * consecutive sweeps. The implementation now lives in
 * `@kontourai/station-shared/return-focus`, which this package consumes
 * directly — the point of the move being that there is nothing left to keep in
 * sync, rather than two copies pinned by a test.
 *
 * COVERAGE HONESTY. jsdom, and only the wiring: that this modal captures a
 * chain while the trigger is attached, restores after it has un-inerted the
 * background, and defers to whatever claimed focus in the meantime. jsdom
 * implements neither `inert` nor layout, so the two assertions that need a
 * real browser — an `inert` ancestor refusing focus, and the ordering that
 * depends on it — are in `tests/dialog-return-focus.spec.ts` against Chromium.
 * Neither suite alone covers the behaviour.
 */
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';
import { ConnectionManagerModalContent } from '../react/ConnectionManagerModalContent';
import { ConnectionsProvider } from '../react/ConnectionsContext';

function memoryAdapter(): StorageAdapter {
  const values: Record<string, string> = {};
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

function stubFrame() {
  const frame: { callback: FrameRequestCallback | null } = { callback: null };
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frame.callback = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return frame;
}

let frame: ReturnType<typeof stubFrame>;

beforeEach(() => {
  frame = stubFrame();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountModal(returnFocusTarget?: HTMLElement | null) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  return render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModalContent
        onClose={vi.fn()}
        checkHealth={vi.fn(async () => false)}
        returnFocusTarget={returnFocusTarget}
      />
    </ConnectionsProvider>,
  );
}

describe('Connection Manager return focus (station#1245)', () => {
  test('restores to an explicit parent-owned trigger when the chooser trigger was replaced', () => {
    const addComputer = document.createElement('button');
    const replacedChooserOption = document.createElement('button');
    document.body.append(addComputer, replacedChooserOption);
    replacedChooserOption.focus();

    const view = mountModal(addComputer);
    replacedChooserOption.remove();
    view.unmount();
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(addComputer);
    addComputer.remove();
  });

  test('restores focus to the control that opened it', () => {
    const screenRoot = document.createElement('div');
    const trigger = document.createElement('button');
    screenRoot.append(trigger);
    document.body.append(screenRoot);
    trigger.focus();

    const view = mountModal();
    view.unmount();
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('tabindex')).toBe(false);
    screenRoot.remove();
  });

  /**
   * The shape that makes this modal's copy of the bug reachable rather than
   * theoretical: `OnboardingGate` renders it from its unreachable-host screen,
   * and a successful connect unmounts that whole screen — trigger included.
   * `isConnected` was then false and the old copy did nothing at all, leaving
   * `activeElement` on `<body>` (station#1126).
   */
  test('falls back to a surviving ancestor when connecting unmounted the screen the trigger was on', () => {
    const app = document.createElement('div');
    const gate = document.createElement('div');
    const trigger = document.createElement('button');
    gate.append(trigger);
    app.append(gate);
    document.body.append(app);
    trigger.focus();

    const view = mountModal();
    view.unmount();
    // Connecting swapped the onboarding gate out for the workspace.
    gate.remove();
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(app);
    expect(document.activeElement).not.toBe(document.body);
    expect(app.getAttribute('tabindex')).toBe('-1');
    app.remove();
  });

  /** Gap 1: the workspace this modal just connected to keeps its own focus. */
  test('leaves focus alone when the destination already claimed it', () => {
    const app = document.createElement('div');
    const gate = document.createElement('div');
    const trigger = document.createElement('button');
    const workspaceInput = document.createElement('input');
    gate.append(trigger);
    app.append(gate);
    document.body.append(app, workspaceInput);
    trigger.focus();

    const view = mountModal();
    view.unmount();
    gate.remove();
    workspaceInput.focus();
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(workspaceInput);
    expect(app.hasAttribute('tabindex')).toBe(false);
    app.remove();
    workspaceInput.remove();
  });

  /**
   * The restore runs against a tree that has already been put back the way the
   * modal found it.
   *
   * What makes that true is the *deferral*, not the order of the two
   * statements — proven by injection: moving the restore above the un-inert
   * loop does not fail anything, because the loop is synchronous and the
   * restore is a frame later. Making the restore synchronous does fail, and
   * only in Chromium (`tests/dialog-return-focus.spec.ts`), because jsdom
   * implements no `inert` behaviour at all. So the assertion this test can
   * honestly make is the narrow one: the restore is still pending when the
   * background has been restored.
   */
  test('has already un-inerted the background when the restore runs', () => {
    const sibling = document.createElement('div');
    const trigger = document.createElement('button');
    sibling.append(trigger);
    document.body.append(sibling);
    trigger.focus();

    const view = mountModal();
    // jsdom does not implement `inert` (the property reads back as an expando
    // and has no behaviour), which is exactly why the half of this that
    // matters is a browser test. `aria-hidden` is real here and moves with it.
    expect(sibling.inert).toBe(true);
    expect(sibling.getAttribute('aria-hidden')).toBe('true');

    view.unmount();
    expect(sibling.inert).toBeFalsy();
    expect(sibling.hasAttribute('aria-hidden')).toBe(false);
    // The restore is still pending at this point, so it can only ever see the
    // un-inerted tree.
    expect(frame.callback).not.toBeNull();

    act(() => {
      frame.callback?.(0);
    });
    expect(document.activeElement).toBe(trigger);
    sibling.remove();
  });

  /** The modal must have a dialog to restore focus *from*. */
  test('renders the dialog it is restoring focus from', () => {
    const view = mountModal();
    expect(screen.getByRole('dialog')).toBeTruthy();
    view.unmount();
  });
});
