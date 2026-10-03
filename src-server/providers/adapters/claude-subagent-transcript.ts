import { createReadStream, type Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CHILD_WORK_TRANSCRIPT_ENTRIES_PER_MESSAGE_MAX,
  CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS,
  type ChildWorkTranscriptEntry,
  type ChildWorkTranscriptPage,
  type ChildWorkTranscriptRef,
  cutChildWorkText,
} from '@kontourai/station-contracts/child-work';
import { redactInlineData } from '../model-image-attachments.js';

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
 * are validated by the contract (a UUID and one path-safe segment), the file
 * name is fixed, and directories are walked without following symlinks.
 *
 * Read-only and bounded: a page is at most `limit` messages, a message adds
 * at most `CHILD_WORK_TRANSCRIPT_ENTRIES_PER_MESSAGE_MAX` entries, inline
 * image data is redacted before any cut (as the parent's tool results are),
 * and every text is cut at `CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS` code
 * points. Thinking blocks and records that are not a conversation turn are
 * left out.
 */

export type ClaudeSubagentTranscriptOutcome =
  | { status: 'found'; page: ChildWorkTranscriptPage }
  /** No transcript for this agent under its config home. */
  | { status: 'unavailable' };

/** How deep under `subagents/` a workflow keeps its agents' transcripts. */
const SUBAGENT_DIR_MAX_DEPTH = 3;
/** A line longer than this is skipped unparsed (never a page entry). */
const TRANSCRIPT_LINE_MAX_CHARS = 4 * 1024 * 1024;

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

async function entriesOf(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** `agent-<id>.jsonl` under a `subagents/` directory, symlinks never followed. */
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

/** The agent's transcript file, or undefined when its config home has none. */
export async function findClaudeSubagentTranscript(
  ref: ChildWorkTranscriptRef,
): Promise<string | undefined> {
  const configHome = ref.configHome ?? claudeGlobalConfigHome();
  const projects = join(configHome, 'projects');
  const fileName = `agent-${ref.agentId}.jsonl`;
  for (const project of await entriesOf(projects)) {
    if (!project.isDirectory()) continue;
    const subagents = join(projects, project.name, ref.sessionId, 'subagents');
    const stat = await lstat(subagents).catch(() => undefined);
    if (!stat?.isDirectory()) continue;
    const found = await findUnder(subagents, fileName, 0);
    if (found) return found;
  }
  return undefined;
}

/** The server's own global config home, as Claude Code resolves it. */
function claudeGlobalConfigHome(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : join(homedir(), '.claude');
}

/**
 * The conversation records of a transcript file, in file order, from
 * `offset` until `limit` have been collected. Streamed: memory holds the
 * page, not the file.
 */
async function readMessages(
  path: string,
  offset: number,
  limit: number,
): Promise<{ type?: unknown; message?: unknown }[]> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const page: { type?: unknown; message?: unknown }[] = [];
  let index = 0;
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      if (line.length > TRANSCRIPT_LINE_MAX_CHARS) continue;
      let record: Record<string, unknown> | undefined;
      try {
        record = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (
        !record ||
        (record.type !== 'user' && record.type !== 'assistant') ||
        record.isMeta === true
      ) {
        continue;
      }
      if (index >= offset) page.push(record);
      index += 1;
      if (page.length >= limit) break;
    }
  } finally {
    lines.close();
  }
  return page;
}

/** A page of the subagent's transcript, starting at message `offset`. */
export async function readClaudeSubagentTranscriptPage(
  ref: ChildWorkTranscriptRef,
  options: { offset: number; limit: number },
): Promise<ClaudeSubagentTranscriptOutcome> {
  const path = await findClaudeSubagentTranscript(ref);
  if (!path) return { status: 'unavailable' };
  // One past the page tells whether another page follows.
  const messages = await readMessages(path, options.offset, options.limit + 1);
  const page = messages.slice(0, options.limit);
  return {
    status: 'found',
    page: {
      entries: page.flatMap((message, index) =>
        claudeTranscriptEntries(message, options.offset + index),
      ),
      ...(messages.length > options.limit
        ? { nextOffset: options.offset + options.limit }
        : {}),
    },
  };
}
