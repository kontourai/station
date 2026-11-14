import { isRecord } from './record-guard.js';
import {
  ENGINE_MCP_ERROR_MAX_CHARS,
  ENGINE_MCP_SERVER_NAME_MAX_CHARS,
  ENGINE_MCP_STATUS_MAX_SERVERS,
  type EngineMcpServerState,
  type EngineMcpServerStatus,
} from './runtime-events.js';

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

/** Per-model measurements may be unreported, just like conversation totals. */
export interface ConversationModelStats
  extends Pick<ConversationStats, 'turns' | 'toolCalls'> {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  estimatedCost?: number;
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
  /**
   * From the token pair when the engine reported one, else the engine's own
   * context reading (`token-usage.updated.contextPercent`).
   */
  contextWindowPercentage?: number;
  /**
   * Costs the engine reported in its own unit, one total per unit (`credit`,
   * `EUR`, …), carried as reported and never converted to USD. Absent when
   * the engine reported none. Separate from `estimatedCost`, which is USD.
   */
  reportedCosts?: ConversationReportedCost[];
  /**
   * The engine's MCP servers as its `engine-mcp.status` events last left
   * them, folded over the conversation's events. Absent when the engine
   * reported none. Lets a reopened conversation show what a live one shows.
   */
  engineMcp?: ConversationEngineMcpStatus;
  systemPromptTokens?: number;
  mcpServerTokens?: number;
  userMessageTokens?: number;
  assistantMessageTokens?: number;
  contextFilesTokens?: number;
  modelStats?: Record<string, ConversationModelStats>;
  notFound?: true;
  measurement?: ConversationStatsMeasurement;
}

export interface ConversationReportedCost {
  unit: string;
  amount: number;
}

/** One engine MCP server in conversation stats: the event's server without its passive sign-in link. */
export type ConversationEngineMcpServer = Omit<
  EngineMcpServerStatus,
  'authUrl'
>;

/** The folded `engine-mcp.status` reports of one conversation. */
export interface ConversationEngineMcpStatus {
  /** In the engine's order, at most {@link ENGINE_MCP_STATUS_MAX_SERVERS}. */
  servers: ConversationEngineMcpServer[];
  /** The latest report said the session can reconnect a server. */
  reconnect?: true;
}

const ENGINE_MCP_SERVER_STATES: ReadonlySet<unknown> =
  new Set<EngineMcpServerState>([
    'starting',
    'ready',
    'failed',
    'needs-auth',
    'disabled',
  ]);

function isEngineMcpServerState(value: unknown): value is EngineMcpServerState {
  return ENGINE_MCP_SERVER_STATES.has(value);
}

function isToolCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One server from an event or the stats wire; anything out of bounds is refused. */
export function parseConversationEngineMcpServer(
  value: unknown,
): ConversationEngineMcpServer | undefined {
  if (!isRecord(value)) return undefined;
  const { name, state, scope, toolCount, error } = value;
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > ENGINE_MCP_SERVER_NAME_MAX_CHARS ||
    !isEngineMcpServerState(state) ||
    (scope !== 'session' && scope !== 'engine-config') ||
    (toolCount !== undefined && !isToolCount(toolCount)) ||
    (error !== undefined &&
      (typeof error !== 'string' || error.length > ENGINE_MCP_ERROR_MAX_CHARS))
  )
    return undefined;
  return {
    name,
    state,
    scope,
    ...(isToolCount(toolCount) ? { toolCount } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Fold one `engine-mcp.status` report into the servers a conversation
 * shows. A complete report replaces the list; a partial one updates the
 * servers it names in place and appends new ones, up to the bound. The
 * reconnect bit is the latest report's. The live chat and the server's
 * stats fold share this, so a reopened conversation shows the same list.
 */
export function foldEngineMcpStatus(
  current: ConversationEngineMcpStatus | undefined,
  report: { servers?: unknown; complete?: unknown; reconnect?: unknown },
): ConversationEngineMcpStatus {
  const next = new Map<string, ConversationEngineMcpServer>(
    report.complete === true
      ? []
      : (current?.servers ?? []).map((server) => [server.name, server]),
  );
  for (const raw of Array.isArray(report.servers) ? report.servers : []) {
    const server = parseConversationEngineMcpServer(raw);
    if (!server) continue;
    if (!next.has(server.name) && next.size >= ENGINE_MCP_STATUS_MAX_SERVERS)
      continue;
    next.set(server.name, server);
  }
  return {
    servers: [...next.values()],
    ...(report.reconnect === true ? { reconnect: true as const } : {}),
  };
}

/**
 * The stats wire's `engineMcp`: `undefined` when absent, `null` when its
 * shape is malformed, else the value with each server that does not parse
 * dropped (one bad entry costs only itself) and servers past the bound
 * dropped.
 */
function readConversationEngineMcp(
  value: unknown,
): ConversationEngineMcpStatus | undefined | null {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !Array.isArray(value.servers) ||
    (value.reconnect !== undefined && value.reconnect !== true)
  )
    return null;
  const servers: ConversationEngineMcpServer[] = [];
  for (const raw of value.servers) {
    if (servers.length >= ENGINE_MCP_STATUS_MAX_SERVERS) break;
    const server = parseConversationEngineMcpServer(raw);
    if (server) servers.push(server);
  }
  return { servers, ...(value.reconnect === true ? { reconnect: true } : {}) };
}

/** Bound on a wire cost unit; engines spell one as a short token. */
const REPORTED_COST_UNIT = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * At most this many cost units in one stats response. The usage fold refuses
 * a unit past it; the parser keeps the first this many rather than refusing
 * the whole response.
 */
export const CONVERSATION_REPORTED_COST_UNITS_MAX = 16;

/** A cost unit the stats wire carries (`credit`, `USD`, `EUR`). */
export function isReportedCostUnit(unit: unknown): unit is string {
  return typeof unit === 'string' && REPORTED_COST_UNIT.test(unit);
}

function isConversationReportedCosts(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry) =>
          isRecord(entry) &&
          isReportedCostUnit(entry.unit) &&
          isFiniteNonnegative(entry.amount),
      ))
  );
}

const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isConversationModelStats(
  value: unknown,
): value is ConversationModelStats {
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    ['turns', 'toolCalls'].every((key) =>
      isFiniteNonnegative(candidate[key]),
    ) &&
    [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'contextTokens',
      'estimatedCost',
    ].every(
      (key) =>
        candidate[key] === undefined || isFiniteNonnegative(candidate[key]),
    )
  );
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
    !isConversationReportedCosts(candidate.reportedCosts) ||
    (candidate.modelStats !== undefined &&
      (!isRecord(candidate.modelStats) ||
        !Object.values(candidate.modelStats).every(isConversationModelStats)))
  )
    return undefined;
  const engineMcp = readConversationEngineMcp(candidate.engineMcp);
  if (engineMcp === null) return undefined;
  return {
    ...candidate,
    ...(Array.isArray(candidate.reportedCosts) &&
    candidate.reportedCosts.length > CONVERSATION_REPORTED_COST_UNITS_MAX
      ? {
          reportedCosts: candidate.reportedCosts.slice(
            0,
            CONVERSATION_REPORTED_COST_UNITS_MAX,
          ),
        }
      : {}),
    ...(engineMcp ? { engineMcp } : {}),
  } as ConversationStatsResponse;
}

/** `undefined` is valid (the field is optional); a malformed record is not. */
function isConversationStatsMeasurement(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
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
