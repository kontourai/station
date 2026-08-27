import type { PublicStationHandshake } from '@kontourai/station-contracts';
import { describe, expect, test } from 'vitest';
import { hasCapability } from '../capability.js';

describe('hasCapability', () => {
  test('returns false when the descriptor is null or undefined', () => {
    expect(hasCapability(null, 'sshEnvironments')).toBe(false);
    expect(hasCapability(undefined, 'sshEnvironments')).toBe(false);
  });

  test('returns false when the descriptor has no `capabilities` object (pre-#1095 host)', () => {
    const descriptor: Pick<PublicStationHandshake, 'capabilities'> = {};
    expect(hasCapability(descriptor, 'sshEnvironments')).toBe(false);
  });

  test('returns false when `capabilities` is present but the specific key is absent', () => {
    const descriptor: Pick<PublicStationHandshake, 'capabilities'> = {
      capabilities: { sshEnvironments: true },
    };
    expect(hasCapability(descriptor, 'webPushNotifications')).toBe(false);
  });

  test('returns false when the flag is explicitly false', () => {
    const descriptor: Pick<PublicStationHandshake, 'capabilities'> = {
      capabilities: { sshEnvironments: false },
    };
    expect(hasCapability(descriptor, 'sshEnvironments')).toBe(false);
  });

  test('returns true only when the flag is explicitly true', () => {
    const descriptor: Pick<PublicStationHandshake, 'capabilities'> = {
      capabilities: { sshEnvironments: true, webPushNotifications: false },
    };
    expect(hasCapability(descriptor, 'sshEnvironments')).toBe(true);
    expect(hasCapability(descriptor, 'webPushNotifications')).toBe(false);
  });
});
