/**
 * station#2530 review 4: `unansweredApprovalRequests` (pendingRequestRows.ts)
 * now deliberately lets the pending-approvals strip render the SAME open
 * request the expanded transcript card can also answer, whenever that
 * request's binding lives on the currently open turn. Two actionable copies
 * of one request raises the question this file answers: is a double answer
 * harmless?
 *
 * `answerOrchestrationRequest` already reads a refused answer's cause from
 * the request's own current state (never guessed from error text) and
 * resolves `already-settled` rather than rejecting when the request was
 * answered elsewhere first. That is the mechanism that makes a second click
 * — from the strip after the transcript card's click already landed, or vice
 * versa — a harmless no-op instead of a thrown error the second surface would
 * have to surface to the user.
 */

import { resolveOrchestrationRequest } from '@kontourai/station-sdk';
import { ChatHttpError } from '@kontourai/station-sdk/client';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const inspectAttentionRequest = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  resolveOrchestrationRequest: vi.fn(),
  inspectAttentionRequest: (...args: unknown[]) =>
    inspectAttentionRequest(...args),
}));

import {
  answerOrchestrationRequest,
  forgetApprovalAnswer,
  readApprovalAnswerState,
  inspectApprovalAnswer,
} from '../answerRequest';

const request = {
  threadId: 'thread-1',
  requestId: 'req-1',
  requestEventId: 'evt-1',
  decision: 'accept' as const,
};

