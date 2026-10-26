import { expect, test } from 'vitest';
import {
  parseTaskApprovalDecision,
  TASK_APPROVAL_LIMITS,
} from '../task-approval.js';

const decision = {
  requestId: 'request-1',
  sessionId: 'session-1',
  decision: 'allow',
  decider: { principalId: 'person-1' },
  channel: 'station',
  decidedAt: '2026-10-26T00:00:00.000Z',
};

test.each(['station', 'slack', 'discord'])(
  'parses %s approval decisions without changing them',
  (channel) => {
    for (const answer of ['allow', 'deny']) {
      const input = { ...decision, decision: answer, channel };
      expect(parseTaskApprovalDecision(input)).toEqual(input);
    }
  },
);
test('accepts maximum IDs and refuses max+1 for each identity without truncation', () => {
  const max = 'x'.repeat(TASK_APPROVAL_LIMITS.idChars);
  const full = {
    ...decision,
    requestId: max,
    sessionId: max,
    decider: { principalId: max },
  };
  expect(parseTaskApprovalDecision(full)).toEqual(full);
  for (const input of [
    { ...full, requestId: `${max}x` },
    { ...full, sessionId: `${max}x` },
    { ...full, decider: { principalId: `${max}x` } },
  ])
    expect(parseTaskApprovalDecision(input)).toBeNull();
});
test.each([
  null,
  {},
  { ...decision, extra: true },
  { ...decision, decider: { ...decision.decider, extra: true } },
  { ...decision, requestId: '' },
  { ...decision, sessionId: ' ' },
  { ...decision, decider: {} },
  { ...decision, decision: 'allow-for-task' },
  { ...decision, decision: true },
  { ...decision, channel: 'email' },
  { ...decision, decidedAt: '2026-10-26' },
  { ...decision, decidedAt: '2026-02-30T00:00:00.000Z' },
  { ...decision, decidedAt: `${decision.decidedAt}x` },
  { ...decision, requestId: '\u0000' },
  { ...decision, requestId: '\ud800' },
])('refuses malformed or surplus approval data (%j)', (value) => {
  expect(parseTaskApprovalDecision(value)).toBeNull();
});
test('refuses accessors, inherited fields and symbol keys without invoking accessors', () => {
  const getter = { ...decision };
  Object.defineProperty(getter, 'requestId', {
    get() {
      throw new Error('must not run');
    },
    enumerable: true,
  });
  expect(parseTaskApprovalDecision(getter)).toBeNull();
  expect(parseTaskApprovalDecision(Object.create(decision))).toBeNull();
  expect(
    parseTaskApprovalDecision({ ...decision, [Symbol('extra')]: true }),
  ).toBeNull();
});
