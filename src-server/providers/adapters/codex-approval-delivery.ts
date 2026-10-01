import type { JsonRpcId } from './codex-adapter-types.js';

/**
 * #2880: how long Station waits for Codex's `serverRequest/resolved` after
 * writing an approval reply before it says the decision is not acknowledged.
 *
 * Codex 0.155.1 acknowledges a reply within ~0.1 s on an idle host (measured
 * against a live app-server for #562). 30 s leaves two orders of magnitude of
 * headroom for a loaded machine, so the warning does not fire on a slow
 * engine, while a reply that was genuinely lost is still reported within the
 * same minute rather than leaving the task silently `running`. The warning
 * copy says "not yet", and a late acknowledgement supersedes it.
 */
export const CODEX_APPROVAL_ACK_WINDOW_MS = 30_000;

/** The metadata declaration and every decision's `request.resolved`. */
export const CODEX_APPROVAL_ACKNOWLEDGEMENT = 'engine' as const;

export const CODEX_DECISION_UNACKNOWLEDGED_CODE =
  'engine-decision-unacknowledged';
export const CODEX_DECISION_REPLY_REFUSED_CODE = 'engine-decision-not-sent';

/**
 * A JSON-RPC id as a map key that keeps its type: Codex matches replies by
 * value AND type (#562), so `0` and `"0"` are different requests.
 */
export function jsonRpcIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

/** Reads a Codex-reported request id; anything else is not an id. */
export function readJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return undefined;
}

const DECISION_VOCABULARY = new Set([
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
]);
const ELICITATION_ACTIONS = new Set(['accept', 'decline', 'cancel']);
const PERMISSION_SCOPES = new Set(['turn', 'session']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * #2880: Codex acknowledges even a reply it could not parse — it logs the
 * deserialize failure, rejects the tool call, and still sends
 * `serverRequest/resolved` (observed on 0.155.1). Its acknowledgement cannot
 * tell a well-formed reply from a malformed one, so Station checks the reply
 * against the method's decision vocabulary BEFORE writing it. Returns why the
 * reply is refused, or `undefined` when it may be sent.
 *
 * Deliberately strict: only the shapes Station itself produces pass.
 */
export function refuseCodexApprovalReply(
  method: string,
  result: unknown,
): string | undefined {
  if (!isPlainObject(result)) return 'the reply is not an object';
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return typeof result.decision === 'string' &&
        DECISION_VOCABULARY.has(result.decision) &&
        Object.keys(result).length === 1
        ? undefined
        : 'the reply does not carry a decision Codex accepts';
    case 'item/tool/requestUserInput':
      return Object.keys(result).length === 1 &&
        isPlainObject(result.answers) &&
        Object.values(result.answers).every(
          (answer) =>
            isPlainObject(answer) &&
            Object.keys(answer).length === 1 &&
            Array.isArray(answer.answers) &&
            answer.answers.every((value) => typeof value === 'string'),
        )
        ? undefined
        : 'the reply does not carry question answers Codex accepts';
    case 'item/permissions/requestApproval':
      return isPlainObject(result.permissions) &&
        typeof result.scope === 'string' &&
        PERMISSION_SCOPES.has(result.scope) &&
        Object.keys(result).length === 2
        ? undefined
        : 'the reply does not carry a permission grant Codex accepts';
    case 'mcpServer/elicitation/request':
      return typeof result.action === 'string' &&
        ELICITATION_ACTIONS.has(result.action) &&
        Object.keys(result).length === 1
        ? undefined
        : 'the reply does not carry an elicitation action Codex accepts';
    default:
      return `Station has no reply vocabulary for ${method}`;
  }
}
