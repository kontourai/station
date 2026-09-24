/**
 * SSH device host routes (#1973): operator-only CRUD, the connection test
 * and hub consent, validated at the route seam — through the REAL registry
 * and store, with a fake ssh underneath.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import { FakeSsh } from '../../services/devices/hosts/__tests__/fake-ssh.js';
import { DeviceHostRegistry } from '../../services/devices/hosts/device-host-registry.js';
import { DeviceHostStore } from '../../services/devices/hosts/device-host-store.js';
import { createDeviceHostRoutes } from '../device-hosts.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'station-device-host-routes-'));
  homes.push(home);
  const spawned: FakeSsh[] = [];
  const registry = new DeviceHostRegistry({
    stationHome: home,
    store: new DeviceHostStore(home),
    localHub: () => undefined,
    spawn: (args) => {
      const child = new FakeSsh(args);
      spawned.push(child);
      child.stdin.on('finish', () => {
        child.stdout.write(
          `${JSON.stringify({ event: 'probe', node: '24.1.0', nodeOk: true, ios: true, android: true, hubInstalled: false, hubRunning: false })}\n`,
        );
        child.exit(0);
      });
      return child;
    },
  });
  let current = true;
  const app = new Hono();
  app.route(
    '/api/mobile-devices',
    createDeviceHostRoutes({
      registry,
      isOperator: async (request) =>
        request.headers.get('x-actor') === 'operator',
      isRequestPrincipalCurrent: () => current,
    }),
  );
  const call = (method: string, path: string, actor: string, body?: unknown) =>
    app.request(`/api/mobile-devices${path}`, {
      method,
      headers: { 'x-actor': actor, 'content-type': 'application/json' },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  return {
    registry,
    spawned,
    call,
    revoke: () => {
      current = false;
    },
  };
}

async function addHost(
  h: ReturnType<typeof harness>,
  sshTarget = 'brian@mac-mini',
) {
  const response = await h.call('POST', '/device-hosts', 'operator', {
    label: 'Mac mini',
    sshTarget,
  });
  expect(response.status).toBe(201);
  return (await readJson(response)).data as { hostId: string };
}

describe('SSH device host routes', () => {
  test('the operator adds, lists, edits and removes a host', async () => {
    const h = harness();
    const host = await addHost(h);
    expect(host.hostId).toMatch(/^ssh-[0-9a-f]{12}$/);
    const list = await readJson(
      await h.call('GET', '/device-hosts', 'operator'),
    );
    expect(list.data.hosts).toMatchObject([
      {
        hostId: host.hostId,
        label: 'Mac mini',
        sshTarget: 'brian@mac-mini',
        hubEnabled: false,
        hub: { state: 'stopped' },
        install: { state: 'unknown' },
      },
    ]);
    const edited = await h.call(
      'PATCH',
      `/device-hosts/${host.hostId}`,
      'operator',
      {
        label: 'Studio Mac',
      },
    );
    expect((await readJson(edited)).data.label).toBe('Studio Mac');
    expect(
      (await h.call('DELETE', `/device-hosts/${host.hostId}`, 'operator'))
        .status,
    ).toBe(200);
    expect(h.registry.views()).toEqual([]);
    expect(
      (await h.call('DELETE', `/device-hosts/${host.hostId}`, 'operator'))
        .status,
    ).toBe(404);
  });

  test('every route is the operator’s: anyone else is refused before anything happens', async () => {
    const h = harness();
    const host = await addHost(h);
    for (const [method, path, body] of [
      ['GET', '/device-hosts', undefined],
      ['POST', '/device-hosts', { label: 'x', sshTarget: 'box' }],
      ['PATCH', `/device-hosts/${host.hostId}`, { label: 'y' }],
      ['DELETE', `/device-hosts/${host.hostId}`, undefined],
      ['POST', `/device-hosts/${host.hostId}/check`, {}],
      [
        'POST',
        `/device-hosts/${host.hostId}/hub`,
        { enabled: true, consent: true },
      ],
      ['POST', `/device-hosts/${host.hostId}/hub/start`, {}],
      // Not even a 404 for a host that does not exist.
      ['DELETE', '/device-hosts/ssh-ffffffffffff', undefined],
    ] as const) {
      for (const actor of ['admin', 'contributor', ''])
        expect((await h.call(method, path, actor, body)).status).toBe(403);
    }
    expect(h.registry.views()).toHaveLength(1);
    expect(h.registry.view(host.hostId)?.hubEnabled).toBe(false);
    expect(h.spawned).toEqual([]);
  });

  test('an option-shaped or malformed target is refused at the seam', async () => {
    const h = harness();
    for (const sshTarget of [
      '-oProxyCommand=touch /tmp/pwned',
      'host -oProxyCommand=x',
      'brian@-oProxyCommand=x',
      'host;id',
      '$(id)',
      'a@b@c',
      '',
      ['box'],
    ]) {
      const response = await h.call('POST', '/device-hosts', 'operator', {
        label: 'x',
        sshTarget,
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).code).toBe('invalid-target');
    }
    const host = await addHost(h);
    expect(
      (
        await h.call('PATCH', `/device-hosts/${host.hostId}`, 'operator', {
          sshTarget: '-oProxyCommand=sh',
        })
      ).status,
    ).toBe(400);
    expect(h.registry.view(host.hostId)?.sshTarget).toBe('brian@mac-mini');
    // Unknown keys, bad ids and bad JSON.
    expect(
      (
        await h.call('POST', '/device-hosts', 'operator', {
          label: 'x',
          sshTarget: 'b',
          identityFile: '/k',
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.call('PATCH', '/device-hosts/local', 'operator', { label: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (await h.call('POST', '/device-hosts', 'operator', '{nope')).status,
    ).toBe(400);
    expect(h.spawned).toEqual([]);
  });

  test('enabling the hub needs the literal consent', async () => {
    const h = harness();
    const host = await addHost(h);
    for (const body of [
      { enabled: true },
      { enabled: true, consent: 'true' },
      { enabled: 'yes' },
    ]) {
      expect(
        (
          await h.call(
            'POST',
            `/device-hosts/${host.hostId}/hub`,
            'operator',
            body,
          )
        ).status,
      ).toBe(400);
    }
    expect(h.registry.view(host.hostId)?.hubEnabled).toBe(false);
    const enabled = await h.call(
      'POST',
      `/device-hosts/${host.hostId}/hub`,
      'operator',
      {
        enabled: true,
        consent: true,
      },
    );
    expect(enabled.status).toBe(202);
    expect((await readJson(enabled)).data.hubEnabled).toBe(true);
  });

  test('removing re-checks the sign-in after its await, like its siblings', async () => {
    const h = harness();
    const host = await addHost(h);
    let checks = 0;
    // Revoke the sign-in between the pre-await check and the answer.
    const original = h.registry.remove.bind(h.registry);
    h.registry.remove = async (hostId: string) => {
      await original(hostId);
      h.revoke();
      checks += 1;
    };
    expect(
      (await h.call('DELETE', `/device-hosts/${host.hostId}`, 'operator'))
        .status,
    ).toBe(403);
    expect(checks).toBe(1);
  });

  test('Test connection answers the steps, and a lapsed sign-in gets nothing', async () => {
    const h = harness();
    const host = await addHost(h);
    const response = await h.call(
      'POST',
      `/device-hosts/${host.hostId}/check`,
      'operator',
      {},
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.data.steps.map((step: { id: string }) => step.id)).toEqual([
      'ssh',
      'host-key',
      'node',
      'ios',
      'android',
      'hub-installed',
      'hub-running',
    ]);
    expect(
      (
        await h.call(
          'POST',
          '/device-hosts/ssh-ffffffffffff/check',
          'operator',
          {},
        )
      ).status,
    ).toBe(404);
    h.revoke();
    expect(
      (
        await h.call(
          'POST',
          `/device-hosts/${host.hostId}/check`,
          'operator',
          {},
        )
      ).status,
    ).toBe(403);
  });
});

describe('the operator-only gate is scoped to /device-hosts', () => {
  test('a sibling family mounted under the same prefix still serves a non-operator', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-device-host-routes-'));
    homes.push(home);
    const registry = new DeviceHostRegistry({
      stationHome: home,
      store: new DeviceHostStore(home),
      localHub: () => undefined,
    });
    const app = new Hono();
    app.route(
      '/api/mobile-devices',
      createDeviceHostRoutes({
        registry,
        isOperator: async (request) =>
          request.headers.get('x-actor') === 'operator',
        isRequestPrincipalCurrent: () => true,
      }),
    );
    // Mounted AFTER, as the runtime mounts the device tools routes.
    const sibling = new Hono();
    sibling.get('/hosts/:hostId/devices/:platform/:deviceId/tools', (c) =>
      c.json({ success: true, data: { reached: true } }),
    );
    app.route('/api/mobile-devices', sibling);
    const answer = await app.request(
      '/api/mobile-devices/hosts/local/devices/ios/x/tools',
      { headers: { 'x-actor': 'admin' } },
    );
    expect(answer.status).toBe(200);
    // …while the family's own routes stay operator-only.
    expect(
      (
        await app.request('/api/mobile-devices/device-hosts', {
          headers: { 'x-actor': 'admin' },
        })
      ).status,
    ).toBe(403);
  });
});
