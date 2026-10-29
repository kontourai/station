import type { ACPConnectionRegistryEntry } from '@kontourai/station-contracts/acp';

/**
 * The one discovery fact a catalogue card may carry. `detected === false` is
 * the host lookup's own negative answer; an absent `detected` means no lookup
 * answered, which claims nothing.
 */
export function registryEntryDiscovery(
  entry: Pick<ACPConnectionRegistryEntry, 'detected'>,
): 'detected-unconfigured' | 'not-installed' | undefined {
  if (entry.detected === true) return 'detected-unconfigured';
  if (entry.detected === false) return 'not-installed';
  return undefined;
}
