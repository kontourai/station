/**
 * The engine catalogue's descriptor facts, read from every registered
 * `acpConnectionRegistry` provider (built-in and plugin-contributed) and
 * admitted only after `validateACPEngineDescriptor` accepts them.
 */

import { isDeepStrictEqual } from 'node:util';
import {
  type ACPConnectionRegistryEntry,
  type ACPEngineAuthDescriptor,
  normalizeACPArgs,
  validateACPEngineDescriptor,
} from '@kontourai/station-contracts/acp';
import { argvDelegatesTo } from '@kontourai/station-contracts/engine-credential-provider';
import {
  MANAGED_RUNTIME_SCRIPT_TOKEN,
  managedRuntimeInstallIdOf,
} from '@kontourai/station-contracts/managed-engine-install';
import type { IACPConnectionRegistryProvider } from '../../providers/provider-interfaces.js';
import { listProviders } from '../../providers/registries/registry.js';
import { createLogger } from '../../utils/logger.js';
import { managedRuntimeInstalls } from '../engines/managed-runtime-installs.js';
import { REVIEWED_ENGINE_CREDENTIAL_BINDINGS } from './acp-inbound-extension-policy.js';

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
  // A managed runtime is code Station downloaded and runs; only a reviewed
  // built-in pin may name one.
  if (entry.managedRuntime !== undefined)
    errors.push('managedRuntime is only accepted from built-in entries');
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
 * The built-in managed-runtime entry a connection runs, keyed by its install
 * id (`station-managed:<installId>`), never by the runtime's executable
 * name: two managed engines can both run `node`.
 */
export function managedRuntimeEntryFor(connection: {
  command: string;
}): ACPConnectionRegistryEntry | undefined {
  const installId = managedRuntimeInstallIdOf(connection.command);
  if (!installId) return undefined;
  return listValidatedACPRegistryEntries({ detect: false }).find(
    ({ entry, builtin }) =>
      builtin &&
      entry.managedRuntime?.installId === installId &&
      entry.command === connection.command,
  )?.entry;
}

/**
 * The built-in entry whose descriptor fields apply to a connection: a
 * managed-runtime connection's own entry, else the first built-in (that is
 * not a managed runtime) launching the same executable name.
 */
function descriptorEntryFor(
  connection: { command: string },
  platform: string,
  has: (entry: ACPConnectionRegistryEntry) => boolean,
): ACPConnectionRegistryEntry | undefined {
  if (managedRuntimeInstallIdOf(connection.command)) {
    const entry = managedRuntimeEntryFor(connection);
    return entry && has(entry) ? entry : undefined;
  }
  const name = executableName(connection.command, platform);
  return listValidatedACPRegistryEntries({ detect: false }).find(
    ({ entry, builtin }) =>
      builtin &&
      !entry.managedRuntime &&
      has(entry) &&
      executableName(entry.command, platform) === name,
  )?.entry;
}

/**
 * The built-in descriptor environment for a connection's executable. Keyed on
 * the executable name rather than the connection id: the variables describe
 * the program (an auto-updater, a keychain prompt), so a custom connection
 * running the same program, by name or by full path, needs them as well. A
 * managed-runtime connection is keyed on its install id instead.
 */
export function registryLaunchEnvFor(
  connection: { command: string },
  platform: string = process.platform,
): Record<string, string> | undefined {
  const entry = descriptorEntryFor(
    connection,
    platform,
    (candidate) => candidate.launchEnv !== undefined,
  );
  return entry?.launchEnv ? { ...entry.launchEnv } : undefined;
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
  const entry = descriptorEntryFor(
    connection,
    platform,
    (candidate) => candidate.auth !== undefined,
  );
  return entry?.auth ? { command: entry.command, auth: entry.auth } : undefined;
}

/** Whether `argv0` names the same program as `command`, by executable name. */
export function namesSameExecutable(
  argv0: string,
  command: string,
  platform: string = process.platform,
): boolean {
  return executableName(argv0, platform) === executableName(command, platform);
}

