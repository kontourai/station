import { HEALTH_PROBE_TIMEOUT_MS } from '@kontourai/station-connect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkServerHealth,
  checkServerHealthDetailed,
  probeServerConnection,
} from '../lib/serverHealth';

const handshake = {
  schemaVersion: 1,
  environmentId: 'environment-1',
  authentication: { scheme: 'bearer', protocolVersion: 1 },
  transports: { http: 1, sse: 1, websocket: 1 },
  compatibility: {
    serverVersion: '0.4.1',
    protocolVersion: 1,
    minClientProtocol: 1,
  },
};

afterEach(() => vi.restoreAllMocks());

describe('checkServerHealth', () => {
  it('propagates a caller-owned abort signal to the status request', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null));

    await expect(
      checkServerHealth(
        'https://station.example.test',
        undefined,
        controller.signal,
      ),
    ).resolves.toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://station.example.test/api/system/status',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('probeServerConnection', () => {
  it('returns verified boot identity after an authenticated handshake', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(handshake))
      .mockResolvedValueOnce(Response.json({ bootId: 'boot-1' }));

    await expect(
      probeServerConnection(
        'https://station.example.test',
        'fixture-credential',
        'environment-1',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ok: true, bootId: 'boot-1' });
    expect(vi.mocked(fetch).mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Bearer fixture-credential' },
    });
  });

  it.each([
    [
      'identity-mismatch',
      Response.json({ ...handshake, environmentId: 'environment-2' }),
    ],
    [
      'unsupported-capability-version',
      Response.json({ ...handshake, schemaVersion: 2 }),
    ],
  ] as const)(
    'returns %s before protected access',
    async (reason, response) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
      await expect(
        probeServerConnection(
          'https://station.example.test',
          'fixture-credential',
          'environment-1',
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: false, reason });
      expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    },
  );

  it('aborts with the shared probe timeout when the host never responds', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      );

      const pending = probeServerConnection(
        'https://station.example.test',
        undefined,
        null,
        new AbortController().signal,
      );
      // Nothing should abort before the shared timeout elapses.
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS - 1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * archive#3297, the reported defect. A phone measured, at the moment of
   * failure: handshake 200, `/api/system/status` 401, `/health` 403 — and was
   * told "Can't reach station. It may be off, asleep, or on another network."
   *
   * These four cases are the ones `if (!handshakeResponse.ok) return
   * { reason: 'unreachable' }` collapsed. Every one of them starts with a
   * response having arrived, so none of them may read as unreachable.
   */
  describe('a host that answers is never reported as unreachable (station#3297)', () => {
    it('reads a 401 on the public handshake as a rejected device', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        Response.json(
          { error: { code: 'authentication_required' } },
          {
            status: 401,
          },
        ),
      );
      await expect(
        probeServerConnection(
          'https://station.example.test',
          'stale-credential',
          'environment-1',
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: false, reason: 'authentication-failed' });
    });

    it('reads a 403 origin refusal as origin policy, not a credential problem', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        Response.json({ error: { code: 'origin_forbidden' } }, { status: 403 }),
      );
      await expect(
        probeServerConnection(
          'https://station.example.test',
          'fixture-credential',
          'environment-1',
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: false, reason: 'origin-not-allowed' });
    });

    it('reads a 404 as something that is not a Station, not an absent host', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Not Found', { status: 404 }),
      );
      await expect(
        probeServerConnection(
          'https://station.example.test',
          'fixture-credential',
          'environment-1',
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: false, reason: 'unexpected-response' });
    });

    it('reads a 200 whose body is not JSON as something else answering', async () => {
      // A captive portal or proxy. This used to throw out of `.json` into
      // the catch block and be reported as a transport failure.
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('<html>Sign in to the network</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
      await expect(
        probeServerConnection(
          'https://station.example.test',
          'fixture-credential',
          'environment-1',
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: false, reason: 'unexpected-response' });
    });

    it('reads an insufficient-scope 403 on the protected request as a device credential problem', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json(handshake))
        .mockResolvedValueOnce(
          Response.json(
            { error: { code: 'insufficient_scope' } },
            {
              status: 403,
            },
          ),
        );
      await expect(
        probeServerConnection(
          'https://station.example.test',
          'scoped-credential',
          'environment-1',
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: false, reason: 'authentication-failed' });
    });

    it('reads a 500 on the protected request as an unusable answer', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json(handshake))
        .mockResolvedValueOnce(new Response('boom', { status: 500 }));
      await expect(
        probeServerConnection(
          'https://station.example.test',
          'fixture-credential',
          'environment-1',
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: false, reason: 'unexpected-response' });
    });

    it('still reports a genuine transport failure as unreachable', async () => {
      // The reason keeps its meaning: nothing answered.
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new TypeError('Failed to fetch'),
      );
      await expect(
        probeServerConnection(
          'https://station.example.test',
          'fixture-credential',
          'environment-1',
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: false, reason: 'unreachable' });
    });
  });

  it('distinguishes authentication rejection', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(handshake))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      probeServerConnection(
        'https://station.example.test',
        'rejected-credential',
        'environment-1',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ok: false, reason: 'authentication-failed' });
  });

  it('flags a live host that no longer serves clients this old', async () => {
    // A host upgraded under a running client. Before this, the client kept
    // reconnecting happily and then misbehaved with no signal at all.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({
        ...handshake,
        compatibility: {
          serverVersion: '9.9.9',
          protocolVersion: 99,
          minClientProtocol: 99,
        },
      }),
    );
    await expect(
      probeServerConnection(
        'https://station.example.test',
        'fixture-credential',
        'environment-1',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'unsupported-capability-version',
    });
    // Refused before any credentialed request went out.
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it('blocks a host that omits the compatibility declaration', async () => {
    const { compatibility: _compatibility, ...unverifiableHandshake } =
      handshake;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(unverifiableHandshake),
    );
    await expect(
      probeServerConnection(
        'https://station.example.test',
        'fixture-credential',
        'environment-1',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'unsupported-capability-version',
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it('blocks a host whose compatibility declaration is malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ ...handshake, compatibility: 'nonsense' }),
    );
    await expect(
      probeServerConnection(
        'https://station.example.test',
        'fixture-credential',
        'environment-1',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'unsupported-capability-version',
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it('connects to a host advertising a compatible contract', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          ...handshake,
          compatibility: {
            serverVersion: '0.4.1',
            protocolVersion: 1,
            minClientProtocol: 1,
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ bootId: 'boot-3' }));
    await expect(
      probeServerConnection(
        'https://station.example.test',
        'fixture-credential',
        'environment-1',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ok: true, bootId: 'boot-3' });
  });

  /**
   * archive#1713 — same recognition as `checkServerHealthDetailed` below,
   * proven against this probe's own catch block: a native invoke-layer
   * refusal must not collapse into 'unreachable' or 'timeout' here either.
   */
  it('classifies a native invoke-layer refusal as authentication-failed, not unreachable (station#1713)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Native Station request failed: Station has no host-authorized active Station',
        ),
        { code: 'no_active_profile' },
      ),
    );
    await expect(
      probeServerConnection(
        'https://station.example.test',
        'fixture-credential',
        'environment-1',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ok: false, reason: 'authentication-failed' });
  });

  it('classifies a mid-authorization native Station as awaiting-approval, not a failure (station#1713)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Native Station request failed: the active Station is mid-authorization for native requests',
        ),
        { code: 'mid_authorization' },
      ),
    );
    await expect(
      probeServerConnection(
        'https://station.example.test',
        'fixture-credential',
        'environment-1',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ok: false, reason: 'awaiting-approval' });
  });

  /**
   * The coordinator's -1 correction: a profile that was never
   * configured here at all (nothing pending, no approval was ever
   * requested) must not read as `awaiting-approval` — that would leave the
   * UI saying "Waiting for approval…" forever with nothing on its way.
   */
  it('classifies a native Station that was never configured here as authentication-failed, not awaiting-approval (station#1713)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Native Station request failed: the active Station is not configured for native requests',
        ),
        { code: 'not_configured' },
      ),
    );
    await expect(
      probeServerConnection(
        'https://station.example.test',
        'fixture-credential',
        'environment-1',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ok: false, reason: 'authentication-failed' });
  });
});

