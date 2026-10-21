import { describe, expect, test } from 'vitest';
import { chatSchema } from '../../../routes/schemas/schema-definitions/runtime.js';
import {
  buildTaskBrief,
  parseTaskMemory,
  TASK_BRIEF_MAX_CHARS,
  type TaskBriefInput,
} from '../task-brief.js';
import { TRACKER_GUIDANCE } from '../task-brief-tracker-guidance.js';

const TASK: TaskBriefInput['task'] = {
  id: 'task-1',
  projectId: 'project-a',
  createdAt: '2026-10-20T00:00:00.000Z',
  title: 'Ship the brief',
  description: 'Dispatched Sessions start with context.',
};

function input(
  overrides: Partial<TaskBriefInput> & { text?: string } = {},
): TaskBriefInput {
  const { text, ...rest } = overrides;
  return {
    task: TASK,
    document: { kind: 'available', revision: 'rev-1', text: text ?? '' },
    sessions: [],
    ...rest,
  };
}

describe('parseTaskMemory', () => {
  test('splits the preamble and the four fixed sections into entries, in document order', () => {
    const parsed = parseTaskMemory(
      [
        '# Title',
        'Seeded brief.',
        '## Decisions',
        '- first decision',
        '  continued line',
        '- second decision',
        '## Done',
        'A paragraph entry.',
        '',
        'Another paragraph.',
        '## Notes',
        '- not memory',
        '## In progress',
        '- s1: working',
        '## Open questions',
      ].join('\n'),
    );
    expect(parsed.preamble).toBe('# Title\nSeeded brief.');
    expect(parsed.sections).toEqual({
      decisions: ['- first decision\n  continued line', '- second decision'],
      done: ['A paragraph entry.', 'Another paragraph.'],
      inProgress: ['- s1: working'],
      openQuestions: [],
    });
  });
});

