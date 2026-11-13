/**
 * Engine extension facts carried on ACP traffic, mapped to generic Station
 * events through the engine-extension binding table
 * (`src-shared/extension-notification-bindings.ts`).
 *
 * The table says WHICH wire shape feeds WHICH generic consumer and whether
 * that consumer is implemented; this module reads each bound wire shape's
 * payload (one reader per binding id, because each vendor spells its payload
 * differently) into a generic fact, and publishes that fact as the canonical
 * event every engine shares: `token-usage.updated.reportedCost` /
 * `contextPercent`, `model.rerouted` and `engine-mcp.status`. Nothing here is keyed on an engine name: a row's
 * wire shape is the only key, and an engine whose traffic never matches a
 * row never reaches a reader.
 *
 * Every reader is fail-closed: a malformed or out-of-bounds payload maps to
 * nothing rather than to a guessed fact.
 */
import crypto from 'node:crypto';
import {
  ENGINE_MCP_ERROR_MAX_CHARS,
  ENGINE_MCP_SERVER_NAME_MAX_CHARS,
  ENGINE_MCP_STATUS_MAX_SERVERS,
  type EngineMcpServerState,
  type EngineMcpServerStatus,
  type EngineReportedCost,
  type ModelReroutedEvent,
} from '@kontourai/station-contracts/runtime-events';
import { readInputRequestLink } from '@kontourai/station-shared/input-request';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import {
  ENGINE_EXTENSION_BINDINGS,
  ENGINE_EXTENSION_CONSUMERS,
  type EngineExtensionBinding,
  type EngineExtensionConsumerId,
  type EngineExtensionWire,
  engineExtensionBinding,
  takeUnboundExtensionNotice,
} from '../../../src-shared/extension-notification-bindings.js';
import type {
  ProviderRuntimeEvent as CanonicalRuntimeEvent,
  ProviderSession,
} from '../adapter-shape.js';

/** What a reader needs from the mapper context; a subset of `AcpMapperContext`. */
export interface EngineExtensionContext {
  provider: 'acp';
  session: ProviderSession;
  activeTurnId?: string;
  publish: (event: CanonicalRuntimeEvent) => void;
  state?: EngineExtensionState;
  logger?: {
    warn: (message: string, fields?: Record<string, unknown>) => void;
  };
}

/**
 * Adapter-owned session state the readers keep. Structurally part of
 * `AcpMapperState`, so the adapter's live session record is the store.
 */
export interface EngineExtensionState {
  /**
   * The last turn-scoped cost published per engine turn id. A frame the
   * engine repeats (a replay, a duplicate) reports the same whole-turn
   * figure; it is not published twice.
   */
  engineTurnCosts?: Map<string, number>;
}

/** Bound on the per-session maps above; the oldest entry goes first. */
const ENGINE_EXTENSION_STATE_MAX_ENTRIES = 256;
const MCP_SERVER_NAME_MAX_CHARS = ENGINE_MCP_SERVER_NAME_MAX_CHARS;
const MCP_ERROR_MAX_CHARS = ENGINE_MCP_ERROR_MAX_CHARS;
/** A model id as engines spell one: one token, at most 200 characters. */
const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,200}$/;
/** A cost unit as engines spell one (`USD`, `EUR`, `credit`). */
const COST_UNIT = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const ENGINE_ID_MAX_CHARS = 200;

/** C0 controls and DEL; built from code points so the source holds none. */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

function hasControlCharacter(value: string): boolean {
  CONTROL_CHARACTERS.lastIndex = 0;
  return CONTROL_CHARACTERS.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function engineId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ENGINE_ID_MAX_CHARS &&
    !hasControlCharacter(value)
    ? value
    : undefined;
}

