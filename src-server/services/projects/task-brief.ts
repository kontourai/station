/**
 * The Task brief (epic #4003, docs/design/tracker-backed-tasks.md "Session
 * brief"): a digest-pinned snapshot that a Session dispatched for a Task
 * receives with its first turn, and that `get_task_brief` returns on demand.
 *
 * It composes two layers, in this order:
 * 1. the Task and its observed work item (facts Station read);
 * 2. the Task summary, in full (judgment: agents and people rewrite it);
 * 3. standing decisions, 4. open questions, 5. recent dead ends (judgment:
 *    keyed Task records; `on_topic` ones are only counted);
 * 6. a compact line per Session of the Task, from the same recorded facts
 *    `get_session_digest` and `list_project_activity` report (derived, never
 *    agent-written);
 * 7. what was left out, naming the tool that fetches it.
 *
 * Pure: no I/O. The caller gathers the Task record, the Task document (the
 * person-authored brief it was seeded with), Task memory, the Sessions'
 * digest facts and a fresh tracker observation; this module fits everything
 * into one bound and renders the text an engine reads. The document is
 * shown as written: nothing here parses memory out of it.
 */
import { createHash } from 'node:crypto';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  isLiveTaskRecord,
  TASK_MEMORY_LIMITS,
  type TaskMemoryAuthor,
  type TaskMemoryRecord,
  type TaskRecordKind,
  type TaskSummaryRevision,
} from '@kontourai/station-contracts/task-memory';
import type { WorkItemObservationResult } from '@kontourai/station-contracts/work-item-provider';
import type { DigestTurn } from '../orchestration/session-digest.js';
import { TRACKER_GUIDANCE } from './task-brief-tracker-guidance.js';

export const TASK_BRIEF_VERSION = 'station.task-brief/v1' as const;

/**
 * The whole rendered brief is at most this many UTF-16 code units: the same
 * bound the Task-room agent request snapshot puts on the document text
 * (`task-room-context.ts`). That bound refuses an oversized document; this
 * one leaves out the oldest records and Sessions instead and says how many,
 * because a brief that refuses would leave the Session with nothing.
 */
export const TASK_BRIEF_MAX_CHARS = 16000;

// Per-part caps, so the fixed parts can never crowd the records out
// entirely. The summary is shown whole (its own cap is a write-time
// refusal), so two caps are new with it: the labels line, and a smaller
// share for the Task document once a summary exists. Every fixed part at
// its worst, with a full summary, leaves about 1.8k for records and
// Sessions: the newest record always fits (task-brief.test.ts).
const TITLE_MAX = 512;
const GOAL_MAX = 1000;
/** The Task document's text: the seeded brief, before any summary exists. */
const DOCUMENT_MAX = 2500;
/** Once a summary exists it carries what is true now; the seed matters less. */
const DOCUMENT_WITH_SUMMARY_MAX = 800;
const COMMENT_EXCERPT_MAX = 400;
const COMMENTS_MAX = 5;
const LABELS_MAX = 20;
const LABELS_LINE_MAX = 400;
const SESSIONS_MAX = 8;
const SESSION_LINE_MAX = 360;
const RECORD_LINE_MAX = TASK_MEMORY_LIMITS.recordTextChars + 160;

/** The listings `get_task_brief` returns when asked for more than the brief. */
export const TASK_BRIEF_INCLUDES = ['all_records', 'summary_history'] as const;
export type TaskBriefInclude = (typeof TASK_BRIEF_INCLUDES)[number];
/** Summary revisions the history listing shows, newest first. */
export const TASK_BRIEF_SUMMARY_HISTORY_REVISIONS = 10;
/**
 * The record listing's bound. Every live record always fits (90 at 1000
 * characters plus their lines is about 105k); answered and retired records
 * fill what is left, newest first, and the rest are counted.
 */
const LISTING_MAX_CHARS = 120_000;

/**
 * What the brief knows about the linked item. `not-read` is the brief's own
 * outcome: the read threw or timed out.
 */
export type TaskBriefObservation =
  | WorkItemObservationResult
  | { status: 'not-read'; reason: string };

/**
 * One Session of the Task, from recorded facts only: the status word
 * `list_project_activity` reports and the newest turn of its
 * `get_session_digest` digest.
 */
