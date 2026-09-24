import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import { LocalMobileDeviceHost } from '../../mobile-device/mobile-device-host.js';
import { explicitDeviceHubEndpoint } from '../device-hub-endpoint.js';
import { createDeviceToolRunner, DeviceToolsService } from '../device-tools.js';

/**
 * REAL Tools drawer evidence (#1971), against a real simulator through the
 * real host tools (`xcrun simctl`) and a real device hub. Nothing is mocked.
 * Every case SKIPS, naming why, unless BOTH:
 *
 * - `STATION_REAL_DEVICE_HUB_URL` names a running expo-device-hub (see
 *   experiments/mobile-device/README.md), and
 * - an iOS simulator is already booted (this test never boots one).
 *
 * On a Linux runner neither exists and every case reports a skip.
 * Each case restores what it changed. Classified process-heavy in
 * scripts/vitest-resource-manifest.mjs.
 */

const HUB = process.env.STATION_REAL_DEVICE_HUB_URL;
const EVIDENCE = process.env.STATION_REAL_DEVICE_EVIDENCE;
const run = promisify(execFile);

function record(fact: Record<string, unknown>): void {
  if (EVIDENCE)
    appendFileSync(
      EVIDENCE,
      `${JSON.stringify({ at: new Date().toISOString(), ...fact })}\n`,
    );
}

async function bootedSimulator(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await run(
      'xcrun',
      ['simctl', 'list', 'devices', 'booted', '-j'],
      { timeout: 15_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as {
      devices: Record<string, { udid: string; state: string }[]>;
    };
    return Object.values(parsed.devices)
      .flat()
      .find((device) => device.state === 'Booted')?.udid;
  } catch {
    return undefined;
  }
}

const prerequisites = (async () => {
  if (!HUB)
    return {
      skip: 'STATION_REAL_DEVICE_HUB_URL is unset, so no device hub is reachable.',
    } as const;
  const udid = await bootedSimulator();
  if (!udid)
    return {
      skip: 'No booted iOS simulator (this test never boots one); on non-macOS hosts there is none.',
    } as const;
  const endpoint = explicitDeviceHubEndpoint(HUB);
  const host = new LocalMobileDeviceHost({ hub: endpoint, timeoutMs: 30_000 });
  try {
    // The serve-sim helper answers the foreground app and the tree.
    await host.attachStream(udid);
  } catch (error) {
    return {
      skip: `The device hub did not attach a helper: ${String(error)}`,
    } as const;
  }
  return {
    udid,
    tools: new DeviceToolsService({
      runner: createDeviceToolRunner(),
      hub: endpoint,
      timeoutMs: 30_000,
    }),
  } as const;
})();

const restores: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const restore of restores.reverse()) await restore().catch(() => {});
}, 60_000);

describe('real Tools drawer on a booted iOS simulator', () => {
  test.for([
    { name: 'foreground app and appearance, read back' },
    { name: 'appearance set, then read back from the device' },
    { name: 'location set and clear (iOS reports last-set, never a reading)' },
    { name: 'accessibility tree' },
    { name: 'push to an installed app' },
  ])('$name', async ({ name }, context) => {
    const ready = await prerequisites;
    if ('skip' in ready) return context.skip(ready.skip);
    const target = {
      hostId: 'local',
      platform: 'ios' as const,
      deviceId: ready.udid,
    };
    const tools = ready.tools;
    if (name.startsWith('foreground')) {
      const snapshot = await tools.snapshot(target);
      record({ step: 'snapshot', snapshot });
      expect(snapshot.foregroundApp.state).toBe('read');
      expect(snapshot.appearance.state).toBe('read');
    } else if (name.startsWith('appearance')) {
      const before = await tools.snapshot(target);
      if (before.appearance.state !== 'read')
        throw new Error('appearance unreadable');
      const original = before.appearance.value;
      const flipped = original === 'dark' ? 'light' : 'dark';
      restores.push(() =>
        tools.act(target, { type: 'set-appearance', appearance: original }),
      );
      const result = await tools.act(target, {
        type: 'set-appearance',
        appearance: flipped,
      });
      record({
        step: 'appearance',
        original,
        set: flipped,
        readBack: result.snapshot.appearance,
      });
      expect(result.snapshot.appearance).toEqual({
        state: 'read',
        value: flipped,
      });
    } else if (name.startsWith('location')) {
      restores.push(() => tools.act(target, { type: 'clear-location' }));
      const set = await tools.act(target, {
        type: 'set-location',
        latitude: -33.8688,
        longitude: 151.2093,
      });
      record({ step: 'location-set', readBack: set.snapshot.location });
      expect(set.snapshot.location).toMatchObject({
        state: 'last-set',
        value: { latitude: -33.8688, longitude: 151.2093 },
      });
      const cleared = await tools.act(target, { type: 'clear-location' });
      expect(cleared.snapshot.location).toMatchObject({
        state: 'last-set',
        value: null,
      });
    } else if (name.startsWith('accessibility')) {
      const tree = await tools.accessibility(target);
      record({
        step: 'accessibility',
        space: tree.space,
        count: tree.elements.length,
        sample: tree.elements.slice(0, 3),
      });
      expect(tree.space.width).toBeGreaterThan(1);
      expect(tree.elements.length).toBeGreaterThan(0);
      for (const element of tree.elements) {
        expect(element.x).toBeGreaterThanOrEqual(0);
        expect(element.x + element.width).toBeLessThanOrEqual(1.0001);
      }
    } else {
      const result = await tools.act(target, {
        type: 'send-push',
        appId: 'com.apple.Preferences',
        payload: { aps: { alert: 'Station Tools drawer real test' } },
      });
      record({ step: 'push', push: result.push });
      expect(result.push).toBe('sent');
    }
  });
});
