import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  engineConnectionId,
  engineId,
  engineRuntimeId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  ConnectionQuotaResult,
  ConnectionQuotaSnapshot,
  ConnectionQuotaSnapshotUpdate,
} from '@kontourai/station-contracts/connection-quota';
import { mergeQuotaSnapshot } from '@kontourai/station-contracts/connection-quota';
import type {
  CapabilityDeliveryChannelReport,
  CapabilityUndelivered,
} from '@kontourai/station-contracts/provider';
import {
  MODEL_SELECTION_RECEIPT_METADATA_KEY,
  modelSelectionReceipt,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  ModelOptionCapabilities,
  Prerequisite,
} from '@kontourai/station-contracts/tool';
import {
  adapterSessionStartDuration,
  agentCapabilityUndelivered,
  appHomeSessions,
  codexToolServersDelivered,
  connectionQuotaReads,
  providerOps,
} from '../../telemetry/metrics.js';
import {
  abortError,
  raceWithSignal,
  throwIfAborted,
} from '../../utils/bounded-async.js';
import type { Logger } from '../../utils/logger.js';
import type {
  ProviderAdapterModelCatalog,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../adapter-shape.js';
import { buildCliRuntimePrerequisites } from '../auth/cli-auth.js';
import {
  effectiveModelMetadata,
  reportedModelMetadata,
} from '../llm/effective-model-metadata.js';
import {
  decodeChatAttachments,
  rejectFileAttachments,
} from '../sessions/chat-attachments.js';
import { mergeCapabilityDeliveryMetadata } from './capability-delivery-metadata.js';
import {
  extractStringField,
  extractThread,
  extractTurn,
  isResumeCursor,
  mapApprovalResolutionStatus,
  resolveApprovalOutcome,
} from './codex-adapter-events.js';
import {
  CodexAdapterTransport,
  createCodexProcess,
  createCodexSessionRecord,
} from './codex-adapter-transport.js';
import type { CodexSessionRecord } from './codex-adapter-types.js';
import {
  mapCodexKnobsToApprovalMode,
  resolveCodexExecutionKnobs,
} from './codex-approval-mode.js';
import {
  type CodexToolServerSkip,
  resolveCodexMcpServers,
} from './codex-mcp-passthrough.js';
import type { CodexModelOptions } from './codex-models.js';
import { terminateCodexProcess } from './codex-process-termination.js';

type CodexAdapterLogger = Pick<Logger, 'warn'>;

interface CodexAdapterOptions {
  processFactory?: (
    appHomeEnv?: Record<string, string>,
    extraArgs?: string[],
  ) => ReturnType<typeof createCodexProcess>;
  now?: () => Date;
  /**
   * App-home profile env (archive#896 wave 2, agent-engine-unification.md §6.1's
   * overlay model, channel 2) — `undefined` when the codex-runtime
   * connection has not opted in (`config.useAppHome`) or on any resolution
   * failure; the caller degrades to `undefined` rather than throwing.
   * Applied at `startSession` only — model discovery deliberately keeps
   * today's byte-identical global env (Ambiguity C).
   */
  getAppHomeEnv?: (
    credentialProfileRef?: string,
  ) => Promise<Record<string, string> | undefined>;
  /**
   * archive#1195: mints a per-session, short-lived, station-control-scoped
   * bearer token and returns the full station-control HTTP/SSE MCP endpoint
   * URL it authenticates — called ONLY when the resolved agent's
   * `toolServers` includes the canonical built-in station-control server
   * (see `resolveAgentToolServers`). `threadId` is Station's own session
   * id, used as the token's revocation key. Undefined/missing (older/test
   * callers) degrades to skipping the built-in server's delivery entirely
   * (codex-mcp-passthrough.ts never falls back to any other credential) —
   * never a thrown/blocked session start.
   */
  mintStationControlMcpAuth?: (
    threadId: string,
    tenantExecutionContext?: import('@kontourai/station-contracts/tenancy').TenantExecutionContext,
  ) => string | undefined;
  /** Best-effort cleanup counterpart to `mintStationControlMcpAuth` — called
   * on ordinary session stop. Never required to be provided; a missing
   * closure just means the token lives out its bounded TTL instead. */
  revokeStationControlMcpAuth?: (threadId: string) => void;
  logger?: CodexAdapterLogger;
  /** Test-only override; production reads are always bounded to five seconds. */
  quotaTimeoutMs?: number;
  /** Test-only cache controls; production cache is 30 seconds and 64 entries. */
  quotaCacheTtlMs?: number;
  quotaCacheMaxEntries?: number;
}

function mapReasoningEffort(options?: CodexModelOptions): string | null {
  const effort = options?.effort ?? options?.reasoningEffort;
  return typeof effort === 'string' && effort.trim() ? effort.trim() : null;
}

function mapCodexModelCatalogEntry(model: any): {
  id: string;
  name: string;
  originalId: string;
  capabilities?: ModelOptionCapabilities;
} | null {
  const id =
    typeof model?.model === 'string'
      ? model.model
      : typeof model?.id === 'string'
        ? model.id
        : null;
  if (!id) return null;
  const name =
    typeof model?.displayName === 'string' &&
    model.displayName.trim().length > 0
      ? model.displayName
      : id;
  const supportedEffortLevels: string[] = [];
  const effortLabels: Record<string, string> = {};
  if (Array.isArray(model.supportedReasoningEfforts)) {
    for (const option of model.supportedReasoningEfforts) {
      const effort =
        typeof option === 'object' &&
        option !== null &&
        typeof (option as { reasoningEffort?: unknown }).reasoningEffort ===
          'string'
          ? (option as { reasoningEffort: string }).reasoningEffort
          : null;
      if (
        effort &&
        !supportedEffortLevels.includes(effort) &&
        supportedEffortLevels.length < 16
      ) {
        supportedEffortLevels.push(effort);
        const label =
          typeof option.description === 'string' &&
          option.description.trim().length > 0 &&
          option.description.trim().length <= 128
            ? option.description.trim()
            : undefined;
        if (label) effortLabels[effort] = label;
      }
    }
  }
  const supportsFastMode =
    Array.isArray(model.serviceTiers) &&
    model.serviceTiers.some(
      (tier: unknown) =>
        typeof tier === 'object' &&
        tier !== null &&
        (tier as { id?: unknown }).id === 'fast',
    );
  const capabilities: ModelOptionCapabilities | undefined =
    supportedEffortLevels.length > 0 || supportsFastMode
      ? {
          ...(supportedEffortLevels.length > 0
            ? {
                supportsEffort: true,
                supportedEffortLevels,
                ...(Object.keys(effortLabels).length > 0
                  ? { effortLabels }
                  : {}),
              }
            : {}),
          ...(supportsFastMode
            ? { supportsFastMode: true, fastModeLabel: 'Fast' }
            : {}),
        }
      : undefined;
  return {
    id,
    name,
    originalId: id,
    ...(capabilities ? { capabilities } : {}),
  };
}

type CodexModelListResult = {
  data?: Array<any>;
  nextCursor?: string | null;
};

const CODEX_MODEL_MAX_ENTRIES = 1000;
const CODEX_MODEL_MAX_PAGES = 32;
const CODEX_MODEL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CODEX_MODEL_CACHE_TTL_MS = 30 * 1000;
const CODEX_MODEL_DISCOVERY_TIMEOUT_MS = 15 * 1000;
const CODEX_QUOTA_TIMEOUT_MS = 5_000;
/** Pull reads are short-lived so logout/profile changes cannot be masked. */
const CODEX_QUOTA_CACHE_TTL_MS = 30 * 1000;
const CODEX_QUOTA_CACHE_MAX_ENTRIES = 64;

function quotaCacheIdentity(options: {
  connectionId: string;
  credentialProfileRef?: string;
  accountScope: 'profile' | 'global';
}): { cacheKey: string; accountScope: 'profile' | 'global' } {
  const accountIdentity =
    options.accountScope === 'profile'
      ? `profile:${options.credentialProfileRef ?? ''}`
      : 'global';
  return {
    accountScope: options.accountScope,
    cacheKey: `${options.connectionId}\u0000${accountIdentity}`,
  };
}

class CodexQuotaTransportError extends Error {
  constructor(
    readonly code: string | number | undefined,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function quotaPercent(value: unknown): number | undefined {
  const candidate = number(value);
  return candidate !== undefined &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= 100
    ? candidate
    : undefined;
}

function requireValidGroup(
  present: boolean,
  valid: boolean,
  group: string,
): void {
  if (present && !valid) {
    throw new CodexQuotaTransportError(
      'invalid_rate_limit_response',
      `Codex returned a malformed ${group} rate-limit group.`,
    );
  }
}

/** Projects only values explicitly supplied by Codex; it never fills a missing window. */
/**
 * Projects the Codex app-server protocol only. The snake_case transcript
 * dialect belongs to the ferry importer; accepting it here would silently
 * guess which protocol produced the payload.
 */
export function projectCodexQuotaUpdate(
  payload: unknown,
  connectionId: string,
  observedAt: string,
  accountScope: 'profile' | 'global' = 'global',
): ConnectionQuotaSnapshotUpdate | null {
  const root = record(payload);
  if (!root) {
    throw new CodexQuotaTransportError(
      'invalid_rate_limit_response',
      'Codex returned a malformed rate-limit envelope.',
    );
  }
  const hasRateLimits = Object.hasOwn(root, 'rateLimits');
  const limits = hasRateLimits ? record(root.rateLimits) : root;
  if (!limits) {
    throw new CodexQuotaTransportError(
      'invalid_rate_limit_response',
      'Codex returned a malformed rate-limit envelope.',
    );
  }
  const windows = ['primary', 'secondary'].flatMap((id) => {
    const window = record(limits[id]);
    const usedPercent = quotaPercent(window?.usedPercent);
    if (!window) {
      requireValidGroup(Object.hasOwn(limits, id), false, id);
      return [];
    }
    requireValidGroup(true, usedPercent !== undefined, id);
    const validUsedPercent = usedPercent as number;
    const label = string(window.limitName);
    const windowDurationMins = number(window.windowDurationMins);
    const resetsAt = number(window.resetsAt);
    requireValidGroup(
      window.windowDurationMins !== undefined,
      windowDurationMins !== undefined,
      `${id}.windowDurationMins`,
    );
    requireValidGroup(
      window.resetsAt !== undefined,
      resetsAt !== undefined,
      `${id}.resetsAt`,
    );
    return [
      {
        id,
        usedPercent: validUsedPercent,
        observedAt,
        ...(label ? { label } : {}),
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ];
  });
  const credits = record(limits.credits);
  const hasCredits = credits?.hasCredits;
  const unlimited = credits?.unlimited;
  const planType = string(limits.planType);
  const limitReached = string(limits.rateLimitReachedType);
  const spendControl = record(limits.spendControl);
  requireValidGroup(
    limits.credits !== undefined && limits.credits !== null,
    Boolean(credits) &&
      typeof hasCredits === 'boolean' &&
      typeof unlimited === 'boolean' &&
      (credits?.balance === undefined ||
        string(credits?.balance) !== undefined),
    'credits',
  );
  requireValidGroup(
    limits.spendControl !== undefined && limits.spendControl !== null,
    Boolean(spendControl) &&
      typeof spendControl?.limit === 'string' &&
      typeof spendControl?.used === 'string' &&
      quotaPercent(spendControl?.remainingPercent) !== undefined &&
      number(spendControl?.resetsAt) !== undefined,
    'spendControl',
  );
  return {
    connectionId,
    provider: 'codex',
    source: 'provider-reported',
    accountScope,
    ...(planType ? { plan: { value: { type: planType }, observedAt } } : {}),
    windows,
    ...(limits.credits === null
      ? { credits: null }
      : typeof hasCredits === 'boolean' && typeof unlimited === 'boolean'
        ? {
            credits: {
              value: {
                hasCredits,
                unlimited,
                ...(string(credits?.balance)
                  ? { balance: string(credits?.balance)! }
                  : {}),
              },
              observedAt,
            },
          }
        : {}),
    ...(limitReached
      ? { limitReached: { value: limitReached, observedAt } }
      : {}),
    ...(limits.spendControl === null
      ? { spendControl: null }
      : spendControl &&
          typeof spendControl.limit === 'string' &&
          typeof spendControl.used === 'string' &&
          quotaPercent(spendControl.remainingPercent) !== undefined &&
          number(spendControl.resetsAt) !== undefined
        ? {
            spendControl: {
              value: {
                limit: spendControl.limit,
                used: spendControl.used,
                remainingPercent: quotaPercent(spendControl.remainingPercent)!,
                resetsAt: number(spendControl.resetsAt)!,
              },
              observedAt,
            },
          }
        : {}),
  };
}

export function projectCodexQuotaSnapshot(
  payload: unknown,
  connectionId: string,
  observedAt: string,
  accountScope: 'profile' | 'global' = 'global',
): ConnectionQuotaSnapshot | null {
  const update = projectCodexQuotaUpdate(
    payload,
    connectionId,
    observedAt,
    accountScope,
  );
  if (!update) return null;
  const snapshot = mergeQuotaSnapshot(undefined, update);
  return snapshot ? { ...snapshot, baselineAt: snapshot.observedAt } : null;
}

export class CodexAdapter implements ProviderAdapterShape {
  readonly provider = 'codex' as const;
  readonly metadata = {
    displayName: 'Codex',
    description: 'Codex app-server runtime over the local Codex CLI.',
    capabilities: [
      'agent-runtime',
      'session-lifecycle',
      'tool-calls',
      'interrupt',
      'approvals',
      'resume',
      'external-process',
      'image-input',
    ],
    continuity: { resume: 'same-session', fork: 'none', rewind: 'none' },
    runtimeId: engineRuntimeId('codex-runtime'),
    connectionId: engineConnectionId('codex'),
    builtin: true,
    engineId: engineId('codex'),
    abortSettlement: 'await',
    recovery: {
      sameSession: true,
      maxAttempts: 1,
      application: 'restart_resume',
      dispatchSettlement: 'provider-response',
    },
    reviewIsolation: 'read-only',
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  } as const;

  private readonly transport: CodexAdapterTransport;
  private readonly processFactory: (
    appHomeEnv?: Record<string, string>,
    extraArgs?: string[],
  ) => ReturnType<typeof createCodexProcess>;
  private readonly now: () => Date;
  private modelCatalogCache: {
    value: ProviderAdapterModelCatalog;
    observedAt: number;
  } | null = null;
  private modelCatalogFlight: Promise<ProviderAdapterModelCatalog> | null =
    null;
  private modelCatalogController: AbortController | null = null;
  private modelCatalogWaiters = 0;
  private readonly startingSessionThreads = new Set<string>();
  private readonly quotaSnapshots = new Map<
    string,
    { snapshot: ConnectionQuotaSnapshot; cachedAt: number }
  >();
  private quotaSnapshotGeneration = 0;

  constructor(private readonly options: CodexAdapterOptions = {}) {
    this.processFactory =
      options.processFactory ??
      ((env, extraArgs) => createCodexProcess(undefined, env, extraArgs));
    this.now = options.now ?? (() => new Date());
    this.transport = new CodexAdapterTransport(
      this.now,
      undefined,
      (record, payload) => this.mergeQuotaNotification(record, payload),
      (method) =>
        this.options.logger?.warn?.('Codex notification dropped', {
          provider: 'codex',
          method,
        }),
    );
  }

  async getPrerequisites(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]> {
    return buildCliRuntimePrerequisites({
      command: 'codex',
      displayName: 'Codex',
      versionArgs: ['--version'],
      authArgs: ['login', 'status'],
      installStep: 'Install the Codex CLI and ensure `codex` is on PATH.',
      authStep: 'Run `codex login` before starting Station.',
      signal: options?.signal,
    });
  }

  async readQuotaSnapshot(options: {
    connectionId: string;
    credentialProfileRef?: string;
  }): Promise<ConnectionQuotaResult> {
    // Resolve the credential namespace before consulting cache: the same
    // connection can legitimately address a profile or global Codex account.
    const appHomeEnv = await this.resolveAppHomeEnv(
      options.credentialProfileRef,
    );
    const { accountScope, cacheKey } = quotaCacheIdentity({
      connectionId: options.connectionId,
      credentialProfileRef: options.credentialProfileRef,
      accountScope: appHomeEnv ? 'profile' : 'global',
    });
    const cacheTtlMs = this.options.quotaCacheTtlMs ?? CODEX_QUOTA_CACHE_TTL_MS;
    const cached = this.quotaSnapshots.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt <= cacheTtlMs) {
      return { kind: 'snapshot', snapshot: cached.snapshot };
    }
    if (cached) this.quotaSnapshots.delete(cacheKey);
    const generation = this.quotaSnapshotGeneration;
    let processHandle: ReturnType<typeof createCodexProcess> | undefined;
    const pending = new Map<
      string,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    let requestId = 0;
    const fail = (error: Error) => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    let stdout: ReturnType<typeof createInterface> | undefined;
    try {
      processHandle = this.processFactory(appHomeEnv);
      stdout = createInterface({ input: processHandle.stdout });
      stdout.on('line', (line) => {
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        const id =
          typeof message?.id === 'string' || typeof message?.id === 'number'
            ? String(message.id)
            : null;
        if (!id || !pending.has(id)) return;
        const entry = pending.get(id)!;
        pending.delete(id);
        message.error
          ? entry.reject(
              new CodexQuotaTransportError(
                typeof message.error?.code === 'string' ||
                  typeof message.error?.code === 'number'
                  ? message.error.code
                  : undefined,
                string(message.error?.message) ?? 'Codex quota read failed',
              ),
            )
          : entry.resolve(message.result);
      });
      processHandle.on('error', (error) =>
        fail(new Error(`Codex app-server failed to start: ${error.message}`)),
      );
      processHandle.on('exit', (code) =>
        fail(
          new Error(
            `Codex app-server exited before responding (code: ${code ?? 'unknown'})`,
          ),
        ),
      );
      const send = (method: string, params?: unknown) => {
        const id = String(++requestId);
        const response = new Promise<unknown>((resolve, reject) =>
          pending.set(id, { resolve, reject }),
        );
        processHandle!.stdin.write(
          `${JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })}\n`,
        );
        return response;
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('quota-timeout')),
          this.options.quotaTimeoutMs ?? CODEX_QUOTA_TIMEOUT_MS,
        ),
      );
      await Promise.race([
        send('initialize', {
          clientInfo: { name: 'station', title: 'Station', version: '0.1.0' },
          capabilities: { experimentalApi: false },
        }),
        timeout,
      ]);
      processHandle.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`,
      );
      const payload = await Promise.race([
        send('account/rateLimits/read', null),
        timeout,
      ]);
      const snapshot = projectCodexQuotaSnapshot(
        payload,
        options.connectionId,
        this.now().toISOString(),
        accountScope,
      );
      const result: ConnectionQuotaResult = snapshot
        ? { kind: 'snapshot', snapshot }
        : {
            kind: 'unavailable',
            reason: 'provider-error',
            detail: 'Codex returned no rate-limit snapshot.',
          };
      if (snapshot && generation === this.quotaSnapshotGeneration) {
        this.cacheQuotaSnapshot(cacheKey, snapshot);
      }
      connectionQuotaReads.add(1, { outcome: result.kind });
      return result;
    } catch (error) {
      const reason =
        error instanceof Error && error.message === 'quota-timeout'
          ? 'timeout'
          : error instanceof CodexQuotaTransportError &&
              (error.code === 'authentication_required' ||
                error.code === 'not_authenticated')
            ? 'not-authenticated'
            : 'provider-error';
      this.options.logger?.warn?.('Codex quota read unavailable', {
        provider: 'codex',
        reason,
      });
      connectionQuotaReads.add(1, { outcome: reason });
      return { kind: 'unavailable', reason };
    } finally {
      stdout?.close();
      if (processHandle)
        await terminateCodexProcess(processHandle).catch(() => undefined);
    }
  }

  /** Stores pull and push observations under one bounded account-scoped cache. */
  private cacheQuotaSnapshot(
    cacheKey: string,
    snapshot: ConnectionQuotaSnapshot,
  ): void {
    this.quotaSnapshots.set(cacheKey, { snapshot, cachedAt: Date.now() });
    while (
      this.quotaSnapshots.size >
      (this.options.quotaCacheMaxEntries ?? CODEX_QUOTA_CACHE_MAX_ENTRIES)
    ) {
      this.quotaSnapshots.delete(this.quotaSnapshots.keys().next().value!);
    }
  }

  private mergeQuotaNotification(
    record: CodexSessionRecord,
    payload: unknown,
  ): void {
    const connectionId = record.quotaConnectionId;
    const accountScope = record.quotaAccountScope;
    const cacheKey = record.quotaCacheKey;
    if (!connectionId || !accountScope || !cacheKey) {
      this.options.logger?.warn?.('Codex quota notification dropped', {
        provider: 'codex',
        reason: 'missing-routing-identity',
      });
      return;
    }

    const observedAt = this.now().toISOString();
    try {
      const update = projectCodexQuotaUpdate(
        payload,
        connectionId,
        observedAt,
        accountScope,
      );
      if (!update) return;
      const cached = this.quotaSnapshots.get(cacheKey);
      // A rolling observation is not a baseline. Until a successful pull has
      // established one, preserve only fields present in this update.
      const baseline = cached?.snapshot.baselineAt
        ? cached.snapshot
        : undefined;
      if (
        baseline &&
        (baseline.connectionId !== update.connectionId ||
          baseline.provider !== update.provider ||
          baseline.accountScope !== update.accountScope)
      ) {
        // `mergeQuotaSnapshot()` intentionally keeps its null-on-mismatch
        // contract. At this cache-owning boundary, however, a mismatch proves
        // that the entry is mislabeled and must not remain readable.
        this.quotaSnapshots.delete(cacheKey);
        this.options.logger?.warn?.('Codex quota cache identity violation', {
          provider: 'codex',
          connectionId,
          accountScope,
        });
        return;
      }
      const snapshot = mergeQuotaSnapshot(baseline, update);
      if (!snapshot) return;
      // A notification observed during a pull wins over that older in-flight
      // result. This is intentionally global to the existing pull generation.
      this.quotaSnapshotGeneration += 1;
      this.cacheQuotaSnapshot(cacheKey, snapshot);
    } catch {
      this.options.logger?.warn?.('Codex quota notification dropped', {
        provider: 'codex',
        reason: 'invalid-rate-limit-notification',
      });
    }
  }

  invalidateQuotaSnapshot(options?: { connectionId?: string }): void {
    this.quotaSnapshotGeneration += 1;
    if (options?.connectionId) {
      const prefix = `${options.connectionId}\u0000`;
      for (const key of this.quotaSnapshots.keys()) {
        if (key.startsWith(prefix)) this.quotaSnapshots.delete(key);
      }
    } else this.quotaSnapshots.clear();
  }

  async listModels(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }): Promise<
    Array<{
      id: string;
      name: string;
      originalId: string;
    }>
  > {
    return (await this.listModelCatalog(options)).models;
  }

  async listModelCatalog(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }): Promise<ProviderAdapterModelCatalog> {
    throwIfAborted(options?.signal);
    const maxEntries = Math.min(
      CODEX_MODEL_MAX_ENTRIES,
      Math.max(1, Math.floor(options?.maxEntries ?? CODEX_MODEL_MAX_ENTRIES)),
    );
    const cached = this.modelCatalogCache;
    if (
      cached &&
      this.now().getTime() - cached.observedAt < CODEX_MODEL_CACHE_TTL_MS
    ) {
      return this.projectModelCatalog(cached.value, maxEntries);
    }

    let flight = this.modelCatalogFlight;
    if (!flight) {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new Error('Codex model discovery timed out.'));
      }, CODEX_MODEL_DISCOVERY_TIMEOUT_MS);
      this.modelCatalogController = controller;
      flight = this.discoverModelCatalog({
        signal: controller.signal,
        maxEntries: CODEX_MODEL_MAX_ENTRIES,
      })
        .then((catalog) => {
          this.modelCatalogCache = {
            value: catalog,
            observedAt: this.now().getTime(),
          };
          return catalog;
        })
        .finally(() => {
          clearTimeout(timeout);
          if (this.modelCatalogFlight === flight) {
            this.modelCatalogFlight = null;
          }
          if (this.modelCatalogController === controller) {
            this.modelCatalogController = null;
          }
        });
      this.modelCatalogFlight = flight;
    }

    const controller = this.modelCatalogController;
    this.modelCatalogWaiters += 1;
    let released = false;
    const release = (reason?: unknown): boolean => {
      if (released) return false;
      released = true;
      this.modelCatalogWaiters -= 1;
      if (
        this.modelCatalogWaiters === 0 &&
        this.modelCatalogFlight === flight &&
        controller &&
        !controller.signal.aborted
      ) {
        controller.abort(reason);
        return true;
      }
      return false;
    };

    try {
      const catalog = await raceWithSignal(flight, options?.signal);
      return this.projectModelCatalog(catalog, maxEntries);
    } catch (error) {
      const cancelledSharedFlight =
        options?.signal?.aborted === true &&
        release(abortError(options.signal));
      if (cancelledSharedFlight) {
        await flight.catch(() => undefined);
      }
      throw error;
    } finally {
      release();
    }
  }

  private projectModelCatalog(
    catalog: ProviderAdapterModelCatalog,
    maxEntries: number,
  ): ProviderAdapterModelCatalog {
    const models = catalog.models.slice(0, maxEntries).map((model) => ({
      ...model,
    }));
    const truncated =
      catalog.truncated === true || catalog.models.length > maxEntries;
    return {
      models,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  private async discoverModelCatalog(options: {
    signal: AbortSignal;
    maxEntries: number;
  }): Promise<ProviderAdapterModelCatalog> {
    const maxEntries = options.maxEntries;
    const processHandle = this.processFactory();
    let termination: Promise<void> | null = null;
    const terminate = () => {
      termination ??= terminateCodexProcess(processHandle);
      return termination;
    };
    const pending = new Map<
      string,
      {
        resolve(value: unknown): void;
        reject(error: Error): void;
      }
    >();
    let requestId = 0;
    const failPending = (error: Error) => {
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
    };
    let receivedBytes = 0;
    let responseLimitExceeded = false;
    const onStdoutData = (chunk: Buffer | string) => {
      if (responseLimitExceeded) return;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes <= CODEX_MODEL_MAX_RESPONSE_BYTES) return;
      responseLimitExceeded = true;
      failPending(
        new Error('Codex model catalog exceeded the response limit.'),
      );
      void terminate();
    };
    processHandle.stdout.on('data', onStdoutData);
    const stdout = createInterface({ input: processHandle.stdout });
    const onAbort = () => {
      failPending(abortError(options?.signal));
      void terminate();
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    stdout.on('line', (line) => {
      if (responseLimitExceeded) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload: any;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return;
      }
      const id =
        typeof payload?.id === 'string' || typeof payload?.id === 'number'
          ? String(payload.id)
          : null;
      if (!id) return;
      const pendingRequest = pending.get(id);
      if (!pendingRequest) return;
      pending.delete(id);
      if (payload.error) {
        pendingRequest.reject(
          new Error(
            typeof payload.error?.message === 'string'
              ? payload.error.message
              : 'Codex model/list failed',
          ),
        );
        return;
      }
      pendingRequest.resolve(payload.result);
    });

    processHandle.on('exit', (code) => {
      failPending(
        new Error(
          `Codex app-server exited before responding (code: ${code ?? 'unknown'})`,
        ),
      );
    });
    processHandle.on('error', (error) => {
      failPending(
        new Error(`Codex app-server failed to start: ${error.message}`),
      );
    });

    const sendRequest = <T = unknown>(
      method: string,
      params?: unknown,
    ): Promise<T> => {
      throwIfAborted(options?.signal);
      const id = String(++requestId);
      const payload =
        params === undefined
          ? { jsonrpc: '2.0', id, method }
          : { jsonrpc: '2.0', id, method, params };
      const response = new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      processHandle.stdin.write(`${JSON.stringify(payload)}\n`);
      return response;
    };

    try {
      await sendRequest('initialize', {
        clientInfo: {
          name: 'station',
          title: 'Station',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: false,
        },
      });
      processHandle.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`,
      );
      const models: any[] = [];
      let cursor: string | null | undefined = null;
      const seenCursors = new Set<string>();
      let pageCount = 0;
      let truncated = false;
      do {
        if (pageCount >= CODEX_MODEL_MAX_PAGES) {
          throw new Error('Codex model catalog exceeded the page limit.');
        }
        pageCount += 1;
        const result: CodexModelListResult = await sendRequest('model/list', {
          cursor,
          limit: Math.min(100, maxEntries - models.length),
          includeHidden: false,
        });
        const remaining = maxEntries - models.length;
        const pageModels = result.data ?? [];
        models.push(...pageModels.slice(0, remaining));
        if (models.length >= maxEntries) {
          truncated =
            Boolean(result.nextCursor) || pageModels.length > remaining;
          break;
        }
        const nextCursor = result.nextCursor;
        if (nextCursor && seenCursors.has(nextCursor)) {
          throw new Error('Codex model pagination cursor did not advance.');
        }
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      const mappedModels = models
        .map(mapCodexModelCatalogEntry)
        .filter((entry): entry is NonNullable<typeof entry> => !!entry)
        .slice(0, maxEntries);
      return {
        models: mappedModels,
        ...(truncated ? { truncated: true } : {}),
      };
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
      processHandle.stdout.removeListener('data', onStdoutData);
      stdout.close();
      await terminate();
    }
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    if (
      this.transport.hasSession(input.threadId) ||
      this.startingSessionThreads.has(input.threadId)
    ) {
      throw new Error(`Codex session already exists: ${input.threadId}`);
    }
    this.startingSessionThreads.add(input.threadId);
    try {
      return await this.startReservedSession(input);
    } finally {
      this.startingSessionThreads.delete(input.threadId);
    }
  }

  private async startReservedSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const startedAt = Date.now();
    const appHomeEnv = await this.resolveAppHomeEnv(input.credentialProfileRef);
    const appHome: 'profile' | 'global' = appHomeEnv ? 'profile' : 'global';
    const quotaConnectionId = string(input.metadata?.connectionId);
    const toolServers = this.resolveAgentToolServers(input);
    const processHandle = this.processFactory(
      appHomeEnv,
      toolServers.configArgs,
    );
    const record = createCodexSessionRecord({
      externalThreadId: input.threadId,
      process: processHandle,
      provider: this.provider,
      threadId: input.threadId,
      model: input.modelId ?? '',
      resumeCursor: input.resumeCursor,
      nowIso: () => this.now().toISOString(),
    });
    if (quotaConnectionId) {
      record.quotaConnectionId = quotaConnectionId;
      const quotaIdentity = quotaCacheIdentity({
        connectionId: quotaConnectionId,
        credentialProfileRef: input.credentialProfileRef,
        accountScope: appHome,
      });
      record.quotaAccountScope = quotaIdentity.accountScope;
      record.quotaCacheKey = quotaIdentity.cacheKey;
    }

    // Retained so a later `session.configured` can restate it: consumers read
    // `cwd` off the latest such event, so an event that omits it erases the
    // session's working directory downstream (archive#903).
    if (input.cwd) {
      record.session.cwd = input.cwd;
    }

    this.transport.registerSession(record);
    this.transport.handleProcess(record);

    try {
      await this.transport.sendRequest(record, 'initialize', {
        clientInfo: {
          name: 'station',
          title: 'Station',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: false,
        },
      });
      this.transport.sendNotification(record, 'initialized');

      const modelOptions = (input.modelOptions ?? {}) as CodexModelOptions;
      const approvalKnobs = resolveCodexExecutionKnobs(
        input.modelOptions,
        input.reviewIsolation,
      );
      const result = isResumeCursor(input.resumeCursor)
        ? await this.transport.sendRequest(record, 'thread/resume', {
            threadId: input.resumeCursor.codexThreadId,
            cwd: input.cwd,
            model: input.modelId,
            approvalPolicy: approvalKnobs.approvalPolicy,
            sandbox: approvalKnobs.sandbox,
            serviceTier: modelOptions.fastMode ? 'fast' : null,
            persistExtendedHistory: false,
          })
        : await this.transport.sendRequest(record, 'thread/start', {
            cwd: input.cwd,
            model: input.modelId,
            approvalPolicy: approvalKnobs.approvalPolicy,
            sandbox: approvalKnobs.sandbox,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            serviceTier: modelOptions.fastMode ? 'fast' : null,
          });

      const codexThread = extractThread(result);
      this.transport.setCodexThreadId(record, codexThread.id);
      // archive#1182: the app-server's own `thread/start`/`thread/resume`
      // response — genuinely reported by Codex, not merely Station's
      // request echoed back. Proof this can diverge from what was
      // requested: `codex-models.ts` documents that Station deliberately
      // leaves `model` unset so Codex applies its own built-in default —
      // in that case `input.modelId` is undefined/empty and this field is
      // the ONLY place the resolved model ever appears.
      const reportedModelFromInit =
        extractStringField(result, 'model') ?? undefined;
      record.session = {
        ...record.session,
        status: 'ready',
        model: reportedModelFromInit ?? input.modelId,
        updatedAt: this.now().toISOString(),
        resumeCursor: { codexThreadId: codexThread.id },
      };

      this.transport.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: this.now().toISOString(),
        method: 'session.started',
        sessionId: input.threadId,
        initialState: 'created',
        metadata: {
          ...input.metadata,
          codexThreadId: codexThread.id,
        },
      });
      const baseConfiguredMetadata: Record<string, unknown> = {
        ...input.metadata,
        // Note: `effectiveModel` here is sourced from `record.session.model`
        // (reported-or-requested, pre-existing behavior kept for
        // back-compat with every consumer already reading it as "the best
        // known model label"), so it equals `reportedModel` whenever the
        // app-server actually returned one. The two only diverge in the
        // direction that matters: when the app-server reports nothing,
        // `effectiveModel` still shows the requested value (or the
        // session's prior model) while `reportedModel` is correctly
        // absent — never the reverse.
        ...effectiveModelMetadata(record.session.model, modelOptions),
        ...reportedModelMetadata(reportedModelFromInit),
        reasoningEffort: mapReasoningEffort(modelOptions),
        fastMode: modelOptions.fastMode ?? false,
        approvalPolicy: approvalKnobs.approvalPolicy,
        sandbox: approvalKnobs.sandbox,
        // Resolved approvalMode alongside the raw knobs, so the client can
        // track a durable lastAppliedApprovalMode baseline at session
        // start without re-deriving it from provider-specific knobs
        // (archive#727 review round 3, item 1).
        approvalMode: mapCodexKnobsToApprovalMode(approvalKnobs),
        codexThreadId: codexThread.id,
        // archive#896 wave 2: whether this session's app-server spawn env was
        // layered with the codex-runtime app-home profile, or left at the
        // global CODEX_HOME (opted out or a degraded lookup).
        appHome,
        [MODEL_SELECTION_RECEIPT_METADATA_KEY]: modelSelectionReceipt(
          input.modelId,
          record.session.model,
        ),
      };
      // archive#1195: chained the same way claude-adapter.ts's toolServers
      // merge is — mergeCapabilityDeliveryMetadata prepends any
      // resolution-stage undelivered entries session-agent-resolution.ts
      // already recorded, so passing the previous metadata as inputMetadata
      // preserves that report.
      const configuredMetadata = toolServers.report
        ? mergeCapabilityDeliveryMetadata(
            baseConfiguredMetadata,
            'toolServers',
            toolServers.report,
          )
        : baseConfiguredMetadata;

      this.transport.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: this.now().toISOString(),
        method: 'session.configured',
        sessionId: input.threadId,
        model: record.session.model,
        cwd: input.cwd,
        metadata: configuredMetadata,
      });

      providerOps.add(1, {
        operation: 'adapter-session-start',
        provider: this.provider,
        model_options:
          mapReasoningEffort(modelOptions) || modelOptions.fastMode
            ? 'applied'
            : 'none',
      });
      adapterSessionStartDuration.record(Date.now() - startedAt, {
        provider: this.provider,
      });
      appHomeSessions.add(1, { provider: this.provider, applied: appHome });

      return record.session;
    } catch (error) {
      // archive#1195: the session never actually started — its
      // station-control MCP token (if one was minted) would otherwise
      // linger unused until its TTL expires.
      this.options.revokeStationControlMcpAuth?.(input.threadId);
      try {
        await this.transport.stopSession(record.externalThreadId, () =>
          this.now().toISOString(),
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Codex startup failed and process termination was not confirmed.',
        );
      }
      throw error;
    }
  }

  /**
   * archive#1195 (agent-engine-unification.md §4.1 Tool-servers row,
   * channel 'wire' — `codex app-server` independently manages its own
   * outbound MCP connections; see `DeliveryChannel`'s doc comment for why
   * that's a distinct channel from Claude's 'subprocess'): resolve an
   * authored `input.agent.toolServers` into `-c mcp_servers....` config
   * args for the `codex app-server` spawn argv, plus the delivery-channel
   * report `startReservedSession` merges into `session.configured`. An
   * unauthored `toolServers` (agent has none, or this isn't a
   * resolved-agent session at all) returns `{}` — `configArgs` stays
   * `undefined` so the spawn argv is byte-identical to before this feature
   * for every session that doesn't author tool servers.
   */
  private resolveAgentToolServers(input: ProviderSessionStartInput): {
    configArgs?: string[];
    report?: CapabilityDeliveryChannelReport;
  } {
    const toolServers = input.agent?.toolServers;
    if (toolServers === undefined) return {};

    const hasBuiltinStationControl = toolServers.some(
      (server) => server.id === 'station-control',
    );
    // Only mint (and therefore only ever hand out) a station-control MCP
    // token when the resolved toolServers actually include it — a session
    // with no authored station-control never gets one, and
    // resolveCodexMcpServers's own isBuiltinStationControl gate is what
    // actually decides whether an entry qualifies as the canonical server
    // (this is just an early-exit so an unrelated session never mints a
    // token it will never use).
    const stationControlMcpUrl = hasBuiltinStationControl
      ? input.tenantExecutionContext
        ? this.options.mintStationControlMcpAuth?.(
            input.threadId,
            input.tenantExecutionContext,
          )
        : this.options.mintStationControlMcpAuth?.(input.threadId)
      : undefined;

    const { configArgs, deliveredIds, skipped } = resolveCodexMcpServers(
      toolServers,
      stationControlMcpUrl,
    );
    const undelivered: CapabilityUndelivered[] = skipped.map(
      (skip: CodexToolServerSkip) => ({
        capability: 'toolServers',
        id: skip.id,
        reason: skip.reason,
        detail: skip.detail,
      }),
    );
    for (const entry of undelivered) {
      agentCapabilityUndelivered.add(1, {
        provider: this.provider,
        capability: entry.capability,
        reason: entry.reason,
      });
    }
    if (configArgs.length > 0) {
      codexToolServersDelivered.add(configArgs.length / 2, {
        provider: this.provider,
      });
    }

    return {
      configArgs: configArgs.length > 0 ? configArgs : undefined,
      report: {
        source: 'agent',
        requested: toolServers.map((server) => server.id),
        delivered: deliveredIds,
        undelivered,
      },
    };
  }

  /**
   * Resolves the app-home profile env for a fresh `startSession` call
   * (archive#896 wave 2). A missing resolver or an opted-out connection degrades to
   * global CODEX_HOME. Ordinary lookup failures also degrade to global, while
   * an explicitly selected credential profile fails closed so Station cannot
   * claim or commit a candidate that was never applied.
   */
  private async resolveAppHomeEnv(
    credentialProfileRef?: string,
  ): Promise<Record<string, string> | undefined> {
    try {
      return await this.options.getAppHomeEnv?.(credentialProfileRef);
    } catch (error) {
      if (credentialProfileRef) {
        throw new Error(
          'Credential profile environment could not be prepared.',
        );
      }
      (this.options.logger ?? console).warn?.(
        `Codex app-home profile lookup failed; continuing with the global Codex config: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const record = this.transport.requireSession(input.threadId);
    const turnStartedAt = Date.now();
    const modelOptions = (input.modelOptions ?? {}) as CodexModelOptions;
    const hasModelOptions = Boolean(
      mapReasoningEffort(modelOptions) || modelOptions.fastMode,
    );
    const decodedAttachments = decodeChatAttachments(input.attachments);
    rejectFileAttachments('Codex', decodedAttachments);
    // Resolved fresh from this turn's modelOptions so a mode picked in the
    // composer takes effect starting with the very next turn — Station
    // resends the full session override bag on every turn (see
    // useActiveChatSessionMessaging.ts), so an unset field here means "no
    // override for this turn," not "clear the previous one."
    const approvalKnobs = resolveCodexExecutionKnobs(
      input.modelOptions,
      input.reviewIsolation,
    );
    let result: unknown;
    try {
      result = await this.transport.sendRequest(record, 'turn/start', {
        threadId: record.codexThreadId,
        input: [
          ...(input.input
            ? [
                {
                  type: 'text',
                  text: input.input,
                  text_elements: [],
                },
              ]
            : []),
          ...decodedAttachments.map(({ attachment }) => ({
            type: 'image',
            url: attachment.dataUrl,
          })),
        ],
        model: input.modelId,
        effort: mapReasoningEffort(modelOptions),
        approvalPolicy: approvalKnobs.approvalPolicy,
        sandbox: approvalKnobs.sandbox,
        serviceTier: modelOptions.fastMode ? 'fast' : undefined,
      });
      providerOps.add(1, {
        operation: 'adapter-model-options',
        provider: this.provider,
        model_options: hasModelOptions ? 'applied' : 'none',
      });
    } catch (error) {
      if (hasModelOptions) {
        providerOps.add(1, {
          operation: 'adapter-model-options',
          provider: this.provider,
          model_options: 'rejected',
        });
      }
      throw error;
    }

    const turnId = extractTurn(result).id;
    record.activeTurnId = turnId;
    // archive#3473 fix round: a new turn starts with no terminal published
    // for it yet — clear whatever the PREVIOUS turn (if any) left behind.
    record.terminalPublishedForTurnId = undefined;
    record.activeTurnStartedAt = turnStartedAt;
    record.turnOutput.set(turnId, '');
    // archive#903: restate the model when a turn changes it — `session.configured` is
    // the only event that carries a model into the read model and the
    // persisted row, and it is otherwise published once at session start.
    if (input.modelId && input.modelId !== record.session.model) {
      this.transport.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: this.now().toISOString(),
        method: 'session.configured',
        sessionId: input.threadId,
        model: input.modelId,
        ...(record.session.cwd ? { cwd: record.session.cwd } : {}),
        metadata: {
          [MODEL_SELECTION_RECEIPT_METADATA_KEY]: modelSelectionReceipt(
            input.modelId,
            input.modelId,
          ),
        },
      });
    }
    record.session = {
      ...record.session,
      status: 'running',
      updatedAt: this.now().toISOString(),
      model: input.modelId ?? record.session.model,
    };

    this.transport.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: this.now().toISOString(),
      method: 'turn.started',
      turnId,
      // Transcript-facing: the typed text, never the composed model input.
      prompt: input.displayInput ?? input.input,
      attachments: input.attachments,
      ...(input.ambientContext ? { ambientContext: input.ambientContext } : {}),
      // Durable per-turn record of the resolved approval posture (archive#727
      // review item 5) — turn/start has no dedicated "turn configured"
      // event, so this reuses turn.started's existing metadata bag rather
      // than adding a new canonical event for one field pair.
      metadata: {
        ...effectiveModelMetadata(
          input.modelId ?? record.session.model,
          modelOptions,
        ),
        ...(input.recoveryCorrelationId
          ? { recoveryCorrelationId: input.recoveryCorrelationId }
          : {}),
        approvalPolicy: approvalKnobs.approvalPolicy,
        sandbox: approvalKnobs.sandbox,
        // Lets the client track a durable lastAppliedApprovalMode baseline
        // (archive#727 review round 3, item 1 — the pending-apply chip state).
        approvalMode: mapCodexKnobsToApprovalMode(approvalKnobs),
        [MODEL_SELECTION_RECEIPT_METADATA_KEY]: modelSelectionReceipt(
          input.modelId,
          input.modelId ? record.session.model : undefined,
        ),
      },
    });

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: { codexThreadId: record.codexThreadId, turnId },
    };
  }

  async interruptTurn(threadId: string, turnId?: string) {
    const record = this.transport.requireSession(threadId);
    const activeTurnId = record.activeTurnId;
    if (!activeTurnId) {
      return { outcome: 'no-active-turn' } as const;
    }
    // archive#3473 fix round (B1/H3): mirrors claude-adapter.ts's and
    // acp-adapter.ts's own target-mismatch guard — codex was the only
    // adapter without one. `activeTurnId` is populated from a BOUNDED fact
    // set (`event-store.ts`'s `listSessionProjectionEvents`), not the full
    // event log; for a second turn on the same thread, that bounded set can
    // make the orchestration-side turn-id derivation stale (see
    // `interruptibleTurnIdForEvents`'s identity check). Refusing a mismatched
    // explicit `turnId` here is the adapter's own backstop against acting on
    // a caller's stale id.
    if (turnId && turnId !== activeTurnId) {
      return { outcome: 'target-mismatch', activeTurnId } as const;
    }
    const targetTurnId = turnId ?? activeTurnId;

    // archive#3473 fix round (H3): do NOT clear `activeTurnId` (or mark the
    // terminal published) until the RPC actually succeeds and `turn.aborted`
    // is actually about to be published — matching claude/acp exactly. The
    // previous synchronous-before-await clear left two callers with no
    // fallback: `orchestration-service.ts`'s recovery `interrupt` hook and
    // its accept-then-abort race cleanup both catch a rejection and rely on
    // "a later canonical terminal event" to close the turn — which is
    // `publishOrphanedTurnFailure`'s job, and a clear here (regardless of
    // outcome) silently disarmed it. `runCooperativeStop`'s cooperative-stop
    // deadline branch (the one caller that DOES have its own unconditional
    // fallback) stays safe via `rejectPendingRpcRequests`'s in-flight check.
    await this.transport.sendRequest(
      record,
      'turn/interrupt',
      {
        threadId: record.codexThreadId,
        turnId: targetTurnId,
      },
      // archive#3451 fix round D2: tracked so a forced teardown that has to
      // force-reject this RPC can tell it apart from an abandoned interrupt
      // targeting a DIFFERENT (earlier) turn.
      { turnId: targetTurnId },
    );

    this.transport.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: this.now().toISOString(),
      turnId: targetTurnId,
      method: 'turn.aborted',
      reason: 'interrupted',
    });
    record.activeTurnId = undefined;
    record.terminalPublishedForTurnId = targetTurnId;
    return { outcome: 'cancelled', turnId: targetTurnId } as const;
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
    const record = this.transport.requireSession(threadId);
    const pending = record.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Unknown Codex approval request: ${requestId}`);
    }

    record.pendingApprovals.delete(requestId);
    const outcome = resolveApprovalOutcome(
      pending.method,
      pending.payload,
      decision,
    );
    this.transport.sendResponse(record, pending.rpcRequestId, outcome.result);

    this.transport.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: this.now().toISOString(),
      requestId,
      method: 'request.resolved',
      status: mapApprovalResolutionStatus(outcome.decision),
    });
  }

  async stopSession(threadId: string): Promise<void> {
    await this.transport.stopSession(threadId, () => this.now().toISOString());
    // archive#1195: best-effort — a session that stops cleanly no longer
    // needs its station-control MCP token; a session that never had one is
    // a no-op (revokeStationControlMcpToken tolerates an unknown id).
    this.options.revokeStationControlMcpAuth?.(threadId);
  }

  async listSessions(): Promise<ProviderSession[]> {
    return this.transport.listSessions().map((record) => record.session);
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.transport.hasSession(threadId);
  }

  async stopAll(): Promise<void> {
    const catalogFlight = this.modelCatalogFlight;
    this.modelCatalogController?.abort(
      new Error('Codex adapter stopped during model discovery.'),
    );
    if (catalogFlight) {
      await catalogFlight.catch(() => undefined);
    }
    await this.transport.stopAll(() => this.now().toISOString());
  }

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.transport.streamEvents(options);
  }
}
