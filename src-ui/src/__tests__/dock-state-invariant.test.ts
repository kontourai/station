// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest';
import { navigationStore } from '../contexts/navigation-store';

function dockParams() {
  const params = new URL(window.location.href).searchParams;
  return { dock: params.get('dock'), maximize: params.get('maximize') };
}

// #795 review: `is-collapsed` and `is-maximized` are independent CSS classes
// and the maximized rule wins on height with `!important`, so the pair renders
// as a full-height dock with an emptied body — a blank shell over the app.
// Callers had to remember this individually and one of them didn't, so the
// invariant is enforced in the store.
describe('setDockState: a closed dock is never maximized', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  test('closing clears maximize even when the caller asks to keep it', () => {
    navigationStore.setDockState(true, true);
    expect(dockParams()).toEqual({ dock: 'open', maximize: 'true' });

    navigationStore.setDockState(false, true);

    expect(dockParams()).toEqual({ dock: null, maximize: null });
  });

  test('closing without an explicit flag also clears a live maximize', () => {
    navigationStore.setDockState(true, true);

    navigationStore.setDockState(false);

    expect(dockParams()).toEqual({ dock: null, maximize: null });
  });

  test('opening still honours the requested maximize', () => {
    navigationStore.setDockState(true, true);
    expect(dockParams().maximize).toBe('true');

    navigationStore.setDockState(true, false);
    expect(dockParams().maximize).toBeNull();
  });

  test('opening without an explicit flag leaves the current maximize alone', () => {
    navigationStore.setDockState(true, true);

    navigationStore.setDockState(true);

    expect(dockParams()).toEqual({ dock: 'open', maximize: 'true' });
  });
});
