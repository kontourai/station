import { PRINCIPAL_UNRESOLVED_CODE } from '@kontourai/station-contracts/principal';
import {
  ENGINE_SESSION_BINDING_DEAD_CODE,
  ENGINE_TURN_FAILED_CODE,
} from '@kontourai/station-contracts/provider';
import { SESSION_ENDED_REJECTION_CODE } from '@kontourai/station-contracts/session-lifecycle';

/**
 * Client-side translation layer for chat/provider-connection failures — archive#191
 *Turns raw, developer-shaped error text (an HTTP status + a server or
 * SDK message string) into targeted, actionable copy for the three named
 * first-run failure classes, with an honest fallback for everything else.
 *
 * This is the *fallback net* behind the pre-send readiness guard
 * (`ChatEmptyState.tsx` / `onboardingGateUtils.ts`, archive#191) — it exists for
 * failures the guard doesn't cover: a dismissed setup banner, a
 * mid-conversation connection failure, or a model-override failure.
 *
 * Deliberately pattern-matched, not exact-string-matched: the real AWS
 * Bedrock "model not enabled" exception text could not be captured live in
 * planning (no repo precedent, no live AWS call performed — see the plan's
 * Stop-short risks). (archive#196) is where the live text gets confirmed against
 * these patterns; until then these are documented as fixture-based.
 *
 * Consumed by both the pre-stream fetch-error path
 * (`useActiveChatSessionMessaging.ts`, via the SDK's `ChatHttpError`) and the
 * mid-stream SSE error path (`useStreamingMessage.ts`, via `writeSSEError`'s
 * `{ errorText, statusCode }` shape) — this module is the single source of
 * classification for both, replacing `useStreamingMessage.ts`'s previous
 * undocumented, partial `isModelError` regex classifier.
 */

export interface ChatErrorTranslation {
  /** Short, human-readable summary of what went wrong. */
  title: string;
  /** One or two sentences explaining the failure in plain language. */
  body: string;
  /** Optional actionable next step. Always present on the unknown fallback. */
  hint?: string;
  /**
   * archive#1827: true when this classification's underlying failure is a
   * permanently unusable conversation binding — either the native engine
   * session is gone or its workspace binding is unsafe to resume. Retrying
   * the same turn cannot help; callers must offer a fresh chat instead.
   */
  terminalSession?: boolean;
  /**
   * archive#1827: true when `formatChatErrorDisplay` should append the raw
   * underlying message as a clearly-labeled, visually secondary section
   * (a blockquote under a rule) rather than only surfacing the translated
   * copy — "for bug reports, not as the headline" per the ticket. Every
   * existing translation leaves this unset (unchanged display).
   */
  disclosureRaw?: boolean;
}

export interface ChatErrorInput {
  /** HTTP status code, when known (pre-stream fetch failures, 401s). */
  status?: number;
  /**
   * The raw underlying message. Callers should pass whichever of
   * `errorText` / `error` / `message` the wire shape actually populated —
   * see the mid-stream blind-spot note in `useStreamingMessage.ts`.
   */
  message: string;
  /**
   * archive#1827: the originating `RuntimeErrorEvent.code`, when the caller
   * has one (the live orchestration event path does; the persisted
   * `[SYSTEM_EVENT] [CHAT_ERROR]` marker embeds it too — see
   * `ChatDockBody.tsx`). Structured classification checked BEFORE any
   * prose pattern below: unlike every other case in this file (client-only
   * display copy with no repo precedent to test against — see the module
   * doc comment), this one has an unambiguous backend-authoritative signal,
   * so using it is strictly better than pattern-matching the same failure's
   * English a second time.
   */
  code?: string;
}

/**
 * A stream the *client* ended — a closed tab, a lost connection, or the stop
 * button — surfaced by `StreamPipeline`'s abort check as "Stream aborted by
 * client". Distinct from every pattern below: nothing about the Model
 * connection is wrong, so the connection-settings hint is actively
 * misleading (archive#797).
 *
 * Deliberately narrowed to the one string this stack actually throws. A bare
 * `AbortError` alternative was dropped in review: `errorMessage` reads only
 * `.message`, where a DOM abort carries its name in `.name`, so it would not
 * have matched a real client abort — while it *would* have matched an
 * unrelated internal abort (a tool-call timeout, say) and told the user
 * nothing was wrong with their connection.
 */
const ABORTED_PATTERN = /\bStream aborted by client\b/i;

