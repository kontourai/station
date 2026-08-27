/**
 * The `contextInjection` sub-record of a turn provenance envelope
 * (station#2649): what Station itself composed into ONE turn's model input,
 * its grammar, and the strict parse that grammar is enforced by.
 *
 * Split out of `turn-provenance.ts` deliberately. The envelope module is
 * reached eagerly by every surface that reads a turn's engine or model
 * identity (`src-ui/src/components/chat/message-bubble/utils.ts`); this
 * record is a distinct, larger concern with its own caps and its own
 * validator, and only the fold, the card, and the share projection speak it.
 *
 * Dependency direction is one-way and must stay that way:
 * `turn-provenance.ts` imports FROM this module (its envelope field re-exports
 * the type, and its whole-envelope guard delegates to the parser here). This
 * module imports nothing from `turn-provenance.ts` — the same rule
 * `chat-context-injection.ts` follows below `chat-context.ts`, for the same
 * reason: the lower-level module owns the shared helper, so there is never a
 * cycle to break later.
 */

/** Hard cap on named knowledge sources so one turn cannot bloat a transcript. */
export const TURN_PROVENANCE_MAX_CONTEXT_SOURCES = 8;

/**
 * Terminal-event metadata key a producer stamps for the `contextInjection`
 * slot (station#2649). The only producer today is the `/chat` execution
 * engine's own record of what IT composed into the model input, relayed by
 * the station-agent adapter onto the turn's `turn.completed` event. External
 * engines (Claude Code, Codex, ACP runtimes) own their context end-to-end
 * and never stamp this key — their turns honestly carry no Station context
 * claim at all.
 */
export const CONTEXT_INJECTION_METADATA_KEY = 'contextInjection';

/**
 * Knowledge chunks retrieved (RAG) and composed into the model input.
 * Source doc filenames and counts only — NEVER the retrieved text itself
 * (the envelope's secret-free rule, #1410 AC3, applies unchanged).
 */
export interface TurnProvenanceContextKnowledge {
  /** Chunks actually composed into the injected block. */
  chunkCount: number;
  /**
   * Distinct source doc filenames of those chunks, bounded by
   * `TURN_PROVENANCE_MAX_CONTEXT_SOURCES`.
   */
  sources: string[];
  /** Distinct sources dropped from `sources` by the cap (disclosed, not silent). */
  omittedSources: number;
  approxTokens: number;
}

/** Whole-namespace inject context (`<project_rules>`) prepended to the input. */
export interface TurnProvenanceContextProjectRules {
  approxTokens: number;
}

/** Behavior guidelines from the feedback loop (`<feedback_profile>`). */
export interface TurnProvenanceContextGuidelines {
  reinforce: number;
  avoid: number;
  approxTokens: number;
}

/** Flow Agents workflow-steering context for managed agents. */
export interface TurnProvenanceContextWorkflowSteering {
  approxTokens: number;
}

/** Per-conversation negative-rating feedback (`<conversation_feedback>`). */
export interface TurnProvenanceContextConversationFeedback {
  flaggedMessages: number;
  approxTokens: number;
}

/**
 * Out-of-band ambient context the client supplied and Station composed into
 * the model input at the same choke point (#685: timezone, geolocation).
 *
 * It is recorded because it is Station-injected: without it an empty record
 * would read "Station injected nothing" on every ambient-carrying turn,
 * which is false. `approxTokens` is measured as the BYTE DELTA the
 * composition added to the input, so it counts the wrapper Station actually
 * wrote rather than the raw client string.
 */
export interface TurnProvenanceContextAmbient {
  approxTokens: number;
}

/**
 * What Station itself injected into this turn's model input, recorded AT
 * DISPATCH from the exact strings composed into the input — never
 * reconstructed after the fact (station#2649).
 *
 * Every present block REACHED the model, and an absent block did not. That
 * is a statement about effect, not intent: the `/chat` composers silently
 * drop their whole block when the user message is array-shaped with no text
 * part (an uncaptioned attachment), and the producer builds this record from
 * what the composer reports applying — never from what it set out to
 * compose. An empty record (`{}`) is therefore a real, earned observation —
 * "no Station-composed context reached the model on this turn" — and is
 * distinct from an `unavailable` slot, which says Station recorded nothing
 * either way.
 *
 * Scope: this covers the context Station itself composes at the `/chat`
 * model-facing choke point. It is NOT a census of the whole model input —
 * the agent's own system prompt, its tool schemas, and prior conversation
 * history are assembled elsewhere and are outside this record.
 *
 * `approxTokens` figures are BYTE-DERIVED ESTIMATES (utf8 bytes / 4) of the
 * real injected strings, never a tokenizer measurement — renderers must
 * label them approximate (`~N`), and must not present them as exact counts.
 */
