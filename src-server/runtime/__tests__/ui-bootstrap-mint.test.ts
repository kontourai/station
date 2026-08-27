import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HttpBindings } from '@hono/node-server';
import {
  PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { DevicePairingService } from '../../services/ssh/device-pairing-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import { configureDevicePairingPublicRoutes } from '../routes/runtime-routes.js';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

let peerCounter = 1;
const loopback = () => `127.0.0.${(peerCounter++ % 250) + 2}`;
const remote = () => `100.96.${(peerCounter++ % 250) + 1}.7`;

function createHarness() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-ui-bootstrap-mint-'));
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const secretPath = join(homeDir, 'runtime', 'local-grant.secret');
  const app = new Hono<{ Bindings: TestBindings }>();
  configureDevicePairingPublicRoutes(
    app as never,
    new DevicePairingService({
      homeDir,
      environmentId: '11111111-1111-4111-8111-111111111111',
    }),
    {
      localGrant: { secretPath },
      allowedOrigins: ['https://station.example.test'],
    },
  );
  const request = (path: string, body: unknown, peer: string, headers = {}) =>
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: peer } } } as TestBindings,
    );
  return { request, secret: () => readFileSync(secretPath, 'utf8') };
}

async function mint(
  harness: ReturnType<typeof createHarness>,
  secret: string,
  peer = loopback(),
  headers: Record<string, string> = {},
) {
  return harness.request(
    PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH,
    { secret },
    peer,
    headers,
  );
}

describe('ui-bootstrap mint', () => {
  test('a direct-loopback caller holding the local grant mints a main exchange token', async () => {
    const harness = createHarness();
    const response = await mint(harness, harness.secret());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: expect.any(String),
      path: PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
    });
  });

  test('refuses proxied and non-loopback callers, even with the local grant', async () => {
    const harness = createHarness();
    const secret = harness.secret();
    const proxied = await mint(harness, secret, loopback(), {
      [INTERNAL_PROXY_CALLER_HEADER]: 'loopback',
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    });
    const offBox = await mint(harness, secret, remote());
    expect(proxied.status).toBe(403);
    expect(offBox.status).toBe(403);
    await expect(proxied.json()).resolves.toEqual({
      error: 'local_grant_forbidden',
    });
    await expect(offBox.json()).resolves.toEqual({
      error: 'local_grant_forbidden',
    });
  });

  test('refuses a wrong local-grant secret with the same code as bad position', async () => {
    const harness = createHarness();
    const response = await mint(harness, 'zzz-not-the-minted-value');
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'local_grant_forbidden',
    });
  });

  test('uses a rate-limit bucket distinct from local-grant', async () => {
    const harness = createHarness();
    const peer = loopback();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await harness.request(
            PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
            { secret: 'bad', deviceName: 'test' },
            peer,
          )
        ).status,
      ).toBe(403);
    }
    expect((await mint(harness, harness.secret(), peer)).status).toBe(200);
  });

  test('the main UI-bootstrap exchange accepts a minted token once and spends it', async () => {
    const harness = createHarness();
    const minted = await mint(harness, harness.secret());
    const { token } = (await minted.json()) as { token: string };
    const exchange = () =>
      harness.request(
        PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
        { token },
        remote(),
        { Origin: 'https://station.example.test' },
      );
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(403);
  });

  test('a later mint invalidates the prior unspent token', async () => {
    const harness = createHarness();
    const first = (await (await mint(harness, harness.secret())).json()) as {
      token: string;
    };
    const second = (await (await mint(harness, harness.secret())).json()) as {
      token: string;
    };
    expect(first.token).not.toBe(second.token);
    const oldExchange = await harness.request(
      PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
      { token: first.token },
      remote(),
      { Origin: 'https://station.example.test' },
    );
    expect(oldExchange.status).toBe(403);
  });
});
