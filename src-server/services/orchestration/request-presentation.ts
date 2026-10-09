import type { RequestOpenedEvent } from '@kontourai/station-contracts/runtime-events';
import {
  boundedDisplayText,
  displayMultilineText,
  truncateDisplay,
} from '@kontourai/station-shared/display-text';
import { readHarnessQuestionnaire } from '@kontourai/station-shared/harness-questions';
import { readMcpElicitationForm } from '@kontourai/station-shared/mcp-elicitation';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import {
  toolRequestFromPayload,
  toolRequestPreviewFromPayload,
} from '@kontourai/station-shared/tool-request-preview';

/**
 * The evidenced title/body for a `needs_input`/`review_pending` item (and,
 * since the archive#1185 fix round, a live `approval` item — see
 * `AttentionProjectionService.resolveApprovalOpenRequest`), built from the
 * request's own `requestType` — the signal that actually distinguishes "a
 * tool call is waiting" from "the agent asked a question" — rather than the
 * coarser lifecycle flag or the notification's own (pre-scrubbed) copy.
 */
/** The fields of a `request.opened` event the presentation reads. */
export type PresentableOpenRequest = Pick<
  RequestOpenedEvent,
  'requestType' | 'title' | 'description' | 'payload'
>;

export function presentOpenRequest(request: PresentableOpenRequest): {
  title: string;
  body?: string;
} {
  const rawTitle = request.title?.trim() || undefined;
  const questionnaire = readHarnessQuestionnaire(
    request.payload?.questionnaire,
  );
  if (questionnaire)
    return presentAskRequest(
      'The agent asked questions',
      rawTitle,
      questionnaire.questions[0].prompt,
    );
  const elicitation = readMcpElicitationForm(request.payload?.mcpElicitation);
  if (elicitation)
    return presentAskRequest(
      'A tool server needs your input',
      rawTitle,
      elicitation.message,
    );

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
 * `summarizeToolPayload` returns no toolName/preview and `rawTitle`
 * becomes the only detail available — it can embed secrets (a `curl -H
 * 'Authorization: Bearer ...'` command) or simply be long, so it is bounded
 * the same way `description`/args are, never passed through verbatim.
 */
function presentToolRequest(
  rawTitle: string | undefined,
  description: string | undefined,
  toolSummary: { toolName?: string; preview?: string } | null,
): { title: string; body?: string } {
  // Everything here is shown beside the approval's preview, which is
  // sanitised (`toolRequestPreview`), so it gets the same display form: an
  // RLO in a Codex title (the literal command) must not reorder the row.
  const boundedRawTitle = rawTitle
    ? displayRequestText(rawTitle, MAX_RAW_TITLE_LENGTH)
    : undefined;
  const toolName = toolSummary?.toolName
    ? displayRequestText(toolSummary.toolName, MAX_RAW_TITLE_LENGTH)
    : boundedRawTitle;
  const title = toolName
    ? `Tool call awaiting approval: ${toolName}`
    : 'Tool call awaiting approval';

  const bodyParts: string[] = [];
  if (description)
    bodyParts.push(displayRequestText(description, MAX_DESCRIPTION_LENGTH));
  if (boundedRawTitle && boundedRawTitle !== toolName)
    bodyParts.push(boundedRawTitle);
  if (toolSummary?.preview) bodyParts.push(toolSummary.preview);

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
  // #3382: the ask's own title and description are engine text shown
  // beside its answer, so they are read in display form (no bidi or
  // invisible characters); the description keeps its line breaks.
  const shownTitle = rawTitle
    ? displayRequestText(rawTitle, MAX_RAW_TITLE_LENGTH)
    : undefined;
  const title = shownTitle ? `${label}: ${shownTitle}` : label;
  const body = description
    ? displayRequestMultilineText(description, MAX_DESCRIPTION_LENGTH)
    : undefined;
  return {
    title,
    ...(body ? { body } : {}),
  };
}

export const MAX_DESCRIPTION_LENGTH = 400;

/**
 * Bound on `request.title` when it is reused as display text (a title or a
 * body fragment) — adapter-supplied, not necessarily scrubbed (see
 * `presentToolRequest`'s doc comment).
 */
const MAX_RAW_TITLE_LENGTH = 200;
/**
 * A bounded, redacted preview of a `request.opened` payload's tool name and of
 * which command, or which file, the call will touch.
 *
 * This used to be a shape summary — argument field NAMES only, never values
 * (archive#1185, deliver #3), on the reasoning that a value may be large or
 * carry a secret. #1545 replaced that: the field list is identical for
 * `rm -rf ./node_modules` and `rm -rf /`, so it could not inform the decision
 * these items exist to support, and an operator approving a call has to be
 * able to see the call. `toolRequestPreview` keeps the bound and the
 * secret-pattern redaction and gives up the value-blindness; it deliberately
 * does NOT strip paths or URLs, which are the substance of the preview. The
 * evidence surface at `platform-mutation-gate.ts` already renders tool
 * arguments as values for the same reason.
 *
 * Still bounded, still single-line, and still not a full disclosure — see
 * `toolRequestPreview`'s own doc comment.
 */
function summarizeToolPayload(
  payload: Record<string, unknown> | undefined,
): { toolName?: string; preview?: string } | null {
  // `toolRequestFromPayload` owns which payload keys carry the name and the
  // arguments (`TOOL_REQUEST_ARGS_FIELDS`). It used to be a private list here,
  // and the client toast grew its own one-key version of it — so ACP and
  // station-agent approvals had a command in this row and a bare tool name in
  // the toast. One reader, one list.
  const { toolName } = toolRequestFromPayload(payload);
  const preview = toolRequestPreviewFromPayload(payload);
  if (!toolName && !preview) return null;
  return {
    ...(toolName ? { toolName } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** `truncateRequestText` in display form: one line, a multi-line value's
 * lines kept apart and counted when cut (`boundedDisplayText`). */
export function displayRequestText(text: string, max: number): string {
  return boundedDisplayText(redactSecrets(text), max);
}

/** `truncateRequestText` in display form, keeping line breaks. */
export function displayRequestMultilineText(text: string, max: number): string {
  return truncateDisplay(displayMultilineText(redactSecrets(text)), max);
}

export function truncateRequestText(text: string, max: number): string {
  const trimmed = redactSecrets(text).trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}
