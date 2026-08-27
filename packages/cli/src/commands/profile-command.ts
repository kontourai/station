import { type PairSavedStationInput, pairSavedStation } from './environment.js';
import {
  addUniquePairingFlag,
  pairingBooleanFlag,
  pairingValueFlag,
} from './pairing-flags.js';
import {
  getProfileCredentialStore,
  type ProfileCredentialStore,
} from './profile-credentials.js';
import {
  clearProjectProfile,
  describeKnownProfiles,
  findProfile,
  isCredentialRefReferenced,
  readProfileStore,
  readProjectProfileSelection,
  removeProfile,
  setDefaultProfile,
  setProjectProfile,
  upsertProfile,
} from './profile-store.js';

export interface StationsCommandDependencies {
  credentialStore?: ProfileCredentialStore;
  stdout?: (value: string) => void;
  pair?: (input: PairSavedStationInput) => Promise<unknown>;
}

const USAGE = `Usage:
  station stations list
  station stations show <name>
  station stations add <name> <endpoint> [--pair] [--default] [--force]
  station stations edit <name> <endpoint> [--pair] [--default] [--force]
  station stations pair <name> [--force]
  station stations use <name>
  station stations forget <name>
  station stations project show|use <name>|clear
  station stations export`;

function splitArgs(args: string[]): {
  positionals: string[];
  flags: Map<string, string | true>;
} {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      const name = separator < 0 ? arg.slice(2) : arg.slice(2, separator);
      addUniquePairingFlag(
        flags,
        name,
        separator < 0 ? true : arg.slice(separator + 1),
      );
    } else positionals.push(arg);
  }
  return { positionals, flags };
}

function assertKnownFlags(
  flags: Map<string, string | true>,
  allowed: string[],
): void {
  for (const flag of flags.keys()) {
    if (!allowed.includes(flag))
      throw new Error(`Unknown option --${flag}.\n\n${USAGE}`);
  }
}

function required(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (!value)
    throw new Error(`Missing required argument: ${label}\n\n${USAGE}`);
  return value;
}

function stationProjection(name: string) {
  const station = findProfile(name);
  if (!station)
    throw new Error(`No Station named "${name}". ${describeKnownProfiles()}`);
  return {
    name: station.name,
    endpoint: station.endpoint,
    environmentId: station.environmentId ?? null,
    setupSource: station.setupSource,
    configurationState: station.configurationState,
    credential: station.credentialRef
      ? getProfileCredentialStore().status(station.credentialRef)
      : 'not-configured',
  };
}

function printList(stdout: (value: string) => void): void {
  const store = readProfileStore();
  if (store.profiles.length === 0) {
    stdout(
      'No Stations saved. Add one with: station stations add <name> <endpoint>',
    );
    return;
  }
  const rows = store.profiles
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.max(4, ...rows.map((profile) => profile.name.length));
  stdout(`  ${'NAME'.padEnd(nameWidth)}  ENDPOINT  CREDENTIAL`);
  for (const profile of rows) {
    const marker =
      store.defaultProfile?.toLowerCase() === profile.name.toLowerCase()
        ? '*'
        : ' ';
    const credential = profile.credentialRef
      ? getProfileCredentialStore().status(profile.credentialRef)
      : 'not-configured';
    stdout(
      `${marker} ${profile.name.padEnd(nameWidth)}  ${profile.endpoint}  ${credential}`,
    );
  }
  stdout(
    '\n* = default Station. Saved Station metadata never contains bearer material.',
  );
}

