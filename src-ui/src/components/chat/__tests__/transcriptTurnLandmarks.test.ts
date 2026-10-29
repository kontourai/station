import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import { describe, expect, test } from 'vitest';
import { compactTurnText } from '../../../hooks/orchestration/replay/timeline';
import type { ChatMessage } from '../../../types';
import { turnStepTarget } from '../TranscriptTurnRail';
import {
  projectTranscriptChildRows,
  type TranscriptChild,
} from '../transcript-child-work';
import { projectTranscriptMessages } from '../transcriptProjection';
import {
  transcriptTurnLandmarks,
  turnIndexForRow,
} from '../transcriptTurnLandmarks';

const SESSION = 'rail-session';

/** Rows exactly as ChatMessageList builds them: the projection's own writer. */
function rows(messages: ChatMessage[]) {
  return projectTranscriptMessages(SESSION, messages);
}

function turns(count: number, repliesPerTurn = 1): ChatMessage[] {
  return Array.from({ length: count }, (_, turn) => [
    { id: `u-${turn}`, role: 'user' as const, content: `Question ${turn}` },
    ...Array.from({ length: repliesPerTurn }, (_, reply) => ({
      id: `a-${turn}-${reply}`,
      role: 'assistant' as const,
      turnId: `t-${turn}`,
      content: `Answer ${turn}.${reply}`,
    })),
  ]).flat();
}

describe('transcriptTurnLandmarks', () => {
  test('one landmark per user row, located in the full row model', () => {
    // 150 rows: far more than a virtualized transcript mounts at once. The
    // derivation reads the row model only, so every turn is placed.
    const model = rows(turns(50, 2));
    const landmarks = transcriptTurnLandmarks(model);
    expect(model).toHaveLength(150);
    expect(landmarks).toHaveLength(50);
    expect(landmarks[37]).toMatchObject({
      rowId: `${SESSION}:message:u-37`,
      rowIndex: 111,
      endRowIndex: 114,
      prompt: 'Question 37',
      reply: 'Answer 37.0',
    });
    expect(landmarks.at(-1)?.endRowIndex).toBe(150);
    expect(landmarks.map((landmark) => model[landmark.rowIndex]?.id)).toEqual(
      landmarks.map((landmark) => landmark.rowId),
    );
  });

  test('rows before the first user turn belong to no landmark', () => {
    const landmarks = transcriptTurnLandmarks(
      rows([
        { id: 'sys', role: 'system', content: 'Session resumed' },
        ...turns(2),
      ]),
    );
    expect(landmarks.map((landmark) => landmark.rowIndex)).toEqual([1, 3]);
  });

  test('prompt and reply are compacted excerpts; a turn without a reply has none', () => {
    const long = `Please ${'look  at\nthis '.repeat(60)}`;
    const [first, second] = transcriptTurnLandmarks(
      rows([
        { id: 'u-0', role: 'user', content: long },
        {
          id: 'a-0',
          role: 'assistant',
          content: '',
          contentParts: [{ type: 'text', content: 'From the parts.' }],
        },
        { id: 'u-1', role: 'user', content: 'Still waiting' },
      ]),
    );
    expect(first?.prompt.length).toBeLessThanOrEqual(140);
    expect(first?.prompt.startsWith('Please look at this look at')).toBe(true);
    expect(first?.prompt.endsWith('…')).toBe(true);
    expect(first?.prompt).not.toMatch(/\s{2}|\n/);
    expect(first?.reply).toBe('From the parts.');
    expect(second?.reply).toBeUndefined();
  });

  test('marks a turn whose reply carries the projected runtime error', () => {
    const landmarks = transcriptTurnLandmarks(
      rows([
        ...turns(2),
        { id: 'u-2', role: 'user', content: 'Try again' },
        {
          id: 'a-2',
          role: 'assistant',
          content: '',
          contentParts: [
            {
              type: 'text',
              content: '⚠️ The engine exited',
              runtimeError: true,
              runtimeErrorCode: 'engine_exit',
            },
          ],
        },
      ]),
    );
    expect(landmarks.map((landmark) => landmark.marker)).toEqual([
      undefined,
      undefined,
      'failed',
    ]);
  });

  test('marks a turn with a standalone sub-agent row; a failure outranks it', () => {
    const messages: ChatMessage[] = [
      { id: 'u-0', role: 'user', content: 'Fan out' },
      {
        id: 'a-0',
        role: 'assistant',
        turnId: 't-0',
        sessionId: 'thread-1',
        content: 'Started a helper.',
      },
      { id: 'u-1', role: 'user', content: 'Fan out again' },
      {
        id: 'a-1',
        role: 'assistant',
        turnId: 't-1',
        sessionId: 'thread-1',
        content: '',
        contentParts: [{ type: 'text', content: 'boom', runtimeError: true }],
      },
    ];
    const child = (turnId: string): TranscriptChild => ({
      item: { reporterThreadId: 'thread-1' } as ChildWorkItem,
      spawn: {
        turnId,
        eventIndex: 0,
        standalone: true,
        toolAnchor: false,
        textOffset: 0,
        turnTextOffset: 0,
      },
      toolAnchor: false,
    });
    const model = projectTranscriptChildRows(
      rows(messages),
      new Map([
        ['child-0', child('t-0')],
        ['child-1', child('t-1')],
      ]),
      undefined,
    );
    expect(model.map((row) => row.kind)).toEqual([
      'message:user',
      'subagent',
      'message:assistant',
      'message:user',
      'subagent',
      'message:assistant',
    ]);
    expect(
      transcriptTurnLandmarks(model).map((landmark) => landmark.marker),
    ).toEqual(['subagent', 'failed']);
  });
});

