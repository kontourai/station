import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('realtime provider privacy boundaries', () => {
  it('does not forward ElevenLabs upstream bodies into public errors or logs', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'examples/elevenlabs-voice/plugin.mjs'),
      'utf8',
    );
    expect(source).not.toMatch(/detail:\s*(err|body|text)/);
    expect(source).not.toMatch(/logger\.(warn|error)\([^\n]*\b(err|body)\b/);
  });

  it('requires an explicit provider selection for live smoke', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'scripts/voice-realtime-live-smoke.mjs'),
      'utf8',
    );
    expect(source).toContain("indexOf('--provider')");
    expect(source).toContain('NOT_VERIFIED');
  });

  it('bounds ElevenLabs authorization issuance by session and outstanding count', async () => {
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'examples/elevenlabs-voice/plugin.mjs'),
    ).href;
    const pluginModule = (await import(moduleUrl)) as {
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
