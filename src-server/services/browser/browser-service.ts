/**
 * Composition root for the Browser pane's server side on a personal host
 * (#90 lane C): acquisition, the per-Project session registry, and a
 * Chromium host factory bound to this Station's listener set.
 */
import { findRunning } from '@kontourai/station-shared/instance-registry';
import { createLogger } from '../../utils/logger.js';
import type { LiveSurfaceRegistry } from '../live-surface/registry.js';
import type { BrowserProjectAuthorizer } from './browser-access.js';
import {
  type BrowserHost,
  createLocalBrowserHostResolver,
} from './browser-host.js';
import { BrowserLiveSurfaces } from './browser-live-surfaces.js';
import { LocalTargetStore } from './browser-local-targets.js';
import { BrowserProjectSettingsStore } from './browser-project-settings.js';
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
  isStationSelfUrl,
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
  /**
   * Where live sessions publish their screencast surfaces, and who may reach
   * them (D5 + D7). Absent: sessions run with no live view.
   */
  liveSurfaces?: {
    registry: Pick<LiveSurfaceRegistry, 'register' | 'get'>;
    authorizeProject: BrowserProjectAuthorizer;
  };
}

export interface BrowserService {
  registry: BrowserSessionRegistry;
  acquisition: ChromiumAcquisition;
  localTargets: LocalTargetStore;
  /** Per-Project browser permissions (D4 `browserEvaluate`). */
  projectSettings: BrowserProjectSettingsStore;
  portScanner: LocalPortScanner;
  listeners(): StationListeners;
  /** The live-surface id of a live session, when live surfaces are wired. */
  surfaceIdFor(browserSessionId: string): string | undefined;
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
    isStationAddress: (url) =>
      isStationSelfUrl(url, listeners(), localInterfaceAddresses()),
    // #90 D13: the resolver is the one path to a host; local only today.
    hostResolver: createLocalBrowserHostResolver((request): BrowserHost => {
      const profile: Pick<BrowserProfile, 'projectId' | 'reach'> = {
        projectId: request.projectId,
        reach: request.principalKey === 'operator' ? 'operator' : 'project',
      };
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
    }),
  });
  const surfaces = options.liveSurfaces
    ? new BrowserLiveSurfaces({
        sessions: registry,
        surfaces: options.liveSurfaces.registry,
        authorizeProject: options.liveSurfaces.authorizeProject,
        onError: (message, error) =>
          logger.warn(`browser: ${message}`, {
            error: error instanceof Error ? error.message : String(error),
          }),
      })
    : undefined;
  return {
    registry,
    acquisition,
    localTargets,
    projectSettings: new BrowserProjectSettingsStore(options.stationHome),
    portScanner: new LocalPortScanner(() => listeners().ports),
    listeners,
    surfaceIdFor: (browserSessionId) =>
      surfaces?.surfaceIdFor(browserSessionId),
    shutdown: async () => {
      // Surfaces first: no viewer keeps streaming from a browser being shut.
      await surfaces?.dispose();
      await registry.shutdown();
    },
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