/**
 * archive#1207: matches BOTH stall-watchdog shapes, not just the direct
 * chat path — 2 caught that the original pattern
 * (`/connection to Station stalled/i`) only matched
 * `ChatStreamStallError`'s own message (`chatRuntimeStream.ts`). Under
 * `managed-chat-orchestration` (the exact config this rework targets), a
 * stalled turn instead arrives as the station-agent bridge's
 * `runtime.error`, whose message is `turnRejectionMessage`-wrapped:
 * `Station agent did not accept the task turn: station-agent chat bridge
 * stalled — no response for 45s` (`station-agent-adapter.ts`). That prefix
 * would have fallen through to the generic fallback and told the user to
 * "check your Model connection settings" — defeating half the fix. Both
 * messages share the literal substring "stalled — no response for
 * <N>s", so matching on that (rather than either message's own prefix)
 * classifies both without needing to enumerate each wrapper shape.
 *
 * Distinct from `ABORTED_PATTERN`: nothing *stopped* the response on
 * purpose, it just never came back, so the copy says "stalled" rather than
 * "stopped" and still offers Retry.
 */
const STALLED_PATTERN = /stalled — no response for \d+s/i;

const CREDENTIALS_PATTERN =
  /credential|accessKeyId|secretAccessKey|UnrecognizedClientException|InvalidSignatureException|ExpiredToken/i;

const BEDROCK_ACCESS_PATTERN =
  /AccessDeniedException|isn't authorized to invoke|don't have access to the model|ValidationException.*on-demand throughput/i;

const UNREACHABLE_PATTERN =
  /ECONNREFUSED|fetch failed|ECONNRESET|EHOSTUNREACH|Cannot connect/i;

const OLLAMA_PATTERN = /ollama/i;

/**
 * The agent exists on disk but failed to register because its configured
 * model couldn't resolve against the live provider catalog (e.g. a Bedrock
 * model ID on an Ollama-only connection). Distinct from a connection
 * problem: the connection is fine, the agent's model is wrong. The generic
 * fallback's former Model-connection hint was actively misleading here
 * (#chat).
 */
const NOT_LAUNCHABLE_PATTERN = /not (currently )?launchable/i;

/**
 * archive#3299: the stream ended without a well-formed body — the client
 * opened a response stream and got a short, non-parseable body instead of a
 * reply (observed live: the server was answering 401 and the SSE machinery
 * surfaced `Failed to execute 'close' on 'ReadableStreamDefaultController':
 * Unexpected end of JSON input`). Both tokens are internals naming a JS API
 * or a parser state, not anything the user did or can act on; neither may
 * be the headline. Checked AFTER the status/credential branches so a known
 * HTTP condition (e.g. that 401) always wins over this shape, and the hint
 * deliberately does not assert that retrying helps — in the observed
 * instance (a stale credential, archive#3297) it would not have.
 */
const STREAM_BODY_ENDED_PATTERN =
  /ReadableStream|Unexpected end of JSON input/i;

/**
 * The one translation for that shape — a named constant because two exports
 * consume it: the `translateChatError` branch below, and
 * `describeInternalStreamFailure`, the deliberately narrow entry point for
 * surfaces (the session failure banner) whose contract is to quote recorded
 * causes VERBATIM and may rewrite only text with no user-meaningful content.
 */
const STREAM_BODY_ENDED_TRANSLATION: ChatErrorTranslation = {
  title: 'The reply stream ended early',
  body: 'This Station’s connection returned an incomplete response instead of a reply, so nothing more arrived for this turn.',
  hint: 'This can be temporary — if it keeps happening, check this Station’s connection and credentials.',
  disclosureRaw: true,
};

/**
 * archive#3299, banner-side: returns product copy ONLY when the text's
 * entire information content is a browser/parser internal (the stream-ended
 * shape above), else `null` so the caller quotes the recorded cause
 * verbatim. Deliberately NOT the full `translateChatError` table: a session
 * failure cause like `Engine transport failed: ECONNREFUSED <host> while
 * resolving <path>` carries real diagnostic content, and rewriting it to a
 * pattern-guessed cause ("local model server is unreachable") would
 * attribute a meaning its producer never stated — the same defect class
 * this ticket fixes, in the opposite direction.
 */
export function describeInternalStreamFailure(text: string): string | null {
  return STREAM_BODY_ENDED_PATTERN.test(text)
    ? STREAM_BODY_ENDED_TRANSLATION.body
    : null;
}

/**
 * archive#1827 fallback net: only consulted when no `code` was supplied
 * (see `ChatErrorInput.code`'s doc comment) — a caller that persisted the
 * marker before this field existed, or an older client build. Narrowed to
 * the shape Claude's CLI actually emits ("No conversation found with
 * session ID:...") rather than a broad "not found", so it cannot swallow
 * an unrelated 404-shaped message.
 */
