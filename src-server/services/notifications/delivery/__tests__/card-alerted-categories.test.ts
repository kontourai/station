import { describe, expect, test } from 'vitest';
import { isCardAlerted } from '../card-alerted-categories.js';

const orchestrationTurn = {
  sessionId: 's1',
  sessionKind: 'runtime',
  threadId: 's1',
  turnId: 't1',
};
const orchestrationApproval = {
  requestKind: 'orchestration',
  sessionId: 's1',
  sessionKind: 'runtime',
  threadId: 's1',
};
const registryApproval = {
  approvalId: 'a1',
  conversationId: 'c1',
  sessionId: 'c1',
  sessionKind: 'managed',
  requestKind: 'registry',
};

describe('isCardAlerted', () => {
  test.each([
    ['approval-request', orchestrationApproval],
    ['turn-completed', orchestrationTurn],
    ['turn-stopped', orchestrationTurn],
    ['turn-failed', orchestrationTurn],
  ])('an orchestration %s is the card’s to announce', (category, metadata) => {
    expect(isCardAlerted({ category, metadata })).toBe(true);
  });

  test.each([
    [
      'a registry approval (managed session)',
      'approval-request',
      registryApproval,
    ],
    [
      'a registry request stamped runtime',
      'approval-request',
      { ...orchestrationApproval, requestKind: 'registry' },
    ],
    ['an approval with no metadata', 'approval-request', undefined],
    ['a turn with no session', 'turn-completed', { sessionKind: 'runtime' }],
    [
      'a turn of another session kind',
      'turn-failed',
      { ...orchestrationTurn, sessionKind: 'managed' },
    ],
    ['another category', 'pairing-request', orchestrationTurn],
    ['an agent notification', 'agent-attention', orchestrationTurn],
  ])('%s is not, so it still alerts', (_label, category, metadata) => {
    expect(isCardAlerted({ category, ...(metadata ? { metadata } : {}) })).toBe(
      false,
    );
  });
});