function modelId(value: unknown): string | undefined {
  return typeof value === 'string' && MODEL_ID.test(value) ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** A context reading, 0-100. A reading above 100 is shown full, not dropped. */
function contextPercent(value: unknown): number | undefined {
  const percent = finiteNonNegative(value);
  return percent === undefined ? undefined : Math.min(percent, 100);
}

/** One line of engine text: controls stripped, secrets redacted, bounded. */
function engineText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const plain = value
    .replace(/\s+/g, ' ')
    .replace(CONTROL_CHARACTERS, '')
    .trim();
  if (!plain) return undefined;
  const redacted = redactSecrets(plain);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > ENGINE_EXTENSION_STATE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function base(ctx: EngineExtensionContext) {
  return {
    eventId: crypto.randomUUID(),
    provider: ctx.provider,
    threadId: ctx.session.threadId,
    createdAt: new Date().toISOString(),
    turnId: ctx.activeTurnId,
  } as const;
}

// --- Generic publishers ----------------------------------------------------

function publishContextPercent(ctx: EngineExtensionContext, percent: number) {
  ctx.publish({
    ...base(ctx),
    method: 'token-usage.updated',
    contextPercent: percent,
  });
}

function publishReportedCost(
  ctx: EngineExtensionContext,
  cost: EngineReportedCost,
  engineTurnId?: string,
) {
  if (cost.scope === 'turn' && engineTurnId && ctx.state) {
    ctx.state.engineTurnCosts ??= new Map();
    // ASSIGN, never accumulate: the frame states the whole turn's cost, so a
    // repeat of the same figure for the same engine turn is not new spend.
    if (ctx.state.engineTurnCosts.get(engineTurnId) === cost.amount) return;
    setBounded(ctx.state.engineTurnCosts, engineTurnId, cost.amount);
  }
  ctx.publish({
    ...base(ctx),
    method: 'token-usage.updated',
    reportedCost: cost,
  });
}

function publishModelRerouted(
  ctx: EngineExtensionContext,
  reroute: Omit<ModelReroutedEvent, keyof ReturnType<typeof base> | 'method'>,
) {
  ctx.publish({ ...base(ctx), method: 'model.rerouted', ...reroute });
  // A session-scope reroute means the engine pinned `toModel` as the
  // session's model; a subagent's reroute never moves the session's.
  if (reroute.scope === 'session' && reroute.toModel && !reroute.childWorkId)
    ctx.session.model = reroute.toModel;
}

function publishMcpStatus(
  ctx: EngineExtensionContext,
  servers: EngineMcpServerStatus[],
  complete: boolean,
) {
  ctx.publish({
    ...base(ctx),
    method: 'engine-mcp.status',
    servers,
    complete,
  });
}

// --- Readers, one per binding id ------------------------------------------

type Reader = (
  payload: Record<string, unknown>,
  ctx: EngineExtensionContext,
) => void;

/** Sum of `entries[unit=credit][field]`; undefined when there is no list. */
function creditSum(
  entries: unknown,
  field: 'usage' | 'value',
): number | undefined {
  if (!Array.isArray(entries)) return undefined;
  let total = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.unit !== 'credit') continue;
    const value = finiteNonNegative(entry[field]);
    if (value !== undefined) total += value;
  }
  return total;
}

/** A frame a subagent produced: it describes the child's work, not this turn's. */
function isSubagentFrame(meta: Record<string, unknown>): boolean {
  return engineId(meta.agentSubtaskId) !== undefined;
}

const KAS_FALLBACK_TRIGGERS: Readonly<
  Record<string, ModelReroutedEvent['trigger']>
> = { refusal: 'refusal', availability: 'availability' };
const V2_FALLBACK_CAUSES: Readonly<
  Record<string, ModelReroutedEvent['trigger']>
> = { refused: 'refusal', unavailable: 'availability' };

/** `_kiro/mcp/status` server states (kirocrew `mcp_report_bound.py`). */
const KAS_MCP_STATES: Readonly<Record<string, EngineMcpServerState>> = {
  connecting: 'starting',
  connected: 'ready',
  failed: 'failed',
  disabled: 'disabled',
};

