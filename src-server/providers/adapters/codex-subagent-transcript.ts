import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CHILD_WORK_TRANSCRIPT_ENTRIES_PER_MESSAGE_MAX,
  CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS,
  type ChildWorkTranscriptEntry,
  type ChildWorkTranscriptPage,
  type ChildWorkTranscriptRef,
  cutChildWorkText,
} from '@kontourai/station-contracts/child-work';
import { redactInlineData } from '../model-image-attachments.js';
import {
  createResolvedPathCache,
  directoryEntries,
  isRealDirectory,
  isRealDirectoryChain,
  openTranscriptFile,
  type TranscriptJsonlRecord,
  transcriptJsonlRecords,
} from './transcript-jsonl-file.js';

/**
 * A Codex child thread's own transcript, read from its rollout file.
 *
 * Codex runs a spawned subagent as a thread of its own and writes it, like
 * every thread, to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local time>-
 * <thread id>.jsonl` as it runs, so the transcript reads the same while the
 * child runs and after its app-server is gone. The first record is
 * `session_meta`, whose `payload.id` is the thread id; a file whose
 * `session_meta` names any other thread is not this child's and is refused.
 *
 * Locating it is bounded: thread ids are UUIDv7, so the id's own timestamp
 * names the day directory (Codex dates it in local time; the neighbouring
 * days and the UTC day are tried too). Only when none holds it are the most
 * recent `FALLBACK_DAY_DIRS_MAX` day directories searched. Every directory
 * below the home must be a real one and the file a regular one, as
 * `transcript-jsonl-file.ts` checks; the home itself may be a link.
 *
 * A forked child (`session_meta.forked_from_id` set, as Codex 0.164 spawns
 * one) starts with a copy of its parent's conversation: the parent's
 * `session_meta`, prompt, tool calls and spawn call, then a developer
 * message saying the preceding conversation is inherited parent context.
 * Only the child's own part is mapped: records from the meta's
 * `subagent_history_start_ordinal` on (each record carries its
 * `ordinal`), or, where a build writes no start ordinal, the records after
 * that inherited-context message. A forked rollout with neither boundary
 * maps nothing rather than show the parent's history as the child's.
 *
 * Mapped, in file order, from `response_item` records:
 * - the parent's task (`agent_message`) and real user input as prompt text,
 *   leaving out the context Codex injects as user messages (AGENTS.md,
 *   environment) and every developer message; a task whose payload is
 *   encrypted reads as its header alone, without the empty `Payload:`;
 * - assistant `output_text`;
 * - `function_call` / `custom_tool_call` as tool calls, their `*_output` as
 *   tool results (text blocks only: encrypted content is never shown).
 * Reasoning, events, usage and turn bookkeeping are left out. Bounds are the
 * contract's: `limit` messages a page, a capped number of entries a message,
 * inline image data redacted before every text is cut, and a 4 MiB line cap.
 */

export type CodexThreadTranscriptRef = Extract<
  ChildWorkTranscriptRef,
  { kind: 'codex-thread' }
>;

export type CodexSubagentTranscriptOutcome =
  | { status: 'found'; page: ChildWorkTranscriptPage }
  /** No rollout for this thread under its Codex home. */
  | { status: 'unavailable' };

/** Day directories searched newest-first when the id's own days miss. */
const FALLBACK_DAY_DIRS_MAX = 31;
/** Resolved rollout paths kept per process. */
const RESOLVED_PATHS_MAX = 256;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Context Codex injects as a user message before the task, when the record
 * carries no `content_item_kinds` to say so.
 */
const INJECTED_CONTEXT_PREFIXES = [
  '# AGENTS.md instructions',
  '<environment_context>',
  '<user_instructions>',
  '<permissions instructions>',
  '<skills_instructions>',
];

/** An inter-agent message's `Payload:` label with nothing after it. */
const EMPTY_PAYLOAD_LABEL = /\n?Payload:\s*$/;

/**
 * The developer message a forked child's own part starts after, when the
 * meta names no start ordinal.
 */