describe('buildTaskBrief', () => {
  test('stays within the bound, keeps the newest entries, and says how many it left out', () => {
    // Entries are numbered oldest first, as task_note appends them.
    const entries = (prefix: string) =>
      Array.from(
        { length: 400 },
        (_, i) => `- ${prefix} ${String(i).padStart(3, '0')} ${'x'.repeat(60)}`,
      );
    const text = [
      '## Decisions',
      ...entries('decision'),
      '## Done',
      ...entries('done'),
      '## In progress',
      ...entries('progress'),
      '## Open questions',
      ...entries('question'),
    ].join('\n');
    const brief = buildTaskBrief(input({ text }));
    expect(brief.text.length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
    // Pin the bound itself: the shared 16000 Task-room context bound.
    expect(TASK_BRIEF_MAX_CHARS).toBe(16000);
    for (const key of [
      'decisions',
      'done',
      'inProgress',
      'openQuestions',
    ] as const) {
      expect(brief.omitted[key]).toBeGreaterThan(0);
      expect(brief.omitted[key]).toBeLessThan(400);
    }
    // Newest first: the last-appended entry is shown, the first is not, and
    // the newest precedes the next-newest.
    expect(brief.text).toContain('decision 399');
    expect(brief.text).not.toContain('decision 000');
    expect(brief.text.indexOf('decision 399')).toBeLessThan(
      brief.text.indexOf('decision 398'),
    );
    expect(brief.text).toContain(
      `(${brief.omitted.decisions} older entries left out;`,
    );
  });

  test('a small document is shown whole, with no omission line', () => {
    const brief = buildTaskBrief(
      input({ text: '## Decisions\n- only one\n## Done\n- shipped' }),
    );
    expect(brief.omitted).toEqual({
      decisions: 0,
      done: 0,
      inProgress: 0,
      openQuestions: 0,
    });
    expect(brief.text).toContain('- only one');
    expect(brief.text).not.toContain('left out');
    expect(brief.text).toContain(
      '## In progress (newest first)\nNothing recorded.',
    );
  });

  test('tracker guidance appears only when the Task has a linked work item', () => {
    const local = buildTaskBrief(input());
    expect(local.text).not.toContain('## Tracker guidance');
    expect(local.text).not.toContain('Comment at milestones only');
    expect(local.text).not.toContain('## Linked work item');

    const linked = buildTaskBrief(
      input({
        task: {
          ...TASK,
          sourceProvider: 'github',
          workItemRef: 'github:o/r#1',
        },
        observation: { status: 'unavailable', reason: 'gh failed' },
      }),
    );
    expect(linked.text).toContain(`## Tracker guidance\n${TRACKER_GUIDANCE}`);
    expect(linked.text).toContain(
      'linked item not re-read: unavailable (gh failed)',
    );
    // The memory rule is in both; the tracker rules, and any tracker
    // wording at all, only where there is a tracker item.
    for (const brief of [local, linked])
      expect(brief.text).toContain('1. Record decisions');
    expect(linked.text).toContain(
      '2. Post to the tracker item only at a milestone.',
    );
    expect(linked.text).toContain('3. Never close the tracker item');
    expect(local.text).not.toMatch(/tracker/i);
  });

  test('tracker guidance is reserved first: a huge memory still leaves it whole', () => {
    const text = `## Decisions\n${Array.from({ length: 2000 }, (_, i) => `- d${i} ${'y'.repeat(40)}`).join('\n')}`;
    const brief = buildTaskBrief(
      input({
        text,
        task: { ...TASK, workItemRef: 'github:o/r#1' },
        observation: {
          status: 'observed',
          observation: {
            workItemRef: 'github:o/r#1',
            url: 'https://github.com/o/r/issues/1',
            title: 'Issue',
            state: 'open',
            labels: ['bug'],
            updatedAt: '2026-10-20T00:00:00.000Z',
            observedAt: '2026-10-21T00:00:00.000Z',
            comments: [
              {
                author: 'alice',
                createdAt: '2026-10-20T01:00:00Z',
                excerpt: 'older',
              },
              {
                author: 'bob',
                createdAt: '2026-10-20T02:00:00Z',
                excerpt: 'newer',
              },
            ],
          },
        },
      }),
    );
    expect(brief.text.length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
    expect(brief.text).toContain(TRACKER_GUIDANCE);
    expect(brief.omitted.decisions).toBeGreaterThan(0);
    expect(brief.text).toContain('State: open');
    expect(brief.text.indexOf('bob')).toBeLessThan(brief.text.indexOf('alice'));
  });

  test('the digest pins the document revision and the Task incarnation', () => {
    const a = buildTaskBrief(input({ text: '## Done\n- x' }));
    const b = buildTaskBrief(
      input({
        document: {
          kind: 'available',
          revision: 'rev-2',
          text: '## Done\n- x',
        },
      }),
    );
    const c = buildTaskBrief(
      input({
        task: { ...TASK, createdAt: '2026-10-21T00:00:00.000Z' },
        text: '## Done\n- x',
      }),
    );
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([a.digest, b.digest, c.digest]).size).toBe(3);
    expect(buildTaskBrief(input({ text: '## Done\n- x' })).digest).toBe(
      a.digest,
    );
  });

  test('an unreadable document says so instead of inventing memory', () => {
    const brief = buildTaskBrief(
      input({ document: { kind: 'unavailable', reason: 'room closed' } }),
    );
    expect(brief.documentRevision).toBeNull();
    expect(brief.text).toContain(
      'Task document revision: unavailable (room closed)',
    );
    expect(brief.text).toContain('memory sections are missing');
  });
});

describe('the brief header', () => {
  test('is true for both callers: dispatch and get_task_brief', () => {
    const brief = buildTaskBrief(input());
    expect(brief.text).not.toContain(
      'snapshot taken when the Session was dispatched',
    );
    expect(brief.text).toContain(
      'built from the Task as it stood when this brief was made (at dispatch, or by a `get_task_brief` call)',
    );
  });
});

describe('the /chat ambient context bound admits a brief', () => {
  // The Station engine relays a first turn's composed ambient context to
  // /chat. Pinned as a literal beside the derivation.
  const BOUND = 4000 + 1 + 16000;
  test('accepts the largest brief plus ordinary ambient context, refuses one more', () => {
    expect(
      chatSchema.safeParse({ input: 'hi', ambientContext: 'a'.repeat(BOUND) })
        .success,
    ).toBe(true);
    expect(
      chatSchema.safeParse({
        input: 'hi',
        ambientContext: 'a'.repeat(BOUND + 1),
      }).success,
    ).toBe(false);
  });
});
