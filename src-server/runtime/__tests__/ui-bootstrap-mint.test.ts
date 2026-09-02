import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
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

function createHarness(options: { uiBootstrapToken?: string } = {}) {
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
      ...options,
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
  purpose?: string,
) {
  return harness.request(
    PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH,
    purpose === undefined ? { secret } : { secret, purpose },
    peer,
    headers,
  );
}

async function mintedToken(
  harness: ReturnType<typeof createHarness>,
  purpose?: string,
) {
  const response = await mint(
    harness,
    harness.secret(),
    loopback(),
    {},
    purpose,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

function redeem(harness: ReturnType<typeof createHarness>, token: string) {
  return harness.request(
    PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
    { token },
    remote(),
    { Origin: 'https://station.example.test' },
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

  test('a redeemed bootstrap lands in the default grant, and that breadth is pinned', async () => {
    // The seam is the redeem handler's `pairing.createOffer({ endpoint })`,
    // which passes no scope: `createOffer` then applies
    // DEFAULT_GRANT_PAIRING_SCOPE, and the stored device takes `offer.scope`.
    // So the browser lands in the default grant — `terminal:operate` and
    // `access:manage` included. That is deliberate and longstanding (the same
    // session `station start`'s own fragment produces), but nothing asserted
    // it: the CONSTANT is pinned in the contracts test, this caller's landing
    // place was not. #1118 routes the tray's "Open API docs" through this path.
    //
    // Fault injection located the seam precisely, and two earlier attempts are
    // worth recording so the next reader does not repeat them: a `scope` added
    // to `pairing.exchange(...)` is ignored (scope comes from the offer), and
    // one added inside the `isSameMachineBrowserCaller` branch is unreachable
    // for an off-box redemption. Only `createOffer` moves this assertion.
    const harness = createHarness();
    const { token } = (await (
      await mint(harness, harness.secret())
    ).json()) as { token: string };
    const redeemed = await harness.request(
      PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
      { token },
      remote(),
      { Origin: 'https://station.example.test' },
    );
    expect(redeemed.status).toBe(200);
    const body = (await redeemed.json()) as { device: { scope: string } };
    expect(body.device.scope).toBe(DEFAULT_GRANT_PAIRING_SCOPE);
  });

  test('minting for the API docs leaves a pending start link usable (#1259)', async () => {
    // The regression #1118 shipped. There was ONE server-held capability, so
    // the tray minting for the docs replaced an unspent `station start` link,
    // and the user's terminal URL then failed with nothing on screen
    // connecting it to the menu item they had clicked.
    const harness = createHarness();
    const launcher = await mintedToken(harness);
    await mintedToken(harness, 'api-docs');

    expect((await redeem(harness, launcher)).status).toBe(200);
  });

  test('minting a start link leaves a pending API-docs capability usable', async () => {
    // The same collision in the other direction: opening the UI must not kill
    // a docs capability already in flight.
    const harness = createHarness();
    const docs = await mintedToken(harness, 'api-docs');
    await mintedToken(harness);

    expect((await redeem(harness, docs)).status).toBe(200);
  });

  test('replace-on-mint still holds WITHIN a purpose', async () => {
    // The rule the single slot was there to enforce is intact; it just applies
    // per purpose now rather than across unrelated ones.
    const harness = createHarness();
    const first = await mintedToken(harness, 'api-docs');
    const second = await mintedToken(harness, 'api-docs');
    expect(first).not.toBe(second);

    expect((await redeem(harness, first)).status).toBe(403);
    expect((await redeem(harness, second)).status).toBe(200);
  });

  test('spending one purpose does not spend the other', async () => {
    const harness = createHarness();
    const launcher = await mintedToken(harness);
    const docs = await mintedToken(harness, 'api-docs');

    expect((await redeem(harness, docs)).status).toBe(200);
    // The launcher capability was never presented, so it is still live.
    expect((await redeem(harness, launcher)).status).toBe(200);
  });

  test('the token station start inherits from the environment survives a docs mint (#1259, real shape)', async () => {
    // Production does not mint the launcher over HTTP: `station start` passes
    // STATION_UI_BOOTSTRAP_TOKEN into the server as `options.uiBootstrapToken`
    // and prints it in the start link. The tests above mint their launcher
    // through the route, so this is the fixture that matches what the CLI
    // actually does — the #1259 report was this token dying.
    const inherited = 'inherited-launcher-token-from-station-start-0123456789';
    const harness = createHarness({ uiBootstrapToken: inherited });
    await mintedToken(harness, 'api-docs');

    expect((await redeem(harness, inherited)).status).toBe(200);
  });

  test('the purpose literal the tray sends is one the server accepts', async () => {
    // src-desktop/src/tray.rs cannot import the TypeScript vocabulary, so it
    // repeats the literal. Bind it behaviourally: mint with exactly what the
    // Rust source says, so a drift on either side is a 400 here rather than
    // a tray item that silently stops working.
    const tray = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'src-desktop',
        'src',
        'tray.rs',
      ),
      'utf8',
    );
    const literal = /const API_DOCS_CAPABILITY_PURPOSE: &str = "([^"]+)";/.exec(
      tray,
    )?.[1];
    expect(literal).toBeDefined();
    const harness = createHarness();
    expect(
      (await mint(harness, harness.secret(), loopback(), {}, literal)).status,
    ).toBe(200);
  });

  test('an unknown purpose is refused rather than given a slot', async () => {
    // An open vocabulary would let a caller allocate unbounded slots and make
    // "which capabilities are live" unanswerable.
    const harness = createHarness();
    const response = await mint(
      harness,
      harness.secret(),
      loopback(),
      {},
      'anything-i-like',
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
    });
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
