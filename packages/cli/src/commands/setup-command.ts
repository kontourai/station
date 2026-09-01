import type { StationProfileCredentialRef } from '@kontourai/station-contracts';
import type {
  PairSavedStationInput,
  PairSavedStationResult,
} from './environment.js';
import {
  CWD,
  DEFAULT_SERVER_PORT,
  DEFAULT_UI_PORT,
  resolveLifecycleHomeTarget,
  resolveLifecycleInstanceId,
} from './helpers.js';
import {
  isLocalSelfAuthCandidate,
  type LocalSelfAuthOutcome,
  selfAuthorizeLocalProfile,
} from './local-self-auth.js';
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
  assertValidProfileName,
  ensureProfileStoreGenesis,
  findProfile,
  isCredentialRefReferenced,
  readProfileStore,
  setDefaultProfile,
  upsertProfile,
} from './profile-store.js';
import type { ServiceInstallReceipt } from './service.js';

const HOSTED_ENDPOINT = 'https://station.kontourai.io';
const HOSTED_NAME = 'station.kontourai.io';

export interface SetupCommandDependencies {
  credentialStore?: ProfileCredentialStore;
  installLocalService: (
    serviceArgs: string[],
  ) => Promise<ServiceInstallReceipt>;
  pair: (input: PairSavedStationInput) => Promise<PairSavedStationResult>;
  /** Test seam for the same-machine local-grant exchange (#1098). */
  selfAuthorizeLocal?: typeof selfAuthorizeLocalProfile;
  stdout?: (value: string) => void;
}

function localProfileEndpoint(host: string | undefined, port: string): string {
  const bindHost = host?.trim() || '127.0.0.1';
  const connectHost =
    bindHost === '0.0.0.0'
      ? '127.0.0.1'
      : bindHost === '::' || bindHost === '[::]'
        ? '[::1]'
        : bindHost.startsWith('[') && bindHost.endsWith(']')
          ? bindHost
          : bindHost.includes(':')
            ? `[${bindHost}]`
            : bindHost;
  return new URL(`http://${connectHost}:${port}`).origin;
}

function retireDiscardedCredential(
  previousRef: StationProfileCredentialRef | undefined,
  dependencies: SetupCommandDependencies,
): void {
  if (!previousRef || isCredentialRefReferenced(previousRef)) return;
  (dependencies.credentialStore ?? getProfileCredentialStore()).delete(
    previousRef,
  );
}

interface ParsedSetupArgs {
  flags: Map<string, string | true>;
  positionals: string[];
}

function parse(args: string[]): ParsedSetupArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const separator = arg.indexOf('=');
    addUniquePairingFlag(
      flags,
      separator < 0 ? arg.slice(2) : arg.slice(2, separator),
      separator < 0 ? true : arg.slice(separator + 1),
    );
  }
  return { flags, positionals };
}

function valueFlag(
  flags: Map<string, string | true>,
  name: string,
  fallback?: string,
): string | undefined {
  const value = pairingValueFlag(flags, name);
  return value ?? fallback;
}

function assertFlags(
  flags: Map<string, string | true>,
  allowed: string[],
): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name))
      throw new Error(`Unknown setup option --${name}.`);
  }
}

/**
 * One setup vocabulary for local, existing, and hosted saved Stations.
 * Only setup deliberately selects a default; failed service or pairing work
 * never leaves a broken target as the default.
 */
