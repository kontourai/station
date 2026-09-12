import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { ReplayHistoryState } from '../../src-ui/src/hooks/orchestration/replay/history';
import type {
  ReplayFrame,
  SessionTape,
} from '../../src-ui/src/hooks/orchestration/replay/tape';
import { buildLongSessionTurns } from './long-session';

const source = {
  threadId: 'replay-scenario',
  agentSlug: 'station',
  provider: 'codex',
};
let nextId = 0;
const base = {
  provider: 'codex',
  threadId: source.threadId,
  createdAt: '2026-09-12T00:00:00.000Z',
  turnId: 'turn-1',
} as const;
function event<M extends CanonicalRuntimeEvent['method']>(
  method: M,
  fields: Omit<
    Extract<CanonicalRuntimeEvent, { method: M }>,
    keyof typeof base | 'eventId' | 'method'
  > & { turnId?: string },
): Extract<CanonicalRuntimeEvent, { method: M }> {
  return {
    ...base,
    ...fields,
    method,
    eventId: `scenario-event-${++nextId}`,
  } as Extract<CanonicalRuntimeEvent, { method: M }>;
}
const runtime = (event: CanonicalRuntimeEvent, atMs = 0): ReplayFrame => ({
  kind: 'runtime',
  event,
  atMs,
});
const start = () =>
  runtime(
    event('turn.started', {
      prompt: 'Please inspect the chat and explain what needs attention.',
    }),
  );
const text = (delta: string, atMs = 500) =>
  runtime(event('content.text-delta', { itemId: 'answer', delta }), atMs);
const tool = (id: string, atMs = 500) =>
  runtime(
    event('tool.started', {
      itemId: id,
      toolCallId: id,
      toolName: 'read_file',
      arguments: { path: `${id}.ts` },
    }),
    atMs,
  );
const result = (id: string, status: 'success' | 'error', atMs = 1_000) =>
  runtime(
    event('tool.completed', {
      itemId: id,
      toolCallId: id,
      toolName: 'read_file',
      status,
      output: status === 'success' ? 'Recorded file contents.' : undefined,
      error:
        status === 'error' ? 'The recorded file could not be read.' : undefined,
    }),
    atMs,
  );
const completed = (outputText: string, atMs = 2_000) =>
  runtime(event('turn.completed', { outputText, finishReason: 'stop' }), atMs);
function tape(
  frames: ReplayFrame[],
  initialHistory?: ReplayHistoryState,
): SessionTape {
  return {
    schemaVersion: 1,
    kind: 'station.session-tape',
    source,
    recordedAt: base.createdAt,
    coverage: 'client-capture',
    events: [],
    frames,
    initialHistory,
  };
}
const emptyHistory: ReplayHistoryState = {
  events: [],
  handoffs: [],
  contextBoundaries: [],
  hasMore: false,
  loading: false,
  settled: true,
  upgradeRequired: false,
};

export const chatReplayScenarios = [
  {
    name: 'reported thinking before an answer',
    tape: tape([
      start(),
      runtime(
        event('content.reasoning-delta', {
          itemId: 'reasoning',
          delta: 'Inspecting the recorded state transitions.',
        }),
        500,
      ),
      { kind: 'clock', atMs: 28_000 },
    ]),
    text: 'Thinking for',
    timer: '0:28',
    streaming: true,
  },

  {
    name: 'waiting before content',
    tape: tape([start(), { kind: 'clock', atMs: 28_000 }]),
    text: 'Working',
    timer: '0:28',
    streaming: true,
  },
  {
    name: 'partial answer still running',
    tape: tape([
      start(),
      text(
        'I have checked the transcript. The next step is to compare the live events with the recorded history.',
      ),
      { kind: 'clock', atMs: 42_000 },
    ]),
    text: 'compare the live events',
    streaming: true,
  },
  {
    name: 'three tools concurrently running',
    tape: tape([
      start(),
      text('I’m reading the relevant files.'),
      tool('transcript'),
      tool('composer', 600),
      tool('transport', 700),
      { kind: 'clock', atMs: 65_000 },
    ]),
    text: 'reading the relevant files',
    streaming: true,
    tools: 3,
  },
  {
    name: 'sequential tools with one failure',
    tape: tape([
      start(),
      tool('transcript'),
      result('transcript', 'success'),
      tool('missing-file', 1_200),
      result('missing-file', 'error', 1_500),
      completed(
        'One file was unavailable. The other result is preserved for inspection.',
      ),
    ]),
    text: 'One file was unavailable',
    streaming: false,
  },
  {
    name: 'approval pending',
    tape: tape([
      start(),
      tool('approval-file'),
      runtime(
        event('request.opened', {
          requestId: 'approval-1',
          requestType: 'approval',
          title: 'Read approval-file.ts',
          payload: {
            toolName: 'read_file',
            toolInput: { path: 'approval-file.ts' },
          },
        }),
        600,
      ),
      { kind: 'clock', atMs: 20_000 },
    ]),
    text: 'Waiting for approval',
    timer: '0:20',
    streaming: true,
  },
  {
    name: 'provider error after partial text',
    tape: tape([
      start(),
      text('The first check completed.'),
      runtime(
        event('runtime.error', {
          severity: 'error',
          message: 'The provider connection failed during the next check.',
          code: 'fixture_connection_failure',
        }),
        1_000,
      ),
    ]),
    text: 'connection failed',
    streaming: false,
  },
  {
    name: 'reconnecting preserves visible content',
    tape: tape([
      start(),
      text('This text was received before the connection dropped.'),
      { kind: 'connection', status: 'interrupted', atMs: 1_000 },
      { kind: 'clock', atMs: 4_000 },
    ]),
    text: 'received before',
    connection: 'Reconnecting',
    streaming: true,
  },
  {
    name: 'catching up is distinct from reconnecting',
    tape: tape([
      start(),
      text('The existing answer stays on screen.'),
      { kind: 'connection', status: 'interrupted', atMs: 1_000 },
      { kind: 'connection', status: 'receiving', atMs: 3_000 },
      { kind: 'clock', atMs: 5_000 },
    ]),
    text: 'stays on screen',
    connection: 'Catching up',
    streaming: true,
  },
  {
    name: 'credential repair preserves content',
    tape: tape([
      start(),
      text('The last received content is retained.'),
      { kind: 'connection', status: 'closed', atMs: 1_000 },
    ]),
    text: 'content is retained',
    connection: 'Connection needs attention',
    streaming: true,
  },
];