export interface TaskBriefSessionFacts {
  sessionId: string;
  provider?: string;
  /** The ladder word (`Running`, `Needs answer`, `Done`, …). */
  status?: string;
  /** Turns the Session's digest counts. */
  turnCount?: number;
  /** The newest turn's digest. */
  lastTurn?: DigestTurn;
  /** The Session receiving this brief. */
  self?: boolean;
  /** When this Session was dispatched for the Task. */
  createdAt: string;
}

export interface TaskBriefMemory {
  summary?: TaskSummaryRevision;
  /** Every key's newest version, any state. */
  records: readonly TaskMemoryRecord[];
}

export interface TaskBriefInput {
  task: Pick<
    TaskRecord,
    | 'id'
    | 'projectId'
    | 'createdAt'
    | 'title'
    | 'description'
    | 'sourceProvider'
    | 'workItemRef'
  >;
  /** The Task room document: the person-authored brief it was seeded with. */
  document:
    | { kind: 'available'; revision: string; text: string }
    | { kind: 'unavailable'; reason: string };
  memory:
    | ({ kind: 'available' } & TaskBriefMemory)
    | { kind: 'unavailable'; reason: string };
  /** Every Session dispatched for the Task, the receiving one included. */
  sessions: readonly TaskBriefSessionFacts[];
  /** Required when the Task has a `workItemRef`; ignored otherwise. */
  observation?: TaskBriefObservation;
}

/** What the brief counted instead of showing. */
export interface TaskBriefOmissions {
  /** Standing live records the bound left out, per kind. */
  standing: Record<TaskRecordKind, number>;
  /** Live `on_topic` records, per kind: counted, never shown. */
  onTopic: Record<TaskRecordKind, number>;
  answeredQuestions: number;
  retiredRecords: number;
  /** Sessions past the cap or the bound. */
  sessions: number;
}

export interface TaskBriefSnapshot {
  version: typeof TASK_BRIEF_VERSION;
  digest: string;
  taskId: string;
  projectId: string;
  title: string;
  /** `null` when the Task document could not be read. */
  documentRevision: string | null;
  /** `null` when there is no summary or memory could not be read. */
  summaryRevision: number | null;
  omitted: TaskBriefOmissions;
  /** The rendered brief an engine reads; at most `TASK_BRIEF_MAX_CHARS`. */
  text: string;
}

