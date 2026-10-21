import type {
  TaskMemoryRecord,
  TaskRecordKind,
  TaskSummaryRevision,
} from '@kontourai/station-contracts/task-memory';
import { describe, expect, test } from 'vitest';
import { chatSchema } from '../../../routes/schemas/schema-definitions/runtime.js';
import type { DigestTurn } from '../../orchestration/session-digest.js';
import {
  buildTaskBrief,
  renderTaskRecordListing,
  renderTaskSummaryHistory,
  TASK_BRIEF_MAX_CHARS,
  type TaskBriefInput,
  type TaskBriefSessionFacts,
} from '../task-brief.js';
import { TRACKER_GUIDANCE } from '../task-brief-tracker-guidance.js';

const TASK: TaskBriefInput['task'] = {
  id: 'task-1',
  projectId: 'project-a',
  createdAt: '2026-10-20T00:00:00.000Z',
  title: 'Ship the brief',
  description: 'Dispatched Sessions start with context.',
};

let clock = 0;
/** A record in the shape `TaskMemoryStore.listRecords` returns. */
function record(
  kind: TaskRecordKind,
  key: string,
  text: string,
  overrides: Partial<TaskMemoryRecord> = {},
): TaskMemoryRecord {
  clock += 1;
  return {
    taskId: TASK.id,
    kind,
    key,
    version: 1,
    action: 'set',
    state: kind === 'question' ? 'open' : 'active',
    importance: 'standing',
    text,
    author: { kind: 'session', sessionId: 'session-1' },
    // Later records are newer, as the store writes them.
    createdAt: new Date(Date.UTC(2026, 9, 21, 0, 0, clock)).toISOString(),
    ...overrides,
  };
}

function summary(
  text: string,
  overrides: Partial<TaskSummaryRevision> = {},
): TaskSummaryRevision {
  return {
    taskId: TASK.id,
    revision: 1,
    text,
    author: { kind: 'session', sessionId: 'session-1' },
    createdAt: '2026-10-21T12:34:56.789Z',
    ...overrides,
  };
}

function input(
  overrides: Partial<TaskBriefInput> & {
    text?: string;
    records?: TaskMemoryRecord[];
    summary?: TaskSummaryRevision;
  } = {},
): TaskBriefInput {
  const { text, records, summary: current, ...rest } = overrides;
  return {
    task: TASK,
    document: { kind: 'available', revision: 'rev-1', text: text ?? '' },
    memory: {
      kind: 'available',
      records: records ?? [],
      ...(current ? { summary: current } : {}),
    },
    sessions: [],
    ...rest,
  };
}

const LINKED_TASK = {
  ...TASK,
  sourceProvider: 'github',
  workItemRef: 'github:o/r#1',
};

function observed(
  overrides: { comments?: number; labels?: string[]; title?: string } = {},
): TaskBriefInput['observation'] {
  return {
    status: 'observed',
    observation: {
      workItemRef: 'github:o/r#1',
      url: 'https://github.com/o/r/issues/1',
      title: overrides.title ?? 'Issue',
      state: 'open',
      labels: overrides.labels ?? ['bug'],
      updatedAt: '2026-10-20T00:00:00.000Z',
      observedAt: '2026-10-21T00:00:00.000Z',
      comments: Array.from({ length: overrides.comments ?? 2 }, (_, i) => ({
        author: i === 0 ? 'alice' : `commenter-${i}`,
        createdAt: `2026-10-20T0${i % 10}:00:00Z`,
        excerpt: i === 0 ? 'older' : `newer ${i} ${'c'.repeat(600)}`,
      })),
    },
  };
}

function turn(overrides: Partial<DigestTurn> = {}): DigestTurn {
  return {
    turnId: 'turn-1',
    startedAt: '2026-10-21T10:00:00.000Z',
    request: 'Fix the parser',
    outcome: 'completed',
    toolCalls: [{ tool: 'edit', calls: 2 }],
    filesTotal: 3,
    files: ['a.ts', 'b.ts', 'c.ts'],
    pullRequests: [{ host: 'github.com', repository: 'o/r', ref: '42' }],
    pullRequestsTotal: 1,
    ...overrides,
  };
}

function sessionFacts(
  overrides: Partial<TaskBriefSessionFacts> & { sessionId: string },
): TaskBriefSessionFacts {
  return { createdAt: '2026-10-20T00:00:00.000Z', ...overrides };
}