export async function runSetupCommand(
  args: string[],
  dependencies: SetupCommandDependencies,
): Promise<void> {
  const stdout = dependencies.stdout ?? console.log;
  const { flags, positionals } = parse(args);
  const [kind, ...values] = positionals;

  if (kind === 'local') {
    assertFlags(flags, [
      'name',
      'base',
      'port',
      'ui-port',
      'instance',
      'features',
      'host',
    ]);
    if (values.length > 0)
      throw new Error(
        'Usage: station setup local [--name=kontour] [service flags]',
      );
    const name = valueFlag(flags, 'name', 'kontour')!;
    assertValidProfileName(name);
    // Fail before mutating the host service for predictable metadata errors.
    // The install receipt below still compensates races and I/O failures that
    // can occur after this preflight.
    readProfileStore();
    // The local service materializes its selected runtime home. Publish the
    // shared profile genesis before that side effect, so a true first install
    // cannot look like a cutover with an unexpectedly missing profiles.json.
    ensureProfileStoreGenesis();
    const port = valueFlag(flags, 'port', String(DEFAULT_SERVER_PORT))!;
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error('--port must be an integer from 1 to 65535.');
    }
    const baseDir = resolveLifecycleHomeTarget({
      baseDir: valueFlag(flags, 'base'),
    }).projectHome;
    const uiPort = valueFlag(flags, 'ui-port', String(DEFAULT_UI_PORT))!;
    const serviceArgs = [
      ...[...flags.entries()]
        .filter(([flag]) => flag !== 'name')
        .map(
          ([flag, value]) => `--${flag}${value === true ? '' : `=${value}`}`,
        ),
      ...(flags.has('base') ? [] : [`--base=${baseDir}`]),
      ...(flags.has('port') ? [] : [`--port=${port}`]),
      ...(flags.has('ui-port') ? [] : [`--ui-port=${uiPort}`]),
    ];
    const endpoint = localProfileEndpoint(valueFlag(flags, 'host'), port);
    const installation = await dependencies.installLocalService(serviceArgs);
    const previousRef = findProfile(name)?.credentialRef;
    let profile: ReturnType<typeof upsertProfile>['profile'];
    try {
      profile = upsertProfile({
        name,
        endpoint,
        setupSource: 'local',
        configurationState: 'configured',
        verifiedBinding: true,
        localService: {
          instanceId: resolveLifecycleInstanceId({
            cwd: CWD,
            instanceName: valueFlag(flags, 'instance'),
            projectHome: baseDir,
            serverPort: Number(port),
            uiPort: Number(uiPort),
          }),
          baseDir,
          serverPort: Number(port),
          uiPort: Number(uiPort),
        },
        makeDefault: true,
        force: true,
      }).profile;
    } catch (profileError) {
      try {
        await installation.rollback();
      } catch (rollbackError) {
        throw new Error(
          `Local Station service installed but saved Station persistence failed (${(profileError as Error).message}); service rollback also failed (${(rollbackError as Error).message}).`,
        );
      }
      throw new Error(
        `Local saved Station persistence failed; the service installation was rolled back: ${(profileError as Error).message}`,
      );
    }
    retireDiscardedCredential(previousRef, dependencies);
    // Same-machine self-authorization (#1098): the install is already
    // durable and the default already selected, so from here on every
    // outcome — including a thrown one — only changes what is REPORTED,
    // never rolls the healthy install back.
    const selfAuthorize =
      dependencies.selfAuthorizeLocal ?? selfAuthorizeLocalProfile;
    let authorization: LocalSelfAuthOutcome;
    try {
      authorization = await selfAuthorize(profile, {
        ...(dependencies.credentialStore
          ? { credentialStore: dependencies.credentialStore }
          : {}),
      });
    } catch (error) {
      authorization = {
        status: 'failed',
        reason: (error as Error).message,
      };
    }
    const installed = `Local Station service installed. Default Station "${profile.name}" targets ${profile.endpoint}`;
    if (authorization.status === 'authorized') {
      stdout(
        `${installed}. CLI authorized; credential stored in the OS credential store.`,
      );
      if (authorization.warning) stdout(authorization.warning);
    } else if (isLocalSelfAuthCandidate(profile)) {
      stdout(
        `${installed}, but the CLI is not yet authorized (${authorization.reason}). It retries automatically on the next station command, or pair explicitly: station stations pair ${profile.name}`,
      );
    } else {
      stdout(
        `${installed}, but the CLI cannot self-authorize a non-loopback endpoint. Pair it explicitly: station stations pair ${profile.name}`,
      );
    }
    return;
  }

  if (kind === 'existing') {
    assertFlags(flags, ['pair', 'device-name']);
    if (values.length !== 2)
      throw new Error(
        'Usage: station setup existing <name> <endpoint> [--pair] [--device-name=<name>]',
      );
    const [name, endpoint] = values as [string, string];
    const shouldPair = pairingBooleanFlag(flags, 'pair');
    if (!shouldPair && flags.has('device-name')) {
      throw new Error('--device-name requires --pair.');
    }
    if (shouldPair) {
      // Pairing owns its one credential + metadata transaction. Do not
      // repoint a working profile/default or retire its credential until that
      // transaction has succeeded.
      const deviceName = valueFlag(flags, 'device-name');
      await dependencies.pair({
        name,
        endpoint,
        ...(deviceName !== undefined ? { deviceName } : {}),
        setupSource: 'existing',
        makeDefault: true,
      });
    } else {
      const previousRef = findProfile(name)?.credentialRef;
      upsertProfile({
        name,
        endpoint,
        setupSource: 'existing',
        configurationState: 'unconfigured',
        force: true,
      });
      setDefaultProfile(name);
      retireDiscardedCredential(previousRef, dependencies);
    }
    stdout(
      `Default Station "${name}" targets ${new URL(endpoint).origin}.${shouldPair ? ' Pairing complete.' : ''}`,
    );
    return;
  }

  if (kind === 'hosted') {
    assertFlags(flags, ['name', 'device-name']);
    if (values.length > 0)
      throw new Error(
        'Usage: station setup hosted [--name=station.kontourai.io] [--device-name=<name>]',
      );
    const name = valueFlag(flags, 'name', HOSTED_NAME)!;
    const deviceName = valueFlag(flags, 'device-name');
    const pairing = await dependencies.pair({
      name,
      endpoint: HOSTED_ENDPOINT,
      ...(deviceName !== undefined ? { deviceName } : {}),
      setupSource: 'hosted',
      makeDefault: true,
    });
    stdout(
      `Hosted Station paired. Default Station "${pairing.profile.name}" targets ${pairing.profile.endpoint}.`,
    );
    return;
  }

  throw new Error(
    'Usage: station setup <local|existing|hosted>\n' +
      '  Setup chooses your default saved Station; the variant is where it lives.\n' +
      '  Only setup selects a default — a failed setup never leaves a broken one.\n' +
      '  station setup local [--name=kontour] [service flags]\n' +
      '      install this machine’s Station service and make it the default\n' +
      '  station setup existing <name> <endpoint> [--pair]\n' +
      '      save a Station that already runs elsewhere (--pair to authorize)\n' +
      '  station setup hosted [--name=station.kontourai.io]\n' +
      '      pair the hosted Station',
  );
}
