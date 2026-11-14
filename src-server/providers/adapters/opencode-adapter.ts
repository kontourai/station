/**
 * OpenCode as its own engine (`opencode`), which picks its transport per
 * session (PLAN A.1, owner decisions 1-2):
 *
 * - native: OpenCode 2.x behind `opencode serve`, verified by the schema
 *   fingerprint of what it serves (`opencode-serve-fingerprint.ts`), driven
 *   by `opencode-serve-session.ts`;
 * - ACP: everything else, through an unregistered `AcpAdapter` this adapter
 *   owns, under the `opencode` id: OpenCode 1.x, a 2.x whose API was not
 *   verified (`runtime.warning` {@link OPENCODE_NATIVE_UNVERIFIED}), and every
 *   session while the native transport is turned off (the Feature Preview,
 *   asked at every start and resume and by the pool before every spawn).
 *
 * Saved connections stay ACP connection records; this adapter runs the ones
 * {@link isOpenCodeConnection} recognises. It adopts no session.
 */
import crypto from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import {
  ACP_ENGINE_DURABILITY,
  acpStationApprovalEngine,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import {
  type EngineId,
  readApprovalMode,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { ownArray, ownRecord } from '@kontourai/station-shared/input-request';
import { prepareManagedAcpWorkspace } from '../../services/acp/managed-acp-workspace.js';
import {
  type OpenCodeNativeFloor,
  type OpenCodeNativeRule,
  type OpenCodeSavedApproval,
  openCodeNativeApprovalRules,
  openCodeSavedApprovalOverrides,
  openCodeSavedApprovalRefusal,
} from '../../services/acp/opencode-approval-native.js';
import {
  findOpenCodeProjectCode as defaultFindProjectCode,
  openCodeProjectCodeRefusal,
} from '../../services/acp/opencode-project-config.js';
import { errorMessage } from '../../utils/error-message.js';
import {
  ApprovalGovernanceRefusedError,
  AttachmentInputUnsupportedError,
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderInterruptTurnResult,
  type ProviderNativeSessionIdentity,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
} from '../adapter-shape.js';
import { augmentedSpawnEnv, findCliBinaryAsync } from '../auth/cli-auth.js';
import {
  dispatchEngineCommand,
  type EngineCommandPort,
  readSlashCommand,
} from '../engine-command-dispatch.js';
import {
  AsyncEventQueue,
  type AsyncEventStreamOptions,
} from '../sessions/async-event-queue.js';
import {
  AcpAdapter,
  type AcpAdapterOptions,
  type AcpResumeCursor,
  acpConnectionDefaultCwd,
  acpConnectionFingerprint,
  acpExecutionIdentity,
  isAcpResumeCursor,
} from './acp-adapter.js';
import {
  acpAppliedApprovalMode,
  acpApprovalFloor,
  governedModeRefusal,
  isOpenCodeGovernedMode,
} from './acp-approval-mode.js';
import { requestedAcpSessionMode } from './acp-session-mode.js';
import { nativeResumeBindingKey } from './native-resume-binding.js';
import { readString } from './opencode-native-events.js';
import type { OpenCodeServeClient } from './opencode-serve-client.js';
import { verifyOpenCodeServeSchema } from './opencode-serve-fingerprint.js';
import {
  type OpenCodeServeAcquireInput,
  type OpenCodeServeLease,
  OpenCodeServePool,
} from './opencode-serve-pool.js';
import {
  type OpenCodeNativeDecision,
  OpenCodeNativeSession,
} from './opencode-serve-session.js';
import {
  type OpenCodeVersionProbe,
  openCodeServesNatively,
  openCodeVersionProbe,
} from './opencode-version-probe.js';

/** `runtime.warning` code: a 2.x server's API was not verified; ACP runs instead. */
export const OPENCODE_NATIVE_UNVERIFIED = 'OPENCODE_NATIVE_UNVERIFIED';

const ENGINE_NAME = 'OpenCode';

/**
 * A saved connection this adapter runs: the OpenCode descriptor's own id,
 * or a command whose executable is `opencode` launched as `opencode acp`.
 */
export function isOpenCodeConnection(config: ACPConnectionConfig): boolean {
  if (config.id === 'opencode') return true;
  return (
    acpStationApprovalEngine(config.command) === 'opencode' &&
    config.args?.[0] === 'acp'
  );
}

/**
 * PLAN A.6. `sessionId` is OpenCode's session id, which is also its ACP
 * session id (settled by the 2.3.0 cross-load capture), so a session can
 * move between transports. `acp` keeps the ACP adapter's own cursor.
 */
export interface OpenCodeResumeCursor {
  kind: 'opencode';
  connectionId: string;
  sessionId: string;
  cwd: string;
  /** `nativeResumeBindingKey('opencode', dataHome, profileRef)`. */
  bindingKey: string;
  transport: 'native' | 'acp';
  acp?: AcpResumeCursor;
}

export function isOpenCodeResumeCursor(
  value: unknown,
): value is OpenCodeResumeCursor {
  const cursor = ownRecord(value);
  return (
    !!cursor &&
    cursor.kind === 'opencode' &&
    typeof cursor.connectionId === 'string' &&
    typeof cursor.sessionId === 'string' &&
    !!cursor.sessionId &&
    typeof cursor.cwd === 'string' &&
    typeof cursor.bindingKey === 'string' &&
    (cursor.transport === 'native' || cursor.transport === 'acp') &&
    (cursor.acp === undefined || isAcpResumeCursor(cursor.acp))
  );
}

/** OpenCode's data home (`$XDG_DATA_HOME/opencode`), where its sessions live. */
function openCodeDataHome(env: NodeJS.ProcessEnv): string {
  return join(
    env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'opencode',
  );
}

type OpenCodeServeLeaser = {
  acquire(input: OpenCodeServeAcquireInput): Promise<OpenCodeServeLease>;
  stopAll(): Promise<void>;
};

export interface OpenCodeAdapterOptions {
  getConnections: () => Promise<ACPConnectionConfig[]>;
  /** Options for the inner ACP adapter, less what this adapter sets. */
  acp?: Omit<
    AcpAdapterOptions,
    'provider' | 'connectionFilter' | 'getConnections'
  >;
  /** Tests: the inner ACP adapter. */
  createAcpAdapter?: (options: AcpAdapterOptions) => ProviderAdapterShape;
  /** The Feature Preview gate. Absent: native is off. */
  nativeEnabled?: () => boolean;
  pool?: OpenCodeServeLeaser;
  versionProbe?: OpenCodeVersionProbe;
  findBinary?: (command: string) => Promise<string | null>;
  /** The binary's identity the verdict is kept under (real path, size, mtime). */
  binaryIdentity?: (binary: string) => Promise<string>;
  /** #3924: OpenCode project code that runs outside any approval mode. */
  findProjectCode?: (cwd: string) => Promise<string[]>;
  launchEnv?: () => Promise<NodeJS.ProcessEnv>;
  /** Exact allowlist override for tests (`OPENCODE_SERVE_VERIFIED_FINGERPRINTS`). */
  verifiedFingerprints?: Readonly<Record<string, string>>;
  managedWorkspaceHomeDir?: string;
  reconnectFirstMs?: number;
}

interface NativeRecord {
  readonly native: OpenCodeNativeSession;
  readonly lease: OpenCodeServeLease;
  session: ProviderSession;
  readonly cursor: OpenCodeResumeCursor;
}

interface NativePlan {
  readonly config: ACPConnectionConfig;
  readonly binary: string;
  readonly version: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

async function defaultBinaryIdentity(binary: string): Promise<string> {
  const real = await realpath(binary);
  const info = await stat(real);
  return JSON.stringify([real, info.size, info.mtimeMs]);
}

export class OpenCodeAdapter implements ProviderAdapterShape {
  readonly provider: EngineId = 'opencode';
  readonly metadata: ProviderAdapterMetadata = {
    displayName: ENGINE_NAME,
    description:
      'OpenCode: OpenCode 2 over its own server (opencode serve) where verified, otherwise over ACP.',
    capabilities: [
      'agent-runtime',
      'session-lifecycle',
      'tool-calls',
      'interrupt',
      'approvals',
    ],
    durability: ACP_ENGINE_DURABILITY,
    continuity: { resume: 'same-session', fork: 'none', rewind: 'in-place' },
    builtin: true,
    engineId: engineId('opencode'),
    approvalAcknowledgement: 'engine',
  };

  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly native = new Map<string, NativeRecord>();
  /** Threads whose session runs over the inner ACP adapter. */
  private readonly overAcp = new Set<string>();
  private readonly inner: ProviderAdapterShape;
  private readonly pool: OpenCodeServeLeaser;
  /** Schema verdicts by binary identity: verified, or why not. */
  private readonly verdicts = new Map<
    string,
    { verified: boolean; reason?: string }
  >();
  private innerPump: Promise<void> | undefined;

  constructor(private readonly options: OpenCodeAdapterOptions) {
    const acpOptions: AcpAdapterOptions = {
      ...options.acp,
      provider: this.provider,
      connectionFilter: isOpenCodeConnection,
      getConnections: options.getConnections,
    };
    this.inner = options.createAcpAdapter
      ? options.createAcpAdapter(acpOptions)
      : new AcpAdapter(acpOptions);
    this.pool =
      options.pool ??
      new OpenCodeServePool({
        allowSpawn: () => this.nativeEnabled(),
      });
  }

  private nativeEnabled(): boolean {
    return this.options.nativeEnabled?.() === true;
  }

  private pumpInner(): void {
    this.innerPump ??= (async () => {
      try {
        for await (const event of this.inner.streamEvents())
          this.events.push(event);
      } catch {
        // The inner adapter closed its stream (stopAll).
      }
    })();
  }

  private publish(event: CanonicalRuntimeEvent): void {
    this.events.push(event);
  }

  private async connection(
    input: ProviderSessionStartInput,
  ): Promise<ACPConnectionConfig> {
    const cursor = isOpenCodeResumeCursor(input.resumeCursor)
      ? input.resumeCursor
      : undefined;
    const connectionId =
      typeof input.metadata?.connectionId === 'string'
        ? input.metadata.connectionId
        : cursor?.connectionId;
    const config = (await this.options.getConnections()).find(
      (candidate) =>
        candidate.id === connectionId && isOpenCodeConnection(candidate),
    );
    if (!config)
      throw new Error(
        `No OpenCode connection ${connectionId ? `named ${connectionId}` : 'was named'} for this session.`,
      );
    return config;
  }

  private async sessionCwd(
    input: ProviderSessionStartInput,
    config: ACPConnectionConfig,
  ): Promise<string> {
    const cursor = isOpenCodeResumeCursor(input.resumeCursor)
      ? input.resumeCursor
      : undefined;
    return (
      input.cwd ||
      cursor?.cwd ||
      acpConnectionDefaultCwd(config) ||
      (await prepareManagedAcpWorkspace(
        { kind: 'session', connectionId: config.id, threadId: input.threadId },
        this.options.managedWorkspaceHomeDir,
      ))
    );
  }

  /**
   * Whether this session runs natively, and on what (A.1). Undefined: ACP.
   * Asked at every start and resume.
   */
  private async nativePlan(
    input: ProviderSessionStartInput,
    config: ACPConnectionConfig,
  ): Promise<NativePlan | undefined> {
    if (!this.nativeEnabled()) return undefined;
    const binary = await (this.options.findBinary ?? findCliBinaryAsync)(
      config.command,
    );
    if (!binary) return undefined;
    const version = await (
      this.options.versionProbe ?? openCodeVersionProbe
    ).probe(binary);
    if (!version || !openCodeServesNatively(version)) return undefined;
    return {
      config,
      binary,
      version: version.text,
      cwd: await this.sessionCwd(input, config),
      env: await (this.options.launchEnv ?? (() => augmentedSpawnEnv()))(),
    };
  }

  /**
   * A lease on the plan's server whose API is verified, or undefined when it
   * is not (the server is stopped and a warning says why).
   */
  private async verifiedLease(
    plan: NativePlan,
    threadId: string,
  ): Promise<OpenCodeServeLease | undefined> {
    let identity: string;
    try {
      identity = await (this.options.binaryIdentity ?? defaultBinaryIdentity)(
        plan.binary,
      );
    } catch {
      return undefined;
    }
    const key = JSON.stringify([identity, plan.version]);
    const known = this.verdicts.get(key);
    if (known && !known.verified) return undefined;
    const lease = await this.pool.acquire({
      connectionId: plan.config.id,
      binary: plan.binary,
      cwd: plan.cwd,
      env: plan.env,
      tmpDir: plan.env.TMPDIR ?? '',
    });
    if (known?.verified) return lease;
    let verdict: { verified: boolean; reason?: string };
    try {
      const doc = await lease.client.request('GET', '/openapi.json');
      const checked = verifyOpenCodeServeSchema(
        plan.version,
        doc,
        this.options.verifiedFingerprints,
      );
      verdict = checked.verified
        ? { verified: true }
        : { verified: false, reason: checked.reason };
    } catch (error) {
      verdict = { verified: false, reason: errorMessage(error) };
    }
    this.verdicts.set(key, verdict);
    if (verdict.verified) return lease;
    lease.discard();
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'runtime.warning',
      severity: 'warning',
      code: OPENCODE_NATIVE_UNVERIFIED,
      message: `Station runs OpenCode ${plan.version} over ACP: ${verdict.reason ?? 'its server API was not verified'}.`,
    });
    return undefined;
  }

  /**
   * A.5: a governed start's rules must be what OpenCode will enforce. The
   * project's own OpenCode code runs outside any mode (#3924), and a saved
   * approval outranks the session's rules.
   */
  private async assertGovernable(
    client: OpenCodeServeClient,
    cwd: string,
    floor: OpenCodeNativeFloor,
    agent: string,
  ): Promise<void> {
    if (floor !== 'confined') return;
    const code = await (this.options.findProjectCode ?? defaultFindProjectCode)(
      cwd,
    );
    if (code.length > 0)
      throw new ApprovalGovernanceRefusedError(
        `Station can't apply its approval mode to OpenCode, so the chat was not started: ${openCodeProjectCodeRefusal(code)}.`,
      );
    const [agentAnswer, savedAnswer] = await Promise.all([
      client.request<{ data?: unknown }>(
        'GET',
        `/api/agent/${encodeURIComponent(agent)}`,
      ),
      client.request<{ data?: unknown }>('GET', '/api/permission/saved'),
    ]);
    const agentRules = readRules(ownRecord(agentAnswer?.data)?.permissions);
    const saved: OpenCodeSavedApproval[] = (
      ownArray(savedAnswer?.data) ?? []
    ).flatMap((item) => {
      const rule = ownRecord(item);
      const action = readString(rule?.action);
      const resource = readString(rule?.resource);
      return action && resource ? [{ action, resource }] : [];
    });
    const overrides = openCodeSavedApprovalOverrides(floor, agentRules, saved);
    if (overrides.length > 0)
      throw new ApprovalGovernanceRefusedError(
        openCodeSavedApprovalRefusal(overrides),
      );
  }

  private bindingKey(
    env: NodeJS.ProcessEnv,
    input: ProviderSessionStartInput,
  ): string {
    return nativeResumeBindingKey(
      'opencode',
      openCodeDataHome(env),
      input.credentialProfileRef ?? null,
    );
  }

  async preflightStart(input: ProviderSessionStartInput): Promise<void> {
    const config = await this.connection(input);
    const plan = await this.nativePlan(input, config);
    if (!plan) {
      await this.inner.preflightStart?.(this.acpStartInput(input, config));
      return;
    }
    const mode = acpAppliedApprovalMode(
      readApprovalMode(input.modelOptions),
      input.confinement,
    );
    const floor = acpApprovalFloor(mode);
    if (!floor) return;
    const agent = requestedAcpSessionMode(input.modelOptions);
    if (agent && !isOpenCodeGovernedMode(agent))
      throw new ApprovalGovernanceRefusedError(governedModeRefusal(agent));
    const lease = await this.verifiedLease(plan, input.threadId);
    if (!lease) {
      await this.inner.preflightStart?.(this.acpStartInput(input, config));
      return;
    }
    try {
      await this.assertGovernable(
        lease.client,
        lease.cwd,
        floor,
        agent ?? 'build',
      );
    } finally {
      lease.release();
    }
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    if (
      input.resumeCursor !== undefined &&
      input.resumeCursor !== null &&
      !isOpenCodeResumeCursor(input.resumeCursor)
    )
      throw new Error('This OpenCode resume cursor is not one Station wrote.');
    const config = await this.connection(input);
    const plan = await this.nativePlan(input, config);
    const lease = plan
      ? await this.verifiedLease(plan, input.threadId)
      : undefined;
    if (!plan || !lease) return this.startOverAcp(input, config);
    try {
      return await this.startNative(input, plan, lease);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  /** The start input the inner ACP adapter reads, its cursor unwrapped. */
  private acpStartInput(
    input: ProviderSessionStartInput,
    config: ACPConnectionConfig,
  ): ProviderSessionStartInput {
    const cursor = isOpenCodeResumeCursor(input.resumeCursor)
      ? input.resumeCursor
      : undefined;
    const { resumeCursor: _resumeCursor, ...rest } = input;
    return {
      ...rest,
      metadata: { ...input.metadata, connectionId: config.id },
      ...(cursor
        ? {
            // A native session moves to ACP under the same id.
            resumeCursor: cursor.acp ?? {
              acpSessionId: cursor.sessionId,
              connectionId: config.id,
              connectionFingerprint: acpConnectionFingerprint(
                acpExecutionIdentity({
                  command: config.command,
                  args: config.args,
                  effectiveCwd: cursor.cwd,
                }),
              ),
            },
            cwd: input.cwd || cursor.cwd,
          }
        : {}),
    };
  }

  private wrapAcpCursor(
    value: unknown,
    input: ProviderSessionStartInput,
    config: ACPConnectionConfig,
    cwd: string | undefined,
    bindingKey: string,
  ): unknown {
    if (!isAcpResumeCursor(value)) return value;
    return {
      kind: 'opencode',
      connectionId: config.id,
      sessionId: value.acpSessionId,
      cwd: cwd ?? input.cwd ?? '',
      bindingKey,
      transport: 'acp',
      acp: value,
    } satisfies OpenCodeResumeCursor;
  }

  private readonly acpBindings = new Map<
    string,
    {
      config: ACPConnectionConfig;
      bindingKey: string;
      cwd?: string;
      input: ProviderSessionStartInput;
    }
  >();

  private async startOverAcp(
    input: ProviderSessionStartInput,
    config: ACPConnectionConfig,
  ): Promise<ProviderSession> {
    this.pumpInner();
    const acpInput = this.acpStartInput(input, config);
    const bindingKey = this.bindingKey(
      await (this.options.launchEnv ?? (() => augmentedSpawnEnv()))(),
      input,
    );
    this.overAcp.add(input.threadId);
    let session: ProviderSession;
    try {
      session = await this.inner.startSession(acpInput);
    } catch (error) {
      this.overAcp.delete(input.threadId);
      throw error;
    }
    const cwd = session.cwd ?? acpInput.cwd;
    this.acpBindings.set(input.threadId, {
      config,
      bindingKey,
      ...(cwd ? { cwd } : {}),
      input,
    });
    return {
      ...session,
      provider: this.provider,
      resumeCursor: this.wrapAcpCursor(
        session.resumeCursor,
        input,
        config,
        cwd,
        bindingKey,
      ),
    };
  }

  private async startNative(
    input: ProviderSessionStartInput,
    plan: NativePlan,
    lease: OpenCodeServeLease,
  ): Promise<ProviderSession> {
    const cursor = isOpenCodeResumeCursor(input.resumeCursor)
      ? input.resumeCursor
      : undefined;
    const bindingKey = this.bindingKey(plan.env, input);
    if (cursor && cursor.bindingKey !== bindingKey)
      throw new Error(
        'This OpenCode session belongs to another OpenCode data home or profile, so it cannot resume here.',
      );
    const mode = acpAppliedApprovalMode(
      readApprovalMode(input.modelOptions),
      input.confinement,
    );
    const floor = acpApprovalFloor(mode);
    const agent = requestedAcpSessionMode(input.modelOptions);
    if (floor && agent && !isOpenCodeGovernedMode(agent))
      throw new ApprovalGovernanceRefusedError(governedModeRefusal(agent));
    if (floor)
      await this.assertGovernable(
        lease.client,
        lease.cwd,
        floor,
        agent ?? 'build',
      );
    const permissions = floor ? openCodeNativeApprovalRules(floor) : undefined;
    const model = readModelRef(input.modelId);
    let sessionId: string;
    if (cursor) {
      sessionId = cursor.sessionId;
      // The session must exist in this server's store; its rules follow the
      // mode this start asks for (null clears an earlier start's).
      await lease.client.request('GET', `/api/session/${sessionId}`);
      await lease.client.request('PATCH', `/api/session/${sessionId}`, {
        permissions: permissions ?? null,
      });
    } else {
      const created = await lease.client.request<{ data?: unknown }>(
        'POST',
        '/api/session',
        {
          location: { directory: lease.cwd },
          ...(floor ? { agent: agent ?? 'build' } : agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(permissions ? { permissions } : {}),
        },
      );
      const id = readString(ownRecord(created?.data)?.id);
      if (!id) throw new Error('OpenCode did not name the session it created.');
      sessionId = id;
    }
    const native = new OpenCodeNativeSession({
      threadId: input.threadId,
      provider: this.provider,
      engineName: ENGINE_NAME,
      client: lease.client,
      sessionId,
      publish: (event) => this.publish(event),
      ...(mode ? { approvalMode: mode } : {}),
      ...(this.options.reconnectFirstMs
        ? { reconnectFirstMs: this.options.reconnectFirstMs }
        : {}),
    });
    try {
      await native.start();
    } catch (error) {
      await native.stop('stopped');
      throw error;
    }
    const resumeCursor: OpenCodeResumeCursor = {
      kind: 'opencode',
      connectionId: plan.config.id,
      sessionId,
      cwd: plan.cwd,
      bindingKey,
      transport: 'native',
    };
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      cwd: plan.cwd,
      ...(input.modelId ? { model: input.modelId } : {}),
      resumeCursor,
      ...(input.persistSession !== undefined
        ? { persistSession: input.persistSession }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    const record: NativeRecord = {
      native,
      lease,
      session,
      cursor: resumeCursor,
    };
    this.native.set(input.threadId, record);
    void lease.exited.then(() => this.onServerExit(input.threadId, record));
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.started',
      sessionId: input.threadId,
      initialState: 'created',
      metadata: {
        ...input.metadata,
        openCodeTransport: 'native',
        openCodeVersion: plan.version,
      },
    });
    return session;
  }

  /** The server died under a live session: its turn aborts and the session exits. */
  private async onServerExit(
    threadId: string,
    record: NativeRecord,
  ): Promise<void> {
    if (this.native.get(threadId) !== record) return;
    this.native.delete(threadId);
    await record.native.stop('exited');
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      sessionId: threadId,
      reason: 'OpenCode server exited',
    });
  }

  private requireNative(threadId: string): NativeRecord {
    const record = this.native.get(threadId);
    if (!record)
      throw new Error(`OpenCode session not found for thread: ${threadId}`);
    return record;
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    if (this.overAcp.has(input.threadId)) {
      const result = await this.inner.sendTurn(input);
      const binding = this.acpBindings.get(input.threadId);
      return binding
        ? {
            ...result,
            resumeCursor: this.wrapAcpCursor(
              result.resumeCursor,
              binding.input,
              binding.config,
              binding.cwd,
              binding.bindingKey,
            ),
          }
        : result;
    }
    const record = this.requireNative(input.threadId);
    if (input.attachments && input.attachments.length > 0)
      throw new AttachmentInputUnsupportedError(
        'OpenCode over its own server does not take attachments in Station yet.',
      );
    const turnId = crypto.randomUUID();
    const displayText = input.displayInput ?? input.input;
    const invocation = readSlashCommand(input.input);
    const result = {
      threadId: input.threadId,
      turnId,
      resumeCursor: record.cursor,
    };
    if (!invocation) {
      await record.native.sendTurn({
        turnId,
        text: input.input,
        displayText,
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      });
      return result;
    }
    const native = record.native;
    const listed = await this.listedCommands(record).catch(() => []);
    const isListed = listed.some((command) => command.name === invocation.name);
    const action =
      invocation.name === 'compact'
        ? 'compact'
        : invocation.name === 'rewind'
          ? 'rewind'
          : undefined;
    if (!action) {
      // A listed OpenCode command runs as the engine's own command, keeping
      // its output (PLAN B); anything else is prompt text.
      await native.sendTurn({
        turnId,
        text: input.input,
        displayText,
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
        ...(isListed
          ? { command: { name: invocation.name, args: invocation.args } }
          : {}),
      });
      return result;
    }
    native.beginCommandTurn({
      turnId,
      displayText,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    });
    const port: EngineCommandPort<void> = {
      engineName: ENGINE_NAME,
      request: async () => ({ kind: 'unsupported' }),
      asPromptText: async () => {
        native.answerTurn(
          turnId,
          `${ENGINE_NAME} did not run /${invocation.name}.`,
        );
      },
      adapterAction: async (adapterAction) => {
        if (adapterAction === 'compact') return native.compact(turnId);
        if (adapterAction === 'rewind') {
          const target = this.rewindTarget(native, invocation.args);
          return target
            ? native.rewind(target)
            : { kind: 'answered', text: 'Nothing to rewind.' };
        }
        return { kind: 'unsupported' };
      },
      answerTurn: (text) => native.answerTurn(turnId, text),
    };
    void dispatchEngineCommand(port, invocation, {
      route: { kind: 'adapter-action', action },
    }).catch((error: unknown) =>
      native.answerTurn(
        turnId,
        `${ENGINE_NAME} could not run /${invocation.name}: ${errorMessage(error)}`,
      ),
    );
    return result;
  }

  /** `/rewind <turnId>`, or with none the turn before the last. */
  private rewindTarget(
    native: OpenCodeNativeSession,
    args: string,
  ): string | undefined {
    const named = args.trim();
    if (named) return named;
    const turns = native.rewindPoints();
    return turns.at(-2);
  }

  private async listedCommands(
    record: NativeRecord,
  ): Promise<Array<{ name: string; description: string }>> {
    const answer = await record.lease.client.request<{ data?: unknown }>(
      'GET',
      '/api/command',
    );
    return (ownArray(answer?.data) ?? []).flatMap((item) => {
      const command = ownRecord(item);
      const name = readString(command?.name);
      return name
        ? [{ name, description: readString(command?.description) ?? '' }]
        : [];
    });
  }

  async getCommands(options?: { signal?: AbortSignal }) {
    const record = [...this.native.values()][0];
    if (!record) return (await this.inner.getCommands?.(options)) ?? [];
    const listed = await this.listedCommands(record);
    return [
      ...listed.map((command) => ({
        name: command.name,
        description: command.description,
        passthrough: true,
      })),
      {
        name: 'compact',
        description: 'Summarize the conversation to free context',
        passthrough: true,
        route: { kind: 'adapter-action' as const, action: 'compact' as const },
      },
      {
        name: 'rewind',
        description: 'Move the session back to an earlier turn',
        passthrough: true,
        route: { kind: 'adapter-action' as const, action: 'rewind' as const },
      },
    ];
  }

  async listModels(options?: { signal?: AbortSignal; maxEntries?: number }) {
    const record = [...this.native.values()][0];
    if (!record) return (await this.inner.listModels?.(options)) ?? [];
    const answer = await record.lease.client.request<{ data?: unknown }>(
      'GET',
      '/api/model',
    );
    const models = (ownArray(answer?.data) ?? []).flatMap((item) => {
      const model = ownRecord(item);
      const id = readString(model?.id);
      const providerId = readString(model?.providerID);
      if (!id || !providerId || model?.enabled === false) return [];
      const selector = `${providerId}/${id}`;
      return [
        {
          id: selector,
          name: readString(model?.name) ?? selector,
          originalId: selector,
        },
      ];
    });
    return options?.maxEntries ? models.slice(0, options.maxEntries) : models;
  }

  async steerTurn(
    threadId: string,
    input: string,
    turnId: string,
  ): Promise<void> {
    if (this.overAcp.has(threadId)) {
      if (!this.inner.steerTurn)
        throw new Error('This session cannot be steered.');
      return this.inner.steerTurn(threadId, input, turnId);
    }
    const text = input.trim();
    if (!text) throw new Error('Steer input is empty.');
    await this.requireNative(threadId).native.steer(text, turnId);
  }

  async interruptTurn(
    threadId: string,
    turnId?: string,
  ): Promise<ProviderInterruptTurnResult> {
    if (this.overAcp.has(threadId))
      return this.inner.interruptTurn(threadId, turnId);
    const record = this.native.get(threadId);
    if (!record) return { outcome: 'no-active-turn' };
    return record.native.interrupt(turnId);
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: OpenCodeNativeDecision,
    context?: Parameters<ProviderAdapterShape['respondToRequest']>[3],
  ): Promise<void> {
    if (this.overAcp.has(threadId))
      return this.inner.respondToRequest(
        threadId,
        requestId,
        decision,
        context,
      );
    await this.requireNative(threadId).native.respond(requestId, decision, {
      ...(context?.inputContent !== undefined
        ? { inputContent: context.inputContent }
        : {}),
      ...(context?.expectedRequestEventId !== undefined
        ? { expectedRequestEventId: context.expectedRequestEventId }
        : {}),
    });
  }

  async rewindSession(
    threadId: string,
    toTurnId: string,
  ): Promise<EngineCommandOutcome> {
    if (this.overAcp.has(threadId))
      return (
        this.inner.rewindSession?.(threadId, toTurnId) ?? {
          kind: 'not-declared',
        }
      );
    return this.requireNative(threadId).native.rewind(toTurnId);
  }

  sessionContinuity(threadId: string) {
    if (this.overAcp.has(threadId))
      return (
        this.inner.sessionContinuity?.(threadId) ?? {
          fork: 'none' as const,
          rewind: 'none' as const,
        }
      );
    return { fork: 'none' as const, rewind: 'in-place' as const };
  }

  nativeSessionIdentity(
    resumeCursor: unknown,
  ): ProviderNativeSessionIdentity | undefined {
    return isOpenCodeResumeCursor(resumeCursor)
      ? { sessionId: resumeCursor.sessionId }
      : undefined;
  }

  preparedTurnBinding(threadId: string) {
    const record = this.native.get(threadId);
    if (record)
      return {
        bindingKey: record.cursor.bindingKey,
        nativeIdentity: { sessionId: record.cursor.sessionId },
      };
    return undefined;
  }

  hasOpenEngineWork(threadId: string): boolean {
    if (this.overAcp.has(threadId))
      return this.inner.hasOpenEngineWork?.(threadId) ?? false;
    return this.native.get(threadId)?.native.hasOpenWork() ?? false;
  }

  async stopSession(threadId: string): Promise<void> {
    if (this.overAcp.has(threadId)) {
      this.overAcp.delete(threadId);
      this.acpBindings.delete(threadId);
      return this.inner.stopSession(threadId);
    }
    const record = this.native.get(threadId);
    if (!record) return;
    this.native.delete(threadId);
    await record.native.stop('stopped');
    record.lease.release();
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      sessionId: threadId,
      reason: 'stopped',
    });
  }

  async listSessions(): Promise<ProviderSession[]> {
    const own = [...this.native.values()].map((record) => record.session);
    const overAcp = (await this.inner.listSessions())
      .filter((session) => this.overAcp.has(session.threadId))
      .map((session) => {
        const binding = this.acpBindings.get(session.threadId);
        return {
          ...session,
          provider: this.provider,
          ...(binding
            ? {
                resumeCursor: this.wrapAcpCursor(
                  session.resumeCursor,
                  binding.input,
                  binding.config,
                  binding.cwd,
                  binding.bindingKey,
                ),
              }
            : {}),
        };
      });
    return [...own, ...overAcp];
  }

  async hasSession(threadId: string): Promise<boolean> {
    if (this.native.has(threadId)) return true;
    return (
      this.overAcp.has(threadId) && (await this.inner.hasSession(threadId))
    );
  }

  async stopAll(): Promise<void> {
    try {
      await Promise.all(
        [...this.native.keys()].map((threadId) => this.stopSession(threadId)),
      );
      await this.inner.stopAll();
      await this.pool.stopAll();
    } finally {
      this.events.close();
    }
  }

  streamEvents(
    options?: AsyncEventStreamOptions<CanonicalRuntimeEvent>,
  ): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
}

function readRules(value: unknown): OpenCodeNativeRule[] {
  return (ownArray(value) ?? []).flatMap((item) => {
    const rule = ownRecord(item);
    const action = readString(rule?.action);
    const resource = readString(rule?.resource);
    const effect = rule?.effect;
    return action &&
      resource &&
      (effect === 'allow' || effect === 'deny' || effect === 'ask')
      ? [{ action, resource, effect }]
      : [];
  });
}

/** `providerID/modelID` as OpenCode's `Model.Ref`. */
function readModelRef(
  modelId: string | undefined,
): { id: string; providerID: string } | undefined {
  if (!modelId) return undefined;
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  return { providerID: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}
