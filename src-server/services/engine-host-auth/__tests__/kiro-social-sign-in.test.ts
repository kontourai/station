/**
 * Kiro's Google/GitHub sign-in through Station's EngineHostAuthService,
 * against a stub portal and social service: the real loopback listener on
 * free local ports (the allowlisted ones are injected), the real exchange,
 * vault and issuer. The test plays the browser, as the portal would send it.
 */
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { REVIEWED_ENGINE_CREDENTIAL_BINDINGS } from '../../acp/acp-inbound-extension-policy.js';
import { KIRO_CREDENTIAL_KIND } from '../kiro-oidc/kiro-sign-in.js';
import {
  KIRO_SOCIAL_CALLBACK_PORTS,
  openSocialCallbackListener,
} from '../kiro-oidc/social.js';
import { EngineHostAuthService } from '../service.js';
import {
  SOCIAL_PROFILE_ARN,
  type SocialStub,
  startSocialStub,
} from './fixtures/social-stub.js';

const makeTempDir = trackTempDirs();
const KIRO = REVIEWED_ENGINE_CREDENTIAL_BINDINGS.find(
  (binding) => binding.id === 'kiro.get-access-token',
)!;
const SCOPE = {
  connectionId: 'kiro-kas-bundle',
  credentialProfileRef: 'default',
};

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Ports nothing listens on right now. */
async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    ports.push((server.address() as AddressInfo).port);
    await new Promise((resolve) => server.close(resolve));
  }
  return ports;
}