function cut(value: string, max: number, marker = ' …(cut)'): string {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** UTC to the second: `2026-10-21T12:34:56Z`. */
function stamp(iso: string): string {
  return cut(oneLine(iso), 64).replace(/\.\d+Z$/, 'Z');
}

function authorWords(author: TaskMemoryAuthor): string {
  return author.kind === 'session'
    ? `session ${cut(oneLine(author.sessionId), 128)}`
    : `person ${cut(oneLine(author.principalId), 128)}`;
}

/**
 * The fixed rules, inline because Codex has no skill channel. The memory
 * rules apply to every Task; the two tracker rules only to a Task with a
 * linked work item, so a Station-only Task's brief says nothing about a
 * tracker.
 */
export const TASK_BRIEF_MEMORY_RULES = [
  'Keep the Task summary current with `task_summary_update`: at milestones and before you stop, rewrite it as a short runbook of what is true now, what works, what is next and what is risky. Pass the revision you read as `baseRevision`; if someone changed it since, merge into the current text and write again.',
  'Record decisions, open questions for a person, and dead ends (approaches that failed, and why) with `task_record`, under a short key. Set the same key to supersede a record; retire one that no longer holds.',
] as const;
export const TASK_BRIEF_TRACKER_RULES = [
  'Post to the tracker item only at a milestone.',
  'Never close the tracker item; the merged pull request closes it.',
] as const;

function renderWorkItem(
  task: TaskBriefInput['task'],
  observation: TaskBriefObservation | undefined,
): string[] {
  if (!task.workItemRef) return [];
  const lines = [
    '## Linked work item',
    `${cut(oneLine(task.workItemRef), 256)}${task.sourceProvider ? ` (${cut(oneLine(task.sourceProvider), 64)})` : ''}`,
  ];
  if (observation?.status !== 'observed') {
    const status = observation?.status ?? 'not-read';
    const reason = observation ? cut(oneLine(observation.reason), 240) : '';
    lines.push(
      `linked item not re-read: ${status}${reason ? ` (${reason})` : ''}`,
    );
    return lines;
  }
  const item = observation.observation;
  const labels = item.labels
    .slice(0, LABELS_MAX)
    .map((label) => cut(oneLine(label), 64));
  lines.push(
    `Title: ${cut(oneLine(item.title), TITLE_MAX)}`,
    `State: ${item.state}${item.stateReason ? ` (${cut(oneLine(item.stateReason), 64)})` : ''}`,
    cut(
      `Labels: ${labels.length ? labels.join(', ') : 'none'}${item.labels.length > LABELS_MAX ? ` (and ${item.labels.length - LABELS_MAX} more)` : ''}`,
      LABELS_LINE_MAX,
    ),
    `URL: ${cut(oneLine(item.url), 512)}`,
    `Updated: ${cut(oneLine(item.updatedAt), 64)}; read at ${cut(oneLine(item.observedAt), 64)}`,
  );
  const comments = [...(item.comments ?? [])].reverse();
  if (comments.length) {
    lines.push('Newer comments, newest first:');
    for (const comment of comments.slice(0, COMMENTS_MAX))
      lines.push(
        `- ${cut(oneLine(comment.author), 64)} (${cut(oneLine(comment.createdAt), 64)}): ${cut(oneLine(comment.excerpt), COMMENT_EXCERPT_MAX)}`,
      );
    if (comments.length > COMMENTS_MAX)
      lines.push(
        `(${comments.length - COMMENTS_MAX} older comments left out; read the item for them)`,
      );
  } else lines.push('No newer comments.');
  return lines;
}

function renderSummary(memory: TaskBriefInput['memory']): string[] {
  if (memory.kind === 'unavailable')
    return [
      '## Task summary',
      `The Task memory could not be read (${cut(oneLine(memory.reason), 160)}), so the summary and records are missing from this brief. Call \`get_task_brief\` again before relying on them.`,
    ];
  const summary = memory.summary;
  if (!summary)
    return [
      '## Task summary',
      'No summary yet. Write the first one with `task_summary_update` and `baseRevision` 0.',
    ];
  return [
    `## Task summary (revision ${summary.revision}, by ${authorWords(summary.author)} at ${stamp(summary.createdAt)})`,
    // Whole: the summary's cap is a refusal at write time, never a cut here.
    summary.text.trim(),
  ];
}

function recordLine(record: TaskMemoryRecord): string {
  const asked =
    record.kind === 'question'
      ? ` (asked by ${authorWords(record.author)})`
      : '';
  return cut(
    `- \`${record.key}\`: ${oneLine(record.text)}${asked}`,
    RECORD_LINE_MAX,
  );
}

const RECORD_SECTIONS = [
  { kind: 'decision', heading: '## Standing decisions (newest first)' },
  {
    kind: 'question',
    heading: '## Open questions for a person (newest first)',
  },
  { kind: 'dead_end', heading: '## Recent dead ends (newest first)' },
] as const satisfies readonly { kind: TaskRecordKind; heading: string }[];

/**
 * Take standing live records newest first, round-robin across the three
 * kinds so each keeps its newest, until the budget is spent. Within a kind
 * the first record that does not fit stops that kind, so what is shown is
 * always a contiguous newest run.
 */
function fitRecords(
  queues: Record<TaskRecordKind, string[]>,
  budget: number,
): { kept: Record<TaskRecordKind, string[]>; remaining: number } {
  const kept: Record<TaskRecordKind, string[]> = {
    decision: [],
    question: [],
    dead_end: [],
  };
  const stopped = new Set<TaskRecordKind>();
  let remaining = budget;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const { kind } of RECORD_SECTIONS) {
      if (stopped.has(kind)) continue;
      const next = queues[kind][kept[kind].length];
      const cost = next === undefined ? 0 : next.length + 1;
      if (next === undefined || cost > remaining) {
        stopped.add(kind);
        continue;
      }
      kept[kind].push(next);
      remaining -= cost;
      progressed = true;
    }
  }
  return { kept, remaining };
}

function sessionLine(session: TaskBriefSessionFacts): string {
  const who = [
    session.provider ? cut(oneLine(session.provider), 32) : undefined,
    session.self ? 'this session' : undefined,
  ].filter(Boolean);
  const parts = [
    session.status ? cut(oneLine(session.status), 32) : 'status unknown',
  ];
  if (session.turnCount !== undefined)
    parts.push(
      `${session.turnCount} ${session.turnCount === 1 ? 'turn' : 'turns'}`,
    );
  const turn = session.lastTurn;
  if (turn) {
    parts.push(
      `last turn ${turn.outcome}${turn.request ? `: "${oneLine(turn.request)}${turn.requestClipped ? '…' : ''}"` : ''}`,
    );
    if (turn.filesTotal) parts.push(`${turn.filesTotal} files changed`);
    const pr = turn.pullRequests?.[0];
    if (pr)
      parts.push(
        `PR ${pr.repository}#${pr.ref}${(turn.pullRequestsTotal ?? 1) > 1 ? ` (+${(turn.pullRequestsTotal ?? 1) - 1})` : ''}`,
      );
  }
  return cut(
    `- ${cut(oneLine(session.sessionId), 128)}${who.length ? ` (${who.join(', ')})` : ''}: ${parts.join('; ')}`,
    SESSION_LINE_MAX,
  );
}

