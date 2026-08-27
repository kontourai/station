import { beforeEach, describe, expect, test, vi } from 'vitest';

const authenticatedFetch = vi.hoisted(() => vi.fn());

vi.mock('../client/http', () => ({ authenticatedFetch }));
vi.mock('../query-core', () => ({
  resolveApiBase: async (apiBase?: string) => apiBase ?? 'http://station.test',
  useApiMutation: vi.fn(),
  useApiQuery: vi.fn(),
}));

import {
  getStarterInspectionCandidate,
  launchContinueSessionStarter,
  launchScheduledCheckStarter,
  launchStarterInspection,
  listStarterWork,
} from '../starter-work';

describe('starter work SDK', () => {
  beforeEach(() => authenticatedFetch.mockReset());

  test('preserves field-level refusal guidance', async () => {
    authenticatedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Validation failed',
          details: {
            fieldErrors: { starterId: ['Choose a known Starter Work item.'] },
          },
        }),
        { status: 400 },
      ),
    );

    await expect(listStarterWork('http://station.test')).rejects.toThrow(
      'Choose a known Starter Work item.',
    );
  });

  test('sends the exact bounded Session continuation identity', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            state: 'continued',
            source: { kind: 'session', id: 'external-session' },
            session: {
              threadId: 'continued-session',
              provider: 'claude',
              controlMode: 'station-owned',
              status: 'ready',
              createdAt: '2026-08-24T00:00:00.000Z',
              updatedAt: '2026-08-24T00:00:00.000Z',
            },
            correlation: { state: 'not_verified', reason: 'test' },
            evidence: { state: 'NOT_VERIFIED', reason: 'test' },
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(
      launchContinueSessionStarter({
        starterId: 'continue-session',
        operationId: 'continue-op-1',
        sourceSessionId: 'external-session',
        apiBase: 'http://station.test',
      }),
    ).resolves.toMatchObject({
      state: 'continued',
      session: { threadId: 'continued-session' },
    });
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'http://station.test/api/starter-work/launch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          starterId: 'continue-session',
          operationId: 'continue-op-1',
          sourceSessionId: 'external-session',
        }),
      },
    );
  });

  test('reads and launches one exact owner-backed inspection identity', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              state: 'current',
              starterId: 'inspect-receipt',
              reference: {
                kind: 'receipt',
                owner: 'independent-review',
                id: 'receipt-1',
                projectSlug: 'alpha',
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              state: 'opened',
              starterId: 'inspect-receipt',
              targetRef: {
                kind: 'receipt',
                owner: 'independent-review',
                id: 'receipt-1',
                projectSlug: 'alpha',
              },
              href: '/review-queue?receipt=receipt-1&project=alpha',
              correlation: { state: 'not_verified', reason: 'fixture' },
              completion: { state: 'receipt-present' },
              evidence: { state: 'NOT_VERIFIED', reason: 'input only' },
            },
          }),
          { status: 201 },
        ),
      );
    await expect(
      getStarterInspectionCandidate('inspect-receipt', 'http://station.test'),
    ).resolves.toMatchObject({ reference: { projectSlug: 'alpha' } });
    const input = {
      starterId: 'inspect-receipt' as const,
      operationId: 'inspect:receipt-1',
      targetRef: {
        kind: 'receipt' as const,
        owner: 'independent-review' as const,
        id: 'receipt-1',
        projectSlug: 'alpha',
      },
      apiBase: 'http://station.test',
    };
    await expect(launchStarterInspection(input)).resolves.toMatchObject({
      state: 'opened',
      href: '/review-queue?receipt=receipt-1&project=alpha',
    });
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      1,
      'http://station.test/api/starter-work/inspect-receipt/candidate',
    );
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      'http://station.test/api/starter-work/launch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          starterId: input.starterId,
          operationId: input.operationId,
          targetRef: input.targetRef,
        }),
      },
    );
  });

  test('launches a scheduled check with only its stable operation identity', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            state: 'started',
            starterId: 'run-scheduled-check',
            receipt: {
              kind: 'receipt',
              owner: 'scheduler-run',
              id: 'schedule:built-in:station-starter-check:run-1',
            },
            replayed: false,
            href: '/schedule?run=run-1',
            completion: { state: 'completed' },
            correlation: { state: 'not_verified', reason: 'fixture' },
            evidence: { state: 'NOT_VERIFIED', reason: 'fixture' },
          },
        }),
        { status: 201 },
      ),
    );
    await expect(
      launchScheduledCheckStarter({
        starterId: 'run-scheduled-check',
        operationId: 'scheduled-check-v1',
        apiBase: 'http://station.test',
      }),
    ).resolves.toMatchObject({
      state: 'started',
      receipt: { owner: 'scheduler-run' },
    });
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'http://station.test/api/starter-work/launch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          starterId: 'run-scheduled-check',
          operationId: 'scheduled-check-v1',
        }),
      },
    );
  });

  test('types an unreadable scheduled-check success for same-operation retry', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response('{truncated', { status: 201 }),
    );
    await expect(
      launchScheduledCheckStarter({
        starterId: 'run-scheduled-check',
        operationId: 'scheduled-check-response-loss',
        apiBase: 'http://station.test',
      }),
    ).rejects.toMatchObject({
      name: 'ScheduledCheckStarterResponseError',
      operationId: 'scheduled-check-response-loss',
      retryable: true,
    });
  });

  test('types a lost scheduled-check transport response as possible admission', async () => {
    authenticatedFetch.mockRejectedValueOnce(new Error('request timed out'));
    await expect(
      launchScheduledCheckStarter({
        starterId: 'run-scheduled-check',
        operationId: 'scheduled-check-timeout',
        apiBase: 'http://station.test',
      }),
    ).rejects.toMatchObject({
      name: 'ScheduledCheckStarterResponseError',
      operationId: 'scheduled-check-timeout',
      retryable: true,
      cause: expect.objectContaining({ message: 'request timed out' }),
    });
  });

  test.each(['StationReadOnlyError', 'SyntaxError'])(
    'preserves a %s that proves the scheduled check was not sent',
    async (name) => {
      const refusal = Object.assign(new Error('request was not sent'), {
        name,
      });
      authenticatedFetch.mockRejectedValueOnce(refusal);
      await expect(
        launchScheduledCheckStarter({
          starterId: 'run-scheduled-check',
          operationId: `scheduled-check-${name}`,
          apiBase: 'http://station.test',
        }),
      ).rejects.toBe(refusal);
    },
  );

  it('classifies an unreadable 201 confirmation as safe-retry uncertainty', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response('{truncated', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      launchContinueSessionStarter({
        starterId: 'continue-session',
        operationId: 'continue-op-lost-body',
        sourceSessionId: 'external-session',
        apiBase: 'http://station.test',
      }),
    ).rejects.toMatchObject({
      name: 'AdoptSessionError',
      failureClass: 'uncertain-no-response',
      retryable: true,
    });
  });
});
