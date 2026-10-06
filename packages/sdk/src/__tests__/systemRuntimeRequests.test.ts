import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { StationHttpError, StationRequestTimeoutError } from '../client/http';
import { requestCoreUpdateRestartStatus } from '../core-update-restart-status';
import { getDeploymentCapabilityState } from '../query-domains/systemRuntime';
import {
  applyCoreUpdate,
  fetchBranding,
  fetchFleetRoutingReceiptsForStation,
  fetchFleetServeReceiptsForStation,
  fetchMonitoringMetrics,
  fetchServerCapabilities,
  requestCoreUpdateStatus,
  requestServiceUpdateProgress,
  requestSystemIdentity,
  requestSystemStatus,
  verifyManagedRuntimeConnection,
} from '../query-domains/systemRuntimeRequests';

describe('systemRuntimeRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('preserves a bounded history window and its truncation disclosure', async () => {
    const { fetchMonitoringEventWindow } = await import(
      '../query-domains/systemRuntimeRequests'
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [{ id: 'recent' }],
        truncated: true,
      }),
    } as Response);
    const result = await fetchMonitoringEventWindow(
      new Date(0),
      new Date(1000),
      undefined,
      { limit: 1000 },
    );
    expect(result).toEqual({ events: [{ id: 'recent' }], truncated: true });
    expect(
      String(
        vi.mocked(fetch).mock.calls[
          vi.mocked(fetch).mock.calls.length - 1
        ]?.[0],
      ),
    ).toContain('limit=1000');
  });

  it('requests all history as JSON rather than accidentally opening the live SSE stream', async () => {
    const { fetchMonitoringEventWindow } = await import(
      '../query-domains/systemRuntimeRequests'
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: [], truncated: false }),
    } as Response);
    await expect(fetchMonitoringEventWindow()).resolves.toEqual({
      events: [],
      truncated: false,
    });
    const requested = new URL(
      String(
        vi.mocked(fetch).mock.calls[
          vi.mocked(fetch).mock.calls.length - 1
        ]?.[0],
      ),
    );
    expect(
      Number.isFinite(Date.parse(requested.searchParams.get('end')!)),
    ).toBe(true);
  });

  it('rejects success without an event array', async () => {
    const { fetchMonitoringEventWindow } = await import(
      '../query-domains/systemRuntimeRequests'
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);
    await expect(fetchMonitoringEventWindow(new Date(0))).rejects.toThrow(
      'no event array',
    );
  });

  it('uses the configured API base and normalizes branding defaults', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: {} }),
    } as Response);

    await expect(fetchBranding()).resolves.toEqual({
      appName: 'Station',
      logo: null,
      theme: null,
      welcomeMessage: null,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://example.test/api/branding',
      { headers: { 'X-Station-Client-Protocol': '1' } },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a branding error answer instead of reporting "no theme"', async () => {
    // A resolved `theme: null` would clear a white-label theme the UI cached;
    // an error has to reject so the query keeps what it had.
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: 'provider down' }),
    } as Response);
    await expect(fetchBranding()).rejects.toBeInstanceOf(StationHttpError);

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, error: 'provider down' }),
    } as Response);
    await expect(fetchBranding()).rejects.toThrow('provider down');
  });

  it('passes a deadline that fires mid-body on as the timeout, not a failed answer', async () => {
    const deadline = new StationRequestTimeoutError(
      'http://example.test/api/branding',
      20,
      { method: 'GET' },
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => {
        throw deadline;
      },
    } as unknown as Response);
    await expect(fetchBranding()).rejects.toBe(deadline);
  });

  it('passes the provider theme through untouched for the consumer to validate', async () => {
    const theme = { dark: { '--k-focus': '#93c5fd' }, '--k-brand': 'url(x)' };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { theme } }),
    } as Response);
    await expect(fetchBranding()).resolves.toMatchObject({ theme });
  });

  it('returns an empty metrics list when monitoring reports failure', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: false,
        data: { metrics: [{ agentSlug: 'one' }] },
      }),
    } as Response);

    await expect(fetchMonitoringMetrics('week')).resolves.toEqual([]);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://example.test/monitoring/metrics?range=week',
      { headers: { 'X-Station-Client-Protocol': '1' } },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the provided API base for system status and rejects non-ok responses', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ ready: false }),
    } as Response);

    await expect(requestSystemStatus('http://custom.test')).rejects.toThrow(
      'Failed to fetch system status',
    );

    expect(fetch).toHaveBeenCalledWith(
      'http://custom.test/api/system/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  // station#3444: `resolveSystemStatusRefetchInterval` and
  // `shouldRetrySystemStatus` classify a terminal (401/403) failure by
  // `error instanceof StationHttpError && isTerminalConnectionStatus(status)`
  // — that only works if this fetcher actually preserves the status rather
  // than discarding it into a generic `Error`.
  it('preserves the response status as a StationHttpError', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ready: false }),
    } as Response);

    let caught: unknown;
    try {
      await requestSystemStatus('http://custom.test');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StationHttpError);
    expect((caught as StationHttpError).status).toBe(401);
  });

  it('surfaces the server endpoint identity through the typed contract (#2551)', async () => {
    const status = {
      acp: { connected: false, connections: [] },
      clis: {},
      ready: true,
      externalEngines: [
        {
          engineId: 'codex',
          engineConnectionId: 'codex-connection',
          name: 'Codex',
          detected: true,
          ready: true,
          source: 'codex-cli',
        },
      ],
      server: {
        host: '127.0.0.1',
        port: 3141,
        publicOrigins: ['https://kontour.example.ts.net'],
      },
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => status,
    } as Response);

    const resolved = await requestSystemStatus();
    expect(resolved).toEqual(status);
    // Typed access, not a cast: the SDK contract must declare the block.
    expect(resolved.server?.host).toBe('127.0.0.1');
    expect(resolved.server?.port).toBe(3141);
    expect(resolved.server?.publicOrigins).toEqual([
      'https://kontour.example.ts.net',
    ]);
    expect(resolved.externalEngines?.[0]).toMatchObject({
      engineId: 'codex',
      engineConnectionId: 'codex-connection',
    });
  });

  it('returns deployed build provenance without changing the status request contract', async () => {
    const status = {
      acp: { connected: false, connections: [] },
      clis: {},
      ready: true,
      build: {
        fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
        shortSha: 'abcdef0',
        branch: 'main',
        builtAt: '2026-07-10T18:00:00.000Z',
        ageSeconds: 42,
        instanceId: 'dogfood',
      },
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => status,
    } as Response);

    await expect(requestSystemStatus()).resolves.toEqual(status);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/system/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('posts core updates through the helper and surfaces server errors', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, error: 'boom' }),
    } as Response);

    await expect(applyCoreUpdate('http://custom.test')).rejects.toThrow('boom');

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://custom.test/api/system/core-update',
      { method: 'POST', headers: { 'X-Station-Client-Protocol': '1' } },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an accepted restart that omits its watchdog correlation', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, restarting: true }),
    } as Response);

    await expect(applyCoreUpdate('http://custom.test')).rejects.toThrow(
      'Core update restart could not be verified',
    );
  });

  it('reads only a complete correlated watchdog restart-status with its caller abort signal', async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'verified',
        expectedHash: 'abcdef0',
        expectedInstanceId: 'instance-1',
        deadlineAt: '2026-08-09T12:01:35.000Z',
        resolvedAt: '2026-08-09T12:00:12.000Z',
      }),
    } as Response);

    await expect(
      requestCoreUpdateRestartStatus('http://custom.test', controller.signal),
    ).resolves.toEqual({
      status: 'verified',
      expectedHash: 'abcdef0',
      expectedInstanceId: 'instance-1',
      deadlineAt: '2026-08-09T12:01:35.000Z',
      resolvedAt: '2026-08-09T12:00:12.000Z',
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://custom.test/api/system/core-update/restart-status',
      {
        signal: controller.signal,
        headers: { 'X-Station-Client-Protocol': '1' },
      },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed restart-status rather than treating it as verified', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'verified', expectedHash: 'abcdef0' }),
    } as Response);

    await expect(
      requestCoreUpdateRestartStatus(
        'http://custom.test',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Core update restart status is unavailable');
  });

  it('rejects a terminal restart-status without its durable resolvedAt', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'verified',
        expectedHash: 'abcdef0',
        expectedInstanceId: 'instance-1',
        deadlineAt: '2026-08-09T12:01:35.000Z',
      }),
    } as Response);

    await expect(
      requestCoreUpdateRestartStatus(
        'http://custom.test',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Core update restart status is unavailable');
  });

  it('rejects unknown fields in a durable restart-status document', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'pending',
        expectedHash: 'abcdef0',
        expectedInstanceId: 'instance-1',
        deadlineAt: '2026-08-09T12:01:35.000Z',
        detail: 'must not be projected',
      }),
    } as Response);

    await expect(
      requestCoreUpdateRestartStatus(
        'http://custom.test',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Core update restart status is unavailable');
  });

  it('posts managed runtime verification through the generic endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ verified: true }),
    } as Response);

    await expect(verifyManagedRuntimeConnection('us-west-2')).resolves.toEqual({
      verified: true,
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://example.test/api/system/verify-managed-runtime');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ region: 'us-west-2' }));
    expect(new Headers(init.headers).get('Content-Type')).toBe(
      'application/json',
    );
  });

  describe('release-archive update (#2675 D3)', () => {
    const REQUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const respond = (body: unknown, ok = true, status = 200) =>
      vi.mocked(fetch).mockResolvedValue({
        ok,
        status,
        json: async () => body,
      } as Response);

    it('carries an archive-service status with its versions, check and progress', async () => {
      respond({
        installKind: 'archive-service',
        applyMethod: 'service-update',
        channel: 'preview',
        currentVersion: '0.8.0-preview.1',
        latestVersion: '0.8.0-preview.2',
        releaseCheck: 'verified',
        updateAvailable: true,
        selfUpdateUnavailableReason: null,
        serviceUpdate: {
          state: 'updating',
          requestId: REQUEST_ID,
          phase: 'trial',
          fromVersion: '0.8.0-preview.1',
          targetVersion: '0.8.0-preview.2',
          attempts: 1,
        },
      });
      expect(await requestCoreUpdateStatus('http://custom.test')).toMatchObject(
        {
          installKind: 'archive-service',
          applyMethod: 'service-update',
          currentVersion: '0.8.0-preview.1',
          latestVersion: '0.8.0-preview.2',
          releaseCheck: 'verified',
          serviceUpdate: { state: 'updating', phase: 'trial', attempts: 1 },
        },
      );
    });

    it('drops an install kind or release check it does not know instead of passing it on', async () => {
      respond({
        installKind: 'container-image',
        releaseCheck: 'maybe',
        updateAvailable: false,
      });
      const status = await requestCoreUpdateStatus('http://custom.test');
      expect(status.installKind).toBeUndefined();
      expect(status.releaseCheck).toBeUndefined();
    });

    it.each([
      [
        { state: 'queued', requestId: REQUEST_ID },
        { state: 'queued', requestId: REQUEST_ID },
      ],
      [
        {
          state: 'rolled-back',
          requestId: null,
          fromVersion: '1.0.0',
          targetVersion: '1.1.0',
          reason: 'prepared-timeout',
          finishedAt: '2026-09-27T12:00:00.000Z',
        },
        {
          state: 'rolled-back',
          requestId: null,
          fromVersion: '1.0.0',
          targetVersion: '1.1.0',
          reason: 'prepared-timeout',
          finishedAt: '2026-09-27T12:00:00.000Z',
        },
      ],
      // A rollback that lost its reason is not a rollback anybody reported.
      [
        {
          state: 'rolled-back',
          requestId: null,
          fromVersion: '1.0.0',
          targetVersion: '1.1.0',
          finishedAt: '2026-09-27T12:00:00.000Z',
        },
        { state: 'unavailable' },
      ],
      [
        {
          state: 'needs-operator',
          requestId: REQUEST_ID,
          fromVersion: '1.0.0',
          targetVersion: '1.1.0',
          reason: 'prepared-timeout',
          restoreAttempts: 3,
          finishedAt: '2026-09-27T12:00:00.000Z',
        },
        {
          state: 'needs-operator',
          requestId: REQUEST_ID,
          fromVersion: '1.0.0',
          targetVersion: '1.1.0',
          reason: 'prepared-timeout',
          restoreAttempts: 3,
          finishedAt: '2026-09-27T12:00:00.000Z',
        },
      ],
      [
        {
          state: 'needs-operator',
          requestId: REQUEST_ID,
          fromVersion: '1.0.0',
          targetVersion: '1.1.0',
          reason: 'prepared-timeout',
          finishedAt: '2026-09-27T12:00:00.000Z',
        },
        { state: 'unavailable' },
      ],
      [{ state: 'queued' }, { state: 'unavailable' }],
      [
        {
          state: 'updating',
          requestId: REQUEST_ID,
          phase: 'dancing',
          fromVersion: '1',
          targetVersion: '2',
          attempts: 1,
        },
        { state: 'unavailable' },
      ],
      [{ state: 'someday' }, { state: 'unavailable' }],
      ['nope', { state: 'unavailable' }],
    ])('reads progress %j as %j', async (body, expected) => {
      respond(body);
      expect(await requestServiceUpdateProgress('http://custom.test')).toEqual(
        expected,
      );
      expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
        'http://custom.test/api/system/core-update/service-update',
      );
    });

    it('a failed progress read throws with its status, for the poll to keep its last state', async () => {
      respond({}, false, 502);
      await expect(
        requestServiceUpdateProgress('http://custom.test'),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('an accepted service update returns its request id, and a malformed one is refused', async () => {
      respond({
        success: true,
        serviceUpdate: { requestId: REQUEST_ID },
        message: 'm',
      });
      expect(await applyCoreUpdate('http://custom.test')).toEqual({
        success: true,
        serviceUpdate: { requestId: REQUEST_ID },
        message: 'm',
      });
      respond({ success: true, serviceUpdate: {} });
      await expect(applyCoreUpdate('http://custom.test')).rejects.toThrow(
        'Service update request could not be followed',
      );
    });
  });

  describe('core-update status diagnostics (update-ux PR2)', () => {
    const identity = {
      instanceId: 'desktop',
      bootId: '22222222-2222-4222-8222-222222222222',
      sha: 'a'.repeat(40),
      shaSource: 'build-stamp',
    };

    it('preserves valid diagnostics verbatim', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          installKind: 'unknown',
          updateAvailable: false,
          message: "This server's update provenance is invalid.",
          serverIdentity: identity,
          provenanceIssue: 'invalid-stamp',
          technicalDetail: 'a build stamp exists at /b/x but is malformed',
          selfUpdateUnavailableReason: null,
        }),
      } as Response);

      const status = await requestCoreUpdateStatus('http://custom.test');
      expect(status.serverIdentity).toEqual(identity);
      expect(status.provenanceIssue).toBe('invalid-stamp');
      expect(status.technicalDetail).toBe(
        'a build stamp exists at /b/x but is malformed',
      );
      expect(status.selfUpdateUnavailableReason).toBeNull();
      // Never inferred: applyMethod stays whatever the server said.
      expect(status.applyMethod).toBeUndefined();
    });

    it('normalizes a legacy response with no diagnostics to explicit unavailability', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          installKind: 'source-checkout',
          branch: 'main',
          behind: 2,
          ahead: 1,
          updateAvailable: true,
        }),
      } as Response);

      await expect(
        requestCoreUpdateStatus('http://custom.test'),
      ).resolves.toMatchObject({
        updateAvailable: true,
        behind: 2,
        serverIdentity: null,
        provenanceIssue: null,
        technicalDetail: null,
        selfUpdateUnavailableReason: null,
        selfUpdateUnavailableCode: null,
      });
    });

    it('keeps a known self-update refusal code and its reason (#2674)', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          installKind: 'source-checkout',
          applyMethod: 'git-pull',
          updateAvailable: true,
          behind: 1,
          ahead: 0,
          selfUpdateUnavailableCode: 'service-managed',
          selfUpdateUnavailableReason: 'this server runs under the service',
        }),
      } as Response);

      const status = await requestCoreUpdateStatus('http://custom.test');
      expect(status.selfUpdateUnavailableCode).toBe('service-managed');
      expect(status.selfUpdateUnavailableReason).toBe(
        'this server runs under the service',
      );
    });

    it('keeps the supervised refusal code', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          updateAvailable: true,
          selfUpdateUnavailableCode: 'supervised',
          selfUpdateUnavailableReason: 'a supervising process runs this server',
        }),
      } as Response);

      const status = await requestCoreUpdateStatus('http://custom.test');
      expect(status.selfUpdateUnavailableCode).toBe('supervised');
    });

    it('reads an unknown self-update refusal code as unknown, keeping its reason', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          installKind: 'source-checkout',
          applyMethod: 'git-pull',
          updateAvailable: true,
          selfUpdateUnavailableCode: 'some-future-code',
          selfUpdateUnavailableReason: 'a future refusal',
        }),
      } as Response);

      const status = await requestCoreUpdateStatus('http://custom.test');
      expect(status.selfUpdateUnavailableCode).toBeNull();
      expect(status.selfUpdateUnavailableReason).toBe('a future refusal');
    });

    it('rejects a non-boolean updateAvailable instead of trusting it', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ updateAvailable: 'yes' }),
      } as Response);

      await expect(
        requestCoreUpdateStatus('http://custom.test'),
      ).rejects.toThrow('Core update status is unavailable');
    });

    it('rejects a malformed supplied count used for state derivation', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ updateAvailable: true, behind: 'three' }),
      } as Response);

      await expect(
        requestCoreUpdateStatus('http://custom.test'),
      ).rejects.toThrow('Core update status is unavailable');
    });

    it('normalizes a malformed serverIdentity to unavailable, never a partial identity', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          updateAvailable: false,
          // sha missing: the load-bearing third of the triple.
          serverIdentity: {
            instanceId: 'desktop',
            bootId: '22222222-2222-4222-8222-222222222222',
          },
        }),
      } as Response);

      const status = await requestCoreUpdateStatus('http://custom.test');
      expect(status.serverIdentity).toBeNull();
    });

    it('an unknown provenance code stays unknown — it never becomes "missing"', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          updateAvailable: false,
          provenanceIssue: 'quarantined-by-future-policy',
        }),
      } as Response);

      const status = await requestCoreUpdateStatus('http://custom.test');
      expect(status.provenanceIssue).toBeNull();
    });

    it('rejects HTTP 503/401 before parsing the body as success', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ ready: false, status: 'identity_unavailable' }),
      } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      } as Response);

      for (const expected of [503, 401]) {
        let caught: unknown;
        try {
          await requestCoreUpdateStatus('http://custom.test');
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StationHttpError);
        expect((caught as StationHttpError).status).toBe(expected);
      }
    });

    it('forwards the caller abort signal to the fetch', async () => {
      const controller = new AbortController();
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ updateAvailable: false }),
      } as Response);

      await requestCoreUpdateStatus('http://custom.test', controller.signal);
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        'http://custom.test/api/system/core-update',
        {
          signal: controller.signal,
          headers: { 'X-Station-Client-Protocol': '1' },
        },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('still throws on a genuine error field, before any status is read', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ updateAvailable: false, error: 'boom' }),
      } as Response);

      await expect(
        requestCoreUpdateStatus('http://custom.test'),
      ).rejects.toThrow('boom');
    });

    it('throws the server error message alone, with no status fields at all', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ error: 'boom' }),
      } as Response);

      await expect(
        requestCoreUpdateStatus('http://custom.test'),
      ).rejects.toThrow('boom');
    });

    it.each([
      ['noUpstream', 'yes'],
      ['remoteUnreachable', 1],
    ])(
      'rejects a non-boolean %s used for state derivation (%p)',
      async (field, supplied) => {
        vi.mocked(fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ updateAvailable: false, [field]: supplied }),
        } as Response);

        await expect(
          requestCoreUpdateStatus('http://custom.test'),
        ).rejects.toThrow('Core update status is unavailable');
      },
    );

    it.each([
      ['null body', null],
      ['string body', 'x'],
    ])(
      'rejects a %s instead of reading it as a status',
      async (_label, body) => {
        vi.mocked(fetch).mockResolvedValue({
          ok: true,
          json: async () => body,
        } as unknown as Response);

        await expect(
          requestCoreUpdateStatus('http://custom.test'),
        ).rejects.toThrow('Core update status is unavailable');
      },
    );
  });

  describe('system identity (update-ux PR2)', () => {
    it('reads a complete identity with its request-bound presentation', async () => {
      const controller = new AbortController();
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          instanceId: 'phone-dogfood',
          bootId: '11111111-1111-4111-8111-111111111111',
          sha: 'abcdef0123456789abcdef0123456789abcdef01',
          shaSource: 'checkout',
          devicePresentation: { deviceClass: 'paired', hostName: 'kontour' },
        }),
      } as Response);

      const identityResponse = await requestSystemIdentity(
        'http://custom.test',
        controller.signal,
      );
      expect(identityResponse).toEqual({
        instanceId: 'phone-dogfood',
        bootId: '11111111-1111-4111-8111-111111111111',
        sha: 'abcdef0123456789abcdef0123456789abcdef01',
        shaSource: 'checkout',
        devicePresentation: { deviceClass: 'paired', hostName: 'kontour' },
      });
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        'http://custom.test/api/system/identity',
        {
          signal: controller.signal,
          headers: { 'X-Station-Client-Protocol': '1' },
        },
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('accepts an older server that omits the optional presentation', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          instanceId: 'phone-dogfood',
          bootId: '11111111-1111-4111-8111-111111111111',
          sha: 'abcdef0123456789abcdef0123456789abcdef01',
        }),
      } as Response);

      const identityResponse =
        await requestSystemIdentity('http://custom.test');
      expect(identityResponse.devicePresentation).toBeUndefined();
      expect(identityResponse.instanceId).toBe('phone-dogfood');
    });

    it('rejects an incomplete identity triple rather than serving a partial identity', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          instanceId: 'phone-dogfood',
          bootId: '11111111-1111-4111-8111-111111111111',
          sha: 'not-a-sha',
        }),
      } as Response);

      await expect(requestSystemIdentity('http://custom.test')).rejects.toThrow(
        'System identity is unavailable',
      );
    });

    it.each([
      [
        'instanceId',
        {
          bootId: '11111111-1111-4111-8111-111111111111',
          sha: 'abcdef0123456789abcdef0123456789abcdef01',
        },
      ],
      [
        'bootId',
        {
          instanceId: 'phone-dogfood',
          sha: 'abcdef0123456789abcdef0123456789abcdef01',
        },
      ],
    ])('rejects a triple missing its %s leg', async (_leg, body) => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => body,
      } as Response);

      await expect(requestSystemIdentity('http://custom.test')).rejects.toThrow(
        'System identity is unavailable',
      );
    });

    it('drops a malformed shaSource label silently, keeping the identity', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          instanceId: 'phone-dogfood',
          bootId: '11111111-1111-4111-8111-111111111111',
          sha: 'abcdef0123456789abcdef0123456789abcdef01',
          shaSource: 42,
        }),
      } as Response);

      const identityResponse =
        await requestSystemIdentity('http://custom.test');
      // The triple survives; only the unproven label is gone — no throw, no
      // fabricated shaSource.
      expect(identityResponse.instanceId).toBe('phone-dogfood');
      expect(identityResponse).not.toHaveProperty('shaSource');
    });

    it.each([
      ['null body', null],
      ['string body', 'x'],
    ])(
      'rejects a %s instead of reading it as an identity',
      async (_label, body) => {
        vi.mocked(fetch).mockResolvedValue({
          ok: true,
          json: async () => body,
        } as unknown as Response);

        await expect(
          requestSystemIdentity('http://custom.test'),
        ).rejects.toThrow('System identity is unavailable');
      },
    );

    it('drops a malformed devicePresentation instead of projecting it', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          instanceId: 'phone-dogfood',
          bootId: '11111111-1111-4111-8111-111111111111',
          sha: 'abcdef0123456789abcdef0123456789abcdef01',
          devicePresentation: { deviceClass: 'teleporter', hostName: '' },
        }),
      } as Response);

      const identityResponse =
        await requestSystemIdentity('http://custom.test');
      expect(identityResponse.devicePresentation).toBeUndefined();
    });

    it('surfaces the 503 identity_unavailable branch as a preserved StationHttpError', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ ready: false, status: 'identity_unavailable' }),
      } as Response);

      let caught: unknown;
      try {
        await requestSystemIdentity('http://custom.test');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StationHttpError);
      expect((caught as StationHttpError).status).toBe(503);
    });
  });

  it('reads optional deployment capability facts without changing the endpoint', async () => {
    const capabilities = {
      runtime: 'voltagent',
      deployment: {
        features: {
          'web-push': { state: 'unsupported' },
          scheduler: { state: 'supported' },
        },
      },
    } as const;
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => capabilities,
    } as Response);

    await expect(fetchServerCapabilities()).resolves.toEqual(capabilities);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://example.test/api/system/capabilities',
      { headers: { 'X-Station-Client-Protocol': '1' } },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats absent or malformed deployment facts as unknown', () => {
    expect(getDeploymentCapabilityState(undefined, 'scheduler')).toBe(
      'unknown',
    );
    expect(
      getDeploymentCapabilityState(
        { deployment: { features: { scheduler: { state: 'future' } } } } as any,
        'scheduler',
      ),
    ).toBe('unknown');
  });

  /*
   * station#3658 review, MEDIUM-2 — this used to assert `[]`, pinning the
   * #2591 tolerance. #2591 asked for the fetch to handle an invalid body
   * "without throwing" because an unhandled SyntaxError surfaced as
   * misleading first-causal noise in a raced test; the store now catches this
   * and renders an error state, so the failure is handled without being
   * relabelled as "no events". A truncated proxy response or an HTML login
   * page served with a 200 is a failed read, not an empty Station.
   */
  it('rejects an unreadable 200 monitoring-events body rather than reading it as empty (#2591, #3658)', async () => {
    const { fetchMonitoringEvents } = await import(
      '../query-domains/systemRuntimeRequests'
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);

    await expect(fetchMonitoringEvents()).rejects.toThrow(
      /unknown rather than empty/,
    );
  });

  it('rejects a 200 that reports success:false, quoting the route (#3658)', async () => {
    const { fetchMonitoringEvents } = await import(
      '../query-domains/systemRuntimeRequests'
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: false,
        error: 'This Station could not read its event log.',
      }),
    } as unknown as Response);

    await expect(fetchMonitoringEvents()).rejects.toThrow(
      'This Station could not read its event log.',
    );
  });

  it('a successful read with zero rows is still an empty result (#3658)', async () => {
    const { fetchMonitoringEvents } = await import(
      '../query-domains/systemRuntimeRequests'
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: [] }),
    } as unknown as Response);

    await expect(fetchMonitoringEvents()).resolves.toEqual([]);
  });

  // station#3658: #2591's tolerance was about an OK response whose body is
  // unreadable. A rejected request is a different fact, and flattening it to
  // `[]` is what let the Monitoring view draw "No events yet" over a 500 —
  // the caller could not tell the two apart because the fetcher had already
  // thrown the difference away.
  it('rejects a non-ok monitoring-events read rather than reading it as empty (#3658)', async () => {
    const { fetchMonitoringEvents } = await import(
      '../query-domains/systemRuntimeRequests'
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        error: 'This Station could not read its event log.',
      }),
    } as unknown as Response);

    // The route's own sentence survives, and the status is preserved for
    // callers that branch on it.
    await expect(fetchMonitoringEvents()).rejects.toMatchObject({
      name: 'StationHttpError',
      status: 500,
      message: 'This Station could not read its event log.',
    });
  });

  it('synthesizes a monitoring-events failure message when the error body is unreadable (#3658)', async () => {
    const { fetchMonitoringEvents } = await import(
      '../query-domains/systemRuntimeRequests'
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    } as unknown as Response);

    await expect(fetchMonitoringEvents()).rejects.toMatchObject({
      name: 'StationHttpError',
      status: 401,
      message: 'Monitoring events request rejected with HTTP 401',
    });
  });

  // station#3444: `resolveFleetReceiptsRefetchInterval` classifies a terminal
  // failure the same way as the system-status fetcher above — both fleet
  // fetchers must preserve the response status rather than discarding it
  // once the body is inspected (or not inspected at all, for a non-ok
  // response whose body may not even be the `{success,data}` shape).
  describe.each([
    {
      label: 'fleet routing receipts',
      fetchReceipts: fetchFleetRoutingReceiptsForStation,
      serverMessage:
        'This Station cannot locate its receipt log, so whether it has fleet-routed anything is unknown rather than empty.',
    },
    {
      label: 'fleet serve receipts',
      fetchReceipts: fetchFleetServeReceiptsForStation,
      serverMessage:
        'This Station cannot locate its receipt log, so what it has served is unknown rather than empty.',
    },
  ])('$label', ({ fetchReceipts, serverMessage }) => {
    async function rejection(): Promise<unknown> {
      try {
        await fetchReceipts();
      } catch (error) {
        return error;
      }
      throw new Error('expected the fleet receipt read to reject');
    }

    it('preserves the response status as a StationHttpError', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ success: false, error: 'Unauthorized' }),
      } as Response);

      const caught = await rejection();
      expect(caught).toBeInstanceOf(StationHttpError);
      expect((caught as StationHttpError).status).toBe(401);
      // Must not collide with `isStationTransportFailure`'s "Failed to fetch"
      // prefix marker for network unreachability.
      expect((caught as StationHttpError).message).not.toMatch(
        /^(?:TypeError:\s*)?Failed to fetch/i,
      );
    });

    // The route (`src-server/routes/operations/monitoring.ts`) authors a 503
    // body explaining why; the fetcher keeps it rather than synthesizing
    // "rejected with HTTP 503", because UI copy derives from this message.
    it('a rejected response keeps the SERVER-authored error text, verbatim', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ success: false, error: serverMessage }),
      } as Response);

      const caught = await rejection();
      expect(caught).toBeInstanceOf(StationHttpError);
      expect((caught as StationHttpError).status).toBe(503);
      expect((caught as StationHttpError).message).toBe(serverMessage);
    });

    it('a rejected response with an unparseable body falls back to a synthesized message', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      } as unknown as Response);

      const caught = await rejection();
      expect(caught).toBeInstanceOf(StationHttpError);
      expect((caught as StationHttpError).status).toBe(502);
      expect((caught as StationHttpError).message).toContain('502');
    });

    it('a successful-status body that reports failure still throws a plain Error', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: false, error: 'no data yet' }),
      } as Response);

      const caught = await rejection();
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(StationHttpError);
      expect((caught as Error).message).toBe('no data yet');
    });
  });
});
