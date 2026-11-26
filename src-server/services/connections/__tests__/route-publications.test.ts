import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConsentChannelService } from '../../consent/consent-channel.js';
import { RoutePublications } from '../route-publications.js';

const HOST = 'station.example.ts.net';
const APP = `https://${HOST}:8448`;
const CONSENT = `https://${HOST}:8449`;

function setup() {
  const state = {
    enabled: true,
    configured: undefined as string | undefined,
    exitCode: 0,
    serve: {
      TCP: { '8448': { HTTPS: true }, '8449': { HTTPS: true } },
      Web: {
        [`${HOST}:8448`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:5284' } },
        },
        [`${HOST}:8449`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3285' } },
        },
      },
      AllowFunnel: {} as Record<string, boolean>,
    },
  };
  const cli = vi.fn(async (args: readonly string[]) => ({
    exitCode: state.exitCode,
    stdout: JSON.stringify(
      args[0] === 'status'
        ? { Self: { DNSName: `${HOST}.`, Online: true } }
        : state.serve,
    ),
  }));
  const publications = new RoutePublications({
    appPorts: [3282, 5284],
    consentPort: 3285,
    enabled: () => state.enabled,
    configuredOrigin: () => state.configured,
    legacyOrigin: null,
    cli,
  });
  return { state, cli, publications };
}

afterEach(() => vi.useRealTimers());

describe('live route publications', () => {
  test('preview off preserves legacy behavior without consulting Tailscale', async () => {
    const { state, cli, publications } = setup();
    state.enabled = false;
    expect(await publications.resolve()).toMatchObject({
      status: 'disabled',
      consentOrigin: null,
      appOrigins: [],
    });
    expect(cli).not.toHaveBeenCalled();
  });

  test('resolves app and approval roles from one owned Serve snapshot', async () => {
    const { publications, cli } = setup();
    expect(await publications.resolve()).toEqual({
      consentOrigin: CONSENT,
      appOrigins: [APP],
      source: 'tailscale',
      status: 'ready',
    });
    expect(cli.mock.calls.map(([args]) => args)).toEqual([
      ['status', '--json'],
      ['serve', 'status', '--json'],
    ]);
  });

  test('route removal and Funnel changes withdraw approval authority while running', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const { state, publications } = setup();
    expect((await publications.resolve()).consentOrigin).toBe(CONSENT);
    state.serve.AllowFunnel[`${HOST}:8449`] = true;
    await vi.advanceTimersByTimeAsync(1001);
    expect((await publications.resolve()).consentOrigin).toBeNull();
    state.serve.AllowFunnel = {};
    await vi.advanceTimersByTimeAsync(1001);
    expect((await publications.resolve()).consentOrigin).toBe(CONSENT);
    delete (state.serve.Web as Record<string, unknown>)[`${HOST}:8449`];
    await vi.advanceTimersByTimeAsync(1001);
    expect(await publications.resolve()).toMatchObject({
      status: 'unavailable',
      consentOrigin: null,
      appOrigins: [APP],
    });
  });

  test('failed daemon evidence cannot create trusted origins', async () => {
    const { state, publications } = setup();
    state.exitCode = 1;
    expect(await publications.resolve()).toMatchObject({
      consentOrigin: null,
      appOrigins: [],
      status: 'unavailable',
    });
  });

  test('ambiguous and mixed-handler approval mappings fail closed rather than selecting a port', async () => {
    const { state, publications } = setup();
    Object.assign(state.serve.TCP, { '8450': { HTTPS: true } });
    Object.assign(state.serve.Web, {
      [`${HOST}:8450`]: {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:3285' } },
      },
    });
    expect(await publications.resolve()).toMatchObject({
      status: 'ambiguous',
      consentOrigin: null,
      appOrigins: [APP],
    });
    const mixed = setup();
    Object.assign(mixed.state.serve.Web[`${HOST}:8449`]!.Handlers, {
      '/foreign': { Proxy: 'http://127.0.0.1:9000' },
    });
    expect(await mixed.publications.resolve()).toMatchObject({
      status: 'unavailable',
      consentOrigin: null,
      appOrigins: [APP],
    });
  });

  test('persisted operator choice changes live, empty restores discovery, and an app origin cannot be an approval origin', async () => {
    const { state, publications } = setup();
    state.configured = 'https://approvals.example.test';
    expect(await publications.resolve()).toMatchObject({
      consentOrigin: state.configured,
      source: 'configured',
    });
    state.configured = APP;
    expect(await publications.resolve()).toMatchObject({
      consentOrigin: null,
      status: 'unavailable',
    });
    state.configured = '';
    expect((await publications.resolve()).consentOrigin).toBe(CONSENT);
  });

  test('request snapshots stay isolated across concurrent requests and change on the next request', async () => {
    const { state, publications } = setup();
    const channel = new ConsentChannelService({
      resolvePublication: () => publications.resolve(),
    });
    const app = new Hono();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    app.use('*', async (_context, next) => channel.withPublication(next));
    app.get('/first', async (context) => {
      started();
      await waiting;
      return context.json({ origin: channel.trustedOrigin });
    });
    app.get('/next', (context) =>
      context.json({ origin: channel.trustedOrigin }),
    );
    const first = app.request('/first');
    await ready;
    state.configured = 'https://new.example.test';
    expect(await (await app.request('/next')).json()).toEqual({
      origin: state.configured,
    });
    release();
    expect(await (await first).json()).toEqual({ origin: CONSENT });
    expect(channel.trustedOrigin).toBeNull();
  });
});
