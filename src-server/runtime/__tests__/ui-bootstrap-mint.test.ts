import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function createHarness() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-ui-bootstrap-mint-'));
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const secretPath = join(homeDir, 'runtime', 'local-grant.secret');
  const app = new Hono<{ Bindings: TestBindings }>();
  // A controllable clock, so the capability's lifetime is asserted by
  // advancing time rather than by sleeping through it.
  const clock = { current: Date.now() };
  configureDevicePairingPublicRoutes(
    app as never,
    new DevicePairingService({
      homeDir,
      environmentId: '11111111-1111-4111-8111-111111111111',
    }),
    {
      localGrant: { secretPath },
      allowedOrigins: ['https://station.example.test'],
      now: () => clock.current,
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
  return {
    request,
    secret: () => readFileSync(secretPath, 'utf8'),
    advance: (ms: number) => {
      clock.current += ms;
    },
  };
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

  test('a capability stops being redeemable once it is stale (#1122)', async () => {
    // It previously had NO lifetime: it stayed redeemable until spent or
    // replaced, so a `station start` URL printed days earlier still worked and
    // a forwarded fragment stayed live indefinitely. Narrowing WHO may redeem
    // would fight this route's design -- it deliberately accepts a UI proxy, a
    // Serve hop and a non-loopback authority, and distinguishes them by
    // locality stamping rather than refusal. Narrowing HOW LONG does not.
    const harness = createHarness();
    const { token } = (await (
      await mint(harness, harness.secret())
    ).json()) as { token: string };

    harness.advance(15 * 60 * 1000 + 1);
    const stale = await harness.request(
      PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
      { token },
      remote(),
      { Origin: 'https://station.example.test' },
    );
    expect(stale.status).toBe(403);
    await expect(stale.json()).resolves.toEqual({
      error: 'ui_bootstrap_expired',
    });
  });

  test('an expired capability is discarded, not left live for a retry', async () => {
    // Refusing without clearing would leave the window reopenable: the same
    // fragment would still be sitting in the server, one clock adjustment or
    // one lucky race away from being spent.
    const harness = createHarness();
    const { token } = (await (
      await mint(harness, harness.secret())
    ).json()) as { token: string };
    harness.advance(15 * 60 * 1000 + 1);
    expect(
      (
        await harness.request(
          PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
          { token },
          remote(),
          { Origin: 'https://station.example.test' },
        )
      ).status,
    ).toBe(403);

    // Even rewound, the capability is gone rather than merely out of date.
    harness.advance(-(15 * 60 * 1000 + 1));
    const replay = await harness.request(
      PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
      { token },
      remote(),
      { Origin: 'https://station.example.test' },
    );
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toEqual({
      error: 'ui_bootstrap_forbidden',
    });
  });

  test('a clock that moves backwards expires the capability rather than reviving it', async () => {
    // Review finding: clearing only runs when someone ATTEMPTS a redemption,
    // and `Date.now()` is not monotonic. A system time or NTP correction that
    // moved past the lifetime and back would have revived an untouched
    // capability -- so the guard fails closed on a negative age rather than
    // trusting the clock to move one way.
    const harness = createHarness();
    const { token } = (await (
      await mint(harness, harness.secret())
    ).json()) as { token: string };

    harness.advance(-1);
    const rolledBack = await harness.request(
      PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
      { token },
      remote(),
      { Origin: 'https://station.example.test' },
    );
    expect(rolledBack.status).toBe(403);
    await expect(rolledBack.json()).resolves.toEqual({
      error: 'ui_bootstrap_expired',
    });
  });

  test('the lifetime boundary itself is refused, not left to a fencepost', async () => {
    // Exactly at the stated lifetime. `>` would have admitted this, which is a
    // boundary nobody chose rather than one anybody decided.
    const harness = createHarness();
    const { token } = (await (
      await mint(harness, harness.secret())
    ).json()) as { token: string };
    harness.advance(15 * 60 * 1000);
    expect(
      (
        await harness.request(
          PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
          { token },
          remote(),
          { Origin: 'https://station.example.test' },
        )
      ).status,
    ).toBe(403);
  });

  test('a capability well inside its lifetime is still redeemable', async () => {
    // The lifetime must not become a lockout: the human gap between
    // `station start` printing a URL and someone clicking it is the case it
    // exists to accommodate.
    const harness = createHarness();
    const { token } = (await (
      await mint(harness, harness.secret())
    ).json()) as { token: string };
    harness.advance(14 * 60 * 1000);
    expect(
      (
        await harness.request(
          PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
          { token },
          remote(),
          { Origin: 'https://station.example.test' },
        )
      ).status,
    ).toBe(200);
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
