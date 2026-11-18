/**
 * Pure mapping between OpenCode 2.x's native wire (`opencode serve`, shapes
 * as captured from 2.3.0 in `__tests__/fixtures/opencode-serve-2.3.0-*`) and
 * Station's canonical shapes. The live session that drives them is
 * `opencode-serve-session.ts`.
 */
import type {
  InputRequestContent,
  InputRequestField,
  InputRequestForm,
} from '@kontourai/station-contracts/input-request';
import { INPUT_REQUEST_SCHEMA } from '@kontourai/station-contracts/input-request';
import {
  ENGINE_MCP_SERVER_NAME_MAX_CHARS,
  type EngineMcpServerState,
  type EngineMcpServerStatus,
} from '@kontourai/station-contracts/runtime-events';
import {
  ownArray,
  ownRecord,
  readInputRequestForm,
} from '@kontourai/station-shared/input-request';
import { redactSecrets } from '@kontourai/station-shared/redaction';

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * The OpenCode session an event belongs to: `data.sessionID`, or a form's
 * own `sessionID` (`form.created` nests the form).
 */
export function openCodeEventSessionId(data: unknown): string | undefined {
  const record = ownRecord(data);
  if (!record) return undefined;
  return (
    readString(record.sessionID) ??
    readString(ownRecord(record.form)?.sessionID) ??
    readString(ownRecord(record.info)?.sessionID)
  );
}

/**
 * Events Station reads nothing from on the native transport. They are
 * neither mapped nor counted as unknown.
 */
export const OPENCODE_IGNORED_EVENTS: ReadonlySet<string> = new Set([
  'session.created',
  'session.updated',
  'session.status',
  'session.idle',
  'session.instructions.updated',
  'session.inbox.enqueued',
  'session.inbox.delivery.changed',
  'session.step.first-token',
  'session.step.streamed',
  'session.text.started',
  'session.reasoning.started',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.usage.updated',
  'session.compaction.delta',
  'session.revert.staged',
  'session.revert.cleared',
  'session.shell.started',
  'session.shell.ended',
  'session.permissions',
  'session.metadata.updated',
  'session.viewed',
  'mcp.resources.changed',
  'integration.updated',
  'provider.updated',
  'model.updated',
  'agent.updated',
  'command.updated',
  'config.updated',
  'skill.updated',
  'plugin.updated',
  'project.updated',
  'worktree.resolved',
  'worktree.updated',
  'vcs.branch.updated',
  'websearch.updated',
  'reference.updated',
  'filesystem.changed',
  'artifact.updated',
  'shell.created',
  'shell.exited',
  'shell.updated',
]);

/** `step.ended` usage: one model step's tokens (not cumulative). */
export function openCodeStepUsage(data: Record<string, unknown>):
  | {
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalTokens: number;
    }
  | undefined {
  const tokens = ownRecord(data.tokens);
  if (!tokens) return undefined;
  const promptTokens = readCount(tokens.input);
  const completionTokens = readCount(tokens.output);
  if (promptTokens === undefined && completionTokens === undefined)
    return undefined;
  const reasoningTokens = readCount(tokens.reasoning);
  const cache = ownRecord(tokens.cache);
  const cacheReadTokens = readCount(cache?.read);
  const cacheWriteTokens = readCount(cache?.write);
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    totalTokens:
      (promptTokens ?? 0) + (completionTokens ?? 0) + (reasoningTokens ?? 0),
  };
}

const TOOL_TEXT_MAX_CHARS = 64 * 1024;

/**
 * A tool result as the text Station shows: its text content, then each
 * file it changed with the patch OpenCode reported (`metadata.files`; a
 * write that created a file reports none, as over ACP).
 */
export function openCodeToolOutput(
  content: unknown,
  metadata: unknown,
): string | undefined {
  const parts: string[] = [];
  for (const item of ownArray(content) ?? []) {
    const block = ownRecord(item);
    const text = readString(block?.text);
    if (block?.type === 'text' && text) parts.push(text);
  }
  for (const item of ownArray(ownRecord(metadata)?.files) ?? []) {
    const file = ownRecord(item);
    const path = readString(file?.file);
    const patch = readString(file?.patch);
    if (path && patch)
      parts.push(
        `${file?.status === 'added' ? 'New file' : 'Modified'}: ${path}\n${patch}`,
      );
  }
  const joined = parts.join('\n');
  if (!joined) return undefined;
  return joined.length > TOOL_TEXT_MAX_CHARS
    ? `${joined.slice(0, TOOL_TEXT_MAX_CHARS)}…`
    : joined;
}

/** A tool failure's message (`{type, message}`), redacted. */
export function openCodeToolError(error: unknown): string {
  const record = ownRecord(error);
  const message = readString(record?.message) ?? readString(record?.type);
  return message ? redactSecrets(message) : 'The tool failed.';
}

const MCP_STATES: Record<string, EngineMcpServerState> = {
  connected: 'ready',
  pending: 'starting',
  failed: 'failed',
  needs_auth: 'needs-auth',
  'needs-auth': 'needs-auth',
  needsAuth: 'needs-auth',
  disabled: 'disabled',
};

/** `GET /api/mcp` (`[{name, status: {status, error?}}]`) as engine MCP status. */
export function openCodeMcpStatus(data: unknown): EngineMcpServerStatus[] {
  const servers: EngineMcpServerStatus[] = [];
  for (const item of ownArray(data) ?? []) {
    const server = ownRecord(item);
    const name = readString(server?.name);
    const status = ownRecord(server?.status);
    const state = MCP_STATES[readString(status?.status) ?? ''];
    if (!name || name.length > ENGINE_MCP_SERVER_NAME_MAX_CHARS || !state)
      continue;
    const error = readString(status?.error);
    servers.push({
      name,
      state,
      ...(error ? { error: redactSecrets(error).slice(0, 1000) } : {}),
      scope: 'engine-config',
    });
  }
  return servers;
}

