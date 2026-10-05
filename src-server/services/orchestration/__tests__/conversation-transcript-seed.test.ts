import { join } from 'node:path';
import type { OrchestrationSessionDetail } from '@kontourai/station-contracts/orchestration';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { approxInjectedTokens } from '../../../routes/chat/chat-context-injection.js';
import {
  renderForkTranscript,
  selectForkTranscriptSlice,
} from '../conversation-fork.js';
import { ConversationLineage } from '../conversation-lineage.js';
import {
  buildTranscriptSeed,
  TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET,
  TRANSCRIPT_SEED_MAX_TOKEN_BUDGET,
  TRANSCRIPT_SEED_MIN_TOKEN_BUDGET,
  TRANSCRIPT_SEED_OMITTED_NOTICE,
  type TranscriptSeedEntry,
  transcriptSeedSource,
} from '../conversation-transcript-seed.js';
import { EventStore } from '../event-store.js';

/**
 * #3164 invariants. Every message body is bracketed by its own start and end
 * tags, so "whole" is checked against the fixture, not against the builder's
 * own rendering: a message is either in the seed with both tags or absent
 * with neither.
 */
const start = (index: number) => `[m${index}:start]`;
const end = (index: number) => `[m${index}:end]`;

function body(index: number, size: number): string {
  // Multibyte filler keeps the byte-derived estimate honest.
  const filler = 'word é 日本 🙂 '.repeat(Math.ceil(size / 16)).slice(0, size);
  return `${start(index)} ${filler} ${end(index)}`;
}

/** Deterministic, uneven message sizes (a small LCG, not Math.random). */
function sizes(count: number, seed: number, max: number): number[] {
  let state = seed;
  return Array.from({ length: count }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return 20 + (state % max);
  });
}

function presence(seed: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    start: seed.includes(start(index)),
    end: seed.includes(end(index)),
  }));
}

/**
 * The invariants every seed holds: within budget, only whole messages, the
 * included ones are the newest contiguous run, and the omission is counted
 * and disclosed.
 */
function expectSeedInvariants(
  seed: string,
  count: number,
  budget: number,
): { included: number; omitted: number } {
  expect(approxInjectedTokens(seed)).toBeLessThanOrEqual(budget);
  const marks = presence(seed, count);
  for (const mark of marks) expect(mark.start).toBe(mark.end);
  const included = marks.filter((mark) => mark.start).length;
  const firstIncluded = count - included;
  marks.forEach((mark, index) =>
    expect(mark.start).toBe(index >= firstIncluded),
  );
  const omitted = count - included;
  if (omitted > 0) {
    expect(seed).toContain(
      `Only the ${included} most recent of ${count} user and assistant text messages ${included === 1 ? 'fits' : 'fit'} the size limit`,
    );
    expect(seed).toContain(
      `The ${omitted} earlier ${omitted === 1 ? 'one is' : 'ones are'} omitted; ${TRANSCRIPT_SEED_OMITTED_NOTICE}`,
    );
    expect(seed).toContain(TRANSCRIPT_SEED_OMITTED_NOTICE);
    // Whether the receiving engine can read further is unknown when the seed
    // is built, so the seed must not claim the history is unreachable.
    expect(seed).not.toMatch(/not available|unavailable/i);
    expect(seed).toContain('the full conversation remains stored in Station');
  } else {
    expect(seed).toContain(
      count === 1
        ? 'The 1 earlier user or assistant text message is included'
        : `All ${count} earlier user and assistant text messages are included`,
    );
    expect(seed).not.toContain('omitted');
  }
  return { included, omitted };
}

function entries(messageSizes: number[]): TranscriptSeedEntry[] {
  return messageSizes.map((size, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: body(index, size),
  }));
}