const INHERITED_CONTEXT_MARKER =
  'The preceding conversation is inherited parent context';

const resolvedPaths = createResolvedPathCache(RESOLVED_PATHS_MAX);

function bounded(text: string): { text: string; truncated?: true } {
  return cutChildWorkText(
    redactInlineData(text),
    CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function codexHomeOf(ref: CodexThreadTranscriptRef): string {
  if (ref.configHome) return ref.configHome;
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : join(homedir(), '.codex');
}

/** The UUIDv7 timestamp of a thread id, or undefined for another version. */
export function codexThreadIdTime(threadId: string): number | undefined {
  const hex = threadId.replaceAll('-', '');
  if (hex.length !== 32 || hex[12] !== '7') return undefined;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ms) ? ms : undefined;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `[YYYY, MM, DD]` day directories the id's own time can fall in. */
function candidateDays(threadId: string): string[][] {
  const time = codexThreadIdTime(threadId);
  if (time === undefined) return [];
  const days = new Map<string, string[]>();
  for (const at of [time, time - DAY_MS, time + DAY_MS]) {
    const date = new Date(at);
    const local = [
      String(date.getFullYear()),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
    ];
    const utc = [
      String(date.getUTCFullYear()),
      pad(date.getUTCMonth() + 1),
      pad(date.getUTCDate()),
    ];
    days.set(local.join('/'), local);
    days.set(utc.join('/'), utc);
  }
  return [...days.values()];
}

/** The rollout for `threadId` directly in `day`, a real directory. */
async function findInDay(
  day: string,
  threadId: string,
): Promise<string | undefined> {
  const suffix = `-${threadId}.jsonl`;
  for (const entry of await directoryEntries(day)) {
    if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith(suffix)
    ) {
      return join(day, entry.name);
    }
  }
  return undefined;
}

/** Real subdirectories of `directory` whose names are all digits, newest first. */
async function numberedDirectories(directory: string): Promise<string[]> {
  return (await directoryEntries(directory))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b) - Number(a));
}

