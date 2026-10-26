import { expect, test } from 'vitest';
import { parseProjectTaskRoomBrowserHistory } from '../project-task-room-browser.js';

const record = {
  actor: { kind: 'agent', label: 'Researcher', id: 'agent-1' },
  sequence: 1,
  occurredAt: '2026-10-15T10:00:00.000Z',
  execution: {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'orchestration:claude:session-1',
  },
  body: { kind: 'human-message', text: '**The answer**' },
  digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
  integrity: 'L0',
};
const page = (value: unknown) => ({
  kind: 'available',
  records: [value],
  checkpoint: {
    throughSeq: 1,
    checkpointDigest: 'b'.repeat(64),
    retainedAnchorSeq: 0,
    retainedAnchorDigest: 'c'.repeat(64),
  },
  hasMore: false,
  integrity: 'L0',
});
test('the closed room DTO retains exact agent answer identity and time', () => {
  expect(parseProjectTaskRoomBrowserHistory(page(record))).toMatchObject({
    kind: 'available',
    records: [record],
  });
});
test.each([
  null,
  {},
  { sessionId: 'session-1', turnId: 'turn-1', secret: 'private' },
  { sessionId: 'session-1', turnId: 'turn-1', runId: null },
])(
  'invalid execution correlation is rejected without throwing (%j)',
  (execution) => {
    expect(
      parseProjectTaskRoomBrowserHistory(page({ ...record, execution })),
    ).toBeUndefined();
  },
);
test('accessors and proxy traps do not execute through optional room fields', () => {
  const read = () => {
    throw new Error('Accessor must not run');
  };
  const accessor = { ...record };
  Object.defineProperty(accessor, 'execution', { get: read, enumerable: true });
  expect(parseProjectTaskRoomBrowserHistory(page(accessor))).toBeUndefined();
  const proxy = new Proxy(record, { getOwnPropertyDescriptor: read });
  expect(parseProjectTaskRoomBrowserHistory(page(proxy))).toBeUndefined();
});

test('projects member standing, structured mentions, and an agent requester without losing legacy records', () => {
  const startedBy = {
    principalId: 'person-1',
    label: 'Alex',
    standing: 'member',
  };
  const agent = { ...record, startedBy };
  expect(parseProjectTaskRoomBrowserHistory(page(agent))).toMatchObject({
    records: [agent],
  });
  const human = {
    ...record,
    actor: { kind: 'human', label: 'Alex', standing: 'member' },
    execution: undefined,
    body: {
      kind: 'human-message',
      text: 'Review this',
      mentions: [{ kind: 'person', principalId: 'person-2' }],
    },
  };
  expect(parseProjectTaskRoomBrowserHistory(page(human))).toMatchObject({
    records: [{ actor: human.actor, body: human.body }],
  });
  for (const invalid of [
    { ...agent, startedBy: { label: 'Alex', standing: 'member' } },
    { ...agent, startedBy: { ...startedBy, extra: true } },
    { ...human, startedBy },
    { ...human, actor: { ...human.actor, standing: 'guest' } },
    {
      ...human,
      body: {
        ...human.body,
        mentions: Array.from({ length: 33 }, () => human.body.mentions[0]),
      },
    },
  ]) {
    expect(parseProjectTaskRoomBrowserHistory(page(invalid))).toBeUndefined();
  }
});