describe('buildTranscriptSeed', () => {
  test('pins its default and hard-cap budgets', () => {
    expect(TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET).toBe(8_000);
    expect(TRANSCRIPT_SEED_MAX_TOKEN_BUDGET).toBe(64_000);
  });

  test.each([
    [TRANSCRIPT_SEED_MIN_TOKEN_BUDGET, 7],
    [2_500, 11],
    [TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET, 23],
    [TRANSCRIPT_SEED_MAX_TOKEN_BUDGET, 41],
  ])(
    'carries only whole newest messages within a %i-token budget',
    (budget, seed) => {
      // No single message outgrows the budget, so none needs shortening.
      const messageSizes = sizes(240, seed, Math.min(4_000, budget));
      const result = buildTranscriptSeed({
        heading: 'Prior conversation transcript.',
        entries: entries(messageSizes),
        budgetTokens: budget,
      });
      const observed = expectSeedInvariants(
        result.text,
        messageSizes.length,
        budget,
      );
      expect(observed.omitted).toBeGreaterThan(0);
      expect(result).toMatchObject({
        totalMessages: messageSizes.length,
        includedMessages: observed.included,
        omittedMessages: observed.omitted,
        newestShortened: false,
      });
      // Greedy: the next older message really did not fit.
      const withNext = buildTranscriptSeed({
        heading: 'Prior conversation transcript.',
        entries: entries(messageSizes).slice(-observed.included - 1),
        budgetTokens: budget,
      });
      expect(withNext.omittedMessages).toBe(1);
    },
  );

  test('includes every message, with no omission notice, when all fit', () => {
    const messageSizes = sizes(6, 3, 200);
    const result = buildTranscriptSeed({
      heading: 'Prior conversation transcript.',
      entries: entries(messageSizes),
    });
    expect(result.omittedMessages).toBe(0);
    expectSeedInvariants(
      result.text,
      messageSizes.length,
      TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET,
    );
    expect(result.text).toContain(`User: ${body(0, messageSizes[0]!)}`);
    expect(result.text).toContain(`Assistant: ${body(1, messageSizes[1]!)}`);
  });

  test('a newest message larger than the budget keeps its beginning and end and says so', () => {
    const budget = TRANSCRIPT_SEED_MIN_TOKEN_BUDGET;
    const huge = body(2, budget * 40);
    const result = buildTranscriptSeed({
      heading: 'Prior conversation transcript.',
      entries: [
        { role: 'user', text: body(0, 100) },
        { role: 'assistant', text: body(1, 100) },
        { role: 'user', text: huge },
      ],
      budgetTokens: budget,
    });
    expect(approxInjectedTokens(result.text)).toBeLessThanOrEqual(budget);
    expect(result).toMatchObject({
      includedMessages: 1,
      omittedMessages: 2,
      newestShortened: true,
    });
    expect(result.text).toContain(`User: ${start(2)}`);
    expect(result.text).toContain(end(2));
    expect(result.text).toMatch(
      /\[… \d+ characters omitted from the middle of this message …\]/,
    );
    expect(result.text).toContain(
      'The most recent message was too long to include whole',
    );
    expect(result.text).toContain('The 2 earlier ones are omitted;');
    expect(result.text).toContain(
      'Only the 1 most recent of 3 user and assistant text messages fits the size limit and is included below',
    );
    expect(result.text).not.toContain(start(1));
    expect(result.text).not.toContain(start(0));
    // The kept head and tail are the message's own text, split on code
    // points, so no surrogate pair is broken.
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  test.each([
    TRANSCRIPT_SEED_MAX_TOKEN_BUDGET + 1,
    TRANSCRIPT_SEED_MIN_TOKEN_BUDGET - 1,
    2_500.5,
    Number.NaN,
  ])('refuses a %d-token budget instead of clamping it', (budgetTokens) => {
    expect(() =>
      buildTranscriptSeed({
        heading: 'Prior conversation transcript.',
        entries: entries([10]),
        budgetTokens,
      }),
    ).toThrow(RangeError);
  });

  test('refuses a heading that alone exceeds the budget', () => {
    expect(() =>
      buildTranscriptSeed({
        heading: 'x'.repeat(TRANSCRIPT_SEED_MIN_TOKEN_BUDGET * 4),
        entries: entries([10]),
        budgetTokens: TRANSCRIPT_SEED_MIN_TOKEN_BUDGET,
      }),
    ).toThrow(RangeError);
  });

  test('carries conversation text only, never reasoning or runtime errors', () => {
    const messages = projectRuntimeEventsToMessages([
      {
        eventId: 'turn-1-started',
        provider: 'claude',
        threadId: 'thread-a',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'visible question',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      {
        eventId: 'turn-1-reasoning',
        provider: 'claude',
        threadId: 'thread-a',
        method: 'content.reasoning-delta',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        delta: 'private reasoning',
        createdAt: '2026-10-01T00:00:01.000Z',
      },
      {
        eventId: 'turn-1-text',
        provider: 'claude',
        threadId: 'thread-a',
        method: 'content.text-delta',
        turnId: 'turn-1',
        itemId: 'text-1',
        delta: 'visible answer',
        createdAt: '2026-10-01T00:00:02.000Z',
      },
      {
        eventId: 'turn-1-error',
        provider: 'claude',
        threadId: 'thread-a',
        method: 'runtime.error',
        turnId: 'turn-1',
        severity: 'error',
        message: 'engine exploded',
        createdAt: '2026-10-01T00:00:03.000Z',
      },
      {
        eventId: 'turn-1-completed',
        provider: 'claude',
        threadId: 'thread-a',
        method: 'turn.completed',
        turnId: 'turn-1',
        createdAt: '2026-10-01T00:00:04.000Z',
      },
    ]);
    expect(transcriptSeedSource(messages)).toEqual({
      entries: [
        { role: 'user', text: 'visible question' },
        { role: 'assistant', text: 'visible answer' },
      ],
      nonTextMessages: 0,
    });
  });

  test.each([
    [
      'a backtick fence after an introduction',
      '`'.repeat(3),
      'Here is the file:\n\n',
    ],
    [
      'a tilde fence after an introduction',
      '~'.repeat(3),
      'Here is the file:\n\n',
    ],
    ['a fence that opens the message', '`'.repeat(3), ''],
  ])(
    'a shortened message never leaves %s open across the marker',
    (_, fence, intro) => {
      const code = Array.from(
        { length: 4_000 },
        (_, line) => `const value${line} = ${line};`,
      ).join('\n');
      const result = buildTranscriptSeed({
        heading: 'Prior conversation transcript.',
        entries: [
          {
            role: 'assistant',
            text: `${intro}${fence}ts\n${code}\n${fence}\n\nThat is all.`,
          },
        ],
        budgetTokens: TRANSCRIPT_SEED_MIN_TOKEN_BUDGET,
      });
      expect(result.newestShortened).toBe(true);
      // Lines a Markdown reader treats as fences: at most three spaces, then
      // a run of three or more backticks or tildes.
      const fenceLines = (text: string) =>
        text.split('\n').filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line))
          .length;
      const [beforeMarker, afterMarker] = result.text.split(
        /\[… \d+ characters omitted from the middle of this message …\]/,
      );
      // The fence the head opened is closed before the marker with the same
      // character, and the tail, which starts inside the same block, reopens it.
      expect(fenceLines(beforeMarker!) % 2).toBe(0);
      expect(fenceLines(afterMarker!) % 2).toBe(0);
      expect(afterMarker!.startsWith(`\n${fence}\n`)).toBe(true);
      expect(beforeMarker!.trimEnd().endsWith(`\n${fence}`)).toBe(true);
    },
  );
});

describe('messages with no text to carry (#3164 review)', () => {
  const event = (overrides: Record<string, unknown>) =>
    ({
      provider: 'claude',
      threadId: 'thread-b',
      createdAt: '2026-10-01T00:00:00.000Z',
      ...overrides,
    }) as never;
  /** A reasoning-only turn and an error-only turn, as adapters persist them. */
  const nonTextTurns = [
    event({ eventId: 'r-done', method: 'turn.started', turnId: 'turn-r' }),
    event({
      eventId: 'r-reason',
      method: 'content.reasoning-delta',
      turnId: 'turn-r',
      itemId: 'reason-1',
      delta: 'thinking only',
    }),
    event({ eventId: 'r-end', method: 'turn.completed', turnId: 'turn-r' }),
    event({ eventId: 'e-start', method: 'turn.started', turnId: 'turn-e' }),
    event({
      eventId: 'e-error',
      method: 'runtime.error',
      turnId: 'turn-e',
      severity: 'error',
      message: 'engine failed',
    }),
    event({ eventId: 'e-end', method: 'turn.completed', turnId: 'turn-e' }),
  ];

  test('counts them separately instead of claiming every message is included', () => {
    const messages = projectRuntimeEventsToMessages([
      event({
        eventId: 't-start',
        method: 'turn.started',
        turnId: 'turn-t',
        prompt: 'a real question',
      }),
      ...nonTextTurns,
    ]);
    const source = transcriptSeedSource(messages);
    expect(source.nonTextMessages).toBe(2);
    const seed = buildTranscriptSeed({ heading: 'Prior.', ...source }).text;
    expect(seed).toContain(
      'The 1 earlier user or assistant text message is included below.',
    );
    expect(seed).toContain(
      '2 other user or assistant messages had no text parts to carry',
    );
  });

  test('a conversation with no text says so without claiming it is empty', () => {
    const seed = buildTranscriptSeed({
      heading: 'Prior.',
      ...transcriptSeedSource(projectRuntimeEventsToMessages(nonTextTurns)),
    }).text;
    expect(seed).toContain(
      'There are no earlier user or assistant text messages.',
    );
    expect(seed).toContain(
      '2 other user or assistant messages had no text parts to carry',
    );
  });
});

/** One completed turn per pair of messages, in the shape adapters persist. */
function appendTurns(
  store: EventStore,
  threadId: string,
  messageSizes: number[],
): void {
  for (let index = 0; index < messageSizes.length; index += 2) {
    const turnId = `${threadId}-turn-${index}`;
    const at = (offset: number) =>
      new Date(Date.UTC(2026, 9, 1, 0, 0, index, offset)).toISOString();
    store.appendEvent({
      eventId: `${turnId}-started`,
      provider: 'claude',
      threadId,
      method: 'turn.started',
      turnId,
      prompt: body(index, messageSizes[index]!),
      createdAt: at(0),
    });
    if (index + 1 < messageSizes.length) {
      store.appendEvent({
        eventId: `${turnId}-text`,
        provider: 'claude',
        threadId,
        method: 'content.text-delta',
        turnId,
        itemId: `${turnId}-item`,
        delta: body(index + 1, messageSizes[index + 1]!),
        createdAt: at(1),
      });
    }
    store.appendEvent({
      eventId: `${turnId}-completed`,
      provider: 'claude',
      threadId,
      method: 'turn.completed',
      turnId,
      finishReason: 'stop',
      createdAt: at(2),
    });
  }
}

function stoppedDetail(threadId: string): OrchestrationSessionDetail {
  return {
    session: {
      threadId,
      provider: 'claude',
      status: 'closed',
      lifecycleState: 'canceled',
      controlMode: 'station-owned',
      answerability: {
        answerable: false,
        qualification: 'past_resume',
        observedBy: 'conversation-transcript-seed-test',
        observedAt: '2026-10-01T00:00:00.000Z',
      },
      isLoaded: false,
      isPersisted: true,
      eventCount: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:01.000Z',
    },
    events: [],
  };
}

describe('handoff and continuation seeds (#3164)', () => {
  const ROOT = 'conversation-seed';
  const makeTempDir = trackTempDirs();
  let store: EventStore;

  beforeEach(() => {
    const dir = makeTempDir('transcript-seed-');
    store = new EventStore(join(dir, 'orchestration.sqlite'));
    store.upsertSession({
      provider: 'claude',
      threadId: ROOT,
      status: 'closed',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:01.000Z',
    } as never);
  });

  afterEach(() => {
    store.close();
  });

  function lineage() {
    return new ConversationLineage({
      eventStore: store,
      logger: { warn: vi.fn() },
      readSession: async (threadId) =>
        threadId === ROOT ? stoppedDetail(ROOT) : null,
      readSessionMessages: (threadId): ConversationMessage[] =>
        projectRuntimeEventsToMessages(
          store.listEvents(threadId).map((event) => event.payload),
        ),
      listSessionReadModel: async () => [],
      canReadSession: () => true,
    });
  }

  test('a continuation without a native cursor seeds whole newest messages under the default budget', async () => {
    const messageSizes = sizes(120, 5, 3_000);
    appendTurns(store, ROOT, messageSizes);

    const resolved = await lineage().resolveConversationContinuation(
      ROOT,
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'codex' },
    );

    expect(resolved.startRequired).toBe(true);
    const observed = expectSeedInvariants(
      resolved.transcriptSeed!,
      messageSizes.length,
      TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET,
    );
    expect(observed.omitted).toBeGreaterThan(0);
    expect(observed.included).toBeGreaterThan(0);
  });

  test('a continuation seed counts messages that had no text parts to carry', async () => {
    appendTurns(store, ROOT, [40, 40]);
    store.appendEvent({
      eventId: 'reasoning-only-started',
      provider: 'claude',
      threadId: ROOT,
      method: 'turn.started',
      turnId: 'reasoning-only',
      createdAt: '2026-10-01T01:00:00.000Z',
    });
    store.appendEvent({
      eventId: 'reasoning-only-delta',
      provider: 'claude',
      threadId: ROOT,
      method: 'content.reasoning-delta',
      turnId: 'reasoning-only',
      itemId: 'reasoning-only-item',
      delta: 'thinking only',
      createdAt: '2026-10-01T01:00:01.000Z',
    });
    store.appendEvent({
      eventId: 'reasoning-only-completed',
      provider: 'claude',
      threadId: ROOT,
      method: 'turn.completed',
      turnId: 'reasoning-only',
      finishReason: 'stop',
      createdAt: '2026-10-01T01:00:02.000Z',
    });

    const resolved = await lineage().resolveConversationContinuation(
      ROOT,
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'codex' },
    );

    expect(resolved.transcriptSeed).toContain(
      'All 2 earlier user and assistant text messages are included',
    );
    expect(resolved.transcriptSeed).toContain(
      '1 other user or assistant message had no text parts to carry',
    );
  });

  test('an Agent/engine handoff seeds whole newest messages under the default budget', async () => {
    const messageSizes = sizes(120, 9, 3_000);
    appendTurns(store, ROOT, messageSizes);

    const prepared = await lineage().prepareConversationHandoff(
      ROOT,
      INTERNAL_SESSION_READ_SCOPE,
      {
        agentId: 'agent-b',
        environmentId: 'environment-a',
        connectionId: 'codex',
        idempotencyKey: 'handoff-a',
        messageDigest: 'message-a',
      },
    );

    const observed = expectSeedInvariants(
      prepared.transcriptSeed!,
      messageSizes.length,
      TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET,
    );
    expect(observed.omitted).toBeGreaterThan(0);
    expect(prepared.carried).toContain('authorizedTranscript');
  });
});

