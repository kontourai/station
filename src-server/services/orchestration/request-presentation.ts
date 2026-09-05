import type { RequestOpenedEvent } from '@kontourai/station-contracts/runtime-events';
import { redactSecrets } from '@kontourai/station-shared/redaction';

/**
 * The evidenced title/body for a `needs_input`/`review_pending` item (and,
 * since the archive#1185 fix round, a live `approval` item — see
 * `AttentionProjectionService.resolveApprovalOpenRequest`), built from the
 * request's own `requestType` — the signal that actually distinguishes "a
 * tool call is waiting" from "the agent asked a question" — rather than the
 * coarser lifecycle flag or the notification's own (pre-scrubbed) copy.
 */
export function presentOpenRequest(request: RequestOpenedEvent): {
  title: string;
  body?: string;
} {
  const rawTitle = request.title?.trim() || undefined;

  switch (request.requestType) {
    case 'approval':
    case 'permission':
      return presentToolRequest(
        rawTitle,
        request.description,
        summarizeToolPayload(request.payload),
      );
    case 'confirmation':
      return presentAskRequest(
        'Confirmation needed',
        rawTitle,
        request.description,
      );
    default:
      // Contract vocabulary is exactly 'approval' | 'permission' |
      // 'confirmation' | 'input'; treat anything else the same as 'input'
      // rather than silently dropping detail for a future requestType.
      return presentAskRequest(
        'The agent asked a question',
        rawTitle,
        request.description,
      );
  }
}

/**
 * "Tool call awaiting approval: <tool>" — approval/permission requests.
 *
 * `rawTitle` is adapter-supplied display text, not a scrubbed value — for
 * producers whose payload doesn't match `TOOL_NAME_PAYLOAD_FIELDS`/
 * `TOOL_ARGS_PAYLOAD_FIELDS` (e.g. Codex's `item/commandExecution/
 * requestApproval`, whose `title` is the literal shell command),
 * `summarizeToolPayload` returns no toolName/argsSummary and `rawTitle`
 * becomes the only detail available — it can embed secrets (a `curl -H
 * 'Authorization: Bearer ...'` command) or simply be long, so it is bounded
 * the same way `description`/args are, never passed through verbatim.
 */
function presentToolRequest(
  rawTitle: string | undefined,
  description: string | undefined,
  toolSummary: { toolName?: string; argsSummary?: string } | null,
): { title: string; body?: string } {
  const boundedRawTitle = rawTitle
    ? truncateRequestText(rawTitle, MAX_RAW_TITLE_LENGTH)
    : undefined;
  const toolName = toolSummary?.toolName
    ? truncateRequestText(toolSummary.toolName, MAX_RAW_TITLE_LENGTH)
    : boundedRawTitle;
  const title = toolName
    ? `Tool call awaiting approval: ${toolName}`
    : 'Tool call awaiting approval';

  const bodyParts: string[] = [];
  if (description)
    bodyParts.push(truncateRequestText(description, MAX_DESCRIPTION_LENGTH));
  if (boundedRawTitle && boundedRawTitle !== toolName)
    bodyParts.push(boundedRawTitle);
  if (toolSummary?.argsSummary) bodyParts.push(toolSummary.argsSummary);

  return {
    title,
    ...(bodyParts.length ? { body: bodyParts.join(' — ') } : {}),
  };
}

/** "<label>: <the request's own ask>" — confirmation/input requests, whose `title` IS the actual ask per the contract. */
function presentAskRequest(
  label: string,
  rawTitle: string | undefined,
  description: string | undefined,
): { title: string; body?: string } {
  const title = rawTitle ? `${label}: ${rawTitle}` : label;
  return {
    title,
    ...(description
      ? { body: truncateRequestText(description, MAX_DESCRIPTION_LENGTH) }
      : {}),
  };
}

export const MAX_DESCRIPTION_LENGTH = 400;

/**
 * Bound on `request.title` when it is reused as display text (a title or a
 * body fragment) — adapter-supplied, not necessarily scrubbed (see
 * `presentToolRequest`'s doc comment).
 */
const MAX_RAW_TITLE_LENGTH = 200;
const MAX_ARG_KEYS = 5;
const MAX_ARGS_SUMMARY_LENGTH = 160;
/** Bound on each individual arg key name before joining — a key name is attacker/caller-controlled and can itself carry a secret-length string (e.g. `{[secret]: value}`); the joined-and-truncated overall bound alone is not enough, since a single oversized key can still survive inside the first MAX_ARGS_SUMMARY_LENGTH characters. */
const MAX_ARG_KEY_LENGTH = 24;
const TOOL_NAME_PAYLOAD_FIELDS = ['toolName', 'tool'] as const;
const TOOL_ARGS_PAYLOAD_FIELDS = [
  'toolInput',
  'toolArgs',
  'rawInput',
  'arguments',
  'args',
] as const;

/**
 * A bounded, secret-safe summary of a `request.opened` payload's tool
 * name/args (archive#1185, deliver #3) — never the raw arg values, which
 * may be large or carry secrets. Argument values are reduced to a shape
 * summary (field names only, each individually bounded — see
 * `MAX_ARG_KEY_LENGTH` — then hard-truncated as a whole); string/number/
 * boolean args are reduced to just their type. Err small: when in doubt,
 * say less.
 */
function summarizeToolPayload(
  payload: Record<string, unknown> | undefined,
): { toolName?: string; argsSummary?: string } | null {
  if (!payload) return null;
  const toolName = firstStringField(payload, TOOL_NAME_PAYLOAD_FIELDS);
  let argsValue: unknown;
  for (const key of TOOL_ARGS_PAYLOAD_FIELDS) {
    if (payload[key] !== undefined) {
      argsValue = payload[key];
      break;
    }
  }
  const argsSummary =
    argsValue !== undefined ? summarizeArgsShape(argsValue) : undefined;
  if (!toolName && !argsSummary) return null;
  return {
    ...(toolName ? { toolName } : {}),
    ...(argsSummary ? { argsSummary } : {}),
  };
}

function firstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Field names only — never values — each individually bounded, then hard-truncated as a whole. */
function summarizeArgsShape(value: unknown): string {
  if (Array.isArray(value)) return `args: array(${value.length})`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    const shown = keys
      .slice(0, MAX_ARG_KEYS)
      .map((key) => truncateRequestText(key, MAX_ARG_KEY_LENGTH));
    const more = keys.length - shown.length;
    const list = shown.join(', ') + (more > 0 ? `, +${more} more` : '');
    return truncateRequestText(`args: {${list}}`, MAX_ARGS_SUMMARY_LENGTH);
  }
  if (typeof value === 'string') return 'args: string';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `args: ${typeof value}`;
  }
  return 'args: present';
}

export function truncateRequestText(text: string, max: number): string {
  const trimmed = redactSecrets(text).trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}
