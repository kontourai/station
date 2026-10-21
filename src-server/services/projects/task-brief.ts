/**
 * The Task brief (epic #4003, docs/design/tracker-backed-tasks.md "Session
 * brief"): a digest-pinned snapshot of a Task's shared memory that a Session
 * dispatched for the Task receives with its first turn, and that
 * `get_task_brief` returns on demand.
 *
 * Pure: no I/O. The caller gathers the Task record, the shared Task document,
 * the other Sessions and a fresh tracker observation; this
 * module parses the memory sections, fits everything into one bound and
 * renders the text an engine reads.
 */
import { createHash } from 'node:crypto';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type { WorkItemObservationResult } from '@kontourai/station-contracts/work-item-provider';
import { TRACKER_GUIDANCE } from './task-brief-tracker-guidance.js';

export const TASK_BRIEF_VERSION = 'station.task-brief/v1' as const;

/**
 * The whole rendered brief is at most this many UTF-16 code units: the same
 * bound the Task-room agent request snapshot puts on the document text
 * (`task-room-context.ts`). That bound refuses an oversized document; this
 * one cuts the memory sections instead, newest first, and says what it left
 * out, because a brief that refuses would leave the Session with nothing.
 */
export const TASK_BRIEF_MAX_CHARS = 16000;

// Per-part caps, so the fixed parts can never crowd the memory sections out
// entirely. Worst case for every fixed part together is about 11k, which
// leaves at least ~4.5k for memory; ordinary Tasks leave far more.
const TITLE_MAX = 512;
const GOAL_MAX = 1000;
const PREAMBLE_MAX = 2500;
const COMMENT_EXCERPT_MAX = 400;
const COMMENTS_MAX = 5;
const LABELS_MAX = 20;
const SESSIONS_MAX = 12;
const ENTRY_MAX = 1500;

/**
 * What the brief knows about the linked item. `not-read` is the brief's own
 * outcome: the read threw or timed out.
 */
export type TaskBriefObservation =
  | WorkItemObservationResult
  | { status: 'not-read'; reason: string };

export const TASK_MEMORY_SECTIONS = [
  { key: 'decisions', heading: 'Decisions' },
  { key: 'done', heading: 'Done' },
  { key: 'inProgress', heading: 'In progress' },
  { key: 'openQuestions', heading: 'Open questions' },
] as const;
export type TaskMemorySectionKey = (typeof TASK_MEMORY_SECTIONS)[number]['key'];

export interface ParsedTaskMemory {
  /** Content before the first fixed heading: the seeded brief. */
  preamble: string;
  /** Entries in document order (oldest first, since `task_note` appends). */
  sections: Record<TaskMemorySectionKey, string[]>;
}

export interface TaskBriefSessionLine {
  sessionId: string;
  provider?: string;
  /** The Session's status word (`running`, `ready`, `closed`, …). */
  status?: string;
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
  document:
    | { kind: 'available'; revision: string; text: string }
    | { kind: 'unavailable'; reason: string };
  /** Other Sessions in this Task; the receiving Session is excluded. */
  sessions: readonly TaskBriefSessionLine[];
  /** Required when the Task has a `workItemRef`; ignored otherwise. */
  observation?: TaskBriefObservation;
}

export interface TaskBriefSnapshot {
  version: typeof TASK_BRIEF_VERSION;
  digest: string;
  taskId: string;
  projectId: string;
  title: string;
  /** `null` when the Task document could not be read. */
  documentRevision: string | null;
  /** Memory entries the bound left out, per section. */
  omitted: Record<TaskMemorySectionKey, number>;
  /** The rendered brief an engine reads; at most `TASK_BRIEF_MAX_CHARS`. */
  text: string;
}

const HEADING_TO_KEY = new Map<string, TaskMemorySectionKey>(
  TASK_MEMORY_SECTIONS.map(({ key, heading }) => [heading.toLowerCase(), key]),
);
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;

/**
 * Split the Task document into its preamble and the four fixed sections. A
 * section runs to the next level-1 or level-2 heading; text under any other
 * level-2 heading is not memory and is left out. An entry is a top-level list
 * item with its continuation lines, or a paragraph.
 */