async function occupy(port: number): Promise<Server> {
  const server = createServer((_request, response) => response.end('other'));
  await new Promise<void>((resolve) =>
    server.listen(port, '127.0.0.1', resolve),
  );
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

function accepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function setup(
  options: { ports?: number[]; timeoutMs?: number; now?: () => number } = {},
) {
  const stub: SocialStub = await startSocialStub();
  const home = makeTempDir('kiro-social-');
  cleanups.push(() => stub.close());
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const ports = options.ports ?? (await freePorts(2));
  const service = new EngineHostAuthService({
    homeDir: home,
    policy: () => 'allowed',
    social: stub.endpoints,
    socialCallbackPorts: ports,
    ...(options.timeoutMs !== undefined
      ? { socialCallbackTimeoutMs: options.timeoutMs }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  cleanups.push(() => service.cancelLogin(SCOPE));
  return { stub, service, ports };
}

/** What the portal hands back: the redirect target, from the sign-in link. */
function portalTarget(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
  return {
    url,
    state: url.searchParams.get('state') ?? '',
    port: Number(redirect.port),
  };
}

async function browserCallback(port: number, pathAndQuery: string) {
  // 127.0.0.1, not `localhost`: the listener binds IPv4 loopback only.
  const response = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`);
  return { status: response.status, text: await response.text() };
}

async function startSocial(service: EngineHostAuthService) {
  const started = await service.startLogin(SCOPE, { identity: 'social' });
  expect(started.phase).toBe('awaiting-approval');
  return portalTarget(started.authorizationUrl ?? '');
}

describe('Kiro social sign-in against a stub portal and service', () => {
  test('the portal link, the callback and the exchange land a social credential, and the listener closes', async () => {
    const { stub, service, ports } = await setup();
    stub.exchangeAnswers.push({
      accessToken: 'social-access',
      refreshToken: 'social-refresh',
      expiresIn: 3600,
      profileArn: SOCIAL_PROFILE_ARN,
    });
    const { url, state, port } = await startSocial(service);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${stub.endpoints.portalUrl}/signin`,
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(
      `http://localhost:${ports[0]}`,
    );
    expect(url.searchParams.get('redirect_from')).toBe('kirocli');
    expect(state).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(port).toBe(ports[0]);
    // The browser opens the portal, then the portal sends it back.
    await fetch(url);
    const page = await browserCallback(
      port,
      `/oauth/callback?login_option=google&code=the-code&state=${state}`,
    );
    expect(page.status).toBe(200);
    expect(page.text).toContain('Signed in');
    await vi.waitFor(() =>
      expect(service.login(SCOPE)?.phase).toBe('completed'),
    );

    const exchange = stub.requests.find((r) => r.path === '/oauth/token');
    expect(exchange?.body).toMatchObject({
      code: 'the-code',
      redirect_uri: `http://localhost:${port}/oauth/callback?login_option=google`,
    });
    // Station's own identity, never kiro-cli's.
    expect(exchange?.userAgent).toBe('Station');
    expect(service.status(SCOPE)).toMatchObject({
      state: 'signed-in',
      identity: { kind: 'social', provider: 'google' },
    });
    const issued = await service.issuerFor(SCOPE).issue(KIRO);
    expect(issued).toMatchObject({
      kind: 'issued',
      issue: {
        accessToken: 'social-access',
        attributes: { profileArn: SOCIAL_PROFILE_ARN, provider: 'Google' },
      },
    });
    expect(JSON.stringify(issued)).not.toContain('social-refresh');
    expect(await accepting(port)).toBe(false);
  });

  test('GitHub, via the other callback path, is stored as github', async () => {
    const { stub, service } = await setup();
    stub.exchangeAnswers.push({
      accessToken: 'gh',
      refreshToken: 'r',
      profileArn: SOCIAL_PROFILE_ARN,
    });
    const { url, state, port } = await startSocial(service);
    await fetch(url);
    await browserCallback(
      port,
      `/signin/callback?login_option=github&code=c&state=${state}`,
    );
    await vi.waitFor(() =>
      expect(service.status(SCOPE).identity).toEqual({
        kind: 'social',
        provider: 'github',
      }),
    );
    expect(
      stub.requests.find((r) => r.path === '/oauth/token')?.body.redirect_uri,
    ).toBe(`http://localhost:${port}/signin/callback?login_option=github`);
  });

  test('a callback with another state is refused, nothing is exchanged, and the listener closes', async () => {
    const { stub, service } = await setup();
    const { url, port } = await startSocial(service);
    await fetch(url);
    const page = await browserCallback(
      port,
      '/oauth/callback?login_option=google&code=c&state=someone-elses',
    );
    expect(page.text).toContain('did not finish');
    await vi.waitFor(() =>
      expect(service.login(SCOPE)).toMatchObject({
        phase: 'failed',
        failure: 'refused',
      }),
    );
    expect(stub.requests).toEqual([]);
    expect(service.status(SCOPE).state).toBe('signed-out');
    await vi.waitFor(async () => expect(await accepting(port)).toBe(false));
  });

  test('only the callback paths are answered: a stray path is ignored, this sign-in on a wrong path fails it', async () => {
    const { stub, service } = await setup();
    const { state, port } = await startSocial(service);
    expect((await browserCallback(port, '/favicon.ico')).status).toBe(404);
    expect(service.login(SCOPE)?.phase).toBe('awaiting-approval');
    expect(
      (
        await browserCallback(
          port,
          `/oauth/callback/?login_option=google&code=c&state=${state}`,
        )
      ).status,
    ).toBe(404);
    await vi.waitFor(() =>
      expect(service.login(SCOPE)).toMatchObject({
        phase: 'failed',
        failure: 'refused',
      }),
    );
    expect(service.login(SCOPE)?.reason).toContain('does not listen on');
    expect(stub.requests).toEqual([]);
    await vi.waitFor(async () => expect(await accepting(port)).toBe(false));
  });

  test('the portal reporting an error ends the sign-in as refused', async () => {
    const { stub, service } = await setup();
    const { state, port } = await startSocial(service);
    await browserCallback(
      port,
      `/oauth/callback?error=access_denied&state=${state}`,
    );
    await vi.waitFor(() =>
      expect(service.login(SCOPE)).toMatchObject({
        phase: 'failed',
        failure: 'refused',
        reason: "Kiro's sign-in page refused the sign-in: access_denied",
      }),
    );
    expect(stub.requests).toEqual([]);
  });

  test('a busy allowlisted port is skipped for the next one', async () => {
    const [busy, free] = await freePorts(2);
    await occupy(busy!);
    const { service } = await setup({ ports: [busy!, free!] });
    const { port, url } = await startSocial(service);
    expect(port).toBe(free);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `http://localhost:${free}`,
    );
  });

  test('every allowlisted port busy: unavailable, and Builder ID or Identity Center is offered', async () => {
    const ports = await freePorts(2);
    for (const port of ports) await occupy(port);
    const { service } = await setup({ ports });
    const started = await service.startLogin(SCOPE, { identity: 'social' });
    expect(started).toMatchObject({ phase: 'failed', failure: 'unavailable' });
    expect(started.reason).toContain('AWS Builder ID or IAM Identity Center');
  });

  test('no answer before the deadline: expired, and the listener closes', async () => {
    const { stub, service } = await setup({ timeoutMs: 150 });
    const { port } = await startSocial(service);
    expect(await accepting(port)).toBe(true);
    await vi.waitFor(() =>
      expect(service.login(SCOPE)).toMatchObject({
        phase: 'failed',
        failure: 'expired',
      }),
    );
    expect(stub.requests).toEqual([]);
    await vi.waitFor(async () => expect(await accepting(port)).toBe(false));
  });

  test('cancelling closes the listener and keeps nothing', async () => {
    const { service } = await setup();
    const { port } = await startSocial(service);
    expect(service.cancelLogin(SCOPE)?.phase).toBe('cancelled');
    await vi.waitFor(async () => expect(await accepting(port)).toBe(false));
    expect(service.login(SCOPE)?.phase).toBe('cancelled');
  });

  test('an exchange the service refuses fails as refused and stores nothing', async () => {
    const { stub, service } = await setup();
    stub.exchangeAnswers.push({ status: 401, error: 'invalid_grant' });
    const { url, state, port } = await startSocial(service);
    await fetch(url);
    await browserCallback(
      port,
      `/oauth/callback?login_option=google&code=c&state=${state}`,
    );
    await vi.waitFor(() =>
      expect(service.login(SCOPE)).toMatchObject({
        phase: 'failed',
        failure: 'refused',
        reason: 'Kiro did not accept the sign-in: HTTP 401 invalid_grant',
      }),
    );
    expect(service.status(SCOPE).state).toBe('signed-out');
  });

  test('an exchange answer without a profile is not kept', async () => {
    const { stub, service } = await setup();
    stub.exchangeAnswers.push({ accessToken: 'a', refreshToken: 'r' });
    const { url, state, port } = await startSocial(service);
    await fetch(url);
    await browserCallback(
      port,
      `/oauth/callback?login_option=google&code=c&state=${state}`,
    );
    await vi.waitFor(() => expect(service.login(SCOPE)?.phase).toBe('failed'));
    expect(service.status(SCOPE).state).toBe('signed-out');
  });

  test('refresh at the social service rotates the token; invalid_grant reads as refresh-rejected and is not retried', async () => {
    let now = Date.now();
    const { stub, service } = await setup({ now: () => now });
    stub.exchangeAnswers.push({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresIn: 600,
      profileArn: SOCIAL_PROFILE_ARN,
    });
    const { url, state, port } = await startSocial(service);
    await fetch(url);
    await browserCallback(
      port,
      `/oauth/callback?login_option=google&code=c&state=${state}`,
    );
    await vi.waitFor(() =>
      expect(service.login(SCOPE)?.phase).toBe('completed'),
    );

    now += 9 * 60 * 1000;
    stub.refreshAnswers.push({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresIn: 600,
    });
    const issuer = service.issuerFor(SCOPE);
    expect(await issuer.issue(KIRO)).toMatchObject({
      kind: 'issued',
      issue: {
        accessToken: 'access-2',
        attributes: { profileArn: SOCIAL_PROFILE_ARN, provider: 'Google' },
      },
    });
    const refresh = stub.requests.filter((r) => r.path === '/refreshToken');
    expect(refresh.map((r) => r.body)).toEqual([{ refreshToken: 'refresh-1' }]);
    expect(refresh[0]?.userAgent).toBe('Station');

    now += 9 * 60 * 1000;
    stub.refreshAnswers.push({ status: 400, error: 'invalid_grant' });
    expect(await issuer.issue(KIRO)).toEqual({
      kind: 'refused',
      reason: 'refresh-rejected',
    });
    expect(service.status(SCOPE).state).toBe('refresh-rejected');
    expect(await issuer.issue(KIRO)).toEqual({
      kind: 'refused',
      reason: 'refresh-rejected',
    });
    expect(
      stub.requests
        .filter((r) => r.path === '/refreshToken')
        .map((r) => r.body.refreshToken),
    ).toEqual(['refresh-1', 'refresh-2']);
    // The vault kept the rotated token for the refresh that was refused.
    expect(
      service.vault.read(KIRO_CREDENTIAL_KIND, SCOPE)?.credential,
    ).toMatchObject({
      refreshToken: 'refresh-2',
    });
  });

  test('the listener binds IPv4 loopback only', async () => {
    const [port] = await freePorts(1);
    const listener = await openSocialCallbackListener({
      ports: [port!],
      state: 'abc',
      timeoutMs: 60_000,
    });
    cleanups.push(() => listener.cancel());
    expect(listener.address).toBe('127.0.0.1');
    listener.cancel();
    await listener.closed;
    expect(await accepting(port!)).toBe(false);
  });

  test('the production ports are the ones Kiro allowlists', () => {
    expect(KIRO_SOCIAL_CALLBACK_PORTS).toEqual([
      3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153,
    ]);
  });
});
