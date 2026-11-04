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
  directoryEntries as entriesOf,
  isRealDirectory,
  isRealDirectoryChain,
  openTranscriptFile as openTranscript,
  type TranscriptJsonlRecord as TranscriptRecord,
  transcriptJsonlRecords as transcriptRecords,
} from './transcript-jsonl-file.js';

/**
 * #3163: a Claude subagent's own transcript, read from disk.
 *
 * Claude Code writes each subagent's conversation under the config home the
 * session ran with: `<config>/projects/<project>/<session>/subagents/` holds
 * `agent-<agentId>.jsonl` (a workflow's agents one level or two further
 * down). The config home is the ref's own (`configHome`, the session's
 * app-home or credential profile, or a connection's config home), else the
 * server's global one. The SDK's `getSubagentMessages` reads only the
 * server process's `CLAUDE_CONFIG_DIR`, so it can't open a profile session's
 * transcript; this reader takes the config home explicitly instead.
 *
 * Nothing here builds a path from request input: the session and agent ids
 * are validated by the contract (a UUID and one path-safe segment), and the
 * file name is fixed. Symlinks below the config home are refused as
 * `transcript-jsonl-file.ts` describes (repeated on every read of a cached
 * path). The config home itself may be a link (a dotfiles-managed
 * `~/.claude`).
 *
 * The file is read in its own order, so it can show what the engine's own
 * reader hides: a branch abandoned by a retry or edit, and a compaction
 * summary. Each line is read as bytes and never buffered past 4 MiB; a
 * longer record, of any type, becomes one `too-large` entry.
 *
 * Read-only and bounded: a page is at most `limit` messages, a message adds
 * at most `CHILD_WORK_TRANSCRIPT_ENTRIES_PER_MESSAGE_MAX` entries, inline
 * image data is redacted before any cut (as the parent's tool results are),
 * and every text is cut at `CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS` code
 * points. Thinking blocks and records that are not a conversation turn are
 * left out.
 */

export type ClaudeSubagentTranscriptRef = Extract<
  ChildWorkTranscriptRef,
  { kind: 'claude-subagent' }
>;

export type ClaudeSubagentTranscriptOutcome =
  | { status: 'found'; page: ChildWorkTranscriptPage }
  /** No transcript for this agent under its config home. */
  | { status: 'unavailable' };

/** How deep under `subagents/` a workflow keeps its agents' transcripts. */
const SUBAGENT_DIR_MAX_DEPTH = 3;
/** Resolved transcript paths kept per process (a FIFO cache: oldest inserted evicted first). */
const RESOLVED_PATHS_MAX = 256;

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

