import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';

/**
 * The engine qualification seam: a real child process (`fake-acp-agent.mjs`,
 * whose agent side is the ACP SDK) driven by one engine profile from
 * `fixtures/acp-engine-profiles`, launched through the real `ACPProcess` by
 * the real `AcpAdapter` or `ACPProbe`. Other suites can launch any profile,
 * or a failure mode of it, with {@link fakeEngineConnection}.
 */
const FAKE_AGENT = fileURLToPath(
  new URL('./fixtures/fake-acp-agent.mjs', import.meta.url),
);
const PROFILE_DIR = fileURLToPath(
  new URL('./fixtures/acp-engine-profiles/', import.meta.url),
);

export interface EngineProfile {
  engine: string;
  initialize: {
    agentCapabilities?: Record<string, unknown>;
    authMethods: Array<{ id: string }>;
  };
  sessionNew?: {
    modes?: { availableModes: Array<{ id: string }> };
    configOptions?: Array<{ id: string }>;
  };
  permissionOptions?: Array<{ optionId: string; kind: string }>;
  vendorNotifications?: Array<{ method: string }>;
}

/** The fake's permission options when a profile declares none. */
export const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: 'allow', kind: 'allow_once' },
  { optionId: 'reject', kind: 'reject_once' },
];

export function loadEngineProfiles(): Array<{
  path: string;
  profile: EngineProfile;
}> {
  return readdirSync(PROFILE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      path: join(PROFILE_DIR, name),
      profile: JSON.parse(
        readFileSync(join(PROFILE_DIR, name), 'utf8'),
      ) as EngineProfile,
    }));
}

export type FakeEngineFailure =
  | 'exit-on-start'
  | 'auth-required-on-session-new'
  | 'auth-required-on-prompt';

export const FAKE_ENGINE_CONNECTION_ID = 'engine-under-test';

/** A connection that launches the fake agent with one engine profile. */
export function fakeEngineConnection(
  profilePath: string,
  options: {
    fail?: FakeEngineFailure;
    initializeDelayMs?: number;
    recordPath?: string;
  } = {},
): ACPConnectionConfig {
  return {
    id: FAKE_ENGINE_CONNECTION_ID,
    name: 'Engine under test',
    command: process.execPath,
    args: [
      FAKE_AGENT,
      '--engine-profile',
      profilePath,
      ...(options.fail ? ['--fail', options.fail] : []),
      ...(options.initializeDelayMs
        ? ['--initialize-delay-ms', String(options.initializeDelayMs)]
        : []),
      ...(options.recordPath ? ['--record', options.recordPath] : []),
    ],
    enabled: true,
  };
}

export const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export async function waitFor<T>(
  find: () => T | undefined,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface FakeEngineHarness {
  adapter: AcpAdapter;
  events: CanonicalRuntimeEvent[];
  /** What reached the engine: one entry per request and permission outcome. */
  engineRecord: () => Array<Record<string, unknown>>;
  startSession: (threadId: string) => Promise<void>;
  stop: () => Promise<void>;
}

/** Call once per suite; it registers temp-dir cleanup with the suite. */
export function createFakeEngineHarnessFactory() {
  const makeTempDir = trackTempDirs();
  return {
    makeTempDir,
    harness(profilePath: string, fail?: FakeEngineFailure): FakeEngineHarness {
      const recordPath = join(
        makeTempDir('station-acp-qualify-'),
        'engine.jsonl',
      );
      writeFileSync(recordPath, '');
      const connection = fakeEngineConnection(profilePath, {
        fail,
        recordPath,
      });
      const adapter = new AcpAdapter({
        getConnections: async () => [connection],
        logger: quietLogger,
      });
      const events: CanonicalRuntimeEvent[] = [];
      const drained = (async () => {
        for await (const event of adapter.streamEvents()) events.push(event);
      })();
      return {
        adapter,
        events,
        engineRecord: () =>
          readFileSync(recordPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        startSession: (threadId) =>
          adapter.startSession({
            provider: 'acp',
            threadId,
            cwd: makeTempDir('station-acp-qualify-cwd-'),
            confinement: 'workspace',
            metadata: { connectionId: FAKE_ENGINE_CONNECTION_ID },
          }) as Promise<never>,
        stop: async () => {
          await adapter.stopAll();
          await drained;
        },
      };
    },
  };
}