export function parseTaskMemory(text: string): ParsedTaskMemory {
  const sections: Record<TaskMemorySectionKey, string[]> = {
    decisions: [],
    done: [],
    inProgress: [],
    openQuestions: [],
  };
  const preamble: string[] = [];
  let current: TaskMemorySectionKey | 'preamble' | 'other' = 'preamble';
  let entries: string[][] = [];
  const flush = () => {
    if (current !== 'preamble' && current !== 'other') {
      for (const lines of entries) {
        const entry = lines.join('\n').trim();
        if (entry) sections[current].push(entry);
      }
    }
    entries = [];
  };
  let blank = true;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^(#{1,2})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const key = HEADING_TO_KEY.get(heading[2]!.toLowerCase());
      if (key) current = key;
      // Headings before the first fixed one (a document title, the seeded
      // brief's own headings) stay part of the preamble.
      else if (current === 'preamble') preamble.push(line);
      else current = 'other';
      blank = true;
      continue;
    }
    if (current === 'preamble') {
      preamble.push(line);
      continue;
    }
    if (current === 'other') continue;
    if (!line.trim()) {
      blank = true;
      continue;
    }
    if (LIST_ITEM.test(line) || blank || entries.length === 0)
      entries.push([line]);
    else entries.at(-1)!.push(line);
    blank = false;
  }
  flush();
  return { preamble: preamble.join('\n').trim(), sections };
}

function cut(value: string, max: number, marker = ' …(cut)'): string {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The fixed rules, inline because Codex has no skill channel. The memory rule
 * applies to every Task; the two tracker rules only to a Task with a linked
 * work item, so a Station-only Task's brief says nothing about a tracker.
 */
export const TASK_BRIEF_MEMORY_RULE =
  'Record decisions, completed work and open questions in the Task memory with the `task_note` Station Control tool.';
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
    `Labels: ${labels.length ? labels.join(', ') : 'none'}${item.labels.length > LABELS_MAX ? ` (and ${item.labels.length - LABELS_MAX} more)` : ''}`,
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
      lines.push(`(${comments.length - COMMENTS_MAX} older comments left out)`);
  } else lines.push('No newer comments.');
  return lines;
}

function renderSessions(sessions: readonly TaskBriefSessionLine[]): string[] {
  const lines = ['## Other Sessions in this Task'];
  if (!sessions.length) return [...lines, 'None.'];
  for (const session of sessions.slice(0, SESSIONS_MAX))
    lines.push(
      `- ${cut(oneLine(session.sessionId), 128)}${session.provider ? ` (${cut(oneLine(session.provider), 32)})` : ''}: ${session.status ? cut(oneLine(session.status), 32) : 'status unknown'}`,
    );
  if (sessions.length > SESSIONS_MAX)
    lines.push(`(and ${sessions.length - SESSIONS_MAX} more)`);
  return lines;
}

/**
 * Take memory entries newest first, round-robin across the four sections so
 * each section keeps its newest entries, until the budget is spent. Within a
 * section the first entry that does not fit stops that section, so what is
 * shown is always a contiguous newest run.
 */
function fitMemory(
  sections: ParsedTaskMemory['sections'],
  budget: number,
): {
  kept: Record<TaskMemorySectionKey, string[]>;
  omitted: Record<TaskMemorySectionKey, number>;
} {
  const queues = Object.fromEntries(
    TASK_MEMORY_SECTIONS.map(({ key }) => [
      key,
      [...sections[key]].reverse().map((entry) => cut(entry, ENTRY_MAX)),
    ]),
  ) as Record<TaskMemorySectionKey, string[]>;
  const kept: Record<TaskMemorySectionKey, string[]> = {
    decisions: [],
    done: [],
    inProgress: [],
    openQuestions: [],
  };
  const stopped = new Set<TaskMemorySectionKey>();
  let remaining = budget;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const { key } of TASK_MEMORY_SECTIONS) {
      if (stopped.has(key)) continue;
      const next = queues[key][kept[key].length];
      if (next === undefined) {
        stopped.add(key);
        continue;
      }
      const cost = next.length + 1;
      if (cost > remaining) {
        stopped.add(key);
        continue;
      }
      kept[key].push(next);
      remaining -= cost;
      progressed = true;
    }
  }
  const omitted = Object.fromEntries(
    TASK_MEMORY_SECTIONS.map(({ key }) => [
      key,
      sections[key].length - kept[key].length,
    ]),
  ) as Record<TaskMemorySectionKey, number>;
  return { kept, omitted };
}