const TERMINAL_SESSION_PATTERN = /no conversation found with session id/i;

const CONTINUATION_WORKSPACE_CODES = new Set([
  'continuation_workspace_project_context_missing',
  'continuation_workspace_corrupt_worktree_binding',
  'continuation_workspace_worktree_gone',
  'continuation_workspace_different_project',
  'continuation_workspace_worktree_moved',
  'continuation_workspace_direct_mismatch',
  'continuation_workspace_unbound',
]);

/**
 * Translates a raw chat/provider error into targeted, non-raw copy.
 *
 * Classification order (first match wins). archive#3120: every structured
 * `code` check now runs BEFORE every prose-pattern check, genuinely, not
 * just in the numbering below — moved here from further down in the
 * function so a future prose pattern can never preempt a backend-supplied
 * `code` by accident, not just "review confirmed none of today's prose
 * patterns collide."
 *   -3. `code === PRINCIPAL_UNRESOLVED_CODE` (archive#4518) -> the request's
 *       caller could not be resolved to a principal — a deterministic authz
 *       failure, never a temporary one, so the hint never claims retrying
 *       may help.
 *   -2. `code` identifies a continuation workspace refusal -> the binding is
 *       unsafe to resume.
 *   -1. `code` identifies a terminal engine binding (archive#1827) -> this
 *       specific native session is gone; retrying cannot help. When `code`
 *       is absent, falls back to matching the engine's own English
 *       (`TERMINAL_SESSION_PATTERN`) as a last resort — still evaluated at
 *       this same point, not lower in the function.
 *   0. Native `transport_*` codes (the FFI contract — see the `switch`).
 *   1. Client-abort-shaped message (prose) -> the response was stopped, not
 *      failed.
 *   2. Stall-watchdog-shaped message (prose) -> the connection went silent
 *      mid-turn (archive#1207) — a dropped/crashed transport, not a stopped
 *      response.
 *   3. 401 / credential-shaped message -> invalid Model connection credentials.
 *   4. Bedrock access-denied / on-demand-throughput-shaped message -> model
 *      not enabled for this account/region.
 *   5. Connection-refused / fetch-failed-shaped message -> local model
 *      server unreachable (Ollama-flavored when the message names Ollama).
 *   6. Agent-not-launchable-shaped message -> the agent's model isn't
 *      available on the configured connection; the user should pick a
 *      different model, not check their connection.
 *   7. Stream-ended-without-a-parseable-body-shaped message (archive#3299)
 *      -> the response stream closed on an incomplete body. Last of the
 *      shapes on purpose: it describes HOW the failure surfaced, not why,
 *      so every recognized cause above outranks it.
 *   8. Fallback -> the raw message plus a hedged retry hint that asserts
 *      nothing about the cause. Never a silent swallow or an unsupported
 *      assertion (archive#3299: "Retry your request." was such an
 *      assertion — a stale credential does not improve on retry).
 */