describe('checkServerHealthDetailed (401 must not read as unreachable)', () => {
  it('reports a rejected credential as authentication-failed, not unreachable', async () => {
    // A reachable Station that rejects the saved credential answers 401.
    // Collapsing that to "unreachable" told the user to check the host when the
    // host was fine and the credential was what needed replacing.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    await expect(
      checkServerHealthDetailed('http://station.example:3141', 'stale-token'),
    ).resolves.toEqual({ ok: false, reason: 'authentication-failed' });
  });

  it('does NOT treat origin policy as an auth failure — pairing cannot fix it', async () => {
    // Classifying it as a credential problem would point the user at a fix
    // that cannot work. It is equally not "unreachable" — the host answered.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'origin_forbidden' } }),
            {
              status: 403,
            },
          ),
      ),
    );
    await expect(
      checkServerHealthDetailed('http://station.example:3141'),
    ).resolves.toEqual({ ok: false, reason: 'origin-not-allowed' });
  });

  /**
   * archive#3297 — the correction to this probe's own comment. It asserted
   * this server returns 403 "never for a rejected credential"; `runtime-http.ts`
   * answers 403 `insufficient_scope` for a credential it recognized and will
   * not accept, at four separate sites.
   */
  it('treats a recognized-but-insufficient credential as an auth failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'insufficient_scope' } }),
            { status: 403 },
          ),
      ),
    );
    await expect(
      checkServerHealthDetailed('http://station.example:3141', 'scoped-token'),
    ).resolves.toEqual({ ok: false, reason: 'authentication-failed' });
  });

  it('refuses to guess which 403 it is when nothing coded the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>Forbidden</html>', { status: 403 }),
      ),
    );
    await expect(
      checkServerHealthDetailed('http://station.example:3141'),
    ).resolves.toEqual({ ok: false, reason: 'unexpected-response' });
  });

  it('still reports a genuine transport failure as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(
      checkServerHealthDetailed('http://station.example:3141'),
    ).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });

  /**
   * archive#1713 — the miscategorization that cost hours of debugging: the
   * desktop native transport's invoke-layer refusal (an ordinary thrown
   * `Error`, indistinguishable by shape from a real transport failure) used
   * to collapse into 'unreachable' here. It must not — the host is fine.
   */
  it('classifies a native invoke-layer refusal as authentication-failed, not unreachable (station#1713)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(
          new Error(
            'Native Station request failed: Station has no host-authorized active Station',
          ),
          { code: 'no_active_profile' },
        );
      }),
    );
    await expect(
      checkServerHealthDetailed('http://station.example:3141', 'stale-token'),
    ).resolves.toEqual({ ok: false, reason: 'authentication-failed' });
  });

  it('classifies a mid-authorization native Station as awaiting-approval, not a failure (station#1713)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(
          new Error(
            'Native Station request failed: the active Station is mid-authorization for native requests',
          ),
          { code: 'mid_authorization' },
        );
      }),
    );
    await expect(
      checkServerHealthDetailed('http://station.example:3141', 'stale-token'),
    ).resolves.toEqual({ ok: false, reason: 'awaiting-approval' });
  });

  it('reports a healthy Station as ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    await expect(
      checkServerHealthDetailed('http://station.example:3141', 'good'),
    ).resolves.toEqual({ ok: true });
  });
});
