import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { createDeviceHostResolver } from '../device-host-resolver.js';
import { explicitDeviceHubEndpoint } from '../device-hub-endpoint.js';

/**
 * D13: device host selection goes through `DeviceHostResolver`.
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
  const root = fileURLToPath(new URL('../../..', import.meta.url));
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
        // The runtime composition: the managed hub (falling back to an
        // explicit one), wrapped by the resolver.
        'runtime/routes/runtime-routes.ts:deviceHubEndpointFromToolchain',
        'runtime/routes/runtime-routes.ts:explicitDeviceHubEndpoint',
      ].sort(),
    );
  });

  test('the runtime passes the managed-or-explicit endpoint straight into the resolver and builds hosts from what it resolves', () => {
    // Whitespace-free, so a reformat of runtime-routes cannot turn this red;
    // the resolver's local binding name is read from the source, not assumed.
    const runtime = files
      .find(({ path }) => path === 'runtime/routes/runtime-routes.ts')!
      .text.replace(/\s+/g, '');
    const resolverCall =
      /const(\w+)=createDeviceHostResolver\(\{local:deviceHubEndpointFromToolchain\(\w+,explicitDeviceHubEndpoint\([^)]*\),?\),remote:\w+,?\}\)/.exec(
        runtime,
      );
    expect(resolverCall).not.toBeNull();
    const resolverName = resolverCall![1]!;
    // SSH device host services are handed the same resolver.
    expect(runtime).toContain(`resolver:${resolverName}`);
    const hosts = [
      ...runtime.matchAll(/newLocalMobileDeviceHost\(\{hub:(\w+)/g),
    ];
    // Every runtime LocalMobileDeviceHost takes `hub:` first (the type
    // requires it) and that hub is what the resolver resolved.
    expect(hosts.length).toBe(
      runtime.split('newLocalMobileDeviceHost(').length - 1,
    );
    expect(hosts.length).toBeGreaterThan(0);
    for (const [, hub] of hosts)
      expect(runtime).toContain(`const${hub}=${resolverName}.resolve({`);
  });
});
