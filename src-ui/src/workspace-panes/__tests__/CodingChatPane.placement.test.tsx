/** @vitest-environment jsdom */

import { render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { CodingChatPane } from '../CodingChatPane';

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

describe('CodingChatPane dock placement', () => {
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    navigationStore.navigate('/', { dockSlotPlacement: null });
    deviceSettingsStore.reset('dockSlotPlacement');
  });

  test('a device-settings change still takes effect after visiting Coding', () => {
    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');

    const view = render(
      <NavigationProvider>
        <CodingChatPane projectId="p" projectSlug="demo" />
      </NavigationProvider>,
    );

    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');
    view.unmount();
    deviceSettingsStore.set('dockSlotPlacement', 'left');
    expect(navigationStore.getSnapshot().dockMode).toBe('left');
  });
});
