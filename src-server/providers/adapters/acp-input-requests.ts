/**
 * One ingress from an ACP engine's "ask the person" requests into
 * `station.input-request/v1` (`packages/contracts/src/input-request.ts`).
 *
 * Four wires, one parser each, all generic over what the engine declared:
 *
 * - core `elicitation/create`: an MCP server's elicitation the engine turns
 *   around to the client, fields flat on `params` (ACP schema
 *   `CreateElicitationRequest`). Form and URL modes.
 * - `_kiro/mcp/elicitation`: the same ask on Kiro's agent service, fields
 *   nested under `params.elicitation` (kirocrew `acp/elicitation.py`,
 *   `test/fixtures/acp_frames/kas/mcp-elicitation.jsonl`).
 * - `_kiro/userInput`: the model's own question, `{question, options[{title,
 *   description, recommended, subOptions}]}`, drawn as one choice field that
 *   allows a custom answer.
 * - `_kiro/openExternalUrl`: a link (an MCP OAuth consent page) for the
 *   person to open. Station never opens it itself.
 *
 * Every parser fails closed: a request Station cannot show faithfully is
 * answered `decline` (or, for `_kiro/userInput`, an `answered` text saying
 * nobody answered) and never with a JSON-RPC error, because Kiro's agent
 * service turns an error into cancelling the whole tool call. Links are
 * https only, carry no user info and are at most 2048 characters
 * (`readInputRequestLink`).
 *
 * The `_kiro/userInput` reply is always `{action: 'answered', answer}`.
 * Kiro's agent service hands only an `answered` with a non-empty answer to
 * the model; anything else (`dismissed`, an error, a missing reply) becomes
 * "move on", which its tool tells the model to read as yes (kirocrew
 * `acp/types.py` METHOD_KAS_USER_INPUT, `acp/elicitation.py`). So a decline,
 * a cancel and an ask nobody could see each go back as `answered` with text
 * that says plainly it is not agreement.
 */
import type {
  InputRequestChoiceField,
  InputRequestContent,
  InputRequestField,
  InputRequestForm,
  InputRequestOption,
  InputRequestUrl,
  InputRequestUrlPurpose,
} from '@kontourai/station-contracts/input-request';
import { INPUT_REQUEST_SCHEMA } from '@kontourai/station-contracts/input-request';
import {
  INPUT_REQUEST_MAX_MESSAGE_CHARS,
  INPUT_REQUEST_MAX_OPTIONS,
  INPUT_REQUEST_MAX_TEXT_CHARS,
  ownArray,
  ownRecord,
  readInputRequestForm,
  readInputRequestLink,
  readInputRequestUrl,
} from '@kontourai/station-shared/input-request';
import { inputRequestFromMcpElicitation } from '@kontourai/station-shared/mcp-elicitation';

export const CORE_ELICITATION_METHOD = 'elicitation/create';

/** How the person answered, or that nobody could. */
export type AcpInputDecision = 'accept' | 'decline' | 'cancel';

/** What a parser made of a request. */
export type AcpInputRequestRead =
  | { readonly kind: 'form'; readonly form: InputRequestForm }
  | { readonly kind: 'url'; readonly request: InputRequestUrl }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Who asked: the engine, relaying a tool server or its model. */
export interface AcpInputRequester {
  /** The engine's display name. */
  readonly engineName: string;
}

const LABEL_MAX = 512;
const DESCRIPTION_MAX = 2000;

function unreadable(reason: string): AcpInputRequestRead {
  return { kind: 'unreadable', reason };
}

function boundedMessage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.length <= INPUT_REQUEST_MAX_MESSAGE_CHARS ? value : null;
}

function harnessSource(requester: AcpInputRequester): `harness:${string}` {
  return `harness:${requester.engineName}`;
}

/**
 * An elicitation body (flat for core, nested for Kiro) read into a form or a
 * URL request. Mode defaults to form when a `requestedSchema` is present,
 * which is the one shape MCP leaves implicit.
 */
