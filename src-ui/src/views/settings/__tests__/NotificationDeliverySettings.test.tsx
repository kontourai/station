/** @vitest-environment jsdom */

import {
  defaultNotificationPreferences,
  type NotificationPreferencesV1,
} from '@kontourai/station-contracts/notification-preferences';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  preferences: {
    isLoading: false,
    error: null as Error | null,
    data: undefined as NotificationPreferencesV1 | undefined,
  },
  devices: [] as Array<{ id: string; name: string; revokedAt: number | null }>,
  mutate: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useNotificationPreferencesQuery: () => state.preferences,
  usePairedDevicesQuery: () => ({ data: state.devices }),
  useUpdateNotificationPreferencesMutation: () => ({
    mutate: state.mutate,
    isPending: false,
    error: null,
  }),
}));

import NotificationDeliverySettings from '../NotificationDeliverySettings';

function saved(): NotificationPreferencesV1 {
  expect(state.mutate).toHaveBeenCalledTimes(1);
  return state.mutate.mock.calls[0]![0] as NotificationPreferencesV1;
}

beforeEach(() => {
  state.mutate.mockReset();
  state.preferences = {
    isLoading: false,
    error: null,
    data: defaultNotificationPreferences(),
  };
  state.devices = [
    { id: 'phone', name: 'Pixel', revokedAt: null },
    { id: 'old', name: 'Old tablet', revokedAt: 5 },
  ];
});

describe('NotificationDeliverySettings', () => {
  test('changing the agent level saves the whole document with only that field changed', () => {
    render(<NotificationDeliverySettings />);
    fireEvent.change(screen.getByLabelText('Agent notifications'), {
      target: { value: 'attention-only' },
    });
    expect(saved()).toEqual({
      ...defaultNotificationPreferences(),
      agentNotifications: 'attention-only',
    });
  });

  test('turning quiet hours on writes a complete window; off removes it', () => {
    const { unmount } = render(<NotificationDeliverySettings />);
    fireEvent.click(screen.getByLabelText('Quiet hours'));
    expect(saved().quietHours).toEqual({
      start: '22:00',
      end: '07:00',
      allowAttention: true,
    });
    unmount();

    state.mutate.mockReset();
    state.preferences.data = {
      ...defaultNotificationPreferences(),
      quietHours: { start: '22:00', end: '07:00', allowAttention: true },
    };
    render(<NotificationDeliverySettings />);
    fireEvent.click(screen.getByLabelText('Quiet hours'));
    expect('quietHours' in saved()).toBe(false);
  });

  test('a quiet window that would be empty is not saved', () => {
    state.preferences.data = {
      ...defaultNotificationPreferences(),
      quietHours: { start: '22:00', end: '07:00', allowAttention: true },
    };
    render(<NotificationDeliverySettings />);
    fireEvent.change(screen.getByLabelText('Quiet hours start'), {
      target: { value: '07:00' },
    });
    expect(state.mutate).not.toHaveBeenCalled();
  });

  test('per-device settings list active devices only and save under device:<id>', () => {
    render(<NotificationDeliverySettings />);
    expect(screen.queryByText('Old tablet')).toBeNull();
    fireEvent.change(screen.getByLabelText('Pixel: interrupt for'), {
      target: { value: 'failed' },
    });
    expect(saved().perSurface).toEqual({
      'device:phone': { minUrgency: 'failed', hideContent: false },
    });
  });

  test('an unreadable saved document says so and offers a reset, not a form', () => {
    state.preferences = {
      isLoading: false,
      error: new Error('The saved notification preferences could not be read.'),
      data: undefined,
    };
    render(<NotificationDeliverySettings />);
    expect(
      screen.getByText('Notification delivery settings could not be loaded'),
    ).toBeTruthy();
    expect(
      screen.getByText('The saved notification preferences could not be read.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Agent notifications')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(saved()).toEqual(defaultNotificationPreferences());
  });
});
