/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  NavigationProvider,
  useNavigationActions,
} from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';

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
  navigationStore.navigate('/', { dock: 'open', maximize: 'true' });
});
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
  expect(navigationStore.lastDockMaximized).toBe(true);
});
test('an explicit maximized conversation deep link retains its requested size', () => {
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