function mcpServerName(value: unknown): string | undefined {
  const name = engineText(value, MCP_SERVER_NAME_MAX_CHARS + 1);
  return name && name.length <= MCP_SERVER_NAME_MAX_CHARS ? name : undefined;
}

/** One `_kiro/mcp/status` entry; the last entry for a name wins. */
function kasMcpServer(entry: unknown): EngineMcpServerStatus | undefined {
  if (!isRecord(entry)) return undefined;
  const name = mcpServerName(entry.name);
  if (!name) return undefined;
  const reported =
    typeof entry.status === 'string' ? KAS_MCP_STATES[entry.status] : undefined;
  const state: EngineMcpServerState =
    entry.failedAuthorization === true
      ? 'needs-auth'
      : (reported ?? 'starting');
  const tools = Array.isArray(entry.tools) ? entry.tools.length : undefined;
  const toolCount = finiteNonNegative(entry.toolCount) ?? tools;
  const error = engineText(entry.errorMessage, MCP_ERROR_MAX_CHARS);
  const authUrl = readInputRequestLink(entry.authorizationUrl) ?? undefined;
  const meta = isRecord(entry._meta) ? entry._meta : undefined;
  const kiro = isRecord(meta?.kiro) ? meta.kiro : undefined;
  const resource = isRecord(kiro?.resource) ? kiro.resource : undefined;
  const source = isRecord(resource?.source) ? resource.source : undefined;
  return {
    name,
    state,
    ...(toolCount !== undefined && Number.isInteger(toolCount)
      ? { toolCount }
      : {}),
    ...(error ? { error } : {}),
    ...(authUrl ? { authUrl } : {}),
    // `origin: 'client'` is a server the client passed on session/new.
    scope: source?.origin === 'client' ? 'session' : 'engine-config',
  };
}

/**
 * Readers keyed by `ENGINE_EXTENSION_BINDINGS` row id. A row whose consumer
 * is implemented must have a reader here, or be a consumer the UI owns
 * (`ENGINE_CONSUMERS_WITHOUT_SERVER_READER`); a test pins that.
 */
