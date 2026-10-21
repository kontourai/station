/**
 * The engine catalogue's descriptor facts, read from every registered
 * `acpConnectionRegistry` provider (built-in and plugin-contributed) and
 * admitted only after `validateACPEngineDescriptor` accepts them.
 */

import {
  type ACPConnectionRegistryEntry,
  validateACPEngineDescriptor,
} from '@kontourai/station-contracts/acp';
import type { IACPConnectionRegistryProvider } from '../../providers/provider-interfaces.js';
import { listProviders } from '../../providers/registries/registry.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'acp-engine-descriptors' });

export interface ValidatedACPRegistryEntry {
  entry: ACPConnectionRegistryEntry;
  builtin: boolean;
  source: string;
}

/**
 * Registry entries whose descriptor validates, in provider order. An entry
 * with an invalid descriptor is refused whole (and logged) rather than shown
 * with the bad fields dropped: a half-applied descriptor would launch the
 * engine with only some of the environment its author intended.
 */
export function listValidatedACPRegistryEntries(
  options: { detect?: boolean } = {},
): ValidatedACPRegistryEntry[] {
  const admitted: ValidatedACPRegistryEntry[] = [];
  for (const registered of listProviders('acpConnectionRegistry')) {
    const provider = registered.provider as IACPConnectionRegistryProvider;
    for (const entry of provider.listAvailable?.(options) ?? []) {
      const errors = validateACPEngineDescriptor(entry);
      if (errors.length > 0) {
        logger.warn(
          'Refused engine registry entry with an invalid descriptor',
          {
            entryId: entry.id,
            source: registered.source,
            errors,
          },
        );
        continue;
      }
      admitted.push({
        entry,
        builtin: registered.builtin === true,
        source: registered.source,
      });
    }
  }
  return admitted;
}

/**
 * The descriptor environment for a connection's command. Keyed on the
 * command rather than the connection id: the variables describe the
 * executable (an auto-updater, a keychain prompt), so a custom connection
 * running the same command needs them just as much.
 */
export function registryLaunchEnvFor(connection: {
  command: string;
}): Record<string, string> | undefined {
  const match = listValidatedACPRegistryEntries({ detect: false }).find(
    ({ entry }) => entry.command === connection.command && entry.launchEnv,
  );
  return match?.entry.launchEnv ? { ...match.entry.launchEnv } : undefined;
}
