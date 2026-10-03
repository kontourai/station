import {
  type GetSubagentMessagesOptions,
  getSubagentMessages,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  CHILD_WORK_TRANSCRIPT_ENTRIES_PER_MESSAGE_MAX,
  CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS,
  type ChildWorkTranscriptEntry,
  type ChildWorkTranscriptPage,
  type ChildWorkTranscriptRef,
} from '@kontourai/station-contracts/child-work';

/**
 * #3163: a Claude subagent's own transcript, read through the SDK's reader.
 *
 * Claude Code writes each subagent's conversation to disk under the parent
 * Claude session, by agent id. `getSubagentMessages` finds and parses it
 * from those two ids (plus the project directory as a hint), so Station never
 * builds or accepts a file path. The transcript outlives both the Claude
 * process and a Station restart.
 *
 * Read-only and bounded: a page is at most `limit` messages, a message adds
 * at most `CHILD_WORK_TRANSCRIPT_ENTRIES_PER_MESSAGE_MAX` entries, and every
 * text is cut at `CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS`. Thinking blocks
 * are left out.
 */

export type ClaudeSubagentMessageReader = (
  sessionId: string,
  agentId: string,
  options: GetSubagentMessagesOptions,
) => Promise<readonly Pick<SessionMessage, 'type' | 'message'>[]>;

export type ClaudeSubagentTranscriptOutcome =
  | { status: 'found'; page: ChildWorkTranscriptPage }
  /** The engine has no transcript for this agent (deleted, or another config home). */
  | { status: 'unavailable' };

function bounded(text: string): { text: string; truncated?: true } {
  return text.length > CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS
    ? {
        text: text.slice(0, CHILD_WORK_TRANSCRIPT_TEXT_MAX_CHARS),
        truncated: true,
      }
    : { text };
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
      const input =
        record.input === undefined ? undefined : JSON.stringify(record.input);
      if (input === undefined)
        return { message, kind: 'tool-call', name: record.name };
      const cut = bounded(input);
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

/** One SDK transcript message as read-only entries. */
export function claudeTranscriptEntries(
  sessionMessage: Pick<SessionMessage, 'type' | 'message'>,
  message: number,
): ChildWorkTranscriptEntry[] {
  if (sessionMessage.type !== 'user' && sessionMessage.type !== 'assistant')
    return [];
  const role = sessionMessage.type;
  const content = asRecord(sessionMessage.message)?.content;
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
 * A page of the subagent's transcript, starting at message `offset`.
 * `projectDir` is the reporting session's working directory, a lookup hint:
 * when it finds nothing, the SDK searches every project for the session.
 */
export async function readClaudeSubagentTranscriptPage(
  ref: ChildWorkTranscriptRef,
  options: {
    offset: number;
    limit: number;
    projectDir?: string;
    reader?: ClaudeSubagentMessageReader;
  },
): Promise<ClaudeSubagentTranscriptOutcome> {
  const reader = options.reader ?? getSubagentMessages;
  // One past the page tells whether another page follows.
  const window = { offset: options.offset, limit: options.limit + 1 };
  let messages = await reader(ref.sessionId, ref.agentId, {
    ...window,
    ...(options.projectDir ? { dir: options.projectDir } : {}),
  });
  if (messages.length === 0 && options.projectDir) {
    messages = await reader(ref.sessionId, ref.agentId, window);
  }
  // Every subagent transcript opens with its prompt: an empty first page
  // means the engine has no transcript for this agent.
  if (messages.length === 0 && options.offset === 0)
    return { status: 'unavailable' };
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