export const ENGINE_EXTENSION_READERS: Readonly<Record<string, Reader>> = {
  // --- usage.context-percent
  'kiro-v3.info.context-usage': (meta, ctx) => {
    if (isSubagentFrame(meta)) return;
    const usage = isRecord(meta.contextUsage) ? meta.contextUsage : undefined;
    const percent = contextPercent(
      meta.usagePercentage ?? usage?.usagePercentage,
    );
    if (percent !== undefined) publishContextPercent(ctx, percent);
  },
  'kiro-v2.metadata': (params, ctx) => {
    const percent = contextPercent(params.contextUsagePercentage);
    if (percent !== undefined) publishContextPercent(ctx, percent);
  },
  // --- usage.reported-cost
  'kiro-v3.info.turn-completion': (meta, ctx) => {
    // A subagent's completion belongs to its child work, not this turn.
    if (isSubagentFrame(meta)) return;
    const amount = creditSum(meta.promptTurnSummaries, 'usage');
    if (amount === undefined) return;
    publishReportedCost(
      ctx,
      { amount, unit: 'credit', scope: 'turn' },
      engineId(meta.turnId) ?? engineId(meta.executionId),
    );
  },
  'kiro-v3.info.session-usage': (meta, ctx) => {
    const amount = creditSum(meta.credits, 'usage');
    if (amount === undefined) return;
    publishReportedCost(ctx, { amount, unit: 'credit', scope: 'session' });
  },
  // --- model.rerouted
  'kiro-v3.info.model-fallback': (meta, ctx) => {
    const fromModel = modelId(meta.from);
    const toModel = meta.to == null ? undefined : modelId(meta.to);
    if (!fromModel || (meta.to != null && !toModel)) return;
    const childWorkId = engineId(meta.agentSubtaskId);
    publishModelRerouted(ctx, {
      fromModel,
      ...(toModel ? { toModel } : {}),
      trigger:
        (typeof meta.trigger === 'string'
          ? KAS_FALLBACK_TRIGGERS[meta.trigger]
          : undefined) ?? 'other',
      // An unknown scope is not promoted: pinning a model the session is not
      // on would be worse than missing a pin.
      scope: meta.scope === 'session' && toModel ? 'session' : 'turn',
      ...(childWorkId ? { childWorkId } : {}),
    });
  },
  'kiro-v2.model-fallback': (params, ctx) => {
    const update = isRecord(params.update) ? params.update : undefined;
    if (!update) return;
    const fromModel = modelId(update.from);
    const toModel = update.to == null ? undefined : modelId(update.to);
    const trigger =
      typeof update.cause === 'string'
        ? V2_FALLBACK_CAUSES[update.cause]
        : undefined;
    if (!fromModel || (update.to != null && !toModel) || !trigger) return;
    if (update.promoted !== undefined && typeof update.promoted !== 'boolean')
      return;
    // v2 reports the hop, then a second notice with `promoted: true` once
    // the target becomes the session's model.
    publishModelRerouted(ctx, {
      fromModel,
      ...(toModel ? { toModel } : {}),
      trigger,
      scope: update.promoted === true && toModel ? 'session' : 'turn',
    });
  },
  // --- engine-mcp.status
  'kiro-v3.mcp-status': (params, ctx) => {
    if (!Array.isArray(params.servers)) return;
    const byName = new Map<string, EngineMcpServerStatus>();
    for (const entry of params.servers) {
      const server = kasMcpServer(entry);
      if (!server) continue;
      if (
        !byName.has(server.name) &&
        byName.size >= ENGINE_MCP_STATUS_MAX_SERVERS
      )
        continue;
      byName.set(server.name, server);
    }
    publishMcpStatus(ctx, [...byName.values()], true);
  },
  'kiro-v2.mcp-server-initialized': (params, ctx) => {
    const name = mcpServerName(params.serverName);
    if (!name) return;
    publishMcpStatus(
      ctx,
      [{ name, state: 'ready', scope: 'engine-config' }],
      false,
    );
  },
  'kiro-v2.mcp-server-init-failure': (params, ctx) => {
    const name = mcpServerName(params.serverName);
    if (!name) return;
    const error = engineText(params.error, MCP_ERROR_MAX_CHARS);
    publishMcpStatus(
      ctx,
      [
        {
          name,
          state: 'failed',
          ...(error ? { error } : {}),
          scope: 'engine-config',
        },
      ],
      false,
    );
  },
};

/**
 * Consumers whose rows carry no server-side reader on purpose: the client
 * owns them, or the mapper handles them before this module.
 */
export const ENGINE_CONSUMERS_WITHOUT_SERVER_READER: ReadonlySet<string> =
  new Set(['acp.host-chrome']);

function consumerImplemented(row: EngineExtensionBinding): boolean {
  return Object.hasOwn(ENGINE_EXTENSION_CONSUMERS, row.consumer)
    ? ENGINE_EXTENSION_CONSUMERS[row.consumer as EngineExtensionConsumerId]
        .implemented
    : true;
}

function runReader(
  row: EngineExtensionBinding,
  payload: Record<string, unknown>,
  ctx: EngineExtensionContext,
): void {
  if (!consumerImplemented(row)) return;
  ENGINE_EXTENSION_READERS[row.id]?.(payload, ctx);
}

