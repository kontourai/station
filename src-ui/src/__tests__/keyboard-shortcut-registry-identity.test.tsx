/** @vitest-environment jsdom */

import { act, render } from '@testing-library/react';
import { memo, useEffect } from 'react';
import { describe, expect, test, vi } from 'vitest';
import {
  type KeyboardShortcut,
  KeyboardShortcutsProvider,
  useKeyboardShortcuts,
  useShortcutRegistry,
} from '../contexts/KeyboardShortcutsContext';

/**
 * What a reader can OBSERVE about the registry, and therefore what has to
 * publish (sol review, LOW). The first signature sorted registration order away
 * and omitted handlers, so two registrations under one id with identical
 * metadata and different handlers replaced the entry in silence — an open
 * command palette kept the retired action while the keyboard dispatched the
 * new one.
 */
type Register = (shortcut: KeyboardShortcut) => () => void;

let registerRef: Register = () => () => undefined;
let readerRenders = 0;
let observed: KeyboardShortcut[] = [];

function Registrar() {
  registerRef = useKeyboardShortcuts().register;
  return null;
}

/**
 * Memoized and propless on purpose: with the provider's context value stable,
 * the ONLY thing that can re-render this is the registry's own notification.
 * An unmemoized reader re-renders whenever its parent does, which makes every
 * "and the reader was told" assertion pass without a publish.
 */
const Reader = memo(function Reader() {
  const { getAllShortcuts } = useShortcutRegistry();
  readerRenders += 1;
  observed = getAllShortcuts();
  return null;
});

function harness() {
  readerRenders = 0;
  observed = [];
  const view = render(
    <KeyboardShortcutsProvider>
      <Registrar />
      <Reader />
    </KeyboardShortcutsProvider>,
  );
  return { view, register: (s: KeyboardShortcut) => registerRef(s) };
}

const chord = (
  id: string,
  handler: () => void,
  overrides: Partial<KeyboardShortcut> = {},
): KeyboardShortcut => ({
  id,
  key: 'j',
  modifiers: ['cmd'],
  description: 'Do the thing',
  handler,
  ...overrides,
});

describe('keyboard shortcut registry identity', () => {
  test('a second registration under one id replaces the first, and says so', () => {
    const { register } = harness();
    const first = vi.fn();
    const second = vi.fn();

    act(() => {
      register(chord('app.thing', first));
    });
    expect(observed.map((s) => s.id)).toEqual(['app.thing']);
    const afterFirst = readerRenders;

    // Same id, same metadata, DIFFERENT handler. Nothing a reader renders has
    // changed — but what it would invoke has.
    act(() => {
      register(chord('app.thing', second));
    });
    expect(readerRenders).toBeGreaterThan(afterFirst);
    expect(observed).toHaveLength(1);

    observed[0].handler();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  test('the reader sees registration order, and replacing in place keeps it', () => {
    const { register } = harness();
    act(() => {
      register(chord('app.first', vi.fn()));
      register(chord('app.second', vi.fn()));
    });
    // Equal-priority dispatch resolves by this order, so a reader has to see it.
    expect(observed.map((s) => s.id)).toEqual(['app.first', 'app.second']);

    // Re-registering an id in place does not reshuffle precedence — `Map.set`
    // keeps an existing key's position — but it is still a change, because the
    // handler behind that id may not be the same one.
    const beforeReplace = readerRenders;
    act(() => {
      register(chord('app.first', vi.fn()));
    });
    expect(observed.map((s) => s.id)).toEqual(['app.first', 'app.second']);
    expect(readerRenders).toBeGreaterThan(beforeReplace);
  });

  test('unregistering and re-registering DOES move it, and publishes', () => {
    const { register } = harness();
    let disposeFirst: () => void = () => undefined;
    act(() => {
      disposeFirst = register(chord('app.first', vi.fn()));
      register(chord('app.second', vi.fn()));
    });
    expect(observed.map((s) => s.id)).toEqual(['app.first', 'app.second']);

    const beforeReorder = readerRenders;
    act(() => {
      disposeFirst();
      register(chord('app.first', vi.fn()));
    });
    // Which of two equal-priority shortcuts fires just changed, and the reader
    // is holding the new order.
    //
    // Honest limit: this case does NOT discriminate order-in-the-signature.
    // The unregister publishes on its own (the set shrank), so a reader is
    // notified even by a signature that sorts order away — verified against
    // that negative control. Order is in the signature because it is part of
    // what a reader observes, not because this test would catch its removal;
    // the tests above are what catch a signature that omits an entry's
    // registration token.
    expect(observed.map((s) => s.id)).toEqual(['app.second', 'app.first']);
    expect(readerRenders).toBeGreaterThan(beforeReorder);
  });

  test('a superseded registration cannot retract the one that replaced it', () => {
    const { register } = harness();
    let disposeFirst: () => void = () => undefined;
    act(() => {
      disposeFirst = register(chord('app.thing', vi.fn()));
      register(chord('app.thing', vi.fn()));
    });
    expect(observed.map((s) => s.id)).toEqual(['app.thing']);

    act(() => {
      disposeFirst();
    });
    expect(observed.map((s) => s.id)).toEqual(['app.thing']);
  });

  test('unmounting a registrant removes its shortcut', () => {
    function Owner({ live }: { live: boolean }) {
      const { register } = useKeyboardShortcuts();
      useEffect(() => {
        if (!live) return;
        return register(chord('app.owned', vi.fn()));
      }, [live, register]);
      return null;
    }
    readerRenders = 0;
    observed = [];
    const view = render(
      <KeyboardShortcutsProvider>
        <Owner live />
        <Reader />
      </KeyboardShortcutsProvider>,
    );
    expect(observed.map((s) => s.id)).toEqual(['app.owned']);

    view.rerender(
      <KeyboardShortcutsProvider>
        <Owner live={false} />
        <Reader />
      </KeyboardShortcutsProvider>,
    );
    expect(observed.map((s) => s.id)).toEqual([]);
  });

  test('a reader that unmounts stops being notified, and nothing throws', () => {
    const { view, register } = harness();
    act(() => {
      register(chord('app.thing', vi.fn()));
    });
    const beforeUnmount = readerRenders;

    view.rerender(
      <KeyboardShortcutsProvider>
        <Registrar />
      </KeyboardShortcutsProvider>,
    );
    expect(() =>
      act(() => {
        register(chord('app.other', vi.fn()));
      }),
    ).not.toThrow();
    expect(readerRenders).toBe(beforeUnmount);
  });
});
