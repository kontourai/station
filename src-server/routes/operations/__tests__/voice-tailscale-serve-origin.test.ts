/**
 * The credential-free voice WebSocket reads the same origin policy as the
 * HTTP API: a browser page served from this Station's own Tailscale Serve
 * origin may upgrade on the loopback path with no `ALLOWED_ORIGINS` entry,
 * and nothing else gains admission.
 *
 * This drives a real `ws` upgrade against the production listener and the
 * production `stationOriginPolicy`. Only the `tailscale` executable is faked,
 * at `execFile`, so the resolver, its parser and its cache all run.
 */
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { stationOriginPolicy } from '../../../security/station-browser-origins.js';
import { attachVoiceWebSocket } from '../voice.js';

const NODE = 'station.example.ts.net';

const tailscale = vi.hoisted(() => ({
  /** `undefined` = the executable is not installed. */
  status: undefined as string | undefined,
  serve: undefined as string | undefined,
  calls: 0,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = ((
    executable: string,
    args: readonly string[],
    ...rest: unknown[]
  ) => {
    if (!/(^|[\\/])tailscale$/i.test(executable)) {
      return (actual.execFile as (...values: unknown[]) => unknown)(
        executable,
        args,
        ...rest,
      );
    }
    tailscale.calls += 1;
    const callback = rest.at(-1) as (
      error: (Error & { code?: unknown }) | null,
      stdout: string,
    ) => void;
    const stdout = args[0] === 'status' ? tailscale.status : tailscale.serve;
    queueMicrotask(() => {
      if (stdout === undefined) {
        callback(Object.assign(new Error('absent'), { code: 'ENOENT' }), '');
      } else {
        callback(null, stdout);
      }
    });
    return undefined;
  }) as typeof actual.execFile;
  return { ...actual, execFile };
});

const STATUS_JSON = JSON.stringify({
  Self: { DNSName: `${NODE}.`, Online: true },
});

function serveJson(port: number, funnel = false): string {
  const authority = `${NODE}:443`;
  return JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: {
      [authority]: {
        Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } },
      },
    },
    ...(funnel ? { AllowFunnel: { [authority]: true } } : {}),
  });
}

// The production resolver is memoized per port with a 30-second cache, so
// each case owns its own Station port.
let nextServerPort = 47_610;

const listeners: WebSocketServer[] = [];

afterEach(async () => {
  for (const wss of listeners.splice(0))
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  delete process.env.ALLOWED_ORIGINS;
  tailscale.status = undefined;
  tailscale.serve = undefined;
  tailscale.calls = 0;
});

async function startVoice(serverPort: number) {
  const voiceService = {
    createSession: vi.fn(),
    getActiveCount: vi.fn(() => 0),
  };
  const wss = attachVoiceWebSocket(0, voiceService as never, '127.0.0.1', {
    verifyCredential: () => false,
    browserOrigins: stationOriginPolicy({
      port: serverPort,
      host: '127.0.0.1',
    }),
  });
  if (!wss) throw new Error('voice websocket was not created');
  listeners.push(wss);
  await once(wss, 'listening');
  const address = wss.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  return { voiceService, port: address.port };
}

/** `'open'` when the upgrade is admitted, else the client's error text. */
async function upgrade(port: number, origin: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?agent=station-voice`, {
    origin,
  });
  const outcome = await new Promise<string>((resolve) => {
    ws.once('error', (error) => resolve(error.message));
    ws.once('open', () => resolve('open'));
  });
  if (outcome === 'open') {
    ws.close();
    await once(ws, 'close');
  }
  return outcome;
}

describe('voice websocket: one origin policy with the HTTP API', () => {
  it("admits an upgrade from this Station's own Serve origin with no ALLOWED_ORIGINS entry", async () => {
    const serverPort = nextServerPort++;
    tailscale.status = STATUS_JSON;
    tailscale.serve = serveJson(serverPort);
    const { voiceService, port } = await startVoice(serverPort);
    expect(await upgrade(port, `https://${NODE}`)).toBe('open');
    expect(voiceService.createSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'Funnel is on', origin: `https://${NODE}`, funnel: true },
    {
      name: 'the origin is another node',
      origin: 'https://other.example.ts.net',
      funnel: false,
    },
    {
      name: 'the plain-HTTP spelling is presented',
      origin: `http://${NODE}`,
      funnel: false,
    },
  ])('refuses the upgrade when $name', async ({ origin, funnel }) => {
    const serverPort = nextServerPort++;
    tailscale.status = STATUS_JSON;
    tailscale.serve = serveJson(serverPort, funnel);
    const { voiceService, port } = await startVoice(serverPort);
    expect(await upgrade(port, origin)).toBe('Unexpected server response: 403');
    expect(voiceService.createSession).not.toHaveBeenCalled();
  });

  it('refuses a non-tailnet origin without consulting Tailscale, and admits an explicit entry first', async () => {
    const serverPort = nextServerPort++;
    process.env.ALLOWED_ORIGINS = 'https://configured.example';
    tailscale.status = STATUS_JSON;
    tailscale.serve = serveJson(serverPort);
    const { port } = await startVoice(serverPort);
    expect(await upgrade(port, 'https://evil.example')).toBe(
      'Unexpected server response: 403',
    );
    expect(await upgrade(port, 'https://configured.example')).toBe('open');
    expect(tailscale.calls).toBe(0);
  });
});