/** Map a bound engine extension notification (or vendor session update). */
export function mapEngineExtensionNotification(
  method: string,
  params: Record<string, unknown>,
  ctx: EngineExtensionContext,
): void {
  // The decoder does not validate `params`; a null or array is no payload.
  if (!isRecord(params)) return;
  const notification = engineExtensionBinding({
    kind: 'notification',
    method,
  });
  if (notification) runReader(notification, params, ctx);
  const update = isRecord(params.update) ? params.update : undefined;
  if (typeof update?.sessionUpdate === 'string') {
    const row = engineExtensionBinding({
      kind: 'session-update-kind',
      method,
      sessionUpdate: update.sessionUpdate,
    });
    if (row) runReader(row, params, ctx);
  }
}

/** Every `_meta` namespace a session-info row names, from the table itself. */
const SESSION_INFO_NAMESPACES: readonly string[] = [
  ...new Set(
    ENGINE_EXTENSION_BINDINGS.flatMap(({ wire }) =>
      wire.kind === 'session-info-kind' ? [wire.namespace] : [],
    ),
  ),
];

/** The provider-tuple key an unbound session-info kind is logged under. */
function sessionInfoNoticeTuple(namespace: string, kind: string) {
  return {
    namespace: `session_info_update._meta.${namespace}`,
    type: kind.slice(0, 64),
  };
}

/**
 * A core `session_info_update`: each vendor `_meta.<namespace>.kind` the
 * table binds is read; a kind it does not bind is logged once per process
 * and otherwise ignored.
 */
export function mapEngineSessionInfo(
  update: { _meta?: Record<string, unknown> | null },
  ctx: EngineExtensionContext,
): void {
  for (const namespace of SESSION_INFO_NAMESPACES) {
    const meta = update._meta?.[namespace];
    if (!isRecord(meta) || typeof meta.kind !== 'string') continue;
    const wire: EngineExtensionWire = {
      kind: 'session-info-kind',
      namespace,
      metaKind: meta.kind,
    };
    const row = engineExtensionBinding(wire);
    if (!row) {
      const tuple = sessionInfoNoticeTuple(namespace, meta.kind);
      if (takeUnboundExtensionNotice(ctx.provider, tuple.namespace, tuple.type))
        ctx.logger?.warn(
          'Unbound session_info_update kind; map it to a Station event or accept it as unique',
          { provider: ctx.provider, ...tuple },
        );
      continue;
    }
    // The adapter's turn ledger (`recordTurnMessage` in acp-adapter.ts) owns
    // the engine's prompt ids; nothing is published for this frame.
    if (row.consumer === 'session.message-id') continue;
    runReader(row, meta, ctx);
  }
}

/**
 * Vendor replay markers: a `session/update` whose `_meta.<namespace>.<key>`
 * is `true` repeats history during `session/load`, so it is never a live
 * fact. Kiro declares this as the `replayMarking` capability flag and marks
 * each replayed update `_meta.kiro.replay: true` (kirocrew
 * `runtime_reader_loop.py`, frames `kas/mcp-live-apply-live.jsonl`).
 */
const ACP_REPLAY_MARKERS: readonly {
  readonly namespace: string;
  readonly key: string;
}[] = Object.freeze([Object.freeze({ namespace: 'kiro', key: 'replay' })]);

export function isReplayMarkedUpdate(update: unknown): boolean {
  if (!isRecord(update) || !isRecord(update._meta)) return false;
  const meta = update._meta;
  return ACP_REPLAY_MARKERS.some(({ namespace, key }) => {
    const vendor = meta[namespace];
    return isRecord(vendor) && vendor[key] === true;
  });
}

/**
 * Core ACP `usage_update.cost`: the session's cumulative cost in the unit
 * the agent names (an ISO currency or a vendor unit). Carried as reported,
 * never converted, scope `session`.
 */
export function readAcpUsageCost(
  cost: unknown,
): EngineReportedCost | undefined {
  if (!isRecord(cost)) return undefined;
  const amount = finiteNonNegative(cost.amount);
  const unit =
    typeof cost.currency === 'string' && COST_UNIT.test(cost.currency)
      ? cost.currency
      : undefined;
  return amount !== undefined && unit
    ? { amount, unit, scope: 'session' }
    : undefined;
}