describe('turnIndexForRow', () => {
  const landmarks = transcriptTurnLandmarks(rows(turns(4, 2)));
  test.each([
    [0, 0],
    [2, 0],
    [3, 1],
    [8, 2],
    [11, 3],
    [99, 3],
  ])('row %i belongs to turn %i', (row, turn) => {
    expect(turnIndexForRow(landmarks, row)).toBe(turn);
  });
});

describe('turnStepTarget', () => {
  test('previous from a turn whose prompt is on screen is the turn before it', () => {
    expect(
      turnStepTarget({ activeTurn: 4, activeStartVisible: true }, -1, 10),
    ).toBe(3);
  });
  test("previous part-way through a turn is that turn's own start", () => {
    expect(
      turnStepTarget({ activeTurn: 4, activeStartVisible: false }, -1, 10),
    ).toBe(4);
  });
  test('next is the following turn; the ends have none', () => {
    expect(
      turnStepTarget({ activeTurn: 4, activeStartVisible: true }, 1, 10),
    ).toBe(5);
    expect(
      turnStepTarget({ activeTurn: 9, activeStartVisible: true }, 1, 10),
    ).toBeUndefined();
    expect(
      turnStepTarget({ activeTurn: 0, activeStartVisible: true }, -1, 10),
    ).toBeUndefined();
  });
});

describe('compactTurnText', () => {
  /** The original definition: collapse every run, trim, then cut. */
  const reference = (text: string | undefined, max = 72) => {
    const compact = text?.replace(/\s+/g, ' ').trim();
    if (!compact) return undefined;
    return compact.length > max ? `${compact.slice(0, max - 3)}…` : compact;
  };
  const cases = [
    undefined,
    '',
    '   \n\t  ',
    'short',
    '  leading and trailing  ',
    'tabs\tand\nnewlines\r\n  mixed\u00a0nbsp\u2028line',
    'x'.repeat(72),
    'x'.repeat(73),
    `${'word '.repeat(14)}word`,
    `${'a'.repeat(70)}   ${'b'.repeat(10)}`,
    `${'a'.repeat(71)} 😀😀 tail`,
    `😀${' '.repeat(5)}${'é'.repeat(100)}`,
  ];
  test.each(cases.map((text) => [text]))(
    'matches the collapse-trim-cut definition for %j',
    (text) => {
      for (const max of [5, 72, 140])
        expect(compactTurnText(text, max)).toBe(reference(text, max));
    },
  );

  test('a long paste is read only as far as the label needs', () => {
    let reads = 0;
    const long = 'word '.repeat(200_000);
    const counted = new Proxy(new String(long), {
      get(target, key, receiver) {
        if (key === 'codePointAt') {
          return (index: number) => {
            reads += 1;
            return long.codePointAt(index);
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as string;
    expect(compactTurnText(counted)).toBe(reference(long));
    expect(reads).toBeLessThan(200);
  });
});
