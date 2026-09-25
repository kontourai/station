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
import { beforeEach, describe, expect, test, vi } from 'vitest';

const inspectAttentionRequest = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  resolveOrchestrationRequest: vi.fn(),
  inspectAttentionRequest: (...args: unknown[]) =>
    inspectAttentionRequest(...args),
}));

import { answerOrchestrationRequest } from '../answerRequest';

const request = {
  threadId: 'thread-1',
  requestId: 'req-1',
  requestEventId: 'evt-1',
  decision: 'accept' as const,
};

describe('answerOrchestrationRequest', () => {
  beforeEach(() => {
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
    expect(inspectAttentionRequest).toHaveBeenCalledWith('http://api', {
      threadId: 'thread-1',
      requestId: 'req-1',
      requestEventId: 'evt-1',
    });
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

  test('a first, successful answer resolves answered', async () => {
    vi.mocked(resolveOrchestrationRequest).mockResolvedValue(undefined as any);

    const outcome = await answerOrchestrationRequest('http://api', request);

    expect(outcome).toBe('answered');
    expect(inspectAttentionRequest).not.toHaveBeenCalled();
  });
});
