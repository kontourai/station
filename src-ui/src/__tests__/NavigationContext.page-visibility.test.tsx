/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  NavigationProvider,
  useNavigationActions,
} from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';

const screenSize = vi.hoisted(() => ({ mobile: false }));
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => screenSize.mobile,
}));

function Controls() {
  const { navigate } = useNavigationActions();
  return (
    <>
      <button type="button" onClick={() => navigate('/settings')}>
        Settings
      </button>
      <button
        type="button"
        onClick={() => navigate('/?chat=fixture&dock=open&maximize=true')}
      >
        Conversation
      </button>
    </>
  );
}
beforeEach(() => {
  screenSize.mobile = false;
  navigationStore.navigate('/', { dock: 'open', maximize: 'true' });
});
test.each(['/', '/settings'])(
  'opening a page from %s on a phone closes the full-height chat while remembering its size',
  (origin) => {
    screenSize.mobile = true;
    navigationStore.navigate(origin, { dock: 'open', maximize: 'true' });
    render(
      <NavigationProvider>
        <Controls />
      </NavigationProvider>,
    );
    fireEvent.click(screen.getByText('Settings'));
    expect(window.location.pathname).toBe('/settings');
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);
    expect(navigationStore.lastDockMaximized).toBe(true);
  },
);
afterEach(() => {
  navigationStore.navigate('/', { dock: null, maximize: null });
});
test('opening Settings reveals the page and retains the explicit chat size for return', () => {
  render(
    <NavigationProvider>
      <Controls />
    </NavigationProvider>,
  );
  fireEvent.click(screen.getByText('Settings'));
  expect(window.location.pathname).toBe('/settings');
  expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
  expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
  expect(navigationStore.lastDockMaximized).toBe(true);
});
test('an explicit maximized conversation deep link retains its requested size', () => {
  screenSize.mobile = true;
  render(
    <NavigationProvider>
      <Controls />
    </NavigationProvider>,
  );
  fireEvent.click(screen.getByText('Conversation'));
  expect(new URLSearchParams(window.location.search).get('chat')).toBe(
    'fixture',
  );
  expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
});

test('a cancelled phone page navigation leaves the chat visible at its original size', () => {
  screenSize.mobile = true;
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('dirty chat'),
    (_proceed, reject) => reject?.(),
  );
  try {
    render(
      <NavigationProvider>
        <Controls />
      </NavigationProvider>,
    );
    fireEvent.click(screen.getByText('Settings'));
    expect(window.location.pathname).toBe('/');
    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
    expect(navigationStore.lastDockMaximized).toBe(true);
  } finally {
    unregister();
  }
});