export function multiTurnReplayTape(turnCount = 8): SessionTape {
  const frames: ReplayFrame[] = [];
  for (let turn = 1; turn <= turnCount; turn++) {
    const turnId = `turn-${turn}`;
    frames.push(
      runtime(
        event('turn.started', {
          turnId,
          prompt: `Follow-up question ${turn}.`,
        }),
        turn * 1_000,
      ),
    );
    frames.push(
      runtime(
        event('content.text-delta', {
          turnId,
          itemId: `answer-${turn}`,
          delta: `Answer ${turn} remains associated with its own question.`,
        }),
        turn * 1_000 + 100,
      ),
    );
    frames.push(
      runtime(
        event('turn.completed', {
          turnId,
          finishReason: 'stop',
          outputText: `Answer ${turn} remains associated with its own question.`,
        }),
        turn * 1_000 + 200,
      ),
    );
  }
  return tape(frames);
}

export function partialHistoryReplayTape(): SessionTape {
  const initial = event('turn.started', {
    prompt: 'Please inspect the chat and explain what needs attention.',
  });
  const prefix = event('content.text-delta', {
    itemId: 'commentary',
    delta: 'I will investigate.',
  });
  return tape(
    [
      runtime(initial),
      runtime(prefix, 100),
      completed(
        'I will investigate.The full answer survived completion and the incomplete history refresh.',
        1_000,
      ),
      {
        kind: 'history',
        atMs: 1_100,
        state: {
          ...emptyHistory,
          hasMore: true,
          events: [
            { sequence: 1, event: initial },
            { sequence: 2, event: prefix },
            ...Array.from({ length: 148 }, (_, index) => ({
              sequence: index + 3,
              elided: 'byte_limit' as const,
              event: event('tool.progress', {
                itemId: 'noisy-tool',
                toolCallId: 'noisy-tool',
                message: '',
              }),
            })),
          ],
        },
      },
    ],
    emptyHistory,
  );
}

export function longHistoryReplayTape(): SessionTape {
  const turns = buildLongSessionTurns({
    threadId: source.threadId,
    turnCount: 10_000,
  });
  const canonical = (raw: Record<string, unknown>): CanonicalRuntimeEvent => {
    const { eventId, turnId, createdAt } = raw;
    if (
      typeof eventId !== 'string' ||
      typeof turnId !== 'string' ||
      typeof createdAt !== 'string'
    )
      throw new Error('Long-history fixture lacks event identity');
    const identity = {
      eventId,
      turnId,
      createdAt,
      provider: 'codex' as const,
      threadId: source.threadId,
    };
    if (raw.method === 'turn.started' && typeof raw.prompt === 'string')
      return { ...identity, method: 'turn.started', prompt: raw.prompt };
    if (raw.method === 'turn.completed' && typeof raw.outputText === 'string')
      return {
        ...identity,
        method: 'turn.completed',
        outputText: raw.outputText,
        finishReason: 'stop',
      };
    throw new Error(
      'Long-history fixture does not contain a complete prompt/answer pair',
    );
  };
  const history = (count: number): ReplayHistoryState => ({
    ...emptyHistory,
    hasMore: true,
    events: turns
      .slice(-count)
      .flat()
      .map((event, index) => ({
        sequence: 20_000 - count * 2 + index,
        event: canonical(event),
      })),
  });
  return tape(
    [30, 50, 70, 90].map((count, index) => ({
      kind: 'history',
      atMs: index * 1_000,
      state: history(count),
    })),
    history(10),
  );
}
