import { describe, expect, test } from 'vitest';
import { parseActionOperation } from '../action-operation.js';

const operation = {
  schemaVersion: 'station.action-operation/v1',
  id: 'operation-a',
  sequence: 1,
  changeSequence: 1,
  revision: 1,
  scope: { accountId: 'account-a' },
  status: 'running',
  title: 'Fork conversation',
  progress: { kind: 'phase', code: 'preparing' },
  cancellation: 'unsupported',
  domain: {
    kind: 'conversation-fork',
    sourceConversationId: 'source-a',
    targetConversationId: 'target-a',
  },
  reentry: {
    kind: 'conversation',
    agentId: 'codex',
    conversationId: 'target-a',
  },
  acceptedAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:01:00.000Z',
};

describe('action operation contract', () => {
  test('parses one exact privacy-safe envelope', () => {
    expect(parseActionOperation(operation)).toEqual(operation);
  });

  test.each([
    [{ ...operation, unexpected: true }, 'unknown root field'],
    [
      { ...operation, scope: { ...operation.scope, unexpected: true } },
      'unknown scope field',
    ],
    [
      {
        ...operation,
        progress: {
          kind: 'determinate',
          completed: 2,
          total: 1,
          unit: 'steps',
        },
      },
      'invalid progress',
    ],
    [{ ...operation, title: 'token=private' }, 'secret-shaped title'],
    [
      {
        ...operation,
        reentry: { kind: 'session', sessionId: 'session-a', href: '/leak?q=x' },
      },
      'URL-shaped reentry',
    ],
    [
      {
        ...operation,
        domain: { kind: 'fleet-dispatch', sessionId: 'session-a' },
      },
      'fleet without an exact correlation join',
    ],
  ])('rejects %s (%s)', (candidate, _label) => {
    expect(parseActionOperation(candidate)).toBeUndefined();
  });

  test('rejects machine-local path-shaped title, error, and progress input', () => {
    for (const unsafe of [
      '/tmp/station-private',
      '/var/folders/private',
      '/srv/agent/worktree',
      'C:\\Users\\operator\\secret',
      '\\\\server\\share\\secret',
      '\\Windows\\System32\\secret',
    ]) {
      expect(
        parseActionOperation({ ...operation, title: `Failed at ${unsafe}` }),
      ).toBeUndefined();
    }
    for (const unsafe of ['/tmp/error', '\\\\server\\share\\error']) {
      expect(
        parseActionOperation({
          ...operation,
          status: 'failed',
          completedAt: operation.updatedAt,
          errorSummary: `Owner reported ${unsafe}`,
        }),
      ).toBeUndefined();
    }
    expect(
      parseActionOperation({
        ...operation,
        progress: { kind: 'phase', code: '/tmp/progress' },
      }),
    ).toBeUndefined();
  });

  test('allows an exact active fleet reference and requires its sealed receipt at terminal settlement', () => {
    const active = {
      ...operation,
      domain: {
        kind: 'fleet-dispatch',
        sessionId: 'session-a',
        correlationId: 'correlation-a',
      },
      reentry: { kind: 'session', sessionId: 'session-a' },
    };
    expect(parseActionOperation(active)).toEqual(active);
    expect(
      parseActionOperation({
        ...active,
        status: 'succeeded',
        completedAt: active.updatedAt,
      }),
    ).toBeUndefined();
    const terminal = {
      ...active,
      status: 'succeeded',
      completedAt: active.updatedAt,
      domain: {
        ...active.domain,
        routingReceiptId: 'receipt-a',
      },
    };
    expect(parseActionOperation(terminal)).toEqual(terminal);
    expect(
      parseActionOperation({
        ...active,
        domain: { ...active.domain, routingReceiptId: 'receipt-a' },
      }),
    ).toBeUndefined();
  });
});
