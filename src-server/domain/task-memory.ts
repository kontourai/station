/**
 * Task memory (#4003, docs/design/tracker-backed-tasks.md "Task memory"): the
 * four fixed sections of a Task document and the text edits `task_note`
 * makes to them.
 *
 * Pure text planning only. The edits are applied by the Task room through its
 * shared working-state write path (`ProjectTaskRoomRuntime.appendTaskNote`),
 * which turns each one into exact atom operations and settles them with the
 * room's convergence and revision history.
 *
 * Every edit this module plans is one contiguous range: an insertion, or the
 * replacement of exactly one line the calling Session wrote. It never plans a
 * change to any other text.
 */

export type TaskNoteSection = 'decision' | 'done' | 'in_progress' | 'question';

export const TASK_NOTE_SECTIONS: readonly TaskNoteSection[] = [
  'decision',
  'done',
  'in_progress',
  'question',
];

/** The fixed headings, in document order. */
export const TASK_MEMORY_HEADINGS: Readonly<Record<TaskNoteSection, string>> = {
  decision: '## Decisions',
  done: '## Done',
  in_progress: '## In progress',
  question: '## Open questions',
};

/** One entry's text, in UTF-16 code units. Longer text is refused, never cut. */
export const TASK_NOTE_MAX_TEXT_LENGTH = 2000;

const SKELETON = TASK_NOTE_SECTIONS.map(
  (section) => TASK_MEMORY_HEADINGS[section],
).join('\n\n');

/**
 * The initial Task document: the brief, then the four memory sections.
 * An empty brief yields the sections alone.
 */
export function taskDocumentSeedText(brief: string): string {
  const head = brief.trimEnd();
  return head ? `${head}\n\n${SKELETON}\n` : `${SKELETON}\n`;
}

export type TaskNoteTextRefusal =
  | { readonly kind: 'empty' }
  | { readonly kind: 'multiline' }
  | {
      readonly kind: 'too-long';
      readonly limit: number;
      readonly length: number;
    };

/** The text refusal, or undefined when the text can be recorded as given. */
export function taskNoteTextRefusal(
  text: string,
): TaskNoteTextRefusal | undefined {
  if (text.trim().length === 0) return { kind: 'empty' };
  if (/[\r\n\u2028\u2029]/.test(text)) return { kind: 'multiline' };
  if (text.length > TASK_NOTE_MAX_TEXT_LENGTH)
    return {
      kind: 'too-long',
      limit: TASK_NOTE_MAX_TEXT_LENGTH,
      length: text.length,
    };
  return undefined;
}

/** Session identities are embedded in a line, so only a closed alphabet is. */
export function isTaskNoteSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._:@-]{1,256}$/.test(sessionId);
}

function entryPrefix(sessionId: string): string {
  return `- [session ${sessionId}, `;
}

/** `- [session <id>, <time>] <text>`: the authoring Session and the time. */
export function taskNoteEntry(input: {
  readonly sessionId: string;
  readonly at: Date;
  readonly text: string;
}): string {
  const at = input.at.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${entryPrefix(input.sessionId)}${at}] ${input.text.trim()}`;
}

/** One contiguous edit of the current text. */
export interface TaskMemoryEdit {
  /** UTF-16 offsets into the text this edit applies to. */
  readonly start: number;
  readonly end: number;
  readonly insert: string;
}

interface Line {
  readonly start: number;
  /** Offset of the line break, or the text length for the last line. */
  readonly end: number;
  readonly text: string;
}

function lines(text: string): Line[] {
  const result: Line[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    result.push({ start, end, text: text.slice(start, end) });
    if (newline === -1) return result;
    start = newline + 1;
  }
}

function normalizedHeading(line: string): string {
  return line.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Line index of each fixed heading (the first, when a person repeated one),
 * outside fenced code. A section ends at the next level-1 or level-2 heading.
 */
function sectionLayout(all: readonly Line[]) {
  const headings = new Map<TaskNoteSection, number>();
  const boundaries: number[] = [];
  let fence: string | undefined;
  for (const [index, line] of all.entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^\s{0,3}#{1,2}(\s|$)/.test(line.text)) boundaries.push(index);
    const heading = normalizedHeading(line.text);
    for (const section of TASK_NOTE_SECTIONS)
      if (
        !headings.has(section) &&
        heading === TASK_MEMORY_HEADINGS[section].toLowerCase()
      )
        headings.set(section, index);
  }
  return { headings, boundaries };
}

/**
 * The edit that adds every missing fixed heading, at the end of the document
 * (an insertion only: existing text is never reordered). Undefined when all
 * four are present.
 */
export function planMissingTaskMemoryHeadings(
  text: string,
): TaskMemoryEdit | undefined {
  const { headings } = sectionLayout(lines(text));
  const missing = TASK_NOTE_SECTIONS.filter(
    (section) => !headings.has(section),
  );
  if (missing.length === 0) return undefined;
  const block = missing
    .map((section) => TASK_MEMORY_HEADINGS[section])
    .join('\n\n');
  const separator =
    text.length === 0 || text.endsWith('\n\n')
      ? ''
      : text.endsWith('\n')
        ? '\n'
        : '\n\n';
  return {
    start: text.length,
    end: text.length,
    insert: `${separator}${block}\n`,
  };
}

/**
 * The edit that records one entry, given a text where the section's heading
 * exists (apply `planMissingTaskMemoryHeadings` first). An `in_progress`
 * entry replaces the calling Session's own line in that section; every other
 * entry is inserted after the section's last non-blank line.
 */
export function planTaskNoteEntry(
  text: string,
  input: {
    readonly section: TaskNoteSection;
    readonly sessionId: string;
    readonly entry: string;
  },
): (TaskMemoryEdit & { readonly replaced: boolean }) | undefined {
  const all = lines(text);
  const { headings, boundaries } = sectionLayout(all);
  const headingIndex = headings.get(input.section);
  if (headingIndex === undefined) return undefined;
  const endIndex =
    boundaries.find((index) => index > headingIndex) ?? all.length;
  const body = all.slice(headingIndex + 1, endIndex);
  if (input.section === 'in_progress') {
    const prefix = entryPrefix(input.sessionId);
    const own = body.find((line) => line.text.startsWith(prefix));
    if (own)
      return {
        start: own.start,
        end: own.end,
        insert: input.entry,
        replaced: true,
      };
  }
  const last = [...body].reverse().find((line) => line.text.trim() !== '');
  if (last)
    return {
      start: last.end,
      end: last.end,
      insert: `\n${input.entry}`,
      replaced: false,
    };
  const heading = all[headingIndex]!;
  return {
    start: heading.end,
    end: heading.end,
    insert: `\n\n${input.entry}`,
    replaced: false,
  };
}

export function applyTaskMemoryEdit(
  text: string,
  edit: TaskMemoryEdit,
): string {
  return `${text.slice(0, edit.start)}${edit.insert}${text.slice(edit.end)}`;
}
