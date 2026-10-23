/**
 * The engine catalogue's descriptor facts, read from every registered
 * `acpConnectionRegistry` provider (built-in and plugin-contributed) and
 * admitted only after `validateACPEngineDescriptor` accepts them.
 */

import {
  type ACPConnectionRegistryEntry,
  type ACPEngineAuthDescriptor,
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
 * Cyrillic and Greek letters that render like Latin ones. Not a full
 * confusables table: enough that a plugin cannot pass "Gооse" (Cyrillic о)
 * off as Goose. NFKC already folds fullwidth and compatibility forms.
 */
const CONFUSABLE_SKELETON: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  з: '3',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
};

/** The form two names are compared in: NFKC, case-folded, confusables mapped, spacing collapsed. */
export function nameSkeleton(name: unknown): string {
  // Entries come from plugin code, so a missing or non-string name is possible.
  if (typeof name !== 'string') return '';
  // Characters that render as nothing are dropped, so they cannot make two
  // names that look alike compare different.
  return [
    ...name
      .normalize('NFKC')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
      .toLowerCase(),
  ]
    .map((char) => CONFUSABLE_SKELETON[char] ?? char)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Names a plugin provider may not register under: it would read as Station's own. */
const RESERVED_PROVIDER_NAMES = ['station', 'kontour'];

function refusalReasons(
  entry: ACPConnectionRegistryEntry,
  builtin: boolean,
  builtinIds: ReadonlySet<string>,
  builtinNames: ReadonlySet<string>,
  source: string,
): string[] {
  const errors = validateACPEngineDescriptor(entry);
  if (builtin) return errors;
  if (nameSkeleton(entry.name) === '') errors.push('name is required');
  // The card and its "Provided by" line are what a person trusts the install
  // command by, so neither may read as a built-in engine or as Station.
  if (builtinNames.has(nameSkeleton(entry.name)))
    errors.push(`name '${entry.name}' reads as a built-in engine`);
  const sourceSkeleton = nameSkeleton(source);
  if (
    RESERVED_PROVIDER_NAMES.includes(sourceSkeleton) ||
    builtinNames.has(sourceSkeleton)
  )
    errors.push(`provider name '${source}' is reserved`);
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
  const builtinNames = new Set(
    listed
      .filter(({ builtin }) => builtin)
      .flatMap(({ entries }) =>
        entries.map((entry) => nameSkeleton(entry.name)),
      ),
  );
  const admitted: ValidatedACPRegistryEntry[] = [];
  for (const { builtin, source, entries } of listed) {
    for (const entry of entries) {
      const errors = refusalReasons(
        entry,
        builtin,
        builtinIds,
        builtinNames,
        source,
      );
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

/**
 * The program a command names: `/opt/homebrew/bin/goose` is `goose`. On
 * Windows, where paths use `\`, executables carry `.exe`/`.cmd`/`.bat` and
 * names are case-insensitive, `C:\tools\Goose.EXE` is `goose` too. POSIX
 * names stay exact.
 */
function executableName(command: string, platform: string): string {
  if (platform !== 'win32') return command.split('/').pop() ?? command;
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/**
 * The built-in descriptor environment for a connection's executable. Keyed on
 * the executable name rather than the connection id: the variables describe
 * the program (an auto-updater, a keychain prompt), so a custom connection
 * running the same program, by name or by full path, needs them as well.
 */
export function registryLaunchEnvFor(
  connection: { command: string },
  platform: string = process.platform,
): Record<string, string> | undefined {
  const name = executableName(connection.command, platform);
  const match = listValidatedACPRegistryEntries({ detect: false }).find(
    ({ entry, builtin }) =>
      builtin &&
      entry.launchEnv &&
      executableName(entry.command, platform) === name,
  );
  return match?.entry.launchEnv ? { ...match.entry.launchEnv } : undefined;
}

/**
 * The built-in sign-in descriptor for a connection's executable, keyed like
 * {@link registryLaunchEnvFor}. Built-in only: a status command is a program
 * Station runs on its own, so plugin descriptors never supply one.
 */
export function registryAuthFor(
  connection: { command: string },
  platform: string = process.platform,
): { command: string; auth: ACPEngineAuthDescriptor } | undefined {
  const name = executableName(connection.command, platform);
  const match = listValidatedACPRegistryEntries({ detect: false }).find(
    ({ entry, builtin }) =>
      builtin && entry.auth && executableName(entry.command, platform) === name,
  );
  return match?.entry.auth
    ? { command: match.entry.command, auth: match.entry.auth }
    : undefined;
}

/** Whether `argv0` names the same program as `command`, by executable name. */
export function namesSameExecutable(
  argv0: string,
  command: string,
  platform: string = process.platform,
): boolean {
  return executableName(argv0, platform) === executableName(command, platform);
}
