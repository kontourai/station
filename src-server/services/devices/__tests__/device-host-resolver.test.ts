import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createDeviceHostResolver,
  createLocalDeviceHostResolver,
  LOCAL_DEVICE_HOST_ID,
} from '../device-host-resolver.js';
import { explicitDeviceHubEndpoint } from '../device-hub-endpoint.js';

/**
 * D13: device host selection goes through `DeviceHostResolver`. Only the
 * local host exists; a future capability host is one more resolver entry.
 */

describe('the local device host resolver', () => {
  test('resolves local, and nothing else', () => {
    const local = explicitDeviceHubEndpoint('http://127.0.0.1:43871');
    const resolver = createLocalDeviceHostResolver(local);
    expect(resolver.resolve({ hostId: LOCAL_DEVICE_HOST_ID })).toBe(local);
    expect(resolver.resolve({ hostId: 'kontour' })).toBeNull();
    expect(resolver.resolve({ hostId: '' })).toBeNull();
  });
});

/**
 * #1973: an SSH device host resolves to ITS endpoint, by id; `local` stays
 * the local hub; anything malformed or not stored is null (never local).
 */
describe('the device host resolver with SSH hosts', () => {
  const local = explicitDeviceHubEndpoint('http://127.0.0.1:43871');
  const remoteA = explicitDeviceHubEndpoint('http://127.0.0.1:43872');
  const remoteB = explicitDeviceHubEndpoint('http://127.0.0.1:43873');
  const stored: Record<string, typeof remoteA> = {
    'ssh-00000000000a': remoteA,
    'ssh-00000000000b': remoteB,
  };
  const asked: string[] = [];
  const resolver = createDeviceHostResolver({
    local,
    remote: {
      has: (hostId) => {
        asked.push(hostId);
        return hostId in stored;
      },
      endpoint: (hostId) => stored[hostId]!,
    },
  });

  test('routes by hostId', () => {
    expect(resolver.resolve({ hostId: 'local' })).toBe(local);
    expect(resolver.resolve({ hostId: 'ssh-00000000000a' })).toBe(remoteA);
    expect(resolver.resolve({ hostId: 'ssh-00000000000b' })).toBe(remoteB);
  });

  test('an unknown, removed or malformed id resolves to nothing', () => {
    asked.length = 0;
    expect(resolver.resolve({ hostId: 'ssh-00000000000c' })).toBeNull();
    for (const hostId of ['', 'LOCAL', 'ssh-', 'ssh-00000000000A', '../local'])
      expect(resolver.resolve({ hostId })).toBeNull();
    // A malformed id never reaches the host store.
    expect(asked).toEqual(['ssh-00000000000c']);
  });

  test('without SSH hosts only local resolves', () => {
    const bare = createDeviceHostResolver({ local });
    expect(bare.resolve({ hostId: 'local' })).toBe(local);
    expect(bare.resolve({ hostId: 'ssh-00000000000a' })).toBeNull();
  });
});

/**
 * A STRUCTURAL rule, proved by a structural scan: in server source (tests
 * excluded), hub endpoints are constructed only where declared below, and
 * the runtime composition hands them out only through the resolver.
 */
describe('the resolver is the only path to a hub', () => {
  const root = join(__dirname, '../../..');
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === '__tests__' || name === 'node_modules') continue;
      if (statSync(path).isDirectory()) out.push(...sources(path));
      else if (/\.ts$/.test(name)) out.push(path);
    }
    return out;
  }
  const files = sources(root).map((path) => ({
    path: relative(root, path),
    text: readFileSync(path, 'utf8'),
  }));
  // Calls, not declarations (`function name(`), and not comment lines.
  const CONSTRUCTORS =
    /(?<!function )\b(explicitDeviceHubEndpoint|explicitHubConnection|deviceHubEndpointFromToolchain)\s*\(/g;
  const code = (text: string) =>
    text
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join('\n');

  test('hub endpoints are built only in the endpoint module, the host fallback and the runtime resolver', () => {
    const sites = files.flatMap(({ path, text }) =>
      [...code(text).matchAll(CONSTRUCTORS)].map(
        (match) => `${path}:${match[1]}`,
      ),
    );
    expect(sites.sort()).toEqual(
      [
        // Definitions and their internal composition.
        'services/devices/device-hub-endpoint.ts:explicitHubConnection',
        // `LocalMobileDeviceHost({ endpoint })` for callers that pass a
        // string (tests); the runtime never does (next test).
        'services/mobile-device/mobile-device-host.ts:explicitDeviceHubEndpoint',
        // The runtime composition: the managed hub (falling back to an
        // explicit one), wrapped by the resolver.
        'runtime/routes/runtime-routes.ts:deviceHubEndpointFromToolchain',
        'runtime/routes/runtime-routes.ts:explicitDeviceHubEndpoint',
      ].sort(),
    );
  });

  test('the runtime passes the managed-or-explicit endpoint straight into the resolver and builds hosts from what it resolves', () => {
    const runtime = files.find(
      ({ path }) => path === 'runtime/routes/runtime-routes.ts',
    )!.text;
    expect(runtime).toMatch(
      /createDeviceHostResolver\(\{\s*local:\s*deviceHubEndpointFromToolchain\(\s*devices,\s*explicitDeviceHubEndpoint\(/,
    );
    // SSH device hosts reach the resolver as its `remote`, never as a hub.
    expect(runtime).toMatch(/remote:\s*hostRegistry,?\s*\}\)/);
    expect(runtime).toMatch(/resolver:\s*deviceHosts/);
    expect(runtime).toMatch(/deviceHosts\.resolve\(\{/);
    const hosts = [
      ...runtime.matchAll(/new LocalMobileDeviceHost\(([^)]*)\)/g),
    ];
    expect(hosts.length).toBeGreaterThan(0);
    for (const [, args] of hosts)
      expect(args).toMatch(/hub:\s*deviceHubEndpoint/);
    expect(runtime).not.toMatch(/new LocalMobileDeviceHost\(\{\s*endpoint:/);
  });
});
