import { describe, expect, test } from 'vitest';
import {
  DEFAULT_STATION_CHANNEL,
  resolveStationChannel,
  STATION_CHANNEL_PORTS,
  stationChannelPorts,
} from '../ports.js';

describe('Station channel port allocation', () => {
  test('keeps every fixed channel server and UI port disjoint', () => {
    const ports = Object.values(STATION_CHANNEL_PORTS).flatMap((channel) => [
      channel.serverPort,
      channel.uiPort,
    ]);
    expect(new Set(ports).size).toBe(ports.length);
  });

  test('keeps the full dynamic development range disjoint from fixed channels', () => {
    const fixed = new Set<number>(
      Object.values(STATION_CHANNEL_PORTS).flatMap((channel) => [
        channel.serverPort,
        channel.uiPort,
      ]),
    );
    const development = stationChannelPorts('development');
    for (let offset = 1; offset <= 500; offset += 1) {
      expect(fixed.has(development.serverPort + offset)).toBe(false);
      expect(fixed.has(development.uiPort + offset)).toBe(false);
      expect(development.serverPort + offset).toBeLessThan(
        development.uiPort + 1,
      );
    }
    expect(development.serverPort + 1).toBe(39141);
    expect(development.uiPort + 1).toBe(40141);
    expect(development.serverPort + 2).toBe(39142);
    expect(development.uiPort + 2).toBe(40142);
    // station#3677: the consent listener rides the same block at +3, and the
    // channel contract publishes it explicitly.
    expect(development.serverPort + 3).toBe(39143);
    expect(development.consentPort).toBe(39143);
  });

  test('resolves known channels and defaults blank input to development', () => {
    expect(DEFAULT_STATION_CHANNEL).toBe('development');
    expect(resolveStationChannel()).toBe('development');
    expect(resolveStationChannel('  beta  ')).toBe('beta');
    expect(stationChannelPorts('nightly')).toMatchObject({
      instanceDirectory: 'nightly',
      serverPort: 38141,
      uiPort: 38000,
    });
    expect(() => resolveStationChannel('preview')).toThrow(/STATION_CHANNEL/);
  });
});