/** Newest activity first: the last turn's start, else the dispatch time. */
function bySessionActivity(
  left: TaskBriefSessionFacts,
  right: TaskBriefSessionFacts,
): number {
  const at = (session: TaskBriefSessionFacts) =>
    session.lastTurn?.startedAt ?? session.createdAt;
  return at(right).localeCompare(at(left));
}

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

const KIND_WORDS: Record<TaskRecordKind, [string, string]> = {
  decision: ['decision', 'decisions'],
  question: ['open question', 'open questions'],
  dead_end: ['dead end', 'dead ends'],
};

function kindCounts(counts: Record<TaskRecordKind, number>): string {
  return RECORD_SECTIONS.filter(({ kind }) => counts[kind] > 0)
    .map(({ kind }) => count(counts[kind], ...KIND_WORDS[kind]))
    .join(', ');
}

const ALL_RECORDS_CALL = 'call `get_task_brief` with `include: "all_records"`';

function omissionLines(
  omitted: TaskBriefOmissions,
  summaryRevision: number | null,
): string[] {
  const lines: string[] = [];
  const standing = kindCounts(omitted.standing);
  if (standing)
    lines.push(
      `- Standing records that did not fit: ${standing}; ${ALL_RECORDS_CALL}.`,
    );
  const onTopic = kindCounts(omitted.onTopic);
  if (onTopic)
    lines.push(
      `- On-topic records, counted only: ${onTopic}; ${ALL_RECORDS_CALL}.`,
    );
  if (omitted.answeredQuestions || omitted.retiredRecords)
    lines.push(
      `- History: ${count(omitted.answeredQuestions, 'answered question', 'answered questions')} and ${count(omitted.retiredRecords, 'retired record', 'retired records')}; ${ALL_RECORDS_CALL}.`,
    );
  if (summaryRevision !== null && summaryRevision > 1)
    lines.push(
      `- ${count(summaryRevision - 1, 'earlier summary revision', 'earlier summary revisions')}; call \`get_task_brief\` with \`include: "summary_history"\`.`,
    );
  if (omitted.sessions)
    lines.push(
      `- ${count(omitted.sessions, 'more Session', 'more Sessions')} of this Task; call \`list_project_activity\`, or \`get_session_digest\` with a Session id.`,
    );
  return lines;
}

// The longest omission section, reserved before records are fitted.
const OMISSION_RESERVE =
  [
    '## Not in this brief',
    ...omissionLines(
      {
        standing: { decision: 99_999, question: 99_999, dead_end: 99_999 },
        onTopic: { decision: 99_999, question: 99_999, dead_end: 99_999 },
        answeredQuestions: 99_999,
        retiredRecords: 99_999,
        sessions: 99_999,
      },
      99_999,
    ),
  ].join('\n').length + 2;

const block = (lines: readonly string[]) =>
  lines.length ? `${lines.join('\n')}\n\n` : '';

