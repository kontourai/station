import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, it } from 'vitest';
import { inputRequestFromMcpElicitation } from '../mcp-elicitation.js';
import { projectRuntimeEventsToMessages } from '../runtime-event-projection.js';
import legacy from './fixtures/legacy-harness-question-events.json' with {
  type: 'json',
};

/**
 * #3390 (and #3331 R1/R7): every input request leaves one transcript record.
 * It opens on `request.opened` and takes its outcome from `request.resolved`
 * — so an answer given anywhere, including another device, shows here.
 */
const base = {
  provider: 'codex',
  threadId: 't1',
  createdAt: '2026-10-05T00:00:00.000Z',
};
let n = 0;
const ev = (
  e: Partial<CanonicalRuntimeEvent> & { method: string },
): CanonicalRuntimeEvent =>
  ({ eventId: `e${n++}`, ...base, ...e }) as unknown as CanonicalRuntimeEvent;

const form = inputRequestFromMcpElicitation('fixture', {
  message: 'Who should the report go to?',
  requestedSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
})!;

const records = (messages: ReturnType<typeof projectRuntimeEventsToMessages>) =>
  messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'input-request')
    .map((part) => part.inputRequestRecord);

const opened = (requestId: string, payload: Record<string, unknown>) =>
  ev({
    method: 'request.opened',
    requestId,
    requestType: 'approval',
    title: 'fixture needs your input',
    turnId: 'turn-1',
    payload,
  } as never);

describe('#3390 input request transcript record', () => {
  it('opens pending and records a form answered on another device', () => {
    const open = opened('form-1', { inputRequest: form });
    const before = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'turn-1', prompt: 'Write it' }),
      open,
    ]);
    expect(records(before)).toEqual([
      {
        requestId: 'form-1',
        threadId: 't1',
        eventId: open.eventId,
        kind: 'form',
        requester: 'fixture',
        message: 'Who should the report go to?',
        outcome: 'pending',
      },
    ]);
    // This client never answered: only the resolution reached it.
    const after = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'turn-1', prompt: 'Write it' }),
      open,
      ev({
        method: 'request.resolved',
        requestId: 'form-1',
        status: 'approved',
      } as never),
      ev({ method: 'turn.completed', turnId: 'turn-1', outputText: 'Done.' }),
    ]);
    expect(records(after).map((record) => record?.outcome)).toEqual([
      'accepted',
    ]);
  });

  it.each([
    ['denied', 'declined'],
    ['cancelled', 'cancelled'],
    ['expired', 'expired'],
  ])('a form resolved %s reads %s', (status, outcome) => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'turn-1', prompt: 'Go' }),
      opened('form-2', { inputRequest: form }),
      ev({
        method: 'request.resolved',
        requestId: 'form-2',
        status,
      } as never),
    ]);
    expect(records(messages)[0]?.outcome).toBe(outcome);
  });

  it('records a pre-#3390 stored harness question too', () => {
    const stored = legacy.codex as unknown as CanonicalRuntimeEvent;
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'turn-1', prompt: 'Ask me' }),
      { ...stored, threadId: 't1' },
      ev({
        method: 'request.resolved',
        requestId: (stored as { requestId: string }).requestId,
        status: 'approved',
      } as never),
    ]);
    expect(records(messages)).toEqual([
      expect.objectContaining({
        kind: 'form',
        requester: 'Codex',
        outcome: 'accepted',
      }),
    ]);
  });

  it('an approval with no call row records allowed or denied; a bound one keeps its tool row', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'turn-1', prompt: 'Run' }),
      ev({
        method: 'tool.started',
        turnId: 'turn-1',
        toolCallId: 'bash-1',
        toolName: 'Bash',
        arguments: { command: 'ls' },
      }),
      opened('bound', { toolName: 'Bash', toolCallId: 'bash-1' }),
      // Codex reports no call identity.
      opened('unbound', { command: 'git push' }),
      ev({
        method: 'request.resolved',
        requestId: 'bound',
        status: 'approved',
      } as never),
      ev({
        method: 'request.resolved',
        requestId: 'unbound',
        status: 'denied',
      } as never),
    ]);
    expect(records(messages)).toEqual([
      expect.objectContaining({
        requestId: 'unbound',
        kind: 'decision',
        outcome: 'denied',
      }),
    ]);
    const bound = messages
      .flatMap((message) => message.parts)
      .find((part) => part.toolCallId === 'bash-1');
    expect(bound?.approvalStatus).toBe('user-approved');
  });

  it('a request its turn ended without answering reads cancelled; an asynchronous one stays pending', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'turn-1', prompt: 'Go' }),
      opened('blocking', { inputRequest: form }),
      ev({
        method: 'request.opened',
        requestId: 'async',
        requestType: 'approval',
        title: 'later',
        blocking: false,
        payload: { inputRequest: form },
      } as never),
      ev({ method: 'turn.completed', turnId: 'turn-1', outputText: 'Ok' }),
    ]);
    expect(
      records(messages).map((record) => [record?.requestId, record?.outcome]),
    ).toEqual([
      ['blocking', 'cancelled'],
      ['async', 'pending'],
    ]);
  });

  it('never carries the answer', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 'turn-1', prompt: 'Go' }),
      opened('form-3', { inputRequest: form }),
      ev({
        method: 'request.resolved',
        requestId: 'form-3',
        status: 'approved',
        response: { content: { name: 'answer-canary' } },
      } as never),
    ]);
    expect(JSON.stringify(messages)).not.toContain('answer-canary');
  });
});