/** The headings, in the order the brief renders them. */
function headings(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^#{1,2} /.test(line))
    .map((line) => line.replace(/ \(.*$/, ''));
}

describe('buildTaskBrief', () => {
  test('composes the layers in order: Task and work item, summary, records, Sessions, omissions, rules', () => {
    const brief = buildTaskBrief(
      input({
        task: LINKED_TASK,
        observation: observed(),
        text: 'The seeded brief.',
        summary: summary('Now: parser fixed.\nNext: tests.'),
        records: [
          record('decision', 'storage', 'Use SQLite.'),
          record('question', 'scope', 'Ship the CLI too?'),
          record('dead_end', 'regex', 'A regex parser cannot nest.'),
          record('decision', 'narrow', 'Only for the CLI.', {
            importance: 'on_topic',
          }),
        ],
        sessions: [
          sessionFacts({
            sessionId: 'session-1',
            provider: 'codex',
            status: 'Running',
            turnCount: 4,
            lastTurn: turn(),
          }),
        ],
      }),
    );
    expect(headings(brief.text)).toEqual([
      '# Station Task brief',
      '## Linked work item',
      '## Task document',
      '## Task summary',
      '## Standing decisions',
      '## Open questions for a person',
      '## Recent dead ends',
      '## Sessions in this Task',
      '## Not in this brief',
      '## Rules',
      '## Tracker guidance',
    ]);
    expect(brief.summaryRevision).toBe(1);
    expect(brief.text).toContain(
      '## Task summary (revision 1, by session session-1 at 2026-10-21T12:34:56Z)\nNow: parser fixed.\nNext: tests.\n',
    );
    expect(brief.text).toContain(
      '## Standing decisions (newest first)\n- `storage`: Use SQLite.\n',
    );
    expect(brief.text).toContain(
      '## Open questions for a person (newest first)\n- `scope`: Ship the CLI too? (asked by session session-1)\n',
    );
    expect(brief.text).toContain(
      '## Recent dead ends (newest first)\n- `regex`: A regex parser cannot nest.\n',
    );
    // On-topic records are counted, never shown.
    expect(brief.text).not.toContain('Only for the CLI.');
    expect(brief.omitted.onTopic).toEqual({
      decision: 1,
      question: 0,
      dead_end: 0,
    });
    expect(brief.text).toContain(
      '- On-topic records, counted only: 1 decision; call `get_task_brief` with `include: "all_records"`.',
    );
    // The Session line is the digest's facts, compact.
    expect(brief.text).toContain(
      '- session-1 (codex): Running; 4 turns; last turn completed: "Fix the parser"; 3 files changed; PR o/r#42',
    );
  });

  test('answered and retired records are history: counted, never shown', () => {
    const brief = buildTaskBrief(
      input({
        records: [
          record('question', 'q', 'Asked?', {
            version: 2,
            action: 'answer',
            state: 'answered',
            answer: 'Yes.',
          }),
          record('decision', 'd', 'Old way.', {
            version: 2,
            action: 'retire',
            state: 'retired',
            reason: 'Superseded by the rewrite.',
          }),
        ],
      }),
    );
    expect(brief.text).not.toContain('Asked?');
    expect(brief.text).not.toContain('Old way.');
    expect(brief.omitted).toMatchObject({
      answeredQuestions: 1,
      retiredRecords: 1,
    });
    expect(brief.text).toContain(
      '- History: 1 answered question and 1 retired record; call `get_task_brief` with `include: "all_records"`.',
    );
    expect(brief.text).toContain(
      '## Open questions for a person (newest first)\nNone.',
    );
  });

  test('the worst case keeps the bound with the summary whole, and counts what it left out', () => {
    const summaryText = `${'s'.repeat(3999)}E`;
    const records = [
      ...Array.from({ length: 40 }, (_, i) =>
        record(
          'decision',
          `d-${i}`,
          `decision ${String(i).padStart(2, '0')} ${'x'.repeat(980)}`,
        ),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        record(
          'question',
          `q-${i}`,
          `question ${String(i).padStart(2, '0')} ${'y'.repeat(980)}`,
        ),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        record(
          'dead_end',
          `e-${i}`,
          `deadend ${String(i).padStart(2, '0')} ${'z'.repeat(980)}`,
        ),
      ),
    ];
    const brief = buildTaskBrief(
      input({
        task: {
          ...LINKED_TASK,
          title: 't'.repeat(600),
          description: 'g'.repeat(1200),
        },
        observation: observed({
          comments: 9,
          labels: Array.from({ length: 30 }, (_, i) => `${i}${'l'.repeat(80)}`),
          title: 'i'.repeat(600),
        }),
        text: 'b'.repeat(5000),
        summary: summary(summaryText, { revision: 7 }),
        records,
        sessions: Array.from({ length: 20 }, (_, i) =>
          sessionFacts({
            sessionId: `session-${i}`,
            status: 'Running',
            lastTurn: turn({ request: 'r'.repeat(240) }),
          }),
        ),
      }),
    );
    expect(brief.text.length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
    // Pin the bound itself: the shared 16000 Task-room context bound.
    expect(TASK_BRIEF_MAX_CHARS).toBe(16000);
    expect(brief.text).toContain(`\n${summaryText}\n`);
    expect(brief.text).toContain(TRACKER_GUIDANCE);
    // At least the newest record survives even the worst case.
    expect(brief.text).toContain('decision 39');
    expect(brief.text).not.toContain('decision 00');
    const shown = (prefix: string) =>
      brief.text.split('\n').filter((line) => line.includes(`: ${prefix} `))
        .length;
    expect(brief.omitted.standing).toEqual({
      decision: 40 - shown('decision'),
      question: 20 - shown('question'),
      dead_end: 30 - shown('deadend'),
    });
    const sessionLines = brief.text
      .split('\n')
      .filter((line) => line.startsWith('- session-')).length;
    expect(brief.omitted.sessions).toBe(20 - sessionLines);
    expect(brief.text).toContain(
      '- 6 earlier summary revisions; call `get_task_brief` with `include: "summary_history"`.',
    );
    expect(brief.text).toContain(
      `- ${20 - sessionLines} more Sessions of this Task; call \`list_project_activity\`, or \`get_session_digest\` with a Session id.`,
    );
    expect(brief.text).toMatch(
      /- Standing records that did not fit: \d+ decisions, \d+ open questions, \d+ dead ends; call `get_task_brief` with `include: "all_records"`\./,
    );
  });

  test('records fill newest first, round-robin, with an ordinary brief keeping the Sessions', () => {
    const brief = buildTaskBrief(
      input({
        summary: summary('A short summary.'),
        records: Array.from({ length: 40 }, (_, i) =>
          record(
            'decision',
            `d-${i}`,
            `decision ${String(i).padStart(2, '0')} ${'x'.repeat(400)}`,
          ),
        ),
        sessions: [
          sessionFacts({ sessionId: 'old', createdAt: '2026-10-19T00:00:00Z' }),
          sessionFacts({
            sessionId: 'me',
            self: true,
            provider: 'claude',
            lastTurn: turn({
              startedAt: '2026-10-22T00:00:00Z',
              outcome: 'open',
            }),
            turnCount: 1,
          }),
        ],
      }),
    );
    expect(brief.text.length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
    expect(brief.omitted.standing.decision).toBeGreaterThan(0);
    expect(brief.text.indexOf('decision 39')).toBeLessThan(
      brief.text.indexOf('decision 38'),
    );
    expect(brief.text).not.toContain('decision 00');
    // Newest activity first; the receiving Session is marked.
    expect(brief.text).toContain(
      '## Sessions in this Task (newest activity first)\n- me (claude, this session): status unknown; 1 turn; last turn open: "Fix the parser"; 3 files changed; PR o/r#42\n- old: status unknown\n',
    );
  });

  test('the document is shown as written, never parsed for memory', () => {
    const brief = buildTaskBrief(
      input({
        text: 'The person-authored brief.\n\n## Decisions\n- a heading a person typed',
      }),
    );
    expect(brief.text).toContain(
      '## Task document\nThe person-authored brief.\n\n## Decisions\n- a heading a person typed\n',
    );
    expect(brief.text).toContain('## Standing decisions (newest first)\nNone.');
    expect(brief.text).toContain(
      '## Task summary\nNo summary yet. Write the first one with `task_summary_update` and `baseRevision` 0.',
    );
    expect(brief.text).not.toContain('## Not in this brief');
  });

  test('rules name the memory tools; tracker wording only where there is a tracker item', () => {
    const local = buildTaskBrief(input());
    expect(local.text).not.toContain('## Tracker guidance');
    expect(local.text).not.toContain('## Linked work item');
    const linked = buildTaskBrief(
      input({
        task: LINKED_TASK,
        observation: { status: 'unavailable', reason: 'gh failed' },
      }),
    );
    expect(linked.text).toContain(`## Tracker guidance\n${TRACKER_GUIDANCE}`);
    expect(linked.text).toContain(
      'linked item not re-read: unavailable (gh failed)',
    );
    for (const brief of [local, linked]) {
      expect(brief.text).toContain(
        '1. Keep the Task summary current with `task_summary_update`: at milestones and before you stop',
      );
      expect(brief.text).toContain(
        '2. Record decisions, open questions for a person, and dead ends',
      );
    }
    expect(linked.text).toContain(
      '3. Post to the tracker item only at a milestone.',
    );
    expect(linked.text).toContain('4. Never close the tracker item');
    expect(local.text).not.toMatch(/tracker/i);
    expect(TRACKER_GUIDANCE).toContain('`task_summary_update`');
    expect(TRACKER_GUIDANCE).toContain('`task_record`');
  });

  test('the digest pins the document, the summary revision, the record versions and the Task incarnation', () => {
    const decision = record('decision', 'd', 'x');
    const base = input({
      text: 'brief',
      records: [decision],
      summary: summary('s'),
    });
    const digests = [
      base,
      {
        ...base,
        document: {
          kind: 'available' as const,
          revision: 'rev-2',
          text: 'brief',
        },
      },
      { ...base, task: { ...TASK, createdAt: '2026-10-21T00:00:00.000Z' } },
      input({
        text: 'brief',
        records: [decision],
        summary: summary('s2', { revision: 2 }),
      }),
      input({
        text: 'brief',
        records: [{ ...decision, version: 2 }],
        summary: summary('s'),
      }),
    ].map((value) => buildTaskBrief(value).digest);
    expect(digests[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(digests).size).toBe(5);
    expect(buildTaskBrief(base).digest).toBe(digests[0]);
  });

  test('an unreadable document or memory says so instead of inventing either', () => {
    const noDocument = buildTaskBrief(
      input({
        document: { kind: 'unavailable', reason: 'room closed' },
        records: [record('decision', 'd', 'still shown')],
      }),
    );
    expect(noDocument.documentRevision).toBeNull();
    expect(noDocument.text).toContain(
      'Task document revision: unavailable (room closed)',
    );
    expect(noDocument.text).toContain('still shown');
    const noMemory = buildTaskBrief(
      input({ memory: { kind: 'unavailable', reason: 'database closed' } }),
    );
    expect(noMemory.summaryRevision).toBeNull();
    expect(noMemory.text).toContain(
      'The Task memory could not be read (database closed), so the summary and records are missing from this brief.',
    );
    expect(noMemory.text).not.toContain('## Standing decisions');
  });

  test('the header is true for both callers: dispatch and get_task_brief', () => {
    const brief = buildTaskBrief(input());
    expect(brief.text).toContain(
      'built from the Task as it stood when this brief was made (at dispatch, or by a `get_task_brief` call)',
    );
  });
});

describe('the get_task_brief listings', () => {
  test('all_records lists live records of both tiers first, then history with answers and reasons', () => {
    const text = renderTaskRecordListing({
      task: TASK,
      records: [
        record('decision', 'storage', 'Use SQLite.', {
          importance: 'on_topic',
        }),
        record('question', 'scope', 'CLI too?', {
          version: 2,
          action: 'answer',
          state: 'answered',
          answer: 'No.',
          author: { kind: 'person', principalId: 'principal-1' },
        }),
        record('dead_end', 'regex', 'Cannot nest.', {
          version: 3,
          action: 'retire',
          state: 'retired',
          reason: 'We dropped nesting.',
        }),
      ],
    });
    expect(text).toContain(
      '## Active decisions (1)\n- `storage` (on_topic, version 1, active, by session session-1 at',
    );
    expect(text).toContain('## Open questions (0)\nNone.');
    expect(text).toContain('  Answer: No.');
    expect(text).toContain('  Retired because: We dropped nesting.');
    expect(text).toContain('## Answered and retired (2)');
  });

  test('summary_history shows each revision whole with its author', () => {
    const text = renderTaskSummaryHistory({
      task: TASK,
      revisions: [
        summary('second', {
          revision: 2,
          author: { kind: 'person', principalId: 'p' },
        }),
        summary('first'),
      ],
      total: 2,
    });
    expect(text).toContain('The newest 2 of 2 revisions, newest first.');
    expect(text).toContain(
      '## Revision 2, by person p at 2026-10-21T12:34:56Z\nsecond',
    );
    expect(text.indexOf('Revision 2')).toBeLessThan(text.indexOf('Revision 1'));
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
