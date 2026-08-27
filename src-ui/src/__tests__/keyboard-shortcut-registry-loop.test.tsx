/** @vitest-environment jsdom */

import { render } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SkillShortcutRegistrar } from '../components/SkillShortcutRegistrar';
import {
  KeyboardShortcutsProvider,
  useKeyboardShortcuts,
  useShortcutRegistry,
} from '../contexts/KeyboardShortcutsContext';

const mocks = vi.hoisted(() => ({ skills: [] as any[], toast: vi.fn() }));
vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({ data: mocks.skills }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.toast }),
}));

const RUNAWAY_RENDER_LIMIT = 50;
const renderBudget = { spent: 0 };

/**
 * station#3736: enabling a slash command on one skill took out every route.
 *
 * The loop needed three ingredients that all shipped: `register` set provider
 * state, the provider rebuilt its context value on every render, and a
 * consumer of that context passed a fresh callback identity into a registering
 * effect. With zero command skills the effect registered nothing, so nothing
 * changed and the loop was invisible — which is why a fresh home was fine and
 * the first command skill was not.
 *
 * The dock below is that consumer, reduced: it reads the context (ChatDock
 * reads `isMac`) and hands the registrar a callback it rebuilds every render
 * (ChatDock's `onRun` is a `useCallback` over `chatInput.handleCommandSelect`).
 */
function Dock({ onRender }: { onRender?: () => void }) {
  useKeyboardShortcuts();
  onRender?.();
  renderBudget.spent += 1;
  // Without a bound, the loop exhausts the worker's heap before React's own
  // depth guard trips, and the run reds as an out-of-memory crash instead of
  // as this defect. Fail by NAME instead.
  if (renderBudget.spent > RUNAWAY_RENDER_LIMIT) {
    throw new Error(
      'registering a keyboard shortcut re-entered the registrar: unbounded ' +
        'update loop (station#3736)',
    );
  }
  const onRun = (_target: { cmd: string; name: string }) => {};
  return <SkillShortcutRegistrar hasContext onRun={onRun} />;
}

function Reader({ onRender }: { onRender: () => void }) {
  const { getAllShortcuts } = useShortcutRegistry();
  onRender();
  return <span data-testid="count">{getAllShortcuts().length}</span>;
}

describe('keyboard shortcut registry (station#3736)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.skills = [];
    mocks.toast.mockReset();
    renderBudget.spent = 0;
  });

  // The reproduction. Before the fix this renders until React gives up with
  // "Maximum update depth exceeded" (minified: React error #185), and the
  // route's error boundary is what the user sees.
  test('a command skill does not drive the tree into an update loop', () => {
    mocks.skills = [
      { name: 'first-book', command: { enabled: true, global: true } },
    ];
    const renders = vi.fn();

    expect(() =>
      render(
        <KeyboardShortcutsProvider>
          <Dock onRender={renders} />
        </KeyboardShortcutsProvider>,
      ),
    ).not.toThrow();

    // A handful of renders is React being React; an unbounded loop is the
    // defect. Ten is far above the settled cost and far below a runaway.
    expect(renders.mock.calls.length).toBeLessThan(10);
  });

  test('registering does not re-render consumers that only register', () => {
    const dockRenders = vi.fn();
    const { rerender } = render(
      <KeyboardShortcutsProvider>
        <Dock onRender={dockRenders} />
      </KeyboardShortcutsProvider>,
    );
    const settled = dockRenders.mock.calls.length;

    mocks.skills = [
      { name: 'first-book', command: { enabled: true, global: true } },
    ];
    rerender(
      <KeyboardShortcutsProvider>
        <Dock onRender={dockRenders} />
      </KeyboardShortcutsProvider>,
    );

    // One render for the prop change. Registering the new skill's chord must
    // not add another: a registration is not news to a component that never
    // reads the registry.
    expect(dockRenders.mock.calls.length).toBe(settled + 1);
  });

  test('a reader sees a new shortcut, and only when there is one', () => {
    const readerRenders = vi.fn();
    function Harness() {
      const [, force] = useState(0);
      const forceRef = useRef(force);
      forceRef.current = force;
      useEffect(() => {
        // A sibling re-rendering for its own reasons must not republish the
        // registry. `useKeyboardShortcut`'s deps are stable, so a re-render
        // does not re-register at all — which is what keeps the loop closed
        // now that a re-registration IS observable (it changes the entry's
        // registration token; see `registrySignature`).
        forceRef.current((current) => (current < 3 ? current + 1 : current));
      });
      return (
        <KeyboardShortcutsProvider>
          <Dock />
          <Reader onRender={readerRenders} />
        </KeyboardShortcutsProvider>
      );
    }

    mocks.skills = [
      { name: 'first-book', command: { enabled: true, global: true } },
    ];
    const view = render(<Harness />);
    expect(view.getByTestId('count').textContent).toBe('1');
    const afterFirst = readerRenders.mock.calls.length;

    mocks.skills = [
      { name: 'first-book', command: { enabled: true, global: true } },
      { name: 'second-book', command: { enabled: true, global: true } },
    ];
    view.rerender(<Harness />);
    expect(view.getByTestId('count').textContent).toBe('2');
    expect(readerRenders.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
