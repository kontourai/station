import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const pluginUrl = pathToFileURL(
  resolve(process.cwd(), 'examples/elevenlabs-voice/plugin.mjs'),
).href;

describe('realtime provider privacy boundaries', () => {
  it.each([
    ['STT', { type: 'stt' }],
    ['TTS', { type: 'tts' }],
  ])(
    'does not forward an ElevenLabs %s upstream body or failure into public errors or logs',
    async (_label, request) => {
      const canary = 'upstream-secret-canary';
      const register = (
        (await import(pluginUrl)) as {
          default: (
            app: unknown,
            options: { config: unknown; logger: unknown },
          ) => void;
        }
      ).default;
      let handler: ((c: unknown) => Promise<unknown>) | undefined;
      const logged: unknown[] = [];
      const logger = {
        warn: (...args: unknown[]) => logged.push(args),
        error: (...args: unknown[]) => logged.push(args),
        info: (...args: unknown[]) => logged.push(args),
      };
      register(
        {
          post: (_path: string, route: typeof handler) => {
            handler = route;
          },
        },
        {
          config: {
            get: (key: string) => (key === 'apiKey' ? 'key' : undefined),
          },
          logger,
        },
      );
      let session = 0;
      const call = () =>
        handler?.({
          req: {
            json: async () => ({
              ...request,
              sessionId: `session-${++session}`,
            }),
          },
          json: (body: unknown, status = 200) => ({ body, status }),
        });
      const upstream = vi.fn();
      vi.stubGlobal('fetch', upstream);
      try {
        // A non-ok upstream response carrying its own error body.
        upstream.mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: async () => ({ detail: canary }),
          text: async () => canary,
        });
        const rejected = await call();
        expect(rejected).toMatchObject({ status: 502 });
        // A transport failure whose message carries upstream text.
        upstream.mockRejectedValueOnce(new Error(canary));
        const failed = await call();
        expect(failed).toMatchObject({
          status: 500,
          body: { error: 'Internal error' },
        });
        expect(upstream).toHaveBeenCalledTimes(2);
        // JSON.stringify renders an Error as {}, yet a real logger or client
        // prints its message; expand Errors so passing one along is visible.
        const serialized = JSON.stringify(
          [rejected, failed, logged],
          (_key, value: unknown) =>
            value instanceof Error
              ? { message: value.message, stack: value.stack }
              : value,
        );
        expect(serialized).not.toContain(canary);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('bounds ElevenLabs authorization issuance by session and outstanding count', async () => {
    const pluginModule = (await import(pluginUrl)) as {
      createMintGuard(now: () => number): {
        reserve(sessionId: string):
          | {
              ok: true;
              releaseFailure(): void;
            }
          | { ok: false; retryAt: number };
      };
    };
    let now = 1_000;
    const guard = pluginModule.createMintGuard(() => now);
    const first = guard.reserve('session-1');
    expect(first.ok).toBe(true);
    for (let index = 2; index <= 6; index += 1) {
      expect(guard.reserve(`session-${index}`).ok).toBe(true);
    }

    expect(guard.reserve('session-1').ok).toBe(false);
    expect(guard.reserve('session-7').ok).toBe(false);
    if (first.ok) first.releaseFailure();
    expect(guard.reserve('session-7').ok).toBe(true);

    now += 61_000;
    expect(guard.reserve('session-1').ok).toBe(true);
  });
});
