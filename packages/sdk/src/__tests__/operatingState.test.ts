import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  fetchOperatingState,
  postBoardIntent,
} from '../query-domains/operatingState';

function mockJsonResponse(payload: unknown, ok = true) {
  vi.mocked(fetch).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  } as Response);
}

describe('operatingState SDK domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('fetches the operating state for a project', async () => {
    mockJsonResponse({ success: true, data: { processes: [] } });

    await expect(fetchOperatingState('demo')).resolves.toEqual({
      processes: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/projects/demo/operating-state',
    );
  });

  it('surfaces a server-reported error', async () => {
    mockJsonResponse({ success: false, error: 'boom' }, false);
    await expect(fetchOperatingState('demo')).rejects.toThrow('boom');
  });

  it('posts a board intent with the exact consent value supplied', async () => {
    mockJsonResponse({
      success: true,
      data: { bound: true, executed: true },
    });

    await expect(
      postBoardIntent({
        projectSlug: 'demo',
        intent: { id: 'i1', kind: 'task dispatch' },
        consent: true,
      }),
    ).resolves.toEqual({ bound: true, executed: true });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://example.test/api/projects/demo/operating-state/intent',
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      JSON.stringify({
        intent: { id: 'i1', kind: 'task dispatch' },
        consent: true,
      }),
    );
    expect(new Headers(init.headers).get('Content-Type')).toBe(
      'application/json',
    );
  });

  it('never coerces an omitted consent to true on the wire', async () => {
    mockJsonResponse({
      success: true,
      data: { bound: true, executed: false, reason: 'consent-required' },
    });

    await postBoardIntent({
      projectSlug: 'demo',
      intent: { id: 'i1', kind: 'task dispatch' },
    });

    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.consent).toBeUndefined();
  });
});
