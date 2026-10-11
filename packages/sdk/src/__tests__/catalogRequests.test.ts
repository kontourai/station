import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { StationHttpError } from '../client/http';
import {
  fetchKitLayout,
  fetchKitRegistry,
  fetchRegistryItems,
  requestIntegration,
  requestRegistryIntegrationAction,
  requestRegistryLayoutAction,
} from '../query-domains/catalogRequests';

function mockJsonResponse(payload: unknown, status = 200) {
  vi.mocked(fetch).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response);
}

describe('catalogRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('keeps registry lookups scoped to the installed suffix and defaults empty arrays', async () => {
    mockJsonResponse({ success: true });

    await expect(fetchRegistryItems('integrations', true)).resolves.toEqual([]);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://example.test/api/registry/integrations/installed',
      { headers: { 'X-Station-Client-Protocol': '2' } },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the read-only Kit registry and encoded layout endpoints', async () => {
    mockJsonResponse({
      success: true,
      data: [
        {
          contributionRef: 'knowledge/kit',
          lifecycle: 'installed',
          incarnation: 2,
          experience: {
            status: 'enabled',
            diagnostics: [],
            standardViews: [],
          },
        },
      ],
    });

    await expect(fetchKitRegistry()).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://example.test/api/registry/kits',
      { headers: { 'X-Station-Client-Protocol': '2' } },
    );
    expect(fetch).toHaveBeenCalledTimes(1);

    mockJsonResponse({
      success: true,
      data: { standardViews: [] },
    });
    await expect(fetchKitLayout('knowledge/kit')).resolves.toEqual({
      standardViews: [],
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://example.test/api/registry/kits/knowledge%2Fkit/layout',
      { headers: { 'X-Station-Client-Protocol': '2' } },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps integration requests on the integrations endpoint', async () => {
    mockJsonResponse({
      success: true,
      data: { id: 'integration-1' },
    });

    await expect(
      requestIntegration('/integration-1', { method: 'DELETE' }),
    ).resolves.toEqual({ id: 'integration-1' });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://example.test/integrations/integration-1',
      { method: 'DELETE', headers: { 'X-Station-Client-Protocol': '2' } },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes a successful persisted-but-not-live integration outcome through', async () => {
    const outcome = {
      id: 'integration-1',
      enabled: true,
      live: false,
      restartRequired: true,
    };
    mockJsonResponse({ success: true, data: outcome });

    await expect(
      requestIntegration('/integration-1/enabled', { method: 'POST' }),
    ).resolves.toEqual(outcome);
  });

  // #2708: the Integrations view curates a refusal from the error's
  // `details`; a plain Error carrying only "Validation failed" gave it nothing.
  it('an integration refusal keeps its status, code and validation details', async () => {
    const details = {
      formErrors: [],
      fieldErrors: { command: ['Command is required for stdio integrations'] },
    };
    mockJsonResponse(
      { success: false, error: 'Validation failed', details },
      400,
    );

    const failure = await requestIntegration('', {
      method: 'POST',
      body: '{}',
    }).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(StationHttpError);
    expect(failure).toMatchObject({
      status: 400,
      details,
      message:
        'Validation failed: command Command is required for stdio integrations',
    });

    mockJsonResponse(
      {
        success: false,
        code: 'station_control_caller_required',
        error: 'This action needs a verified calling session.',
      },
      403,
    );
    await expect(requestIntegration('/integration-1')).rejects.toMatchObject({
      status: 403,
      code: 'station_control_caller_required',
    });
  });

  it('uses the integration message fallback when an install fails', async () => {
    mockJsonResponse({
      success: false,
      message: 'Plugin install dependencies unavailable',
    });

    await expect(
      requestRegistryIntegrationAction({
        id: 'demo',
        action: 'install',
      }),
    ).rejects.toThrow('Plugin install dependencies unavailable');

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    const requestInit = init!;
    expect(url).toBe('http://example.test/api/registry/integrations/install');
    expect(requestInit).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ id: 'demo' }),
    });
    expect(new Headers(requestInit.headers).get('content-type')).toBe(
      'application/json',
    );
  });

  it('prefers registry error text over message text on install failures', async () => {
    mockJsonResponse({
      success: false,
      error: 'Registry install denied',
      message: 'Plugin install dependencies unavailable',
    });

    await expect(
      requestRegistryIntegrationAction({
        id: 'demo',
        action: 'install',
      }),
    ).rejects.toThrow('Registry install denied');
  });

  it('uses explicit layout lifecycle endpoints rather than generic plugin actions', async () => {
    mockJsonResponse({
      success: true,
      data: { id: 'builtin:tasks', lifecycle: { state: 'installed' } },
    });

    await expect(
      requestRegistryLayoutAction({ id: 'builtin:tasks', action: 'enable' }),
    ).resolves.toMatchObject({ id: 'builtin:tasks' });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://example.test/api/registry/layouts/builtin%3Atasks/enable',
      { method: 'POST', headers: { 'X-Station-Client-Protocol': '2' } },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
