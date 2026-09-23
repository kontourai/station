/**
 * Composition root for the Browser pane's server side on a personal host
 * (#90 lane C): acquisition, the per-Project session registry, and a
 * Chromium host factory bound to this Station's listener set.
 */
import { findRunning } from '@kontourai/station-shared/instance-registry';
import { createLogger } from '../../utils/logger.js';
import type { BrowserHost } from './browser-host.js';
import { LocalTargetStore } from './browser-local-targets.js';
import {
  type BrowserProfile,
  BrowserSessionRegistry,
} from './browser-session-registry.js';
import { ChromiumAcquisition } from './chromium-acquisition.js';
import type { EgressPolicy } from './egress-policy.js';
import {
  BrowserHostExitedError,
  ChromiumServerHost,
} from './hosts/chromium-server-host.js';
import { LocalPortScanner } from './local-port-scanner.js';
import {
  deriveStationListeners,
  localInterfaceAddresses,
  type StationInstancePorts,
  type StationListeners,
} from './station-listeners.js';

const logger = createLogger({ name: 'browser-service' });

/** Re-read the instance registry at most this often (per connection check). */
const INSTANCE_REFRESH_MS = 2_000;

export interface BrowserServiceOptions {
  stationHome: string;
  serverPort: number;
  consentPort?: number;
  /** The resolved allowed-origin list (`resolveConfiguredRuntimeOrigins`). */
  configuredOrigins: readonly string[];
}

export interface BrowserService {
  registry: BrowserSessionRegistry;
  acquisition: ChromiumAcquisition;
  localTargets: LocalTargetStore;
  portScanner: LocalPortScanner;
  listeners(): StationListeners;
  shutdown(): Promise<void>;
}

/**
 * Other Station instances registered in this home. A registry that cannot be
 * read contributes nothing (logged): this Station's own listeners are always
 * blocked regardless, and refusing all browsing because a sibling's registry
 * file is damaged would be the wrong failure.
 */
function readOtherInstances(
  stationHome: string,
  serverPort: number,
): StationInstancePorts[] {
  try {
    return findRunning(stationHome)
      .filter((instance) => instance.port !== serverPort)
      .map((instance) => ({
        port: instance.port,
        ...(instance.uiPort !== undefined ? { uiPort: instance.uiPort } : {}),
        ...(instance.consentPort !== undefined
          ? { consentPort: instance.consentPort }
          : {}),
      }));
  } catch (error) {
    logger.warn(
      'browser: instance registry unreadable; blocking this Station only',
      {
        error: String(error),
      },
    );
    return [];
  }
}

export function createBrowserService(
  options: BrowserServiceOptions,
): BrowserService {
  const acquisition = new ChromiumAcquisition(options.stationHome);
  let cached: { at: number; listeners: StationListeners } | undefined;
  const listeners = (): StationListeners => {
    const now = Date.now();
    if (!cached || now - cached.at > INSTANCE_REFRESH_MS) {
      cached = {
        at: now,
        listeners: deriveStationListeners({
          serverPort: options.serverPort,
          consentPort: options.consentPort,
          configuredOrigins: options.configuredOrigins,
          otherInstances: readOtherInstances(
            options.stationHome,
            options.serverPort,
          ),
        }),
      };
    }
    return cached.listeners;
  };
  const localTargets = new LocalTargetStore(options.stationHome);
  const registry = new BrowserSessionRegistry({
    stationHome: options.stationHome,
    createHost: (profile: BrowserProfile): BrowserHost => {
      const executablePath = acquisition.resolveExecutable();
      if (!executablePath) {
        throw new BrowserHostExitedError(
          `no Chromium is available (${acquisition.status().state})`,
        );
      }
      return new ChromiumServerHost({
        executablePath,
        egressPolicy: egressPolicyFor(profile, listeners, localTargets),
        onEvent: (event) => {
          if (
            event.kind === 'request-blocked' ||
            event.kind === 'egress-refused'
          )
            logger.info('browser: request refused', {
              projectId: profile.projectId,
              reach: profile.reach,
              ...event,
            });
        },
      });
    },
  });
  return {
    registry,
    acquisition,
    localTargets,
    portScanner: new LocalPortScanner(() => listeners().ports),
    listeners,
    shutdown: () => registry.shutdown(),
  };
}

/**
 * The egress policy for one profile's browser (D7): operator profiles get
 * full reach minus Station listeners; every other profile public addresses
 * plus the Project's registered local targets, read live per connection.
 */
export function egressPolicyFor(
  profile: Pick<BrowserProfile, 'projectId' | 'reach'>,
  listeners: () => StationListeners,
  localTargets: Pick<LocalTargetStore, 'list'>,
): EgressPolicy {
  return {
    listeners,
    interfaceAddresses: localInterfaceAddresses,
    reach:
      profile.reach === 'operator'
        ? { kind: 'operator' }
        : {
            kind: 'project',
            localTargets: () => localTargets.list(profile.projectId),
          },
  };
}

/** `STATION_CONSENT_PORT` when set to a valid port (else the +3 default). */
export function configuredConsentPort(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.STATION_CONSENT_PORT;
  if (raw === undefined) return undefined;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}
