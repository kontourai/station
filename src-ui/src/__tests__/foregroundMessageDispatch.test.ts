import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The wire shape of a foreground turn's `target`.
 *
 * This moved down from `tests/cross-runtime-chat-switching.spec.ts`, which was
 * asserting a seven-field request body in a browser. Two of those fields are
 * conditional in `dispatchForeground` and the browser test had drifted from
 * both — it demanded `environment: { kind: 'current' }` on a project-scoped
 * turn (mutually exclusive with `workspace`) and a `model.override` for a turn
 * its own fixture reported as `engine-selected`. A request body is a contract,
 * not a journey; the browser keeps the journey (right agent, right project,
 * one turn) and this file owns the shape.
 *
 * `sendExecutionMessage` is the seam under test: every branch below is a
 * spread in `src-ui/src/lib/foregroundMessageDispatch.ts:36-59`.
 */
const sendExecutionMessage = vi.fn(
  async (_input: { target: Record<string, unknown> }) => ({}) as unknown,
);
const attachmentQueueImported = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useOrchestration', () => ({
  sendExecutionMessage: (input: { target: Record<string, unknown> }) =>
    sendExecutionMessage(input),
}));
vi.mock('../lib/attachment-staging-queue', () => {
  attachmentQueueImported();
  return {
    inlineComposerAttachments: (attachments: unknown[]) => attachments,
  };
});

const { dispatchForeground } = await import('../lib/foregroundMessageDispatch');

type DispatchInput = Parameters<typeof dispatchForeground>[0];

function baseInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    apiBase: 'http://localhost:3242',
    sessionId: 'session-1',
    agentSlug: 'claude',
    message: 'Run the deterministic smoke confirmation.',
    clientTurnId: 'turn-1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function dispatchedTarget(): Record<string, unknown> {
  expect(sendExecutionMessage).toHaveBeenCalledTimes(1);
  const [call] = sendExecutionMessage.mock.calls;
  return call[0].target;
}

describe('dispatchForeground target', () => {
  beforeEach(() => {
    sendExecutionMessage.mockClear();
    attachmentQueueImported.mockClear();
  });

  test('a project-scoped turn carries workspace and NO environment', async () => {
    await dispatchForeground(baseInput({ projectSlug: 'alpha' }));

    const target = dispatchedTarget();
    expect(target).toMatchObject({
      agent: 'claude',
      workspace: { kind: 'project', projectSlug: 'alpha' },
    });
    // The exclusivity is the point: a turn bound to a project must not also
    // claim the current environment.
    expect(target).not.toHaveProperty('environment');
  });

  test('an unbound turn carries environment and NO workspace', async () => {
    await dispatchForeground(baseInput());

    const target = dispatchedTarget();
    expect(target).toMatchObject({
      environment: { kind: 'current' },
      agent: 'claude',
    });
    expect(target).not.toHaveProperty('workspace');
  });

  test('a text-only Send never imports attachment staging', async () => {
    await dispatchForeground(baseInput());
    expect(attachmentQueueImported).not.toHaveBeenCalled();
  });

  test('a reconciled reference is sendable after reload without File bytes', async () => {
    await dispatchForeground(
      baseInput({
        attachmentStages: [
          {
            clientAttachmentId: 'file-1',
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 2,
            state: 'complete',
            progress: 1,
            delivery: 'staged',
            reference: {
              stageId: 'stage-1',
              clientAttachmentId: 'file-1',
              source: 'current-composer',
              kind: 'file',
              name: 'notes.txt',
              mimeType: 'text/plain',
              size: 2,
              digest: `sha256-${'a'.repeat(64)}`,
              expiresAt: '2030-01-01T00:00:00.000Z',
            },
          },
        ],
      }),
    );
    expect(sendExecutionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentRefs: [expect.objectContaining({ stageId: 'stage-1' })],
      }),
    );
  });

  test('does not resend an accepted-stage tombstone', async () => {
    await expect(
      dispatchForeground(
        baseInput({
          attachments: [
            {
              id: 'file-1',
              name: 'notes.txt',
              type: 'text/plain',
              size: 2,
              data: 'data:text/plain;base64,aGk=',
            },
          ],
          attachmentStages: [
            {
              clientAttachmentId: 'file-1',
              name: 'notes.txt',
              mimeType: 'text/plain',
              size: 2,
              state: 'failed',
              progress: 0,
              stageId: 'stage-accepted',
              needsFile: true,
            },
          ],
        }),
      ),
    ).rejects.toThrow('must complete supervised staging');
    expect(sendExecutionMessage).not.toHaveBeenCalled();
  });

  test('keeps a validated legacy stage on the inline compatibility path', async () => {
    await dispatchForeground(
      baseInput({
        attachments: [
          {
            id: 'legacy-file',
            name: 'legacy.txt',
            type: 'text/plain',
            size: 2,
            data: 'data:text/plain;base64,aGk=',
          },
        ],
        attachmentStages: [
          {
            clientAttachmentId: 'legacy-file',
            name: 'legacy.txt',
            mimeType: 'text/plain',
            size: 2,
            state: 'complete',
            progress: 1,
            delivery: 'legacy-inline',
          },
        ],
      }),
    );
    expect(sendExecutionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ name: 'legacy.txt' })],
      }),
    );
  });

  test('an engine-selected turn omits model entirely', async () => {
    await dispatchForeground(
      baseInput({
        projectSlug: 'alpha',
        requestedModel: undefined,
        model: undefined,
      }),
    );

    // `resolveTurnModel` reports `engine-selected` when nothing was requested
    // and nothing was reported; sending an empty `model` object then would
    // claim an override the engine never received.
    expect(dispatchedTarget()).not.toHaveProperty('model');
  });

  test('an explicit override is sent with its options', async () => {
    await dispatchForeground(
      baseInput({
        projectSlug: 'alpha',
        requestedModel: 'claude-sonnet-4-20250514',
        requestedProviderOptions: { effort: 'high' },
      }),
    );

    expect(dispatchedTarget()).toMatchObject({
      model: {
        override: 'claude-sonnet-4-20250514',
        options: { effort: 'high' },
      },
    });
  });

  test('the target never leaks transport or credential identity', async () => {
    await dispatchForeground(
      baseInput({
        projectSlug: 'alpha',
        requestedModel: 'gpt-5-codex',
        requestedProviderOptions: { effort: 'low' },
      }),
    );

    expect(JSON.stringify(dispatchedTarget())).not.toMatch(
      /provider|connection|engine|apiBase|transport|credential/i,
    );
  });
});
