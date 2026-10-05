/**
 * `station.input-request/v1` (#3390): one contract for "something asks the
 * person a structured question" — a harness question (Claude
 * `AskUserQuestion`, Codex `request_user_input`), a tool server's form-mode
 * MCP elicitation, and a tool approval.
 *
 * Each source maps into this contract at its own edge and maps the response
 * back out; a renderer reads only this contract. Validation lives in
 * `@kontourai/station-shared/input-request`, used by the browser and run again
 * by the server against the exact request it opened.
 *
 * Two body kinds, deliberately separate:
 *
 * - `form` collects data that goes back to its source. The field vocabulary
 *   is MCP elicitation's restricted schema (a flat object of primitive
 *   fields), plus three extensions harnesses need: an option `description`,
 *   `allowCustom` on choice fields and `secret`.
 * - `decision` is an approval. Answering it is a grant, which needs
 *   approve-capable authority; a form answer never is. A form can carry no
 *   option effect, and a stored request can carry no decision body: decision
 *   bodies are derived from an approval request by Station itself.
 */

export const INPUT_REQUEST_SCHEMA = 'station.input-request/v1' as const;

/**
 * Who asked. `harness:<engine>` for an engine's own question tool,
 * `mcp:<serverId>` for a tool server's elicitation, `approval` for a tool
 * approval. The request id and event id are the request event's own; they
 * are not repeated here, where a second copy could disagree.
 */
export type InputRequestSource =
  | `harness:${string}`
  | `mcp:${string}`
  | 'approval';

export interface InputRequest<
  Body extends InputRequestBody = InputRequestBody,
> {
  schema: typeof INPUT_REQUEST_SCHEMA;
  source: InputRequestSource;
  /** A display label for the asker: an engine or tool server name. */
  requester: string;
  message: string;
  body: Body;
}

export type InputRequestBody = InputRequestFormBody | InputRequestDecisionBody;

export type InputRequestForm = InputRequest<InputRequestFormBody>;

export interface InputRequestFormBody {
  kind: 'form';
  fields: InputRequestField[];
}

interface InputRequestFieldBase {
  /** The content key the answer is returned under. */
  name: string;
  title?: string;
  description?: string;
  required: boolean;
}

export type InputRequestStringFormat = 'email' | 'uri' | 'date' | 'date-time';

export interface InputRequestStringField extends InputRequestFieldBase {
  kind: 'string';
  minLength?: number;
  maxLength?: number;
  format?: InputRequestStringFormat;
  default?: string;
  /** Station extension: masked while typed, never saved as a draft or shown back. */
  secret?: boolean;
}

export interface InputRequestNumberField extends InputRequestFieldBase {
  kind: 'number' | 'integer';
  minimum?: number;
  maximum?: number;
  default?: number;
}

export interface InputRequestBooleanField extends InputRequestFieldBase {
  kind: 'boolean';
  default?: boolean;
}

export interface InputRequestOption {
  value: string;
  label: string;
  /** Station extension: what choosing this option means. */
  description?: string;
}

interface InputRequestChoiceExtensions {
  /**
   * Station extension: the person may answer in their own words instead of
   * (for `choice`) or as well as (for `multi-choice`) an offered option.
   */
  allowCustom?: boolean;
  /** Station extension: the answer is never saved as a draft or shown back. */
  secret?: boolean;
}

export interface InputRequestChoiceField
  extends InputRequestFieldBase,
    InputRequestChoiceExtensions {
  kind: 'choice';
  options: InputRequestOption[];
  default?: string;
}

export interface InputRequestMultiChoiceField
  extends InputRequestFieldBase,
    InputRequestChoiceExtensions {
  kind: 'multi-choice';
  options: InputRequestOption[];
  minItems?: number;
  maxItems?: number;
  default?: string[];
}

export type InputRequestField =
  | InputRequestStringField
  | InputRequestNumberField
  | InputRequestBooleanField
  | InputRequestChoiceField
  | InputRequestMultiChoiceField;

/**
 * An approval's choices. Each option says what answering it does (`effect`)
 * and how long that lasts (`scope`). There is no `always` scope: no source
 * Station implements offers one, and Station's response channel has no
 * decision that would carry it.
 */
export interface InputRequestDecisionBody {
  kind: 'decision';
  options: InputRequestDecisionOption[];
}

export interface InputRequestDecisionOption {
  id: string;
  label: string;
  effect: 'allow' | 'deny';
  scope: 'once' | 'session';
}

/**
 * A custom answer to a choice field that allows one. It stands in the place
 * of an option value, so a field without `allowCustom` — every MCP field —
 * keeps plain MCP content.
 */
export interface InputRequestCustomAnswer {
  custom: string;
}

export type InputRequestValue =
  | string
  | number
  | boolean
  | InputRequestCustomAnswer
  | Array<string | InputRequestCustomAnswer>;

/** Accepted form content, keyed by field name. */
export type InputRequestContent = Record<string, InputRequestValue>;

/** The response, in MCP elicitation's result shape. */
export type InputRequestResponse =
  | { action: 'accept'; content: InputRequestContent }
  | { action: 'decline' }
  | { action: 'cancel' };

/**
 * What became of a request, for its transcript record. A form is
 * `accepted`, `declined` or `cancelled`; a decision is `allowed` or
 * `denied` (or `cancelled`). `expired` is a request Station closed because
 * the turn that asked could not continue.
 */
export type InputRequestOutcome =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'allowed'
  | 'denied'
  | 'expired';

/**
 * The transcript's record of one request: it opens on `request.opened` and
 * takes its outcome from `request.resolved`. It carries no answer content.
 */
export interface InputRequestRecord {
  requestId: string;
  threadId: string;
  eventId: string;
  kind: InputRequestBody['kind'];
  requester: string;
  message: string;
  outcome: InputRequestOutcome;
}