/**
 * How a connection's process is launched, as far as an engine-credential
 * binding needs to know (`AcpCredentialLaunchFacts`). Derived from the
 * connection and the validated built-in table only, never from a caller's
 * claim:
 *
 * - A managed-runtime connection launches its built-in entry's
 *   `managedRuntime.argv` (the `{script}` token stands for the installed
 *   entry script), and nothing else: {@link resolveManagedRuntimeLaunch}
 *   refuses extra arguments.
 * - Any other connection is a built-in launch only when a built-in entry
 *   names exactly its command and arguments.
 */
export function engineLaunchFactsFor(connection: {
  command: string;
  args?: readonly string[];
}): { builtinDescriptor: boolean; argv: readonly string[] } {
  const managed = managedRuntimeEntryFor(connection);
  if (managed?.managedRuntime)
    return {
      builtinDescriptor: managedArgsAccepted(managed, connection.args),
      argv: [...managed.managedRuntime.argv],
    };
  const args = normalizeACPArgs([...(connection.args ?? [])]);
  const builtin =
    !managedRuntimeInstallIdOf(connection.command) &&
    listValidatedACPRegistryEntries({ detect: false }).some(
      ({ entry, builtin }) =>
        builtin &&
        !entry.managedRuntime &&
        entry.command === connection.command &&
        isDeepStrictEqual(normalizeACPArgs(entry.args ?? []), args),
    );
  return { builtinDescriptor: builtin, argv: args };
}

function managedArgsAccepted(
  entry: ACPConnectionRegistryEntry,
  args: readonly string[] | undefined,
): boolean {
  const given = normalizeACPArgs([...(args ?? [])]);
  return (
    given.length === 0 ||
    isDeepStrictEqual(given, normalizeACPArgs(entry.args ?? []))
  );
}

/**
 * Whether Station owns this connection's engine sign-in: a built-in launch
 * that delegates its credential to the host through a reviewed binding (the
 * Kiro bundle). Such a connection is signed in from Station's engine
 * host-auth vault, not by the engine.
 */
export function stationOwnsEngineSignIn(connection: {
  command: string;
  args?: readonly string[];
}): boolean {
  const facts = engineLaunchFactsFor(connection);
  return (
    facts.builtinDescriptor &&
    REVIEWED_ENGINE_CREDENTIAL_BINDINGS.some(
      (binding) =>
        binding.wire.protocol === 'acp' &&
        argvDelegatesTo(facts.argv, binding.delegationArgv),
    )
  );
}

/** A managed engine that is not installed (or not installable here) yet. */
export class ManagedRuntimeNotInstalledError extends Error {
  constructor(
    readonly installId: string,
    engineName: string,
  ) {
    super(
      `${engineName} isn't installed yet. Install it from the engine's sign-in panel in Connections.`,
    );
    this.name = 'ManagedRuntimeNotInstalledError';
  }
}

/** A managed engine connection carrying arguments of its own. */
class ManagedRuntimeLaunchRefusedError extends Error {
  constructor(engineName: string, reason: string) {
    super(`${engineName} cannot be launched: ${reason}.`);
    this.name = 'ManagedRuntimeLaunchRefusedError';
  }
}

/**
 * The program and arguments a managed-runtime connection runs: the
 * install's runtime and the built-in entry's argv with `{script}` replaced.
 * Undefined for any other connection. Throws when the install is missing or
 * the connection adds arguments of its own.
 */
export function resolveManagedRuntimeLaunch(connection: {
  command: string;
  args?: readonly string[];
}): { command: string; args: string[]; installId: string } | undefined {
  const installId = managedRuntimeInstallIdOf(connection.command);
  if (!installId) return undefined;
  const entry = managedRuntimeEntryFor(connection);
  if (!entry?.managedRuntime)
    throw new ManagedRuntimeLaunchRefusedError(
      connection.command,
      'no built-in engine names this managed runtime',
    );
  if (!managedArgsAccepted(entry, connection.args))
    throw new ManagedRuntimeLaunchRefusedError(
      entry.name,
      'a managed engine runs only with the arguments Station pins for it',
    );
  const installed = managedRuntimeInstalls()?.installed(installId);
  if (!installed)
    throw new ManagedRuntimeNotInstalledError(installId, entry.name);
  return {
    command: installed.runtime,
    args: entry.managedRuntime.argv.map((arg) =>
      arg === MANAGED_RUNTIME_SCRIPT_TOKEN ? installed.script : arg,
    ),
    installId,
  };
}