export async function runStationsCommand(
  args: string[],
  dependencies: StationsCommandDependencies = {},
): Promise<void> {
  const stdout = dependencies.stdout ?? console.log;
  const credentialStore =
    dependencies.credentialStore ?? getProfileCredentialStore();
  const [action, ...rest] = args;
  switch (action ?? 'list') {
    case 'list': {
      const { flags } = splitArgs(rest);
      assertKnownFlags(flags, []);
      printList(stdout);
      return;
    }
    case 'show': {
      const { positionals, flags } = splitArgs(rest);
      assertKnownFlags(flags, []);
      stdout(
        JSON.stringify(
          stationProjection(required(positionals, 0, '<name>')),
          null,
          2,
        ),
      );
      return;
    }
    case 'add':
    case 'edit': {
      const { positionals, flags } = splitArgs(rest);
      assertKnownFlags(flags, [
        'default',
        'force',
        'pair',
        'device-name',
        'timeout',
      ]);
      const name = required(positionals, 0, '<name>');
      const endpoint = required(positionals, 1, '<endpoint>');
      const shouldPair = pairingBooleanFlag(flags, 'pair');
      const shouldForce = pairingBooleanFlag(flags, 'force');
      const shouldDefault = pairingBooleanFlag(flags, 'default');
      if (!shouldPair && (flags.has('device-name') || flags.has('timeout'))) {
        throw new Error(
          `--device-name and --timeout require --pair.\n\n${USAGE}`,
        );
      }
      if (shouldPair) {
        const pair =
          dependencies.pair ??
          ((input: PairSavedStationInput) =>
            pairSavedStation(input, { credentialStore, stdout }));
        const timeout = pairingValueFlag(flags, 'timeout');
        const deviceName = pairingValueFlag(flags, 'device-name');
        await pair({
          name,
          endpoint,
          force: shouldForce,
          allowEndpointReplacement: action === 'edit' || shouldForce,
          makeDefault: shouldDefault,
          ...(deviceName !== undefined ? { deviceName } : {}),
          ...(timeout ? { timeoutSeconds: Number(timeout) } : {}),
        });
        return;
      }
      const previousRef = findProfile(name)?.credentialRef;
      const result = upsertProfile({
        name,
        endpoint,
        makeDefault: shouldDefault,
        force: action === 'edit' || shouldForce,
      });
      if (
        previousRef &&
        previousRef.id !== result.profile.credentialRef?.id &&
        !isCredentialRefReferenced(previousRef)
      ) {
        credentialStore.delete(previousRef);
      }
      const authentication = result.profile.credentialRef
        ? 'Existing credential remains configured.'
        : `Credential not configured; pair it with: station stations pair ${result.profile.name}`;
      stdout(
        `${result.replaced ? 'Edited' : 'Added'} Station "${result.profile.name}" → ${result.profile.endpoint}${result.isDefault ? ' (default)' : ''}. ${authentication}`,
      );
      return;
    }
    case 'pair': {
      const { positionals, flags } = splitArgs(rest);
      assertKnownFlags(flags, ['force', 'device-name', 'timeout']);
      const station = findProfile(required(positionals, 0, '<name>'));
      if (!station) {
        throw new Error(
          `No Station named "${positionals[0]}". ${describeKnownProfiles()}`,
        );
      }
      const pair =
        dependencies.pair ??
        ((input: PairSavedStationInput) =>
          pairSavedStation(input, { credentialStore, stdout }));
      const timeout = pairingValueFlag(flags, 'timeout');
      const deviceName = pairingValueFlag(flags, 'device-name');
      await pair({
        name: station.name,
        endpoint: station.endpoint,
        force: pairingBooleanFlag(flags, 'force'),
        ...(deviceName !== undefined ? { deviceName } : {}),
        ...(timeout ? { timeoutSeconds: Number(timeout) } : {}),
      });
      return;
    }
    case 'use': {
      const { positionals, flags } = splitArgs(rest);
      assertKnownFlags(flags, []);
      const profile = setDefaultProfile(required(positionals, 0, '<name>'));
      stdout(`Default Station is now "${profile.name}" (${profile.endpoint}).`);
      return;
    }
    case 'forget': {
      const { positionals, flags } = splitArgs(rest);
      assertKnownFlags(flags, []);
      const { profile, wasDefault } = removeProfile(
        required(positionals, 0, '<name>'),
      );
      if (
        profile.credentialRef &&
        !isCredentialRefReferenced(profile.credentialRef)
      ) {
        credentialStore.delete(profile.credentialRef);
      }
      stdout(
        `Forgot Station "${profile.name}" (${profile.endpoint}).${wasDefault ? ' It was the default Station.' : ''}`,
      );
      return;
    }
    case 'project': {
      const [projectAction, ...projectArgs] = rest;
      const { positionals, flags } = splitArgs(projectArgs);
      assertKnownFlags(flags, []);
      if (projectAction === 'show') {
        const selected = readProjectProfileSelection();
        stdout(
          selected
            ? `Project Station for this directory is "${selected}".`
            : 'No Station is selected for this directory.',
        );
        return;
      }
      if (projectAction === 'use') {
        const profile = setProjectProfile(required(positionals, 0, '<name>'));
        stdout(
          `Project Station for this directory is now "${profile.name}" (${profile.endpoint}).`,
        );
        return;
      }
      if (projectAction === 'clear') {
        clearProjectProfile();
        stdout("Cleared this directory's Station selection.");
        return;
      }
      throw new Error(
        `Usage: station stations project show|use <name>|clear\n\n${USAGE}`,
      );
    }
    case 'export': {
      const { flags } = splitArgs(rest);
      assertKnownFlags(flags, []);
      // The store contract excludes secret values by construction.
      stdout(JSON.stringify(readProfileStore(), null, 2));
      return;
    }
    default:
      throw new Error(
        `Unknown Stations action: ${action}\n\n${USAGE}\n\n${describeKnownProfiles()}`,
      );
  }
}