function readElicitationBody(
  body: Record<string, unknown>,
  requester: AcpInputRequester,
): AcpInputRequestRead {
  const message = boundedMessage(body.message);
  if (!message) return unreadable('the elicitation carries no usable message');
  const mode =
    body.mode === undefined && ownRecord(body.requestedSchema)
      ? 'form'
      : body.mode;
  if (mode === 'url') {
    const url = readInputRequestLink(body.url);
    if (!url)
      return unreadable(
        'the elicitation link is not an https URL without user info, of at most 2048 characters',
      );
    const elicitationId = body.elicitationId;
    if (typeof elicitationId !== 'string' || !elicitationId)
      return unreadable('the URL elicitation carries no elicitationId');
    return urlRead(
      {
        message,
        url,
        purpose: 'elicitation',
        elicitationId,
      },
      requester,
    );
  }
  if (mode !== 'form') return unreadable('unsupported elicitation mode');
  // The shared MCP edge reads the schema; this edge then names the engine
  // as the asker, because the request does not name the tool server.
  const mapped = inputRequestFromMcpElicitation(requester.engineName, {
    mode: 'form',
    message,
    requestedSchema: body.requestedSchema,
  });
  if (!mapped)
    return unreadable('the elicitation asks for a form Station cannot show');
  const form = readInputRequestForm({
    ...mapped,
    source: harnessSource(requester),
    requester: requester.engineName,
  });
  return form
    ? { kind: 'form', form }
    : unreadable('the elicitation asks for a form Station cannot show');
}

function urlRead(
  body: {
    message: string;
    url: string;
    purpose: InputRequestUrlPurpose;
    elicitationId?: string;
  },
  requester: AcpInputRequester,
): AcpInputRequestRead {
  const request = readInputRequestUrl({
    schema: INPUT_REQUEST_SCHEMA,
    source: harnessSource(requester),
    requester: requester.engineName,
    message: body.message,
    body: {
      kind: 'url',
      url: body.url,
      purpose: body.purpose,
      ...(body.elicitationId ? { elicitationId: body.elicitationId } : {}),
    },
  });
  return request
    ? { kind: 'url', request }
    : unreadable('the link request is not one Station can show');
}

/** Core `elicitation/create`: fields flat on `params`. */
export function readCoreElicitation(
  params: unknown,
  requester: AcpInputRequester,
): AcpInputRequestRead {
  const body = ownRecord(params);
  if (!body) return unreadable('the elicitation is not an object');
  // A request-scoped ask (`requestId`, outside any session) has no person
  // routed to it in Station's chat.
  if (typeof body.sessionId !== 'string' || !body.sessionId)
    return unreadable('the elicitation names no session');
  return readElicitationBody(body, requester);
}

/** `_kiro/mcp/elicitation`: the same fields nested under `params.elicitation`. */
export function readKiroMcpElicitation(
  params: unknown,
  requester: AcpInputRequester,
): AcpInputRequestRead {
  const outer = ownRecord(params);
  const body = ownRecord(outer?.elicitation);
  if (!outer || !body)
    return unreadable('the elicitation carries no `elicitation` object');
  return readElicitationBody(body, requester);
}

/** The single field a `_kiro/userInput` question is drawn with. */
const KIRO_USER_INPUT_FIELD = 'answer';

/**
 * `_kiro/userInput` as a form: one field. With options, a choice that also
 * takes the person's own words (`allowCustom`); without, a required text
 * answer. A recommended option says so in its label; `subOptions` are not
 * drawn, so the chosen option's title is the answer.
 */
