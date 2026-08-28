import type { KeyboardEvent } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { type ActivatableProps, activatable } from '../activatable';

/**
 * A KeyboardEvent stub carrying only what `activatable` reads or calls.
 * `currentTarget` identity matters: Space press provenance is keyed on the
 * element, so a press and its release must share one `el` to pair up.
 */
function keyEvent(
  key: string,
  overrides: {
    defaultPrevented?: boolean;
    repeat?: boolean;
    el?: object;
  } = {},
) {
  const preventDefault = vi.fn();
  return {
    event: {
      key,
      defaultPrevented: overrides.defaultPrevented ?? false,
      repeat: overrides.repeat ?? false,
      preventDefault,
      currentTarget: overrides.el ?? {},
    } as unknown as KeyboardEvent<Element>,
    preventDefault,
  };
}

function asActivatable(
  props: ReturnType<typeof activatable>,
): ActivatableProps {
  if (!('onKeyDown' in props)) {
    throw new Error('expected activatable props, got the inert shape');
  }
  return props as ActivatableProps;
}

/** Press-and-release on ONE element, the way a real interaction arrives. */
function pressKey(props: ActivatableProps, key: string) {
  const el = {};
  const down = keyEvent(key, { el });
  props.onKeyDown(down.event);
  const up = keyEvent(key, { el });
  props.onKeyUp(up.event);
  return { down, up };
}

