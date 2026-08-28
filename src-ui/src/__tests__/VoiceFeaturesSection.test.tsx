/** @vitest-environment jsdom */

/**
 * Each setting must be one native button carrying `role="switch"`. A prior
 * implementation put that button inside an activatable outer row, which axe
 * correctly reports as nested interactive controls. These assertions pin the
 * one-control contract for feature, context-provider, and push settings.
 */

import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES } from '@kontourai/station-contracts/device-settings';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: null }),
  useHostUrl: () => ({ hostUrl: 'http://localhost:3141', isDetecting: false }),
  QRDisplay: () => null,
}));

const featureSettings = {
  voiceS2SEnabled: false,
  mobilePairingEnabled: false,
  ttsReadbackEnabled: false,
  pushNotificationsEnabled: false,
  notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
};
const toggleFeature = vi.fn();

vi.mock('../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({
    settings: featureSettings,
    toggle: toggleFeature,
  }),
}));

vi.mock('../contexts/VoiceProviderContext', () => ({
  useVoiceProviderContext: () => ({
    availableSTT: [],
    availableTTS: [],
    activeSTT: null,
    activeTTS: null,
    setSTTProvider: vi.fn(),
    setTTSProvider: vi.fn(),
  }),
}));

const contextProvider = {
  id: 'provider-1',
  name: 'Open files',
  enabled: false,
  description: 'Currently open files in the editor',
};
const toggleProvider = vi.fn();

vi.mock('../contexts/MessageContextContext', () => ({
  useMessageContextContext: () => ({
    providers: [contextProvider],
    toggleProvider,
  }),
}));

vi.mock('../hooks/usePushNotifications', () => ({
  usePushNotifications: () => ({ supported: false }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import {
  NotificationsSection,
  VoiceFeaturesSection,
} from '../views/settings/VoiceFeaturesSection';

function renderRows() {
  render(
    <>
      <VoiceFeaturesSection />
      <NotificationsSection apiBase="http://host" guard={(cb) => cb()} />
    </>,
  );
}

function getSwitch(name: RegExp) {
  return screen.getByRole('switch', { name });
}

function getRow(name: RegExp) {
  return getSwitch(name).closest(
    '.settings__feature-toggle, .settings__toggle-row',
  ) as HTMLElement;
}

/**
 * `spy` is the exact mock the row's activation calls in the real component —
 * both the feature-list row and the push-notifications row share
 * `useFeatureSettings.toggle` (`FEATURE_META`'s voiceS2SEnabled entry and
 * `NotificationsSection`'s pushNotificationsEnabled toggle are two distinct
 * calls into the same mocked function), so their call counts are
 * indistinguishable by count alone across DIFFERENT rows in one test — each
 * row is exercised in isolation per `test`, so that is not a problem here.
 */
const ROWS: Array<{
  label: string;
  name: RegExp;
  spy: () => ReturnType<typeof vi.fn>;
}> = [
  {
    label: 'feature-list row (voice pill)',
    name: /voice pill/i,
    spy: () => toggleFeature,
  },
  {
    label: 'message-context provider row',
    name: /open files/i,
    spy: () => toggleProvider,
  },
  {
    label: 'push-notifications row',
    name: /push notifications/i,
    spy: () => toggleFeature,
  },
];

describe('VoiceFeaturesSection / NotificationsSection — one native switch per row', () => {
  beforeEach(() => {
    toggleFeature.mockClear();
    toggleProvider.mockClear();
  });

  for (const { label, name, spy } of ROWS) {
    describe(label, () => {
      test('the row itself is the only focusable switch', () => {
        renderRows();
        const row = getRow(name);
        const toggle = getSwitch(name);

        expect(toggle).toBe(row);
        expect(toggle.tagName).toBe('BUTTON');
        expect(toggle.getAttribute('tabindex')).toBeNull();
      });

      test('the sole AT stop carries its concise accessible name', () => {
        renderRows();
        const row = getRow(name);

        expect(row.getAttribute('aria-label')).toMatch(name);
        expect(screen.getByRole('switch', { name })).toBe(row);
      });

      test('clicking the row fires its handler exactly once', () => {
        renderRows();
        const row = getRow(name);

        fireEvent.click(row);

        expect(spy()).toHaveBeenCalledTimes(1);
      });

      test('clicking the native switch fires the handler exactly once', () => {
        renderRows();
        const toggle = getSwitch(name);

        fireEvent.click(toggle);

        expect(spy()).toHaveBeenCalledTimes(1);
      });

      test('the row uses native button semantics', () => {
        renderRows();
        const row = getRow(name);

        expect(row.tagName).toBe('BUTTON');
        expect(row.getAttribute('type')).toBe('button');
        expect(row.getAttribute('role')).toBe('switch');
      });

      test('the switch retains its accessible name', () => {
        renderRows();
        expect(getSwitch(name)).toBeTruthy();
      });
    });
  }
});