/** The question `form.created` asked, mapped to `station.input-request/v1`. */
export interface OpenCodeFormMapping {
  readonly form: InputRequestForm;
}

/**
 * An OpenCode form (`Form.Info`) as a Station form, or null when Station
 * cannot show it faithfully: an `external` link field, a conditional
 * (`when`) or hidden field, or anything the input-request reader refuses.
 * The caller cancels such a form rather than answer it wrongly.
 */
export function openCodeFormRequest(
  info: unknown,
  requester: string,
): OpenCodeFormMapping | null {
  const form = ownRecord(info);
  const list = ownArray(form?.fields);
  if (!form || !list || list.length === 0) return null;
  const question = ownRecord(form.metadata)?.kind === 'question';
  const fields: InputRequestField[] = [];
  for (const entry of list) {
    const field = ownRecord(entry);
    const key = readString(field?.key);
    if (!field || !key || field.hidden === true || field.when !== undefined)
      return null;
    const label = readString(field.title);
    const description = readString(field.description);
    const header =
      question && label && label.length <= 64 && description
        ? label
        : undefined;
    const base = {
      name: key,
      ...(header ? { header } : {}),
      ...((header ? description : label)
        ? { title: (header ? description : label) as string }
        : {}),
      ...(!header && description ? { description } : {}),
      required: field.required === true || question,
    };
    const options = (ownArray(field.options) ?? []).flatMap((item) => {
      const option = ownRecord(item);
      const value = readString(option?.value);
      const optionLabel = readString(option?.label);
      if (!value || !optionLabel) return [];
      const optionDescription = readString(option?.description);
      return [
        {
          value,
          label: optionLabel,
          ...(optionDescription ? { description: optionDescription } : {}),
        },
      ];
    });
    const custom = field.custom === true;
    switch (field.type) {
      case 'string':
        if (options.length > 0)
          fields.push({
            ...base,
            kind: 'choice',
            options,
            ...(custom ? { allowCustom: true } : {}),
          });
        else
          fields.push({
            ...base,
            kind: 'string',
            ...(typeof field.default === 'string'
              ? { default: field.default }
              : {}),
          });
        break;
      case 'multiselect':
        fields.push({
          ...base,
          kind: 'multi-choice',
          options,
          ...(custom ? { allowCustom: true } : {}),
          ...(readCount(field.minItems) !== undefined
            ? { minItems: field.minItems as number }
            : base.required
              ? { minItems: 1 }
              : {}),
          ...(readCount(field.maxItems) !== undefined
            ? { maxItems: field.maxItems as number }
            : {}),
        });
        break;
      case 'number':
      case 'integer':
        fields.push({
          ...base,
          kind: field.type,
          ...(typeof field.minimum === 'number'
            ? { minimum: field.minimum }
            : {}),
          ...(typeof field.maximum === 'number'
            ? { maximum: field.maximum }
            : {}),
        });
        break;
      case 'boolean':
        fields.push({
          ...base,
          kind: 'boolean',
          ...(typeof field.default === 'boolean'
            ? { default: field.default }
            : {}),
        });
        break;
      default:
        return null;
    }
  }
  const mapped = readInputRequestForm({
    schema: INPUT_REQUEST_SCHEMA,
    source: 'harness:opencode',
    requester,
    message:
      readString(form.title) && form.title !== 'Questions'
        ? (form.title as string)
        : 'The agent has questions for you',
    body: { kind: 'form', fields },
  });
  return mapped ? { form: mapped } : null;
}

/**
 * A validated Station answer as OpenCode's `Form.Answer`: option values as
 * they are, a custom answer as its text.
 */
export function openCodeFormAnswer(
  form: InputRequestForm,
  content: InputRequestContent,
): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {};
  for (const field of form.body.fields) {
    const value = content[field.name];
    if (value === undefined) continue;
    const one = (item: unknown): string =>
      typeof item === 'string'
        ? item
        : String((item as { custom?: unknown }).custom ?? '');
    answer[field.name] = Array.isArray(value)
      ? value.map(one)
      : typeof value === 'object'
        ? one(value)
        : value;
  }
  return answer;
}

/**
 * The text a message held when history was read: each text part of an
 * assistant message, keyed by {@link openCodePartKey} as the live
 * `session.text.*` events name the part.
 */
export function openCodeHistoryText(messages: unknown): Map<string, string> {
  const texts = new Map<string, string>();
  for (const item of ownArray(messages) ?? []) {
    const message = ownRecord(item);
    const id = readString(message?.id);
    if (!message || !id || message.type !== 'assistant') continue;
    // Counted among the message's text parts only, as the live feed counts
    // them: reasoning and tool parts before a text part do not move it.
    let ordinal = 0;
    for (const part of ownArray(message.content) ?? []) {
      const block = ownRecord(part);
      if (block?.type !== 'text') continue;
      if (typeof block.text === 'string')
        texts.set(openCodePartKey('text', id, ordinal), block.text);
      ordinal += 1;
    }
  }
  return texts;
}

/**
 * A message part's key: its kind, its message and its ordinal among that
 * message's parts of the same kind, which is how OpenCode 2.x numbers them
 * (`session.text.*` and `session.reasoning.*` each count from 0).
 */
export function openCodePartKey(
  kind: 'text' | 'reasoning',
  messageId: string,
  ordinal: number | '',
): string {
  return `${kind}:${messageId}:${ordinal}`;
}