export function translateChatError(
  input: ChatErrorInput,
): ChatErrorTranslation {
  const { status, message, code } = input;
  const text = message || '';

  // A dispatch refused because the session's lifecycle already ended — a
  // Station-side refusal, not an agent failure. The server's message is
  // already user-readable, but the structured code is what lets this branch
  // claim "ended" honestly instead of pattern-matching lifecycle prose.
  if (code === SESSION_ENDED_REJECTION_CODE) {
    return {
      title: 'This chat has ended',
      body:
        text ||
        'This session has already ended, so it cannot take another message.',
      hint: 'Start a new chat to continue.',
      terminalSession: true,
    };
  }

  // archive#4518: the request's caller could not be resolved to a principal
  // (`PrincipalUnresolvedError`, `principal-resolver.ts`) — a deterministic
  // authz failure (no verified identity, no home-possession/tenant authority
  // fact for this request), never a transient one. The generic fallback's
  // "Retrying may help if this was a temporary failure" hint would be false
  // here: the SAME request, same credential, fails the SAME way every time.
  if (code === PRINCIPAL_UNRESOLVED_CODE) {
    // (archive#4518): the body must be a short, human CANNED
    // string, never the raw server message — `text` here is
    // `PrincipalUnresolvedError`'s engineering-shaped
    // "Unable to resolve a principal: <reason>", which is exactly the
    // archive#3120-class defect this file documents elsewhere (carrying an internal
    // string faithfully into a human headline). A body that fell back to
    // `text` when present (which it always was) meant it WAS the headline.
    //
    // deliberately NO `disclosureRaw` here.
    // This error's only delivery path is the pre-stream `/chat` 400 handled
    // by `useActiveChatSessionMessaging`, which builds its ephemeral bubble
    // straight from this translation and never calls
    // `formatChatErrorDisplay` (the only reader of `disclosureRaw`) — and
    // the SSE `[SYSTEM_EVENT] [CHAT_ERROR]` marker path that DOES call it
    // can't emit this code either, because a turn that never started (this
    // IS "never started" — resolution fails before dispatch) never reaches
    // the marker-writing settle path. `disclosureRaw: true` was therefore a
    // flag nothing derives — always inert for this branch, not "still
    // carries the raw text somewhere for bug reports": it never does. The
    // canned body above is the whole delivery.
    return {
      title: "This Station couldn't verify who's asking",
      body: "This device isn't authorized to chat on this Station yet. It needs to be paired and approved before it can send messages.",
      hint: 'This will not resolve on its own by retrying — pair (or re-pair) this device and try again.',
    };
  }

  if (code && CONTINUATION_WORKSPACE_CODES.has(code)) {
    return {
      title: "Can't resume",
      body: text || 'Unsafe workspace.',
      hint: 'New chat.',
      terminalSession: true,
    };
  }

  if (code === ENGINE_TURN_FAILED_CODE) {
    return {
      title: 'This turn did not complete',
      body: 'The engine reported an error for this turn.',
      hint: 'Review the engine message below.',
      disclosureRaw: true,
    };
  }

  if (
    code === ENGINE_SESSION_BINDING_DEAD_CODE ||
    (code === undefined && TERMINAL_SESSION_PATTERN.test(text))
  ) {
    // #765 A1: no longer `terminalSession` — the CONVERSATION survives this
    // failure. Only the engine-native session binding is dead; the server's
    // continuation seam reserves a fresh child session for the next turn and
    // refuses to re-present a cursor a dead binding already disproved
    // (`conversation-lineage.ts`), carrying the transcript forward as a seed
    // when no trustworthy cursor exists. So "send it again" is a true claim
    // now, where the pre-#765 copy could only honestly offer a new chat.
    return {
      title: "This conversation's engine session was lost",
      body: 'The engine could not reopen the native session behind this conversation, so this turn failed.',
      hint: 'Send your message again — the conversation continues in a fresh engine session — or start a new chat.',
      disclosureRaw: true,
    };
  }

  // Native transport codes are the FFI contract. `message` is display-only:
  // never infer the class from its wording, because Rust may reword it.
  switch (code) {
    case 'transport_capacity':
      return {
        title: 'Station is handling too many requests',
        body: text || 'This Station has too many concurrent requests.',
        hint: 'Retry your request in a moment.',
      };
    case 'transport_timeout':
      return {
        title: 'Connection to this Station timed out',
        body: text || 'The connection timed out.',
        hint: 'Check that Station is reachable, then Retry.',
      };
    case 'transport_tls':
      return {
        title: 'Secure connection to this Station failed',
        body: text || 'The secure connection failed.',
        hint: 'Check its address, certificate, and device clock, then Retry.',
      };
    case 'transport_reset':
      return {
        title: 'Connection to this Station was interrupted',
        body: text || 'The connection was interrupted.',
        hint: 'Retry to reconnect and resend your saved message.',
      };
    case 'transport_dns':
      return {
        title: 'Station address could not be resolved',
        body: text || 'The Station address could not be resolved.',
        hint: 'Check the selected Station address, then Retry.',
      };
    case 'transport_refused':
    case 'transport_unreachable':
    case 'transport':
      return {
        title: 'Station is unreachable',
        body: text || 'The connection to this Station failed.',
        hint: 'Check that Station is running at the selected address, then Retry.',
      };
  }

  if (code === 'resource_engine_start_capacity') {
    return {
      title: 'Another engine is starting',
      body: text || 'Another engine start still owns the start slot.',
      hint: 'Retry after that start settles.',
    };
  }

  if (ABORTED_PATTERN.test(text)) {
    return {
      title: 'Response stopped before it finished',
      body: 'The connection to this Station ended while the model was still responding, so the turn was cut short. Nothing is wrong with the Model connection.',
      hint: 'Your message was kept — send it again to retry.',
    };
  }

  if (STALLED_PATTERN.test(text)) {
    return {
      title: 'Station stopped responding',
      body: 'The connection went silent mid-turn — no response arrived for a while. This looks like a dropped connection or a Station restart, not a problem with your Model connection.',
      hint: 'Your message was kept — Retry to reconnect and resend it.',
    };
  }

  if (status === 401 || CREDENTIALS_PATTERN.test(text)) {
    return {
      title: 'Model connection credentials were rejected',
      body: 'The credentials for this Model connection are invalid or have expired.',
      hint: 'Open Connections → Models and update the access key, secret, or token for this connection, then retry.',
    };
  }

  if (BEDROCK_ACCESS_PATTERN.test(text)) {
    return {
      title: 'Model is not enabled for this account/region',
      body: "This model isn't enabled for your AWS account in the selected region yet.",
      hint: 'Open the AWS Bedrock console for this region, request or verify model access, then retry — or choose a different Model connection.',
    };
  }

  if (UNREACHABLE_PATTERN.test(text)) {
    const isOllama = OLLAMA_PATTERN.test(text);
    return {
      title: isOllama
        ? 'Ollama server is unreachable'
        : 'Local model server is unreachable',
      body: isOllama
        ? 'Station could not reach the local Ollama server.'
        : 'Station could not reach the configured local model server.',
      hint: isOllama
        ? 'Make sure Ollama is running and reachable at its configured URL, then retry.'
        : 'Check that the server is running and reachable, then retry.',
    };
  }

  if (NOT_LAUNCHABLE_PATTERN.test(text)) {
    return {
      title: 'Agent model is not available',
      body: "This agent's configured model isn't available on the current connection, so it couldn't start.",
      hint: 'Select a different model from the model picker above, or update the agent\u2019s model setting to one the connection provides.',
    };
  }

  // archive#3299: see STREAM_BODY_ENDED_PATTERN. Placed after every
  // status/credential/transport branch on purpose \u2014 this is the shape of the
  // failure, not its cause, so any recognized cause outranks it.
  if (STREAM_BODY_ENDED_PATTERN.test(text)) {
    return STREAM_BODY_ENDED_TRANSLATION;
  }

  return {
    title: 'Error',
    body: text || 'An unknown error occurred.',
    // archive#3299: the fallback classified nothing, so it must not assert
    // that retrying helps \u2014 that is a claim about a cause it does not know.
    hint: 'Retrying may help if this was a temporary failure.',
  };
}

