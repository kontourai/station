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

function refusalReasons(
  entry: ACPConnectionRegistryEntry,
  builtin: boolean,
  builtinIds: ReadonlySet<string>,
): string[] {
  const errors = validateACPEngineDescriptor(entry);
  if (builtin) return errors;
  // A plugin entry may not change how Station launches an executable, and may
  // not replace a built-in card (and with it the install command shown under
  // that engine's name). It can still list engines under its own ids.
  if (entry.launchEnv !== undefined)
    errors.push('launchEnv is only accepted from built-in entries');
  if (builtinIds.has(entry.id))
    errors.push(`id '${entry.id}' belongs to a built-in engine`);
  return errors;
}

/**
 * Registry entries whose descriptor validates, built-in providers first. An
 * entry with an invalid descriptor is refused whole (and logged) rather than
 * shown with the bad fields dropped: a half-applied descriptor would launch
 * the engine with only some of the environment its author intended.
 */
export function listValidatedACPRegistryEntries(
  options: { detect?: boolean } = {},
): ValidatedACPRegistryEntry[] {
  const listed = listProviders('acpConnectionRegistry')
    .map((registered) => ({
      builtin: registered.builtin === true,
      source: registered.source,
      entries:
        (registered.provider as IACPConnectionRegistryProvider).listAvailable?.(
          options,
        ) ?? [],
    }))
    .sort((a, b) => Number(b.builtin) - Number(a.builtin));
  const builtinIds = new Set(
    listed
      .filter(({ builtin }) => builtin)
      .flatMap(({ entries }) => entries.map((entry) => entry.id)),
  );
  const admitted: ValidatedACPRegistryEntry[] = [];
  for (const { builtin, source, entries } of listed) {
    for (const entry of entries) {
      const errors = refusalReasons(entry, builtin, builtinIds);
      if (errors.length > 0) {
        logger.warn('Refused engine registry entry', {
          entryId: entry.id,
          source,
          errors,
        });
        continue;
      }
      admitted.push({ entry, builtin, source });
    }
  }
  return admitted;
}

/** `/opt/homebrew/bin/goose` and `C:\…\goose.exe` both name `goose`. */
function executableName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat)$/i, '');
}

/**
 * The built-in descriptor environment for a connection's executable. Keyed on
 * the executable name rather than the connection id: the variables describe
 * the program (an auto-updater, a keychain prompt), so a custom connection
 * running the same program, by name or by full path, needs them as well.
 */
export function registryLaunchEnvFor(connection: {
  command: string;
}): Record<string, string> | undefined {
  const name = executableName(connection.command);
  const match = listValidatedACPRegistryEntries({ detect: false }).find(
    ({ entry, builtin }) =>
      builtin && entry.launchEnv && executableName(entry.command) === name,
  );
  return match?.entry.launchEnv ? { ...match.entry.launchEnv } : undefined;
}
