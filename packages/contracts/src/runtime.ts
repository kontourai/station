export interface ToolCallResponse {
  success: boolean;
  response?: unknown;
  error?: string;
  metadata?: { toolDuration?: number };
}

export interface AgentInvokeResponse {
  success: boolean;
  response?: string;
  error?: string;
  toolCalls?: Array<{ name: string; arguments: unknown; result?: unknown }>;
}

export interface WorkflowMetadata {
  id: string;
  label: string;
  filename?: string;
  lastModified?: string;
}

export interface SessionMetadata {
  sessionId: string;
  lastTs: string;
  sizeBytes?: number;
}

export interface MemoryEvent {
  ts: string;
  sessionId: string;
  actor: 'USER' | 'ASSISTANT' | 'TOOL';
  content: string;
  meta?: Record<string, unknown>;
}

export interface ConversationStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  toolCalls: number;
  estimatedCost: number;
}

export interface ConversationModelStats extends ConversationStats {
  contextTokens: number;
}

/**
 * How a `ConversationStatsResponse`'s figures were measured (station#1299,
 * station#3201). Present so a reader can tell a measured zero from a
 * measurement nobody took, and can say WHICH engine did not report a class
 * of figures rather than rendering an unexplained grid of dashes.
 */
export interface ConversationStatsMeasurement {
  /**
   * - `station-memory` — Station's own engine accounted the turn as it ran
   *   it, so an absent field means the accounting genuinely recorded none.
   * - `engine-events` — folded from the engine's canonical runtime events
   *   (`token-usage.updated`/`turn.completed`/`tool.completed`), so an
   *   absent field means the engine never reported that measurement, and
   *   `estimatedCost`, when present, is the provider's own figure carried
   *   verbatim rather than a Station price-table estimate.
   */
  source: 'station-memory' | 'engine-events';
  /**
   * Provider id observed on the folded events (`claude`, `codex`, `acp`, …).
   * Only meaningful with `source: 'engine-events'`; absent when the stream
   * carried no provider.
   */
  provider?: string;
}

/**
 * **Every measurement is optional, and absent never means zero**
 * (station#3201). A field is present only when something actually measured
 * it: `estimatedCost: undefined` means no cost was ever reported, while
 * `estimatedCost: 0` means a reported zero. Renderers must show these
 * differently — an em-dash, never `0` or `$0.0000`.
 *
 * This widened the pre-#3201 contract, which required every one of these as
 * a number and so had no way to say "not measured"; that is precisely how
 * an external-engine session came to render six invented figures beside one
 * real one. Producers may now omit; consumers must handle `undefined`.
 * `modelId` and the two event-derived counts stay required — Station
 * observes `turn.completed`/`tool.completed` itself, so zero there is a
 * genuine count of zero.
 */
export interface ConversationStatsResponse {
  conversationId?: string;
  modelId: string;
  turns: number;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Provider-reported or Station-computed; see {@link ConversationStatsMeasurement}. */
  estimatedCost?: number;
  /**
   * Prompt-cache tokens the engine reported (station#4196). Additive and
   * optional: absent means the engine never reported a cache figure —
   * never a measured zero. Whether these may be SUMMED with `inputTokens`
   * is a per-provider declaration
   * (`PROVIDER_PROMPT_CACHE_INCLUSIVITY`,
   * `@kontourai/station-shared/usage-fold`): only a provider declared
   * `'disjoint'` backs `input + cacheRead + cacheWrite` as the prompt-side
   * total; for every other declaration a renderer shows the components
   * separately rather than summing.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  contextWindowPercentage?: number;
  systemPromptTokens?: number;
  mcpServerTokens?: number;
  userMessageTokens?: number;
  assistantMessageTokens?: number;
  contextFilesTokens?: number;
  modelStats?: Record<string, ConversationModelStats>;
  notFound?: true;
  measurement?: ConversationStatsMeasurement;
}

const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isConversationModelStats(
  value: unknown,
): value is ConversationModelStats {
  if (!isPlainRecord(value)) return false;
  const candidate = value;
  return [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'contextTokens',
    'turns',
    'toolCalls',
    'estimatedCost',
  ].every((key) => isFiniteNonnegative(candidate[key]));
}

/** One wire validator shared by the route, SDK, and UI-facing hook. */
export function parseConversationStatsResponse(
  value: unknown,
): ConversationStatsResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  const requiredNumbers = ['turns', 'toolCalls'] as const;
  /**
   * Optional because "not measured" must survive the wire (station#3201).
   * Absence is accepted; a PRESENT value is still validated, so a garbage
   * or negative figure is rejected rather than quietly rendered.
   */
  const optionalNumbers = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'estimatedCost',
    'systemPromptTokens',
    'mcpServerTokens',
    'userMessageTokens',
    'assistantMessageTokens',
    'contextFilesTokens',
    'contextTokens',
    'contextWindowPercentage',
  ] as const;
  if (
    typeof candidate.modelId !== 'string' ||
    requiredNumbers.some((key) => !isFiniteNonnegative(candidate[key])) ||
    optionalNumbers.some(
      (key) =>
        candidate[key] !== undefined && !isFiniteNonnegative(candidate[key]),
    ) ||
    (candidate.conversationId !== undefined &&
      typeof candidate.conversationId !== 'string') ||
    (candidate.notFound !== undefined && candidate.notFound !== true) ||
    !isConversationStatsMeasurement(candidate.measurement) ||
    (candidate.modelStats !== undefined &&
      (!isPlainRecord(candidate.modelStats) ||
        !Object.values(candidate.modelStats).every(isConversationModelStats)))
  )
    return undefined;
  return candidate as unknown as ConversationStatsResponse;
}

/** `undefined` is valid (the field is optional); a malformed record is not. */
function isConversationStatsMeasurement(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainRecord(value)) return false;
  return (
    (value.source === 'station-memory' || value.source === 'engine-events') &&
    (value.provider === undefined || typeof value.provider === 'string')
  );
}

export enum AgentSwitchState {
  IDLE = 'IDLE',
  WAITING = 'WAITING',
  TEARDOWN = 'TEARDOWN',
  BUILD = 'BUILD',
  READY = 'READY',
}