/**
 * Renders a `ChatErrorTranslation` as the markdown chat copy shown to the
 * user — shared by the live SSE path (`useStreamingMessage.ts`), the
 * pre-stream ephemeral bubble (`useActiveChatSessionMessaging.ts`), and the
 * persisted-marker reload path (`ChatDockBody.tsx`) so a translated error
 * reads identically whether it's live or restored after a reload.
 *
 * `rawMessage` is only used when `translation.disclosureRaw` is set
 * (archive#1827): the engine's own text, appended as a clearly-labeled,
 * visually secondary section — a blockquote under a rule, never the
 * headline — "for bug reports, not as the headline" per the ticket. This
 * codebase's markdown renderer has no raw-HTML support (no `rehype-raw`),
 * so a literal collapsible `<details>` widget isn't available here; a
 * blockquote is the closest de-emphasized treatment markdown-only rendering
 * can express. Every existing translation leaves `disclosureRaw` unset, so
 * this is purely additive — their display is byte-identical to before.
 */
/**
 * #765 A1: translation for a runtime-error part rehydrated from the durable
 * event projection (`runtime-event-projection.ts` writes
 * `⚠️ <raw engine message>` with `runtimeError: true` and, when the event
 * carried one, `runtimeErrorCode`). Returns the same translated markdown the
 * live path shows, or `null` when the code is not one this table maps —
 * an uncoded or unrecognised failure keeps its verbatim engine prose, the
 * same honesty rule the live `turnHandlers.ts` path applies.
 */
export function translateProjectedRuntimeError(
  text: string,
  code: string,
): string | null {
  if (
    code !== ENGINE_SESSION_BINDING_DEAD_CODE &&
    code !== ENGINE_TURN_FAILED_CODE
  )
    return null;
  const match = /^⚠️ ([\s\S]*?)( \(repeated \d+×\))?$/.exec(text);
  const raw = match?.[1] ?? text;
  const repeatSuffix = match?.[2] ?? '';
  const display = formatChatErrorDisplay(
    translateChatError({ message: raw, code }),
    raw,
  );
  return repeatSuffix ? `${display}\n${repeatSuffix.trim()}` : display;
}

export function formatChatErrorDisplay(
  translation: ChatErrorTranslation,
  rawMessage?: string,
): string {
  const lines = [`**${translation.title}**`, '', translation.body];
  if (translation.hint) {
    lines.push('', translation.hint);
  }
  if (translation.disclosureRaw && rawMessage) {
    lines.push(
      '',
      '---',
      '',
      'Raw engine message (for bug reports):',
      '',
      `> ${rawMessage.replace(/\n/g, '\n> ')}`,
    );
  }
  return lines.join('\n');
}