describe('answerOrchestrationRequest', () => {
  beforeEach(() => {
    forgetApprovalAnswer(request.threadId, request.requestId);
    vi.mocked(resolveOrchestrationRequest).mockReset();
    inspectAttentionRequest.mockReset();
  });

  test('a second answer to an already-resolved request is harmless: it resolves already-settled, not an error', async () => {
    vi.mocked(resolveOrchestrationRequest).mockRejectedValue(
      new Error('409 already resolved'),
    );
    inspectAttentionRequest.mockResolvedValue({ state: 'resolved' });

    const outcome = await answerOrchestrationRequest('http://api', request);

    expect(outcome).toBe('already-settled');
    expect(inspectAttentionRequest).toHaveBeenCalledWith(
      'http://api',
      {
        threadId: 'thread-1',
        requestId: 'req-1',
        requestEventId: 'evt-1',
      },
      { timeoutMs: 5_000 },
    );
  });

  test('a genuine failure while the request is STILL open stays loud (not swallowed as already-settled)', async () => {
    vi.mocked(resolveOrchestrationRequest).mockRejectedValue(
      new Error('network error'),
    );
    inspectAttentionRequest.mockResolvedValue({ state: 'open' });

    await expect(
      answerOrchestrationRequest('http://api', request),
    ).rejects.toThrow('network error');
  });

  test.each([undefined, 'server'] as const)(
    'does not coalesce a different session grant scope into %s',
    async (sessionGrantScope) => {
      let finish!: () => void;
      vi.mocked(resolveOrchestrationRequest).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const intent = {
        ...request,
        decision: 'acceptForSession' as const,
        ...(sessionGrantScope ? { sessionGrantScope } : {}),
      };
      const first = answerOrchestrationRequest('http://api', intent);
      expect(answerOrchestrationRequest('http://api', intent)).toBe(first);
      const other = {
        ...request,
        decision: 'acceptForSession' as const,
        ...(sessionGrantScope ? {} : { sessionGrantScope: 'server' as const }),
      };
      await expect(
        answerOrchestrationRequest('http://api', other),
      ).rejects.toThrow('still being sent');
      expect(resolveOrchestrationRequest).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(resolveOrchestrationRequest).mock.calls[0][0]
          .sessionGrantScope,
      ).toBe(sessionGrantScope);
      finish();
      await expect(first).resolves.toBe('answered');

      vi.mocked(resolveOrchestrationRequest).mockRejectedValueOnce(
        new TypeError('Reply lost'),
      );
      inspectAttentionRequest.mockRejectedValueOnce(
        new Error('Inspection unavailable'),
      );
      await expect(
        answerOrchestrationRequest('http://api', intent),
      ).rejects.toMatchObject({ code: 'approval_delivery_unconfirmed' });
      const reference = { apiBase: 'http://api', ...request };
      expect(readApprovalAnswerState(reference)).toMatchObject({
        phase: 'unconfirmed',
        decision: 'acceptForSession',
      });
      expect(readApprovalAnswerState(reference)?.sessionGrantScope).toBe(
        sessionGrantScope,
      );
      inspectAttentionRequest.mockResolvedValueOnce({ state: 'resolved' });
      await expect(inspectApprovalAnswer('http://api', request)).resolves.toBe(
        'already-settled',
      );
      expect(readApprovalAnswerState(reference)).toEqual({
        phase: 'already-settled',
        decision: 'acceptForSession',
        ...(sessionGrantScope ? { sessionGrantScope } : {}),
      });
      await expect(
        answerOrchestrationRequest('http://api', other),
      ).resolves.toBe('already-settled');
      expect(resolveOrchestrationRequest).toHaveBeenCalledTimes(2);
    },
  );

  test('a first, successful answer resolves answered', async () => {
    vi.mocked(resolveOrchestrationRequest).mockResolvedValue(undefined as any);

    const outcome = await answerOrchestrationRequest('http://api', request);

    expect(outcome).toBe('answered');
    expect(inspectAttentionRequest).not.toHaveBeenCalled();
  });
  test.each([
    new TypeError('Response lost'),
    Object.assign(new Error('Unavailable'), { status: 503 }),
    new SyntaxError('Invalid response'),
    new ChatHttpError(408, 'Proxy timeout', undefined, false),
    new ChatHttpError(403, 'Proxy refusal', undefined, false),
  ])(
    'coalesces decisions and holds %s until inspection confirms the request',
    async (failure) => {
      let rejectSend!: (error: Error) => void;
      vi.mocked(resolveOrchestrationRequest).mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSend = reject;
          }),
      );
      inspectAttentionRequest.mockRejectedValue(new Error('Read unavailable'));
      const first = answerOrchestrationRequest('http://api', request);
      const second = answerOrchestrationRequest('http://api', request);
      const firstFailure = expect(first).rejects.toMatchObject({
        code: 'approval_delivery_unconfirmed',
      });
      const secondFailure = expect(second).rejects.toMatchObject({
        code: 'approval_delivery_unconfirmed',
      });
      rejectSend(failure);
      await Promise.all([firstFailure, secondFailure]);
      await expect(
        answerOrchestrationRequest('http://api', {
          ...request,
          decision: 'decline',
        }),
      ).rejects.toMatchObject({ code: 'approval_delivery_unconfirmed' });
      expect(resolveOrchestrationRequest).toHaveBeenCalledTimes(1);
      inspectAttentionRequest.mockResolvedValue({
        state: 'open',
        canRespond: true,
      });
      expect(await inspectApprovalAnswer('http://api', request)).toBe(
        'pending',
      );
      vi.mocked(resolveOrchestrationRequest).mockResolvedValue(undefined);
      expect(await answerOrchestrationRequest('http://api', request)).toBe(
        'answered',
      );
      expect(resolveOrchestrationRequest).toHaveBeenCalledTimes(2);
    },
  );
  test('a verified Station refusal remains a refusal when inspection is unavailable', async () => {
    const refused = new ChatHttpError(
      403,
      'Station refused this decision',
      'permission_denied',
      true,
    );
    vi.mocked(resolveOrchestrationRequest).mockRejectedValue(refused);
    inspectAttentionRequest.mockRejectedValue(
      new Error('Inspection unavailable'),
    );
    await expect(
      answerOrchestrationRequest('http://api', request),
    ).rejects.toBe(refused);
    await expect(
      answerOrchestrationRequest('http://api', request),
    ).rejects.toBe(refused);
    expect(resolveOrchestrationRequest).toHaveBeenCalledTimes(2);
  });
});
