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
import { type ReactNode, useState } from 'react';
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

function FirstRenderHash() {
  const [hash] = useState(() => window.location.hash);
  return <output>{hash || 'no hash'}</output>;
}

function pane(active: string, child: ReactNode = <Controls />) {
  const layout = {
    slug: 'pane',
    tabs: [{ id: active }],
  } as LayoutDefinition;
  return (
    <PluginWorkspacePaneSDKBoundary layout={layout} projectSlug="project">
      {child}
    </PluginWorkspacePaneSDKBoundary>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

test('a plugin initializer sees the retained active tab hash on first render', () => {
  sessionStorage.setItem('layout-pane-tab-first', 'view=retained');
  render(pane('first', <FirstRenderHash />));
  expect(screen.getByText('#view=retained')).toBeTruthy();
  expect(window.location.hash).toBe('#view=retained');
});

test('an incoming deep link wins over retained state before the plugin initializes', () => {
  sessionStorage.setItem('layout-pane-tab-first', 'view=retained');
  window.history.replaceState(null, '', '/#view=linked');
  render(pane('first', <FirstRenderHash />));
  expect(screen.getByText('#view=linked')).toBeTruthy();
  expect(sessionStorage.getItem('layout-pane-tab-first')).toBe('view=retained');
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
  const remounted = render(pane('first'));
  expect(window.location.hash).toBe('');
  expect(sessionStorage.getItem('layout-pane-tab-second')).toBe('view=other');
  click('Clear second');
  expect(sessionStorage.getItem('layout-pane-tab-second')).toBeNull();

  click('Save first');
  act(() => vi.advanceTimersToNextFrame());
  remounted.unmount();
  window.history.replaceState(null, '', '/');
  act(() => vi.runAllTimers());
  expect(window.location.hash).toBe('');
  expect(sessionStorage.getItem('layout-pane-tab-first')).toBe('view=old');
});
