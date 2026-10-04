/**
 * #3160 (epic #3167): `send_to_session`, `interrupt_session` and
 * `wait_session`, the tools by which an agent waits on, messages and
 * interrupts another Session in its Project.
 *
 * Authority never comes from arguments. Each tool calls its own Station route
 * (`routes/orchestration/session-agent-control.ts`), which acts as the VERIFIED
 * calling session, holds the target to that session's scope, and keys every
 * mutation on a `requestKey` so a retry cannot deliver twice. The authority
 * table (`station-control-policy.ts`) makes the tool-side check an early,
 * typed answer.
 *
 * The input schemas are STRICT and carry no approval mode, model or
 * environment: a message sent here runs under the target Agent's saved
 * defaults, so nothing a caller passes can widen what the callee may do. An
 * unknown field is a validation error rather than a silently ignored one.
 *
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import { z } from 'zod';

import { CHAT_INPUT_MAX_CHARS } from '../../src-shared/chat-input-limits.js';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const SESSION_CONTROL_API = '/api/orchestration/session-control';

/** The longest a single `wait_session` call holds; the caller re-calls. */
const WAIT_SESSION_MAX_TIMEOUT_MS = 50_000;

const sessionId = z
  .string()
  .min(1)
  .max(512)
  .describe(
    'The Session to act on: a sessionId or conversationId from another Station Control tool (send_message, delegate_task, list_conversations).',
  );

const requestKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .describe(
    'A fresh unique string (a UUID is fine) naming THIS request. Reuse it only to retry the same call: Station then returns the first answer instead of acting twice. The same key with different arguments is refused (request_key_conflict).',
  );

export const sendToSessionInputSchema = z
  .object({
    sessionId,
    text: z
      .string()
      .trim()
      .min(1)
      .max(CHAT_INPUT_MAX_CHARS)
      .describe('The message to deliver to the Session.'),
    mode: z
      .enum(['auto', 'start', 'steer'])
      .default('auto')
      .describe(
        '`auto` (default): steer a running Session, start an idle one. `start`: only start a turn on an idle Session (a running one answers session_busy). `steer`: only add to a running turn (an idle one answers no_active_turn).',
      ),
    requestKey,
  })
  .strict();

export const interruptSessionInputSchema = z
  .object({
    sessionId,
    turnId: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'Interrupt only this turn; it is refused as already finished if another turn is running.',
      ),
    requestKey,
  })
  .strict();

export const waitSessionInputSchema = z
  .object({
    sessionId: sessionId.describe(
      'The Session to wait on: pass the sessionId send_to_session returned.',
    ),
    until: z
      .enum(['turn-settled', 'idle'])
      .describe(
        '`turn-settled`: a turn finished after `afterEventCursor` (without one, the turn running now). `idle`: no turn is running.',
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(WAIT_SESSION_MAX_TIMEOUT_MS)
      .default(30_000)
      .describe(
        `How long to wait, at most ${WAIT_SESSION_MAX_TIMEOUT_MS} ms. Timing out only stops this wait: the Session keeps running. Call again to keep waiting.`,
      ),
    afterEventCursor: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'With until=turn-settled: the `eventCursor` send_to_session (or a previous wait) returned. Use it so a turn that finished before this call is still seen.',
      ),
  })
  .strict();

const SEND_TO_SESSION_DESCRIPTION =
  "Send a message to another Session in your Project: it starts a turn if the Session is idle, or steers the turn it is running (once, when its engine supports it). The Session runs under its own Agent's saved settings; you cannot change its approvals, model or environment. Returns the sessionId, the turnId and an `eventCursor`; pass the sessionId and cursor to wait_session (until=turn-settled) to wait for the turn to finish. If the Session is busy and cannot take the message, it answers `session_busy` (or `no_active_turn` for mode `steer` on an idle Session); nothing is sent and the same requestKey may be reused to try again. Repeating a call that delivered returns its first answer (`replayed: true`) and never delivers twice; use a new requestKey for each new message. An `indeterminate` answer means the message may have been delivered: do not send it again under a new key.";

const INTERRUPT_SESSION_DESCRIPTION =
  'Interrupt the turn another Session in your Project is running. It stops the Session cooperatively (forcing it only if the engine does not stop). Answers `no-active-turn` when nothing is running (nothing happened, so the same requestKey may be reused). Repeating a call that interrupted returns its first answer; use a new requestKey for a new interrupt.';

const WAIT_SESSION_DESCRIPTION = `Wait, for at most ${WAIT_SESSION_MAX_TIMEOUT_MS / 1000} seconds, until a Session you can read finishes a turn (\`turn-settled\`) or has no turn running (\`idle\`). It only observes: when it times out, the Session is left running and you can call it again. After send_to_session, wait with until=turn-settled and the returned afterEventCursor (idle can read true before the turn has begun). Returns \`settled\`, \`timedOut\`, the Session's \`state\` and, when a turn finished, \`settledTurn\` with its outcome. It watches only the Session you name: if a newer Session now serves its conversation, the answer carries \`superseded: true\` and \`currentSessionId\`, so wait on that one instead. At most 4 waits per session and 256 in all run at once.`;

type ToolBody = Record<string, unknown>;

/** The route's answer as a tool result; a transport failure reads as one. */
async function callRoute(
  path: string,
  init: { method: 'GET' | 'POST'; body?: ToolBody; signal?: AbortSignal },
) {
  try {
    return jsonToolResult(
      await api(path, {
        method: init.method,
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      }),
    );
  } catch (error) {
    // `api` throws only when Station did not answer with JSON (it is down, or
    // the call was cancelled): nothing is known about the effect.
    return jsonToolResult({
      success: false,
      code: 'session_control_unavailable',
      error:
        error instanceof Error && error.name === 'AbortError'
          ? 'The call was cancelled.'
          : 'Station did not answer. If this was a send or an interrupt, repeat the call with the SAME requestKey to learn whether it took effect.',
    });
  }
}

export function registerSessionTools(registry: StationControlToolRegistry) {
  registry.toolWithSchema(
    'send_to_session',
    SEND_TO_SESSION_DESCRIPTION,
    sendToSessionInputSchema,
    async (input) =>
      callRoute(`${SESSION_CONTROL_API}/send`, {
        method: 'POST',
        body: input,
      }),
  );

  registry.toolWithSchema(
    'interrupt_session',
    INTERRUPT_SESSION_DESCRIPTION,
    interruptSessionInputSchema,
    async (input) =>
      callRoute(`${SESSION_CONTROL_API}/interrupt`, {
        method: 'POST',
        body: input,
      }),
  );

  registry.toolWithSchema(
    'wait_session',
    WAIT_SESSION_DESCRIPTION,
    waitSessionInputSchema,
    async (input, context) => {
      const query = new URLSearchParams({
        until: input.until,
        timeoutMs: String(input.timeoutMs),
        ...(input.afterEventCursor !== undefined
          ? { afterEventCursor: String(input.afterEventCursor) }
          : {}),
      });
      return callRoute(
        `${SESSION_CONTROL_API}/${encodeURIComponent(input.sessionId)}/wait?${query}`,
        { method: 'GET', signal: context.mcpReq.signal },
      );
    },
  );
}