export function buildTaskBrief(input: TaskBriefInput): TaskBriefSnapshot {
  const { task } = input;
  const title = cut(oneLine(task.title), TITLE_MAX);
  const documentRevision =
    input.document.kind === 'available' ? input.document.revision : null;
  const memory = input.memory.kind === 'available' ? input.memory : undefined;
  const summaryRevision = memory?.summary?.revision ?? null;
  const observation = task.workItemRef
    ? (input.observation ?? {
        status: 'not-read' as const,
        reason: 'no tracker read was made',
      })
    : undefined;

  const scope = [
    TASK_BRIEF_VERSION,
    task.projectId,
    task.id,
    task.createdAt,
  ] as const;
  const digestInput = {
    title,
    description: task.description,
    documentRevision,
    documentText:
      input.document.kind === 'available' ? input.document.text : null,
    documentUnavailable:
      input.document.kind === 'unavailable' ? input.document.reason : null,
    summary: memory?.summary
      ? [memory.summary.revision, memory.summary.text]
      : null,
    records: memory
      ? memory.records.map((record) => [
          record.kind,
          record.key,
          record.version,
        ])
      : {
          unavailable:
            input.memory.kind === 'unavailable' ? input.memory.reason : '',
        },
    workItemRef: task.workItemRef ?? null,
    sourceProvider: task.sourceProvider ?? null,
    observation: observation ?? null,
    sessions: input.sessions,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify([...scope, digestInput]))
    .digest('hex');

  // 1. The Task and its observed work item.
  const head = [
    `# Station Task brief (${TASK_BRIEF_VERSION}, digest ${digest.slice(0, 16)})`,
    'Context Station attached for this Session, built from the Task as it stood when this brief was made (at dispatch, or by a `get_task_brief` call). It does not update itself; call `get_task_brief` for the current state.',
    '',
    `Task: ${title}`,
    `Task id: ${task.id}`,
    `Task document revision: ${documentRevision ?? `unavailable (${cut(oneLine(input.document.kind === 'unavailable' ? input.document.reason : ''), 160)})`}`,
    ...(task.description.trim()
      ? [`Goal: ${cut(oneLine(task.description), GOAL_MAX)}`]
      : []),
  ];
  const workItem = renderWorkItem(task, observation);
  const documentText =
    input.document.kind === 'available' ? input.document.text.trim() : '';
  const document = documentText
    ? [
        '## Task document',
        cut(
          documentText,
          memory?.summary ? DOCUMENT_WITH_SUMMARY_MAX : DOCUMENT_MAX,
          ' …(cut; the Task document has the rest)',
        ),
      ]
    : [];
  // 2. The summary, whole.
  const summary = renderSummary(input.memory);
  const rules = [
    '## Rules',
    ...[
      ...TASK_BRIEF_MEMORY_RULES,
      ...(task.workItemRef ? TASK_BRIEF_TRACKER_RULES : []),
    ].map((rule, index) => `${index + 1}. ${rule}`),
  ];
  const guidance = task.workItemRef
    ? ['## Tracker guidance', TRACKER_GUIDANCE]
    : [];
  const footer = 'End of Station Task brief.';

  // 3–5. Records: standing live ones are shown newest first, the rest counted.
  const omitted: TaskBriefOmissions = {
    standing: { decision: 0, question: 0, dead_end: 0 },
    onTopic: { decision: 0, question: 0, dead_end: 0 },
    answeredQuestions: 0,
    retiredRecords: 0,
    sessions: 0,
  };
  const standing: Record<TaskRecordKind, TaskMemoryRecord[]> = {
    decision: [],
    question: [],
    dead_end: [],
  };
  for (const record of memory?.records ?? []) {
    if (record.state === 'answered') omitted.answeredQuestions += 1;
    else if (record.state === 'retired') omitted.retiredRecords += 1;
    else if (record.importance === 'on_topic')
      omitted.onTopic[record.kind] += 1;
    else standing[record.kind].push(record);
  }
  const queues = Object.fromEntries(
    RECORD_SECTIONS.map(({ kind }) => [
      kind,
      [...standing[kind]]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(recordLine),
    ]),
  ) as Record<TaskRecordKind, string[]>;

  // 6. Sessions: newest activity first, at most SESSIONS_MAX.
  const sessions = [...input.sessions].sort(bySessionActivity);
  const sessionLines = sessions.slice(0, SESSIONS_MAX).map(sessionLine);

  const sessionsHeading = '## Sessions in this Task (newest activity first)';
  const recordScaffolding = memory
    ? RECORD_SECTIONS.reduce(
        (sum, { heading }) => sum + `${heading}\n`.length + 'None.'.length + 2,
        0,
      )
    : 0;
  const fixed =
    block(head) +
    block(workItem) +
    block(document) +
    block(summary) +
    block(rules) +
    block(guidance) +
    footer;
  const budget = Math.max(
    0,
    TASK_BRIEF_MAX_CHARS -
      fixed.length -
      recordScaffolding -
      (sessionsHeading.length + 'None.'.length + 3) -
      OMISSION_RESERVE,
  );

  const fitted = fitRecords(queues, budget);
  for (const { kind } of RECORD_SECTIONS)
    omitted.standing[kind] = queues[kind].length - fitted.kept[kind].length;
  let sessionBudget = fitted.remaining;
  const shownSessions: string[] = [];
  for (const line of sessionLines) {
    if (line.length + 1 > sessionBudget) break;
    shownSessions.push(line);
    sessionBudget -= line.length + 1;
  }
  omitted.sessions = sessions.length - shownSessions.length;

  const recordsText = memory
    ? RECORD_SECTIONS.map(({ kind, heading }) =>
        block([
          heading,
          ...(fitted.kept[kind].length ? fitted.kept[kind] : ['None.']),
        ]),
      ).join('')
    : '';
  const sessionsText = block([
    sessionsHeading,
    ...(shownSessions.length ? shownSessions : ['None.']),
  ]);
  const omissions = omissionLines(omitted, summaryRevision);
  const omissionText = omissions.length
    ? block(['## Not in this brief', ...omissions])
    : '';

  const text =
    block(head) +
    block(workItem) +
    block(document) +
    block(summary) +
    recordsText +
    sessionsText +
    omissionText +
    block(rules) +
    block(guidance) +
    footer;
  if (text.length > TASK_BRIEF_MAX_CHARS)
    // Unreachable by construction; refuse rather than hand an engine a brief
    // that broke its own bound.
    throw new Error('Task brief exceeded its bound');
  return Object.freeze({
    version: TASK_BRIEF_VERSION,
    digest,
    taskId: task.id,
    projectId: task.projectId,
    title,
    documentRevision,
    summaryRevision,
    omitted,
    text,
  });
}

