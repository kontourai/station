/**
 * #90 D13: which Station runs a browser is a seam. Every session record
 * carries `hostId` (always `local` today, persisted), and the session
 * registry reaches a browser host ONLY through `BrowserHostResolver`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type BrowserHost,
  type BrowserHostResolver,
  createLocalBrowserHostResolver,
  LOCAL_BROWSER_HOST_ID,
} from '../browser-host.js';
import { BrowserSessionRegistry } from '../browser-session-registry.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function fakeHost(): BrowserHost {
  return {
    kind: 'server-chromium',
    openTarget: async () => ({ targetId: 'T1', cdpSessionId: 'S1' }),
    cdp: () => ({
      send: async <R>() => ({}) as R,
      on: () => () => {},
      close: async () => {},
      closed: new Promise(() => {}),
    }),
    closeTarget: async () => {},
    onExit: () => () => {},
    shutdown: async () => {},
  };
}

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'station-browser-hostid-'));
  homes.push(dir);
  return dir;
}

describe('browser host resolution (D13)', () => {
  test('a session asks the resolver for its profile on the local host, and records that host', async () => {
    const stationHome = home();
    const resolve = vi.fn(() => fakeHost());
    const resolver: BrowserHostResolver = { resolve };
    const registry = new BrowserSessionRegistry({
      stationHome,
      hostResolver: resolver,
    });
    const session = await registry.createSession({
      projectId: 'alpha',
      projectSlug: 'alpha',
      url: 'about:blank',
      actor: { kind: 'project-admin', principalId: 'human:deployment:a' },
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({
      projectId: 'alpha',
      principalKey: 'principal:human:deployment:a',
      hostId: 'local',
    });
    expect(session.hostId).toBe(LOCAL_BROWSER_HOST_ID);
    await registry.shutdown();
    // Persisted: a new registry over the same home reads it back.
    const again = new BrowserSessionRegistry({
      stationHome,
      hostResolver: resolver,
    });
    expect(again.getSession(session.browserSessionId)?.hostId).toBe('local');
  });

  test('a record stored before hostId existed loads as local', () => {
    const stationHome = home();
    const seed = new BrowserSessionRegistry({
      stationHome,
      hostResolver: { resolve: () => fakeHost() },
    });
    void seed;
    const store = join(stationHome, 'browser', 'sessions.json');
    mkdirSync(join(stationHome, 'browser'), { recursive: true });
    writeFileSync(
      store,
      JSON.stringify({
        version: 2,
        generations: {},
        sessions: [
          {
            browserSessionId: 'bs_00000000-0000-4000-8000-000000000001',
            projectId: 'alpha',
            projectSlug: 'alpha',
            principalKey: 'operator',
            reach: 'operator',
            url: 'about:blank',
            viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
            generation: 1,
            hostKind: 'server-chromium',
            profileRef: 'browser/profiles/a/b',
            state: 'closed',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            history: { entries: [], total: 0 },
            activity: { agentDriven: false },
          },
        ],
      }),
    );
    const loaded = new BrowserSessionRegistry({
      stationHome,
      hostResolver: { resolve: () => fakeHost() },
    });
    expect(
      loaded.getSession('bs_00000000-0000-4000-8000-000000000001')?.hostId,
    ).toBe('local');
  });

  test('the local resolver serves only the local host', () => {
    const create = vi.fn(() => fakeHost());
    const resolver = createLocalBrowserHostResolver(create);
    expect(() =>
      resolver.resolve({
        projectId: 'alpha',
        principalKey: 'operator',
        hostId: 'peer-station',
      }),
    ).toThrow(/not available on this Station/);
    expect(create).not.toHaveBeenCalled();
  });

  test('the resolver is the only path to a host: the registry and the service construct none themselves', () => {
    const registrySource = readFileSync(
      join(import.meta.dirname, '..', 'browser-session-registry.ts'),
      'utf8',
    );
    // One call site resolves hosts; the legacy convenience is only wrapped
    // into a local resolver, never called on its own.
    expect(registrySource.match(/hostResolver\.resolve\(/g)).toHaveLength(1);
    expect(registrySource).toMatch(/this\.hostResolver\.resolve\(/);
    expect(registrySource.match(/\bcreateHost\(/g)).toHaveLength(1);
    expect(registrySource).not.toMatch(/options\.createHost\(/);
    expect(registrySource).toMatch(
      /createHost\(profileForRequest\(request\)\)/,
    );
    expect(registrySource).not.toMatch(/new ChromiumServerHost/);
    const serviceSource = readFileSync(
      join(import.meta.dirname, '..', 'browser-service.ts'),
      'utf8',
    );
    expect(serviceSource).toMatch(
      /hostResolver: createLocalBrowserHostResolver\(/,
    );
    expect(serviceSource).not.toMatch(/\bcreateHost:/);
  });
});
