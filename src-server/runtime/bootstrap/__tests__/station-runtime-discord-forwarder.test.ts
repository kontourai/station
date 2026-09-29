/**
 * #2377 C2b review: the Discord continue path gets its remote forwarder at
 * composition, as the routes do, rather than inside the per-message
 * callback, so an invalid
 * `STATION_REMOTE_REQUEST_TIMEOUT_MS` fails construction with its own
 * message instead of surfacing on the first bound conversation.
 *
 * Drives the real `StationRuntime` constructor and stops it at the Discord
 * gateway (the mock throws after capturing its options), so nothing starts.
 */
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const hoisted = vi.hoisted(() => ({
  built: 0,
  gatewayOptions: undefined as
    | undefined
    | { executeForegroundMessage: (input: unknown) => unknown },
}));

/** Answers every member with an inert, non-thenable callable proxy. */
vi.mock('../../../services/orchestration/event-store.js', () => {
  const inert: unknown = new Proxy(() => inert, {
    get: (_target, property) => (property === 'then' ? undefined : inert),
    apply: () => inert,
  });
  return {
    EventStore: class {
      constructor() {
        // biome-ignore lint/correctness/noConstructorReturn: an inert stand-in store
        return inert as object;
      }
    },
  };
});

vi.mock(
  '../../../services/remote-stations/remote-station-forwarder.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../services/remote-stations/remote-station-forwarder.js')
      >();
    return {
      ...actual,
      createRemoteStationForwarder: (
        ...args: Parameters<typeof actual.createRemoteStationForwarder>
      ) => {
        hoisted.built += 1;
        return actual.createRemoteStationForwarder(...args);
      },
    };
  },
);

vi.mock('../../../services/discord/discord-gateway-service.js', () => ({
  DiscordGatewayService: class {
    constructor(options: typeof hoisted.gatewayOptions) {
      hoisted.gatewayOptions = options;
      throw new Error('runtime construction stopped at the Discord gateway');
    }
  },
}));

const makeTempDir = trackTempDirs();

afterEach(() => {
  hoisted.built = 0;
  hoisted.gatewayOptions = undefined;
  delete process.env.STATION_REMOTE_REQUEST_TIMEOUT_MS;
});

function home(): string {
  const homeDir = makeTempDir('station-runtime-discord-forwarder-');
  ensureStationHomeSchemaSync(homeDir);
  return homeDir;
}

describe('StationRuntime builds the Discord forwarder at composition', () => {
  // The pin is the construction-time count. The Discord continue callback
  // cannot be driven from here: the stopped runtime has no orchestration
  // service, so the callback refuses before any forwarder code, which made
  // a "call it twice" check vacuous (#2377 C2b round-4 review).
  it('builds the forwarder at construction, before any message', {
    timeout: 120_000,
  }, async () => {
    const { StationRuntime } = await import('../station-runtime.js');
    expect(() => new StationRuntime({ projectHomeDir: home() })).toThrow(
      'runtime construction stopped at the Discord gateway',
    );
    expect(hoisted.built).toBe(1);
    expect(hoisted.gatewayOptions).toBeDefined();
  });

  it('an invalid bound fails construction with the variable’s own message', {
    timeout: 120_000,
  }, async () => {
    process.env.STATION_REMOTE_REQUEST_TIMEOUT_MS = '30s';
    const { StationRuntime } = await import('../station-runtime.js');
    expect(() => new StationRuntime({ projectHomeDir: home() })).toThrow(
      'STATION_REMOTE_REQUEST_TIMEOUT_MS must be an integer from 1 to 600000',
    );
  });
});