function recordHistoryLine(record: TaskMemoryRecord): string {
  const parts = [
    `- \`${record.key}\` (${record.importance}, version ${record.version}, ${record.state}, by ${authorWords(record.author)} at ${stamp(record.createdAt)}): ${oneLine(record.text)}`,
  ];
  if (record.answer) parts.push(`  Answer: ${oneLine(record.answer)}`);
  if (record.reason) parts.push(`  Retired because: ${oneLine(record.reason)}`);
  return parts.join('\n');
}

/**
 * Every record of the Task, for `get_task_brief` with `include:
 * "all_records"`: live records (both tiers) first, then answered and
 * retired ones, each newest first. Live records always fit the listing's
 * bound; history fills the rest and is counted past it.
 */
export function renderTaskRecordListing(input: {
  task: Pick<TaskRecord, 'id' | 'title'>;
  records: readonly TaskMemoryRecord[];
}): string {
  const newest = [...input.records].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const lines = [
    `# Task records: ${cut(oneLine(input.task.title), TITLE_MAX)} (${input.task.id})`,
    'Every record with its newest version. Live records first, then answered questions and retired records.',
    '',
  ];
  for (const { kind } of RECORD_SECTIONS) {
    const live = newest.filter(
      (record) => record.kind === kind && isLiveTaskRecord(record),
    );
    lines.push(
      `## ${kind === 'question' ? 'Open questions' : kind === 'decision' ? 'Active decisions' : 'Active dead ends'} (${live.length})`,
      ...(live.length ? live.map(recordHistoryLine) : ['None.']),
      '',
    );
  }
  const history = newest.filter((record) => !isLiveTaskRecord(record));
  lines.push(`## Answered and retired (${history.length})`);
  let length = lines.join('\n').length;
  let shown = 0;
  for (const record of history) {
    const line = recordHistoryLine(record);
    if (length + line.length + 200 > LISTING_MAX_CHARS) break;
    lines.push(line);
    length += line.length + 1;
    shown += 1;
  }
  if (!history.length) lines.push('None.');
  if (shown < history.length)
    lines.push(
      `(${history.length - shown} older answered or retired records left out)`,
    );
  return lines.join('\n');
}

/** The newest summary revisions, for `include: "summary_history"`. */
export function renderTaskSummaryHistory(input: {
  task: Pick<TaskRecord, 'id' | 'title'>;
  revisions: readonly TaskSummaryRevision[];
  total: number;
}): string {
  const lines = [
    `# Task summary history: ${cut(oneLine(input.task.title), TITLE_MAX)} (${input.task.id})`,
    `The newest ${input.revisions.length} of ${input.total} revisions, newest first.`,
    '',
  ];
  if (!input.revisions.length) lines.push('No summary has been written yet.');
  for (const revision of input.revisions)
    lines.push(
      `## Revision ${revision.revision}, by ${authorWords(revision.author)} at ${stamp(revision.createdAt)}`,
      revision.text.trim(),
      '',
    );
  return lines.join('\n').trimEnd();
}