async function findCodexRollout(
  ref: CodexThreadTranscriptRef,
): Promise<string | undefined> {
  const home = codexHomeOf(ref);
  const sessions = join(home, 'sessions');
  if (!(await isRealDirectory(sessions))) return undefined;
  const tried = new Set<string>();
  for (const [year, month, day] of candidateDays(ref.threadId)) {
    const directory = join(sessions, year, month, day);
    tried.add(directory);
    if (!(await isRealDirectoryChain(home, directory))) continue;
    const found = await findInDay(directory, ref.threadId);
    if (found) return found;
  }
  // Bounded fallback: the most recent day directories, newest first.
  let searched = 0;
  for (const year of await numberedDirectories(sessions)) {
    for (const month of await numberedDirectories(join(sessions, year))) {
      for (const day of await numberedDirectories(
        join(sessions, year, month),
      )) {
        if (searched >= FALLBACK_DAY_DIRS_MAX) return undefined;
        searched += 1;
        const directory = join(sessions, year, month, day);
        if (tried.has(directory)) continue;
        const found = await findInDay(directory, ref.threadId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/** Text of `input_text` / `output_text` blocks; encrypted content is dropped. */
function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const record = asRecord(block);
    return (record?.type === 'input_text' || record?.type === 'output_text') &&
      typeof record.text === 'string' &&
      record.text.length > 0
      ? [record.text]
      : [];
  });
}

/** A user message's own input, without the context Codex injects. */
function userInputTexts(payload: Record<string, unknown>): string[] {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
  const kinds = Array.isArray(metadata?.content_item_kinds)
    ? metadata.content_item_kinds
    : undefined;
  return content.flatMap((block, index) => {
    const record = asRecord(block);
    if (record?.type !== 'input_text' || typeof record.text !== 'string')
      return [];
    const kind = kinds?.[index];
    if (typeof kind === 'string') {
      return kind.startsWith('user.') && record.text ? [record.text] : [];
    }
    const text = record.text;
    return text &&
      !INJECTED_CONTEXT_PREFIXES.some((prefix) => text.startsWith(prefix))
      ? [text]
      : [];
  });
}

function textEntry(
  role: 'user' | 'assistant',
  text: string,
  message: number,
): ChildWorkTranscriptEntry {
  return { message, kind: 'text', role, ...bounded(text) };
}

/** A tool's output: a string, a JSON string, or text blocks. */
function toolOutputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output.length > 0 ? output : undefined;
  const texts = textBlocks(output);
  if (texts.length > 0) return texts.join('\n');
  const record = asRecord(output);
  if (record && typeof record.content === 'string') return record.content;
  return undefined;
}

/** One rollout record as transcript entries; none for what is left out. */
function codexRolloutEntries(
  rolloutRecord: Record<string, unknown>,
  message: number,
): ChildWorkTranscriptEntry[] {
  if (rolloutRecord.type !== 'response_item') return [];
  const payload = asRecord(rolloutRecord.payload);
  if (!payload) return [];
  switch (payload.type) {
    case 'message': {
      if (payload.role === 'assistant')
        return textBlocks(payload.content).map((text) =>
          textEntry('assistant', text, message),
        );
      if (payload.role === 'user')
        return userInputTexts(payload).map((text) =>
          textEntry('user', text, message),
        );
      // Developer and system instructions are not the child's conversation.
      return [];
    }
    case 'agent_message':
      // Another agent's message to this child (the parent's task). Codex
      // 0.164 encrypts the payload and leaves its label empty in the text.
      return textBlocks(payload.content).flatMap((text) => {
        const readable = text.replace(EMPTY_PAYLOAD_LABEL, '');
        return readable ? [textEntry('user', readable, message)] : [];
      });
    case 'function_call':
    case 'custom_tool_call': {
      if (typeof payload.name !== 'string' || payload.name.length === 0)
        return [];
      const name =
        typeof payload.namespace === 'string' && payload.namespace
          ? `${payload.namespace}.${payload.name}`
          : payload.name;
      const input =
        payload.type === 'function_call' ? payload.arguments : payload.input;
      if (typeof input !== 'string' || input.length === 0)
        return [{ message, kind: 'tool-call', name }];
      const cut = bounded(input);
      return [
        {
          message,
          kind: 'tool-call',
          name,
          input: cut.text,
          ...(cut.truncated ? { truncated: true as const } : {}),
        },
      ];
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const text = toolOutputText(payload.output);
      const cut = text === undefined ? undefined : bounded(text);
      const failed =
        payload.success === false ||
        asRecord(payload.output)?.success === false;
      return [
        {
          message,
          kind: 'tool-result',
          ...(cut ? { text: cut.text } : {}),
          ...(cut?.truncated ? { truncated: true as const } : {}),
          ...(failed ? { isError: true as const } : {}),
        },
      ];
    }
    default:
      // Reasoning, and items this build does not know, are left out.
      return [];
  }
}

function capEntries(
  entries: ChildWorkTranscriptEntry[],
  message: number,
): ChildWorkTranscriptEntry[] {
  if (entries.length <= CHILD_WORK_TRANSCRIPT_ENTRIES_PER_MESSAGE_MAX)
    return entries;
  return [
    ...entries.slice(0, CHILD_WORK_TRANSCRIPT_ENTRIES_PER_MESSAGE_MAX),
    {
      message,
      kind: 'omitted',
      count: entries.length - CHILD_WORK_TRANSCRIPT_ENTRIES_PER_MESSAGE_MAX,
    },
  ];
}

/**
 * Where the child's own records start: everywhere for a thread that was not
 * forked, else from an ordinal or after the inherited-context message.
 */
type OwnHistoryStart =
  | { kind: 'whole' }
  | { kind: 'ordinal'; ordinal: number }
  | { kind: 'after-marker' };

/**
 * This thread's own `session_meta` as where its own history starts, or
 * undefined when the record is not this thread's meta.
 */
function ownSessionStart(
  record: TranscriptJsonlRecord,
  threadId: string,
): OwnHistoryStart | undefined {
  if (record.tooLarge || record.type !== 'session_meta') return undefined;
  const meta = asRecord(record.payload);
  if (meta?.id !== threadId) return undefined;
  if (typeof meta.forked_from_id !== 'string' || !meta.forked_from_id)
    return { kind: 'whole' };
  const start = meta.subagent_history_start_ordinal;
  return typeof start === 'number' && Number.isInteger(start) && start >= 0
    ? { kind: 'ordinal', ordinal: start }
    : { kind: 'after-marker' };
}

/** Whether `record` is the developer message ending inherited context. */
function isInheritedContextMarker(record: TranscriptJsonlRecord): boolean {
  if (record.tooLarge || record.type !== 'response_item') return false;
  const payload = asRecord(record.payload);
  return (
    payload?.type === 'message' &&
    payload.role === 'developer' &&
    textBlocks(payload.content).some((text) =>
      text.includes(INHERITED_CONTEXT_MARKER),
    )
  );
}

/**
 * The page from message `offset`, plus whether another message follows.
 * A message is a record that maps to at least one entry, or a record too
 * large to read. Memory holds the page plus at most one line's capped bytes.
 */
async function readPage(
  handle: FileHandle,
  threadId: string,
  offset: number,
  limit: number,
): Promise<{ entries: ChildWorkTranscriptEntry[]; more: boolean } | undefined> {
  const entries: ChildWorkTranscriptEntry[] = [];
  let index = 0;
  let first = true;
  let start: OwnHistoryStart = { kind: 'whole' };
  let inherited = false;
  let line = -1;
  for await (const record of transcriptJsonlRecords(handle)) {
    line += 1;
    if (first) {
      first = false;
      // Not this thread's rollout: nothing in it is this child's.
      const own = ownSessionStart(record, threadId);
      if (!own) return undefined;
      start = own;
      inherited = own.kind !== 'whole';
      continue;
    }
    if (inherited) {
      if (start.kind === 'ordinal') {
        const ordinal =
          !record.tooLarge && typeof record.ordinal === 'number'
            ? record.ordinal
            : line;
        if (ordinal < start.ordinal) continue;
        inherited = false;
      } else {
        // The marker itself is a developer message, never mapped.
        if (isInheritedContextMarker(record)) inherited = false;
        continue;
      }
    }
    const mapped = record.tooLarge
      ? [{ message: index, kind: 'too-large' as const }]
      : codexRolloutEntries(record, index);
    if (mapped.length === 0) continue;
    if (index >= offset + limit) return { entries, more: true };
    if (index >= offset) entries.push(...capEntries(mapped, index));
    index += 1;
  }
  return first ? undefined : { entries, more: false };
}

/** A page of the child thread's transcript, starting at message `offset`. */
export async function readCodexSubagentTranscriptPage(
  ref: CodexThreadTranscriptRef,
  options: { offset: number; limit: number },
): Promise<CodexSubagentTranscriptOutcome> {
  const key = JSON.stringify([ref.configHome ?? '', ref.threadId]);
  let handle: FileHandle | undefined;
  const cached = resolvedPaths.get(key);
  if (cached) {
    // Re-checked as the search checks it: every directory below the home
    // still a real directory.
    if (await isRealDirectoryChain(codexHomeOf(ref), dirname(cached)))
      handle = await openTranscriptFile(cached);
    if (!handle) resolvedPaths.forget(key);
  }
  if (!handle) {
    const path = await findCodexRollout(ref);
    if (path) handle = await openTranscriptFile(path);
    if (!path || !handle) return { status: 'unavailable' };
    resolvedPaths.remember(key, path);
  }
  try {
    const page = await readPage(
      handle,
      ref.threadId,
      options.offset,
      options.limit,
    );
    if (!page) {
      resolvedPaths.forget(key);
      return { status: 'unavailable' };
    }
    return {
      status: 'found',
      page: {
        entries: page.entries,
        ...(page.more ? { nextOffset: options.offset + options.limit } : {}),
      },
    };
  } finally {
    await handle.close();
  }
}
