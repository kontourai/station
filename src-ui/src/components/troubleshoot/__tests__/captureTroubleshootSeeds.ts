/**
 * Test helper for #4470 entry points: records the seed the start flow would
 * receive for each open event, by running the host's own
 * `troubleshootSeedFromEvent` on it. `TroubleshootHost.test.tsx` proves the
 * host hands that seed to prepare.
 */
import type { TroubleshootSeed } from '@kontourai/station-contracts/troubleshoot';
import { OPEN_TROUBLESHOOT_EVENT } from '../../../lib/troubleshootEvents';
import { troubleshootSeedFromEvent } from '../troubleshootSeed';

export function captureTroubleshootSeeds() {
  const seeds: Array<TroubleshootSeed | undefined> = [];
  const listener = (event: Event) =>
    seeds.push(troubleshootSeedFromEvent(event));
  window.addEventListener(OPEN_TROUBLESHOOT_EVENT, listener);
  return {
    seeds,
    stop: () => window.removeEventListener(OPEN_TROUBLESHOOT_EVENT, listener),
  };
}