describe('fork replay seed (#3164)', () => {
  test('a fork seeds whole newest messages through the selected branch point', () => {
    const messageSizes = sizes(80, 13, 3_000);
    const messages = messageSizes.map(
      (size, index) =>
        ({
          id: `message-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          parts: [{ type: 'text', text: body(index, size) }],
          metadata: { turnId: `turn-${Math.floor(index / 2)}` },
        }) satisfies ConversationMessage,
    );
    const slice = selectForkTranscriptSlice(messages, 'turn-29');
    expect(slice?.messages).toHaveLength(60);

    const seed = renderForkTranscript({
      sourceTitle: 'Planning',
      sourceAgent: 'Claude',
      messages: slice!.messages,
    });

    expect(seed).toContain(
      'Continued from a previous conversation (Planning, on Claude)',
    );
    const observed = expectSeedInvariants(
      seed,
      60,
      TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET,
    );
    expect(observed.omitted).toBeGreaterThan(0);
    // Nothing after the branch point leaks in.
    expect(seed).not.toContain(start(60));
  });

  test.each([
    ['a long title', 'x'.repeat(32_000)],
    ['an emoji title', '🙂'.repeat(8_000)],
  ])('%s is bounded in the heading instead of failing the fork', (_, title) => {
    const seed = renderForkTranscript({
      sourceTitle: title,
      sourceAgent: 'Claude',
      messages: [
        {
          id: 'u',
          role: 'user',
          parts: [{ type: 'text', text: body(0, 50) }],
        },
      ],
    });
    expect(approxInjectedTokens(seed)).toBeLessThanOrEqual(
      TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET,
    );
    const heading = seed.split('\n')[0]!;
    expect(heading).toContain('…, on Claude)');
    expect(Buffer.byteLength(heading, 'utf8')).toBeLessThan(1_000);
    expect(heading).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(seed).toContain(start(0));
  });
});