function omissionLine(count: number): string {
  return `(${count} older ${count === 1 ? 'entry' : 'entries'} left out; call \`get_task_brief\` or open the Task document for the rest)`;
}

// The longest omission line, reserved per section before memory is fitted.
const OMISSION_RESERVE = omissionLine(999_999).length + 1;

export function buildTaskBrief(input: TaskBriefInput): TaskBriefSnapshot {
  const { task } = input;
  const title = cut(oneLine(task.title), TITLE_MAX);
  const documentRevision =
    input.document.kind === 'available' ? input.document.revision : null;
  const memory =
    input.document.kind === 'available'
      ? parseTaskMemory(input.document.text)
      : undefined;
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
    workItemRef: task.workItemRef ?? null,
    sourceProvider: task.sourceProvider ?? null,
    observation: observation ?? null,
    sessions: input.sessions,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify([...scope, digestInput]))
    .digest('hex');

  const head = [
    `# Station Task brief (${TASK_BRIEF_VERSION}, digest ${digest.slice(0, 16)})`,
    'Context Station attached for this Session. It is a snapshot taken when the Session was dispatched; call `get_task_brief` for the current memory.',
    '',
    `Task: ${title}`,
    `Task id: ${task.id}`,
    `Task document revision: ${documentRevision ?? `unavailable (${cut(oneLine(input.document.kind === 'unavailable' ? input.document.reason : ''), 160)})`}`,
    ...(task.description.trim()
      ? [`Goal: ${cut(oneLine(task.description), GOAL_MAX)}`]
      : []),
  ];
  const workItem = renderWorkItem(task, observation);
  const sessions = renderSessions(input.sessions);
  const preamble = memory?.preamble
    ? ['## Task document brief', cut(memory.preamble, PREAMBLE_MAX)]
    : [];
  const rules = [
    '## Rules',
    ...[
      TASK_BRIEF_MEMORY_RULE,
      ...(task.workItemRef ? TASK_BRIEF_TRACKER_RULES : []),
    ].map((rule, index) => `${index + 1}. ${rule}`),
  ];
  const guidance = task.workItemRef
    ? ['## Tracker guidance', TRACKER_GUIDANCE]
    : [];
  const footer = ['End of Station Task brief.'];

  const block = (lines: string[]) =>
    lines.length ? `${lines.join('\n')}\n\n` : '';
  const fixed =
    block(head) +
    block(workItem) +
    block(sessions) +
    block(preamble) +
    block(rules) +
    block(guidance) +
    footer.join('\n');
  // The memory part's own scaffolding: four headings and, at worst, four
  // omission lines, plus the block separators.
  const scaffolding = TASK_MEMORY_SECTIONS.reduce(
    (sum, { heading }) =>
      sum + `## ${heading} (newest first)\n`.length + OMISSION_RESERVE + 2,
    0,
  );
  const budget = Math.max(0, TASK_BRIEF_MAX_CHARS - fixed.length - scaffolding);

  let memoryText = '';
  let omitted: Record<TaskMemorySectionKey, number> = {
    decisions: 0,
    done: 0,
    inProgress: 0,
    openQuestions: 0,
  };
  if (memory) {
    const fitted = fitMemory(memory.sections, budget);
    omitted = fitted.omitted;
    memoryText = TASK_MEMORY_SECTIONS.map(({ key, heading }) =>
      block([
        `## ${heading} (newest first)`,
        ...(fitted.kept[key].length || fitted.omitted[key]
          ? fitted.kept[key]
          : ['Nothing recorded.']),
        ...(fitted.omitted[key] ? [omissionLine(fitted.omitted[key])] : []),
      ]),
    ).join('');
  } else {
    memoryText = block([
      '## Task memory',
      'The Task document could not be read, so the memory sections are missing from this brief.',
    ]);
  }

  // Memory sits after the work item and Sessions, before the rules.
  const text =
    block(head) +
    block(workItem) +
    block(sessions) +
    block(preamble) +
    memoryText +
    block(rules) +
    block(guidance) +
    footer.join('\n');
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
    omitted: Object.freeze({ ...omitted }),
    text,
  });
}