export function readKiroUserInput(
  params: unknown,
  requester: AcpInputRequester,
): AcpInputRequestRead {
  const value = ownRecord(params);
  if (!value) return unreadable('the question is not an object');
  const question = boundedMessage(value.question);
  if (!question) return unreadable('the question carries no text');
  const raw = value.options === undefined ? [] : ownArray(value.options);
  if (!raw) return unreadable('the question options are not a list');
  if (raw.length > INPUT_REQUEST_MAX_OPTIONS)
    return unreadable('the question offers too many options');
  const options: InputRequestOption[] = [];
  for (const entry of raw) {
    const option = ownRecord(entry);
    const title = option?.title;
    if (typeof title !== 'string' || !title.trim() || title.length > LABEL_MAX)
      return unreadable('an option has no usable title');
    if (options.some((existing) => existing.value === title)) continue;
    const description =
      typeof option?.description === 'string' &&
      option.description.trim() &&
      option.description.length <= DESCRIPTION_MAX
        ? option.description.trim()
        : undefined;
    options.push({
      value: title,
      label: option?.recommended === true ? `${title} (recommended)` : title,
      ...(description ? { description } : {}),
    });
  }
  const field: InputRequestField =
    options.length > 0
      ? ({
          name: KIRO_USER_INPUT_FIELD,
          kind: 'choice',
          title: 'Choose an answer, or write your own',
          required: true,
          options,
          allowCustom: true,
        } satisfies InputRequestChoiceField)
      : {
          name: KIRO_USER_INPUT_FIELD,
          kind: 'string',
          title: 'Your answer',
          required: true,
          maxLength: INPUT_REQUEST_MAX_TEXT_CHARS,
        };
  const form = readInputRequestForm({
    schema: INPUT_REQUEST_SCHEMA,
    source: harnessSource(requester),
    requester: requester.engineName,
    message: question,
    body: { kind: 'form', fields: [field] },
  });
  return form
    ? { kind: 'form', form }
    : unreadable('the question is not one Station can show');
}

/** `_kiro/openExternalUrl`: `{url}`, an MCP sign-in's consent page. */
export function readKiroOpenExternalUrl(
  params: unknown,
  requester: AcpInputRequester,
): AcpInputRequestRead {
  const value = ownRecord(params);
  const url = readInputRequestLink(value?.url);
  if (!url)
    return unreadable(
      'the link is not an https URL without user info, of at most 2048 characters',
    );
  return urlRead(
    {
      message: `${requester.engineName} asks you to open a sign-in page for one of its tool servers.`,
      url,
      purpose: 'mcp-sign-in',
    },
    requester,
  );
}

/** Text the model reads when the person saw the question and declined it. */
export const KIRO_USER_INPUT_DECLINED_ANSWER =
  'The user declined to answer this question. This is not agreement: do not assume yes or pick an option for them.';

/** Text the model reads when the question went to nobody, or was cancelled unanswered. */
export const KIRO_USER_INPUT_NO_PERSON_ANSWER =
  'No person could answer this question, so it went unanswered. This is not agreement: do not assume yes or pick an option for them.';

function answerText(content: InputRequestContent | undefined): string {
  const value = content?.[KIRO_USER_INPUT_FIELD];
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value.custom.trim();
  return '';
}

/**
 * The `_kiro/userInput` reply: always `answered` with a non-empty answer.
 * `person` is false when Station decided without asking anyone (no person
 * may be asked, the question could not be shown, the session stopped).
 */
export function kiroUserInputReply(
  decision: AcpInputDecision,
  content: InputRequestContent | undefined,
  person: boolean,
): { action: 'answered'; answer: string } {
  if (decision === 'accept') {
    const answer = answerText(content);
    return {
      action: 'answered',
      answer: answer || KIRO_USER_INPUT_DECLINED_ANSWER,
    };
  }
  return {
    action: 'answered',
    answer:
      person && decision === 'decline'
        ? KIRO_USER_INPUT_DECLINED_ANSWER
        : KIRO_USER_INPUT_NO_PERSON_ANSWER,
  };
}

/**
 * The reply to an elicitation (core or Kiro), MCP's result shape. Content
 * rides only with an accepted form; an accepted URL request reports only
 * that the person opened the link.
 */
export function elicitationReply(
  decision: AcpInputDecision,
  content?: InputRequestContent,
): Record<string, unknown> {
  if (decision === 'accept')
    return content ? { action: 'accept', content } : { action: 'accept' };
  return { action: decision };
}
