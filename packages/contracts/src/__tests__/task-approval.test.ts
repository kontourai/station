import { expect, test } from 'vitest';
import {
  parseTaskApprovalDecision,
  parseTaskApprovalOutcome,
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
test.each(['requestId', 'sessionId', 'principalId'])(
  'refuses whitespace, controls and malformed Unicode in approval %s',
  (field) => {
    for (const value of [
      ' id',
      'id ',
      '\u00a0id',
      'id\u00a0',
      'a\u0000b',
      'a\u001fb',
      'a\u007fb',
      'a\u0085b',
      'a\u202eb',
      'a\u200bb',
      'a\u034fb',
      '\ud800',
    ]) {
      const input =
        field === 'principalId'
          ? { ...decision, decider: { principalId: value } }
          : { ...decision, [field]: value };
      expect(parseTaskApprovalDecision(input)).toBeNull();
    }
  },
);
test.each(['decided', 'already-decided'])(
  'parses %s with complete attribution for either decision',
  (kind) => {
    for (const answer of ['allow', 'deny']) {
      for (const channel of ['station', 'slack', 'discord']) {
        const value = { ...decision, decision: answer, channel };
        const input =
          kind === 'decided'
            ? { kind, decision: value }
            : { kind, winner: value };
        expect(parseTaskApprovalOutcome(input)).toEqual(input);
      }
    }
  },
);
test.each([
  'invalid-request',
  'not-found',
  'forbidden',
  'request-not-pending',
  'unavailable',
])('parses refusal %s', (code) => {
  const input = { kind: 'refused', code };
  expect(parseTaskApprovalOutcome(input)).toEqual(input);
});
test.each([
  null,
  {},
  { kind: 'unknown' },
  { kind: 'decided' },
  { kind: 'already-decided' },
  { kind: 'decided', winner: decision },
  { kind: 'already-decided', decision },
  { kind: 'decided', decision, extra: true },
  { kind: 'already-decided', winner: decision, extra: true },
  { kind: 'refused', code: 'timeout' },
  { kind: 'refused', code: 'forbidden', winner: decision },
  { kind: 'decided', decision: { ...decision, decider: {} } },
  { kind: 'already-decided', winner: { ...decision, decider: {} } },
  { kind: 'already-decided', winner: { ...decision, channel: 'email' } },
  { kind: 'already-decided', winner: { ...decision, decidedAt: '2026-10-26' } },
  {
    kind: 'already-decided',
    winner: { ...decision, decider: { principalId: ' id' } },
  },
])('refuses malformed or surplus approval outcomes (%j)', (value) => {
  expect(parseTaskApprovalOutcome(value)).toBeNull();
});
test('refuses outcome accessors, inherited fields and symbol keys without invoking accessors', () => {
  const outcome = { kind: 'already-decided', winner: decision };
  const getter = { ...outcome };
  Object.defineProperty(getter, 'winner', {
    get() {
      throw new Error('must not run');
    },
    enumerable: true,
  });
  expect(parseTaskApprovalOutcome(getter)).toBeNull();
  expect(parseTaskApprovalOutcome(Object.create(outcome))).toBeNull();
  expect(
    parseTaskApprovalOutcome({ ...outcome, [Symbol('extra')]: true }),
  ).toBeNull();
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
