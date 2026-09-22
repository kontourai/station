/**
 * Composition root for the Browser pane's server side on a personal host
 * (#90 lane C): acquisition, the per-Project session registry, and a
 * Chromium host factory bound to this Station's listener set.
 */
import { findRunning } from '@kontourai/station-shared/instance-registry';
import { createLogger } from '../../utils/logger.js';
import type { BrowserHost } from './browser-host.js';
import { BrowserSessionRegistry } from './browser-session-registry.js';
import { ChromiumAcquisition } from './chromium-acquisition.js';
import {
  BrowserHostExitedError,
  ChromiumServerHost,
} from './hosts/chromium-server-host.js';
import {
  deriveStationListeners,
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
  const registry = new BrowserSessionRegistry({
    stationHome: options.stationHome,
    createHost: (projectId): BrowserHost => {
      const executablePath = acquisition.resolveExecutable();
      if (!executablePath) {
        throw new BrowserHostExitedError(
          `no Chromium is available (${acquisition.status().state})`,
        );
      }
      return new ChromiumServerHost({
        executablePath,
        stationListeners: listeners,
        onEvent: (event) => {
          if (
            event.kind === 'request-blocked' ||
            event.kind === 'egress-refused'
          )
            logger.info('browser: request refused', { projectId, ...event });
        },
      });
    },
  });
  return {
    registry,
    acquisition,
    listeners,
    shutdown: () => registry.shutdown(),
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