export interface TurnProvenanceContextInjection {
  knowledge?: TurnProvenanceContextKnowledge;
  projectRules?: TurnProvenanceContextProjectRules;
  guidelines?: TurnProvenanceContextGuidelines;
  workflowSteering?: TurnProvenanceContextWorkflowSteering;
  conversationFeedback?: TurnProvenanceContextConversationFeedback;
  ambient?: TurnProvenanceContextAmbient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCountField(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Strict parse of a `contextInjection` record (the terminal-event metadata
 * value AND the observed slot value — one grammar, used by the adapter that
 * stamps it, the fold that reads it, and the envelope validator).
 *
 * Returns a NEW object holding only the declared blocks and fields, so an
 * oversized or extra-keyed input cannot ride into a persisted envelope.
 * Any malformed block rejects the WHOLE record (returns `undefined`): a
 * half-readable context claim would render as a smaller injection than
 * actually happened, which is the quiet mis-statement this envelope exists
 * to prevent — an admitted gap is the better answer.
 *
 * An empty record (`{}`) is valid and meaningful: Station injected nothing.
 */
export function parseTurnProvenanceContextInjection(
  value: unknown,
): TurnProvenanceContextInjection | undefined {
  if (!isRecord(value)) return undefined;
  const out: TurnProvenanceContextInjection = {};

  if (value.knowledge !== undefined) {
    const raw = value.knowledge;
    if (!isRecord(raw)) return undefined;
    if (
      !isCountField(raw.chunkCount) ||
      !isCountField(raw.omittedSources) ||
      !isCountField(raw.approxTokens) ||
      !Array.isArray(raw.sources) ||
      raw.sources.length > TURN_PROVENANCE_MAX_CONTEXT_SOURCES ||
      !raw.sources.every(
        (source) => isNonEmptyString(source) && source.length <= 256,
      )
    ) {
      return undefined;
    }
    out.knowledge = {
      chunkCount: raw.chunkCount,
      sources: [...(raw.sources as string[])],
      omittedSources: raw.omittedSources,
      approxTokens: raw.approxTokens,
    };
  }

  if (value.projectRules !== undefined) {
    const raw = value.projectRules;
    if (!isRecord(raw) || !isCountField(raw.approxTokens)) return undefined;
    out.projectRules = { approxTokens: raw.approxTokens };
  }

  if (value.guidelines !== undefined) {
    const raw = value.guidelines;
    if (
      !isRecord(raw) ||
      !isCountField(raw.reinforce) ||
      !isCountField(raw.avoid) ||
      !isCountField(raw.approxTokens)
    ) {
      return undefined;
    }
    out.guidelines = {
      reinforce: raw.reinforce,
      avoid: raw.avoid,
      approxTokens: raw.approxTokens,
    };
  }

  if (value.workflowSteering !== undefined) {
    const raw = value.workflowSteering;
    if (!isRecord(raw) || !isCountField(raw.approxTokens)) return undefined;
    out.workflowSteering = { approxTokens: raw.approxTokens };
  }

  if (value.conversationFeedback !== undefined) {
    const raw = value.conversationFeedback;
    if (
      !isRecord(raw) ||
      !isCountField(raw.flaggedMessages) ||
      !isCountField(raw.approxTokens)
    ) {
      return undefined;
    }
    out.conversationFeedback = {
      flaggedMessages: raw.flaggedMessages,
      approxTokens: raw.approxTokens,
    };
  }

  if (value.ambient !== undefined) {
    const raw = value.ambient;
    if (!isRecord(raw) || !isCountField(raw.approxTokens)) return undefined;
    out.ambient = { approxTokens: raw.approxTokens };
  }

  return out;
}
