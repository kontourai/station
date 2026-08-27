import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  acceptFlowException,
  evaluateFlowGate,
} from '../query-domains/flowRuns';

describe('gate re-evaluation / exception acceptance (attention inbox gate items)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts a re-evaluate request to the run evaluate endpoint for the gate', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: {} }),
    } as Response);

    await evaluateFlowGate({
      projectSlug: 'dev',
      runId: 'run-2',
      gate: 'test-gate',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/projects/dev/flow/runs/run-2/evaluate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ gate: 'test-gate' }),
      }),
    );
  });

  it('surfaces a safe error when the evaluate request fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'Gate not open' }),
    } as Response);

    await expect(
      evaluateFlowGate({
        projectSlug: 'dev',
        runId: 'run-2',
        gate: 'test-gate',
      }),
    ).rejects.toThrow('Gate not open');
  });

  it('posts gate/reason/authority to the EXISTING exception endpoint — receipt parity with the run console', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ success: true, data: { id: 'ex-1' } }),
    } as Response);

    await acceptFlowException({
      projectSlug: 'dev',
      runId: 'run-3',
      gate: 'verify-gate',
      reason: 'Ship blocked on a flaky check',
      authority: 'release-manager@station',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/projects/dev/flow/runs/run-3/exception',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          gate: 'verify-gate',
          reason: 'Ship blocked on a flaky check',
          authority: 'release-manager@station',
        }),
      }),
    );
  });

  it('surfaces a safe error when the exception request fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: 'authority is required' }),
    } as Response);

    await expect(
      acceptFlowException({
        projectSlug: 'dev',
        runId: 'run-3',
        gate: 'verify-gate',
        reason: 'reason',
        authority: '',
      }),
    ).rejects.toThrow('authority is required');
  });
});
