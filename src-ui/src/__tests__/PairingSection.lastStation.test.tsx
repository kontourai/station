/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { PairingSection } from '../views/settings/PairingSection';

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile: true }),
}));

vi.mock('../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({
    settings: { mobilePairingEnabled: false },
    toggle: vi.fn(),
  }),
}));

afterEach(() => {
  deviceSettingsStore.reset('openLastStationOnLaunch');
});

test('the phone can choose its next-launch Station in device settings', () => {
  render(<PairingSection />);
  const toggle = screen.getByRole('switch', {
    name: 'Open last Station on launch',
  });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(toggle.getAttribute('aria-describedby')).toBe(
    'open-last-station-description',
  );

  fireEvent.click(toggle);
  expect(deviceSettingsStore.get('openLastStationOnLaunch')).toBe(false);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
});