/** A tool result's text: a string, or the text blocks of its content. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === 'text' && typeof record.text === 'string'
      ? [record.text]
      : [];
  });
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function blockEntry(
  block: unknown,
  role: 'user' | 'assistant',
  message: number,
): ChildWorkTranscriptEntry | undefined {
  const record = asRecord(block);
  if (!record) return undefined;
  switch (record.type) {
    case 'text': {
      if (typeof record.text !== 'string' || record.text.length === 0)
        return undefined;
      return { message, kind: 'text', role, ...bounded(record.text) };
    }
    case 'tool_use': {
      if (typeof record.name !== 'string') return undefined;
      if (record.input === undefined)
        return { message, kind: 'tool-call', name: record.name };
      const cut = bounded(JSON.stringify(record.input));
      return {
        message,
        kind: 'tool-call',
        name: record.name,
        input: cut.text,
        ...(cut.truncated ? { truncated: true as const } : {}),
      };
    }
    case 'tool_result': {
      const text = toolResultText(record.content);
      const cut = text === undefined ? undefined : bounded(text);
      return {
        message,
        kind: 'tool-result',
        ...(cut ? { text: cut.text } : {}),
        ...(cut?.truncated ? { truncated: true as const } : {}),
        ...(record.is_error === true ? { isError: true as const } : {}),
      };
    }
    default:
      // Thinking, images and blocks this build does not know are left out.
      return undefined;
  }
}

/** One transcript record (`{ type, message: { role, content } }`) as entries. */
export function claudeTranscriptEntries(
  transcriptRecord: { type?: unknown; message?: unknown },
  message: number,
): ChildWorkTranscriptEntry[] {
  const role = transcriptRecord.type;
  if (role !== 'user' && role !== 'assistant') return [];
  const content = asRecord(transcriptRecord.message)?.content;
  if (typeof content === 'string') {
    return content.length > 0
      ? [{ message, kind: 'text', role, ...bounded(content) }]
      : [];
  }
  if (!Array.isArray(content)) return [];
  const entries = content.flatMap((block) => {
    const entry = blockEntry(block, role, message);
    return entry ? [entry] : [];
  });
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
 * `agent-<id>.jsonl` under a `subagents/` directory. Only real directories
 * are entered and only a regular file matches: a symlinked directory or file
 * is never followed (`Dirent` reports the link itself).
 */
async function findUnder(
  directory: string,
  fileName: string,
  depth: number,
): Promise<string | undefined> {
  const entries = await entriesOf(directory);
  const file = entries.find((entry) => entry.name === fileName);
  if (file?.isFile()) return join(directory, fileName);
  if (depth >= SUBAGENT_DIR_MAX_DEPTH) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findUnder(
      join(directory, entry.name),
      fileName,
      depth + 1,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * Where each reference's transcript was last found. The search walks every
 * project directory, so a page read after the first reuses the answer; the
 * file is still opened without following links and checked on every read,
 * and a miss forgets the entry.
 */
const resolvedPaths = createResolvedPathCache(RESOLVED_PATHS_MAX);

function refKey(ref: ClaudeSubagentTranscriptRef): string {
  return JSON.stringify([ref.configHome ?? '', ref.sessionId, ref.agentId]);
}

/**
 * The agent's transcript file, or undefined when its config home has none.
 * The config home itself is the one the server recorded (it may be a link,
 * as a dotfiles-managed `~/.claude` often is); every directory below it
 * (`projects`, the project, the session, `subagents` and any workflow
 * level) must be a real directory.
 */
async function findClaudeSubagentTranscript(
  ref: ClaudeSubagentTranscriptRef,
): Promise<string | undefined> {
  const projects = join(configHomeOf(ref), 'projects');
  if (!(await isRealDirectory(projects))) return undefined;
  const fileName = `agent-${ref.agentId}.jsonl`;
  for (const project of await entriesOf(projects)) {
    if (!project.isDirectory()) continue;
    const session = join(projects, project.name, ref.sessionId);
    if (!(await isRealDirectory(session))) continue;
    const subagents = join(session, 'subagents');
    if (!(await isRealDirectory(subagents))) continue;
    const found = await findUnder(subagents, fileName, 0);
    if (found) return found;
  }
  return undefined;
}

function configHomeOf(ref: ClaudeSubagentTranscriptRef): string {
  return ref.configHome ?? claudeGlobalConfigHome();
}

/** The server's own global config home, as Claude Code resolves it. */
function claudeGlobalConfigHome(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : join(homedir(), '.claude');
}

/** A conversation turn: a user or assistant record that is not meta. */
function isConversationRecord(record: TranscriptRecord): boolean {
  if (record.tooLarge) return true;
  const raw = record as Record<string, unknown>;
  return (
    (raw.type === 'user' || raw.type === 'assistant') && raw.isMeta !== true
  );
}

/**
 * The conversation records from `offset` until `limit` have been collected.
 * Memory holds the page plus at most one line's capped bytes.
 */
async function readMessages(
  handle: FileHandle,
  offset: number,
  limit: number,
): Promise<TranscriptRecord[]> {
  const page: TranscriptRecord[] = [];
  let index = 0;
  for await (const record of transcriptRecords(handle)) {
    if (!isConversationRecord(record)) continue;
    if (index >= offset) page.push(record);
    index += 1;
    if (page.length >= limit) break;
  }
  return page;
}

/** A page of the subagent's transcript, starting at message `offset`. */
export async function readClaudeSubagentTranscriptPage(
  ref: ClaudeSubagentTranscriptRef,
  options: { offset: number; limit: number },
): Promise<ClaudeSubagentTranscriptOutcome> {
  const key = refKey(ref);
  let handle: FileHandle | undefined;
  const cached = resolvedPaths.get(key);
  if (cached) {
    // A cached path is re-checked as the search checks it: every directory
    // below the config home still a real directory.
    if (await isRealDirectoryChain(configHomeOf(ref), dirname(cached)))
      handle = await openTranscript(cached);
    if (!handle) resolvedPaths.forget(key);
  }
  if (!handle) {
    const path = await findClaudeSubagentTranscript(ref);
    if (path) handle = await openTranscript(path);
    if (!path || !handle) return { status: 'unavailable' };
    resolvedPaths.remember(key, path);
  }
  try {
    // One past the page tells whether another page follows.
    const messages = await readMessages(
      handle,
      options.offset,
      options.limit + 1,
    );
    const page = messages.slice(0, options.limit);
    return {
      status: 'found',
      page: {
        entries: page.flatMap((record, index): ChildWorkTranscriptEntry[] =>
          record.tooLarge
            ? [{ message: options.offset + index, kind: 'too-large' }]
            : claudeTranscriptEntries(
                { type: record.type, message: record.message },
                options.offset + index,
              ),
        ),
        ...(messages.length > options.limit
          ? { nextOffset: options.offset + options.limit }
          : {}),
      },
    };
  } finally {
    await handle.close();
  }
}