describe('activatable', () => {
  test('gives a static element the role, tab stop and click handler it lacked', () => {
    const onActivate = vi.fn();
    const props = asActivatable(activatable(onActivate));

    expect(props.role).toBe('button');
    expect(props.tabIndex).toBe(0);

    props.onClick({} as never);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  // Native semantics : Enter fires on keydown; Space fires
  // on KEYUP with the scroll default suppressed on keydown — a full
  // press-and-release of either activates a button exactly once.
  test.each(['Enter', ' '])(
    'a full press-and-release of %s activates a button exactly once',
    (key) => {
      const onActivate = vi.fn();
      const props = asActivatable(activatable(onActivate));

      const { down } = pressKey(props, key);

      expect(onActivate).toHaveBeenCalledTimes(1);
      // Space would scroll the page and Enter can submit an enclosing form.
      expect(down.preventDefault).toHaveBeenCalledTimes(1);
    },
  );

  test('Space activates on keyup, not keydown — a held key cannot auto-repeat the action', () => {
    const onActivate = vi.fn();
    const props = asActivatable(activatable(onActivate));

    // Hold: initial keydown plus auto-repeats, all on one element. Nothing
    // fires yet, but the scroll default is suppressed throughout.
    const el = {};
    props.onKeyDown(keyEvent(' ', { el }).event);
    props.onKeyDown(keyEvent(' ', { repeat: true, el }).event);
    props.onKeyDown(keyEvent(' ', { repeat: true, el }).event);
    expect(onActivate).not.toHaveBeenCalled();

    // Release: exactly one activation, because keyup cannot repeat.
    props.onKeyUp(keyEvent(' ', { el }).event);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  test('a held Enter activates once — auto-repeat keydowns are ignored', () => {
    const onActivate = vi.fn();
    const props = asActivatable(activatable(onActivate));

    props.onKeyDown(keyEvent('Enter').event);
    props.onKeyDown(keyEvent('Enter', { repeat: true }).event);
    props.onKeyDown(keyEvent('Enter', { repeat: true }).event);

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  // ARIA links follow native-link behavior: Enter navigates, Space remains
  // the page-scroll key. Hijacking Space on a breadcrumb would break
  // scrolling for keyboard users anywhere a link has focus.
  test('role "link": Enter activates; Space neither activates nor blocks scrolling', () => {
    const onActivate = vi.fn();
    const props = asActivatable(activatable(onActivate, { role: 'link' }));

    props.onKeyDown(keyEvent('Enter').event);
    expect(onActivate).toHaveBeenCalledTimes(1);

    const spaceDown = keyEvent(' ');
    props.onKeyDown(spaceDown.event);
    const spaceUp = keyEvent(' ');
    props.onKeyUp(spaceUp.event);

    expect(onActivate).toHaveBeenCalledTimes(1);
    // The scroll default must survive — preventDefault would hijack it.
    expect(spaceDown.preventDefault).not.toHaveBeenCalled();
    expect(spaceUp.preventDefault).not.toHaveBeenCalled();
  });

  // a Space keyup with no live press on the SAME
  // element must not activate. Native buttons cancel on focus-away and on a
  // prevented press; these pin that the primitive does too.
  test('an orphan Space keyup (no prior keydown on this element) does NOT activate', () => {
    const onActivate = vi.fn();
    const props = asActivatable(activatable(onActivate));

    // Focus arrived mid-hold: the release is the first event seen here.
    props.onKeyUp(keyEvent(' ').event);

    expect(onActivate).not.toHaveBeenCalled();
  });

  test('a press whose keydown was prevented by a nested handler does not activate on release', () => {
    const onActivate = vi.fn();
    const props = asActivatable(activatable(onActivate));
    const el = {};

    // The keydown was already handled (defaultPrevented) — never armed.
    props.onKeyDown(keyEvent(' ', { defaultPrevented: true, el }).event);
    // The keyup itself arrives clean.
    props.onKeyUp(keyEvent(' ', { el }).event);

    expect(onActivate).not.toHaveBeenCalled();
  });

  test('blur mid-hold cancels the press — release after refocus does not activate', () => {
    const onActivate = vi.fn();
    const props = asActivatable(activatable(onActivate));
    const el = {};

    props.onKeyDown(keyEvent(' ', { el }).event);
    props.onBlur({
      currentTarget: el,
    } as unknown as import('react').FocusEvent<Element>);
    props.onKeyUp(keyEvent(' ', { el }).event);

    expect(onActivate).not.toHaveBeenCalled();
  });

  test('a full same-element press-and-release still activates exactly once (provenance does not break the happy path)', () => {
    const onActivate = vi.fn();
    const props = asActivatable(activatable(onActivate));
    const el = {};

    props.onKeyDown(keyEvent(' ', { el }).event);
    props.onKeyUp(keyEvent(' ', { el }).event);
    expect(onActivate).toHaveBeenCalledTimes(1);

    // A SECOND release with no new press is stale — must not fire again.
    props.onKeyUp(keyEvent(' ', { el }).event);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  test.each(['Tab', 'Escape', 'a', 'ArrowDown'])(
    'ignores %s, leaving navigation and typing alone',
    (key) => {
      const onActivate = vi.fn();
      const props = asActivatable(activatable(onActivate));

      const down = keyEvent(key);
      props.onKeyDown(down.event);
      const up = keyEvent(key);
      props.onKeyUp(up.event);

      expect(onActivate).not.toHaveBeenCalled();
      expect(down.preventDefault).not.toHaveBeenCalled();
      expect(up.preventDefault).not.toHaveBeenCalled();
    },
  );

  test('does not double-fire when something nested already handled the key', () => {
    const onActivate = vi.fn();
    const props = asActivatable(activatable(onActivate));

    props.onKeyDown(keyEvent('Enter', { defaultPrevented: true }).event);
    props.onKeyUp(keyEvent(' ', { defaultPrevented: true }).event);

    expect(onActivate).not.toHaveBeenCalled();
  });

  // The chat dock's project row is also the dock's click-to-toggle surface,
  // so its handler must `stopPropagation` or selecting a project also
  // collapses the dock. Passing the event to onClick alone would have fixed
  // the mouse and shipped that exact bug to the keyboard.
  test('the activation event reaches the handler on BOTH the mouse and key paths', () => {
    const seen: string[] = [];
    const props = asActivatable(
      activatable((event) => {
        event.stopPropagation();
        seen.push(event.type);
      }),
    );

    const click = { type: 'click', stopPropagation: vi.fn() };
    props.onClick(click as never);
    expect(click.stopPropagation).toHaveBeenCalledTimes(1);

    const key = {
      type: 'keydown',
      key: 'Enter',
      defaultPrevented: false,
      repeat: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    props.onKeyDown(key as unknown as KeyboardEvent<Element>);
    expect(key.stopPropagation).toHaveBeenCalledTimes(1);

    expect(seen).toEqual(['click', 'keydown']);
  });

  test('role "link" is carried through for navigation, not flattened to button', () => {
    const props = asActivatable(activatable(() => {}, { role: 'link' }));
    expect(props.role).toBe('link');
  });

  test('an accessible name is set only when one is supplied', () => {
    const named = asActivatable(activatable(() => {}, { label: 'Go home' }));
    expect(named['aria-label']).toBe('Go home');

    const unnamed = asActivatable(activatable(() => {}));
    expect('aria-label' in unnamed).toBe(false);
  });

  test.each([undefined, null])(
    'a %s handler yields NO role and NO tab stop',
    (handler) => {
      // A focusable control that does nothing on activation is worse than
      // static text: it spends a tab stop and promises an action it will not
      // perform. Conditionally-inert call sites (a breadcrumb segment with no
      // route behind it) depend on this.
      expect(activatable(handler)).toEqual({});
    },
  );
});
