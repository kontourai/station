// @vitest-environment jsdom
import type { LayoutDefinition } from '@kontourai/station-contracts/layout';
import { useLayoutNavigation } from '@kontourai/station-sdk';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { PluginWorkspacePaneSDKBoundary } from '../PluginWorkspacePaneSDKBoundary';

vi.mock('../../core/SDKAdapter', () => ({
  SDKAdapter: ({ children }: { children: ReactNode }) => children,
}));

function Controls() {
  const { clearTabState, setTabState } = useLayoutNavigation();
  return (
    <>
      <button type="button" onClick={() => setTabState('first', 'view=old')}>
        Save first
      </button>
      <button type="button" onClick={() => clearTabState('first')}>
        Clear first
      </button>
      <button type="button" onClick={() => clearTabState('second')}>
        Clear second
      </button>
    </>
  );
}

function pane(active: string) {
  const layout = {
    slug: 'pane',
    tabs: [{ id: active }],
  } as LayoutDefinition;
  return (
    <PluginWorkspacePaneSDKBoundary layout={layout} projectSlug="project">
      <Controls />
    </PluginWorkspacePaneSDKBoundary>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

test('clearing a tab cancels its delayed restoration and survives switches and remount', () => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  sessionStorage.setItem('layout-pane-tab-second', 'view=other');
  const view = render(pane('first'));
  const click = (name: string) =>
    fireEvent.click(screen.getByRole('button', { name }));

  click('Save first');
  expect(window.location.hash).toBe('#view=old');
  window.history.replaceState(null, '', '/');
  act(() => vi.runAllTimers());
  expect(window.location.hash).toBe('#view=old');

  click('Save first');
  act(() => vi.advanceTimersToNextFrame());
  click('Clear first');
  act(() => vi.runAllTimers());
  expect(window.location.hash).toBe('');
  expect(sessionStorage.getItem('layout-pane-tab-first')).toBeNull();

  view.rerender(pane('second'));
  expect(window.location.hash).toBe('#view=other');
  view.rerender(pane('first'));
  expect(window.location.hash).toBe('');

  view.unmount();
  render(pane('first'));
  expect(window.location.hash).toBe('');
  expect(sessionStorage.getItem('layout-pane-tab-second')).toBe('view=other');
  click('Clear second');
  expect(sessionStorage.getItem('layout-pane-tab-second')).toBeNull();
});
