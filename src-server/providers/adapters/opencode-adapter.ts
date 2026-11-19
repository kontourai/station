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
import { setTimeout as sleep } from 'node:timers/promises';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import {
  ACP_ENGINE_DURABILITY,
  isOpenCodeAcpConnection,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import {
  ACP_APPROVAL_TAKEOVER_FAILED_CODE,
  type EngineId,
  readApprovalMode,
  type SessionLiveContinuity,
  type SessionRewindOutcome,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { ownArray, ownRecord } from '@kontourai/station-shared/input-request';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import type { StagedPreToolPolicyEvaluator } from '../../runtime/agents/pre-tool-policy.js';
import type { InvocationContext } from '../../runtime/types.js';
import {
  assertEngineAllowedByManagedPolicy,
  managedEngineLaunch,
} from '../../security/managed-engine-limits.js';
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
import { openCodeSteerCustody } from '../../services/acp/opencode-steer-custody.js';
import {
  sharedUntrustedContentLedger,
  untrustedContentAncestry,
} from '../../services/plugins/untrusted-content-policy.js';
import { errorMessage } from '../../utils/error-message.js';
import { resolveHomeDir } from '../../utils/paths.js';
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
  SendTurnRefusedError,
} from '../adapter-shape.js';
import { augmentedSpawnEnv, findCliBinaryAsync } from '../auth/cli-auth.js';
import {
  AsyncEventQueue,
  type AsyncEventStreamOptions,
} from '../sessions/async-event-queue.js';
import {
  decodeChatAttachments,
  rejectFileAttachments,
} from '../sessions/chat-attachments.js';
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
  type AcpAppliedApprovalMode,
  acpAppliedApprovalMode,
  acpApprovalFloor,
  governedModeRefusal,
  isOpenCodeGovernedMode,
} from './acp-approval-mode.js';
import { requestedAcpSessionMode } from './acp-session-mode.js';
import { assertExecutionOverrideDelivery } from './capability-delivery-metadata.js';
import {
  dispatchEngineCommand,
  type EngineCommandPort,
  readSlashCommandInvocation,
} from './engine-command-dispatch.js';
import { externalPreToolPolicyIdentity } from './external-pre-tool-policy-identity.js';
import { nativeResumeBindingKey } from './native-resume-binding.js';
import { readString } from './opencode-native-events.js';
import {
  type OpenCodeNativeMcp,
  openCodeMcpDigest,
  resolveOpenCodeNativeMcp,
} from './opencode-native-mcp.js';
import {
  type OpenCodeServeClient,
  OpenCodeServeHttpError,
} from './opencode-serve-client.js';
import { verifyOpenCodeServeSchema } from './opencode-serve-fingerprint.js';
import {
  type OpenCodeServeAcquireInput,
  type OpenCodeServeLease,
  OpenCodeServePool,
} from './opencode-serve-pool.js';
import {
  type OpenCodeNativeDecision,
  OpenCodeNativeSession,
  type OpenCodeNativeSessionDeps,
} from './opencode-serve-session.js';
import {
  type OpenCodeVersionProbe,
  openCodeServesNatively,
  openCodeVersionProbe,
} from './opencode-version-probe.js';

/** `runtime.warning` code: a 2.x server's API was not verified; ACP runs instead. */
export const OPENCODE_NATIVE_UNVERIFIED = 'OPENCODE_NATIVE_UNVERIFIED';
/** `runtime.warning` code: a 2.x server could not be started; ACP runs instead. */
export const OPENCODE_NATIVE_UNAVAILABLE = 'OPENCODE_NATIVE_UNAVAILABLE';
/**
 * `runtime.warning` code: the session asks for something only ACP honours
 * (an `effort` setting), so ACP runs instead. OpenCode 2's native model
 * reference takes a provider-defined `variant`, not a level Station can map.
 */
export const OPENCODE_NATIVE_UNSUPPORTED_SETTING =
  'OPENCODE_NATIVE_UNSUPPORTED_SETTING';
/**
 * `runtime.warning` code: a governed native session moved (`session.moved`)
 * to a directory whose OpenCode configuration runs its own code, which
 * OpenCode loaded on the move; Station stopped the session.
 */
export const OPENCODE_SESSION_MOVED_UNGOVERNABLE =
  'OPENCODE_SESSION_MOVED_UNGOVERNABLE';

/**
 * How long an agent lookup keeps asking while the server answers 404: a
 * just-started server reports ready (`/api/info` 200) before its agent
 * catalog is loaded (seen on 2.3.0: one 404, then 200 about 200ms later).
 */
const AGENT_LOOKUP_BOUND_MS = 3_000;
const AGENT_LOOKUP_RETRY_MS = 100;

const ENGINE_NAME = 'OpenCode';
/**
 * How long a governed preflight's server lease waits for its start
 * (`preflightStart` runs just before `startSession`); past it the lease is
 * given back and the server idles as usual.
 */
const PREFLIGHT_LEASE_HOLD_MS = 60_000;

/** What the server a plan runs on is keyed by, less its tool servers. */
function nativePlanKey(plan: NativePlan): string {
  return JSON.stringify([plan.config.id, plan.binary, plan.cwd, plan.env]);
}

/**
 * A saved connection this adapter runs: the OpenCode descriptor's own id,
 * or a command whose executable is `opencode` launched as `opencode acp`.
 */
function isOpenCodeConnection(config: ACPConnectionConfig): boolean {
  return isOpenCodeAcpConnection(config);
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
    env.XDG_DATA_HOME ||
      join(env.HOME || env.USERPROFILE || homedir(), '.local', 'share'),
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
  /** Tests: how long a turn stopped on a refused rejection waits for OpenCode. */
  failCloseSettleMs?: number;
  /** Tests: how many refused asks a native session remembers before forgetting, then stopping. */
  refusedAsksBounds?: { evictAbove: number; stopAbove: number };
  /** Tests: the ids native sessions give their prompts. */
  newMessageId?: () => string;
}

interface NativeRecord {
  readonly native: OpenCodeNativeSession;
  readonly lease: OpenCodeServeLease;
  session: ProviderSession;
  readonly cursor: OpenCodeResumeCursor;
  /** The OpenCode agent the session runs (undefined: OpenCode's default). */
  agent: string | undefined;
  /**
   * The session's directory: the server's launch directory, or where
   * OpenCode moved it (`session.moved`), as the resume cursor carries it.
   */
  cwd: string;
  /** The session ruleset last applied to the engine. */
  rules: OpenCodeNativeRule[];
  /**
   * A settings change failed part way, so what the engine runs is not
   * known: the next turn applies the agent and the rules again.
   */
  dirty: boolean;
  /** A turn is being set up (settings, prompt): a second one is refused. */
  busy: boolean;
  modelUnconfirmed?: boolean;
  /**
   * The server's key carries this session's own credentials
   * (`OpenCodeNativeMcp.sessionScoped`): no other session can share it, so
   * it stops with the session rather than idling.
   */
  readonly serverIsSessions: boolean;
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
      'image-input',
    ],
    durability: ACP_ENGINE_DURABILITY,
    continuity: { resume: 'same-session', fork: 'none', rewind: 'in-place' },
    builtin: true,
    engineId: engineId('opencode'),
    connectionBacking: 'acp-registry',
    approvalAcknowledgement: 'engine',
    // Native sessions apply a catalog-checked model before the next prompt.
    // ACP fallback keeps its original model and refuses a changed selector.
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: false,
      overridePerTurn: true,
    },
  };

  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly native = new Map<string, NativeRecord>();
  /** Threads whose session runs over the inner ACP adapter. */
  private readonly overAcp = new Set<string>();
  /** Leases a governed preflight checked on, waiting for their start. */
  private readonly preflightLeases = new Map<
    string,
    {
      lease: OpenCodeServeLease;
      planKey: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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

  /**
   * New chats on an OpenCode connection run here only while the Feature
   * Preview is on; otherwise the ACP adapter keeps them, as before this
   * engine existed.
   */
  /** Listed as a provider only while its Feature Preview is on. */
  listedInProviderInventory(): boolean {
    return this.nativeEnabled();
  }

  claimsAcpConnection(config: ACPConnectionConfig): boolean {
    return this.nativeEnabled() && isOpenCodeConnection(config);
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
    // R5′: the policy's `acp` entry governs this connection, whichever
    // transport runs it (`managedPolicyEngineId` maps `opencode` to `acp`).
    assertEngineAllowedByManagedPolicy(this.provider, config);
    // The native path cannot honour these; ACP can.
    if (this.nativeUnsupported(input)) return undefined;
    // A managed policy pins OpenCode's launch through its `acp` entry: the
    // binary and environment apply to `serve` as they do to `acp`. Pinned
    // arguments belong to the `acp` command line and are not given to
    // `serve`.
    const pinned = managedEngineLaunch(
      'acp',
      {
        command: config.command,
        args: [],
        env: await (this.options.launchEnv ?? (() => augmentedSpawnEnv()))(),
      },
      'user',
    );
    const binary = await (this.options.findBinary ?? findCliBinaryAsync)(
      pinned.command,
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
      env: pinned.env,
    };
  }

  /**
   * Why a session must run over ACP whatever OpenCode serves: undefined
   * when nothing it asks for needs ACP.
   *
   * - An `effort` setting: OpenCode 2's native model reference takes a
   *   provider-defined `variant`, not a level Station can map.
   *
   * A session started as an Agent runs natively too: its staged pre-tool
   * policy runs on each ask there, as ACP runs it on each permission
   * request ({@link preparePreToolPolicy}).
   */
  private nativeUnsupported(
    input: ProviderSessionStartInput,
  ): string | undefined {
    if (input.modelOptions?.effort !== undefined)
      return "its effort setting is not available on OpenCode's own server";
    return undefined;
  }

  /**
   * Station's staged pre-tool policy for a session started as an Agent,
   * resolved as the ACP adapter resolves it (`AcpAdapter`
   * `resolvePreToolPolicy`: the same option, the same input, and on a
   * failed preparation an evaluator that denies every call with the same
   * reason), bound to this session for its asks (`AcpAdapter`
   * `requestPermission`: the Agent, the conversation and its delegation;
   * an external interaction with the raw tool name as its identity).
   */
  private async preparePreToolPolicy(
    input: ProviderSessionStartInput,
    delegation: InvocationContext['delegation'],
  ): Promise<OpenCodeNativeSessionDeps['preToolPolicy']> {
    const resolve = this.options.acp?.resolvePreToolPolicy;
    if (!input.agent || !resolve) return undefined;
    let evaluator: StagedPreToolPolicyEvaluator | undefined;
    try {
      evaluator = await resolve(input);
    } catch (error) {
      const reason = `Station pre-tool policy could not be prepared; tool execution was denied: ${errorMessage(error)}`;
      evaluator = async () => ({
        behavior: 'deny',
        denial: { allowed: false, reason },
      });
    }
    if (!evaluator) return undefined;
    const evaluate = evaluator;
    const agentSlug = input.agent.slug ?? 'unknown';
    return (tool, fullAccess) =>
      evaluate(
        {
          toolName: tool.toolName,
          toolCallId: tool.toolCallId,
          toolArgs: tool.toolArgs,
        },
        { agentSlug, conversationId: input.threadId, delegation },
        {
          interaction: 'external',
          identity: externalPreToolPolicyIdentity(tool.toolName),
          ...(fullAccess ? { fullAccess } : {}),
        },
      );
  }

  /**
   * A lease on the plan's server whose API is verified, or undefined when it
   * is not (the server is stopped and a warning says why).
   */
  private async verifiedLease(
    plan: NativePlan,
    threadId: string,
    mcpDigest: string,
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
    let lease: OpenCodeServeLease;
    try {
      lease = await this.pool.acquire({
        connectionId: plan.config.id,
        binary: plan.binary,
        cwd: plan.cwd,
        env: plan.env,
        tmpDir: plan.env.TMPDIR ?? '',
        mcpDigest,
      });
    } catch (error) {
      // The server would not start: the session runs over ACP, as for an
      // unverified one. Not a verdict on the binary; the next start tries
      // again.
      this.warn(
        threadId,
        OPENCODE_NATIVE_UNAVAILABLE,
        `Station runs OpenCode ${plan.version} over ACP: its server did not start (${redactSecrets(errorMessage(error))}).`,
      );
      return undefined;
    }
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
      // Only a document read is a verdict on the binary; a failed read is
      // not kept, and the next start asks again.
      this.verdicts.set(key, verdict);
    } catch (error) {
      verdict = { verified: false, reason: errorMessage(error) };
    }
    if (verdict.verified) return lease;
    lease.discard();
    this.warn(
      threadId,
      OPENCODE_NATIVE_UNVERIFIED,
      `Station runs OpenCode ${plan.version} over ACP: ${verdict.reason ?? 'its server API was not verified'}.`,
    );
    return undefined;
  }

  private warn(
    threadId: string,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
      method: 'runtime.warning',
      severity: 'warning',
      code,
      message,
      ...(details ? { details } : {}),
    });
  }

  /**
   * The agent's configured rules. A server that just reported ready may not
   * have loaded its agents yet and answers 404 for a while, so a 404 is
   * asked again within {@link AGENT_LOOKUP_BOUND_MS} before it counts.
   */
  private async agentRules(
    client: OpenCodeServeClient,
    agent: string,
  ): Promise<OpenCodeNativeRule[]> {
    const deadline = Date.now() + AGENT_LOOKUP_BOUND_MS;
    for (;;) {
      try {
        const answer = await client.request<{ data?: unknown }>(
          'GET',
          `/api/agent/${encodeURIComponent(agent)}`,
        );
        return readRules(ownRecord(answer?.data)?.permissions);
      } catch (error) {
        if (
          !(error instanceof OpenCodeServeHttpError) ||
          error.status !== 404 ||
          Date.now() + AGENT_LOOKUP_RETRY_MS > deadline
        )
          throw error;
      }
      await sleep(AGENT_LOOKUP_RETRY_MS);
    }
  }

  private async assertInspectableProjectConfig(cwd: string): Promise<void> {
    const findings = await (
      this.options.findProjectCode ?? defaultFindProjectCode
    )(cwd);
    if (findings.length > 0)
      throw new ApprovalGovernanceRefusedError(
        `Station can't apply its approval mode to OpenCode, so the chat was not started: ${openCodeProjectCodeRefusal(findings)}.`,
      );
  }

  /** A.5: saved approvals must not outrank a governed session's rules. */
  private async assertGovernable(
    client: OpenCodeServeClient,
    cwd: string,
    floor: OpenCodeNativeFloor,
    agent: string,
  ): Promise<OpenCodeNativeRule[]> {
    if (floor !== 'confined') return [];
    await this.assertInspectableProjectConfig(cwd);
    const [agentRules, savedAnswer] = await Promise.all([
      this.agentRules(client, agent),
      client.request<{ data?: unknown }>('GET', '/api/permission/saved'),
    ]);
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
    return agentRules;
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
    // The pool can spawn OpenCode in this directory.
    if (floor === 'confined')
      await this.assertInspectableProjectConfig(plan.cwd);
    // The governance check needs no tool servers; it reads from a server
    // that has none added.
    const lease = await this.verifiedLease(
      plan,
      input.threadId,
      openCodeMcpDigest([]),
    );
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
    } catch (error) {
      lease.release();
      throw error;
    }
    // Nothing was added to it: the start takes it over for its own tool
    // servers (`startLease`) instead of starting a second server.
    this.keepPreflightLease(input.threadId, plan, lease);
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
    const preflight = this.preflightLeases.get(input.threadId);
    const config = await this.connection(input);
    const plan = await this.nativePlan(input, config);
    const unsupported = this.nativeUnsupported(input);
    if (!plan && this.nativeEnabled() && unsupported)
      this.warn(
        input.threadId,
        OPENCODE_NATIVE_UNSUPPORTED_SETTING,
        `Station runs this OpenCode chat over ACP: ${unsupported}.`,
      );
    // Direct starts and starts reusing a preflight both check the launch cwd.
    const floor = acpApprovalFloor(
      acpAppliedApprovalMode(
        readApprovalMode(input.modelOptions),
        input.confinement,
      ),
    );
    if (plan && floor === 'confined') {
      try {
        await this.assertInspectableProjectConfig(plan.cwd);
      } catch (error) {
        if (
          preflight?.planKey === nativePlanKey(plan) &&
          this.preflightLeases.get(input.threadId) === preflight
        )
          this.takePreflightLease(input.threadId)?.lease.release();
        throw error;
      }
    }

    // Station's tool servers decide which server the session may share.
    let mcp: OpenCodeNativeMcp | undefined;
    if (plan) {
      mcp = await resolveOpenCodeNativeMcp(
        input,
        config,
        this.options.acp ?? {},
      );
      try {
        assertExecutionOverrideDelivery(input.metadata, mcp.undelivered);
      } catch (error) {
        this.revokeMcpAuth(input.threadId);
        throw error;
      }
    }
    const lease =
      plan && mcp
        ? await this.startLease(input.threadId, plan, mcp)
        : undefined;
    if (!plan || !lease || !mcp) {
      // The ACP adapter mints its own credentials for the session.
      if (mcp) this.revokeMcpAuth(input.threadId);
      return this.startOverAcp(input, config);
    }
    try {
      return await this.startNative(input, plan, lease, mcp);
    } catch (error) {
      if (mcp.sessionScoped) lease.discard();
      else lease.release();
      this.revokeMcpAuth(input.threadId);
      throw error;
    }
  }

  /**
   * The server a native start runs on: the one its preflight checked
   * governance on, when the preflight left one for this thread and it can
   * take the session's tool servers (same set, or moved to the set's key),
   * so a governed start spawns one server, not two; else the server for the
   * session's tool servers.
   */
  private async startLease(
    threadId: string,
    plan: NativePlan,
    mcp: OpenCodeNativeMcp,
  ): Promise<OpenCodeServeLease | undefined> {
    const digest = openCodeMcpDigest(mcp.servers);
    const checked = this.takePreflightLease(threadId);
    if (checked) {
      if (
        checked.planKey === nativePlanKey(plan) &&
        checked.lease.rekey(digest)
      )
        return checked.lease;
      checked.lease.release();
    }
    return this.verifiedLease(plan, threadId, digest);
  }

  private takePreflightLease(
    threadId: string,
  ): { lease: OpenCodeServeLease; planKey: string } | undefined {
    const held = this.preflightLeases.get(threadId);
    if (!held) return undefined;
    this.preflightLeases.delete(threadId);
    clearTimeout(held.timer);
    return held;
  }

  /** Hold the lease a preflight checked on for the start that follows it. */
  private keepPreflightLease(
    threadId: string,
    plan: NativePlan,
    lease: OpenCodeServeLease,
  ): void {
    this.takePreflightLease(threadId)?.lease.release();
    const timer = setTimeout(() => {
      if (this.preflightLeases.get(threadId)?.lease !== lease) return;
      this.preflightLeases.delete(threadId);
      lease.release();
    }, PREFLIGHT_LEASE_HOLD_MS);
    timer.unref?.();
    this.preflightLeases.set(threadId, {
      lease,
      planKey: nativePlanKey(plan),
      timer,
    });
  }

  /** Revoke the Station tool-server credentials minted for a native session. */
  private revokeMcpAuth(threadId: string): void {
    this.options.acp?.revokeStationControlMcpAuth?.(threadId);
  }

  /**
   * Add the session's Station tool servers to its server (`PUT
   * /api/experimental/mcp/{name}`). One OpenCode will not add is reported,
   * by name only (its config carries credentials), and the session starts
   * without it, as on ACP.
   */
  private async addMcpServers(
    threadId: string,
    client: OpenCodeServeClient,
    mcp: OpenCodeNativeMcp,
  ): Promise<void> {
    const failed: string[] = [];
    for (const server of mcp.servers) {
      try {
        await client.request(
          'PUT',
          `/api/experimental/mcp/${encodeURIComponent(server.name)}`,
          { config: server.config },
        );
      } catch (error) {
        failed.push(
          `${server.name} (${error instanceof OpenCodeServeHttpError ? error.status : 'no answer'})`,
        );
      }
    }
    const skipped = mcp.undelivered.map((entry) => entry.id ?? entry.reason);
    if (failed.length > 0 || skipped.length > 0)
      this.warn(
        threadId,
        'OPENCODE_TOOL_SERVERS_UNDELIVERED',
        `Some tool servers were not given to OpenCode: ${[...failed, ...skipped].join(', ')}.`,
      );
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
    const effective = managedEngineLaunch(
      'acp',
      {
        command: config.command,
        args: [],
        env: await (this.options.launchEnv ?? (() => augmentedSpawnEnv()))(),
      },
      'user',
    );
    const bindingKey = this.bindingKey(effective.env, input);
    if (
      isOpenCodeResumeCursor(input.resumeCursor) &&
      input.resumeCursor.bindingKey !== bindingKey
    )
      throw new Error(
        'This OpenCode session belongs to another OpenCode data home or profile, so it cannot resume here.',
      );
    const resumedId = isOpenCodeResumeCursor(input.resumeCursor)
      ? input.resumeCursor.sessionId
      : isAcpResumeCursor(input.resumeCursor)
        ? input.resumeCursor.acpSessionId
        : undefined;
    if (resumedId)
      openCodeSteerCustody(
        this.options.managedWorkspaceHomeDir ?? resolveHomeDir(),
        bindingKey,
        resumedId,
      ).assertClear();
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
    mcp: OpenCodeNativeMcp,
  ): Promise<ProviderSession> {
    const cursor = isOpenCodeResumeCursor(input.resumeCursor)
      ? input.resumeCursor
      : undefined;
    const bindingKey = this.bindingKey(plan.env, input);
    if (cursor)
      openCodeSteerCustody(
        this.options.managedWorkspaceHomeDir ?? resolveHomeDir(),
        bindingKey,
        cursor.sessionId,
      ).assertClear();
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
    let sessionId: string;
    let stored: string | undefined;
    // Where the session is: the server's directory, unless OpenCode moved it
    // (a resumed session is where its last move put it).
    let cwd = lease.cwd;
    if (cursor) {
      sessionId = cursor.sessionId;
      // The session must exist in this server's store.
      const existing = await lease.client.request<{ data?: unknown }>(
        'GET',
        `/api/session/${sessionId}`,
      );
      stored = readString(ownRecord(existing?.data)?.agent);
      const inbox = await lease.client.request<{ data?: unknown }>(
        'GET',
        `/api/session/${sessionId}/inbox`,
      );
      if ((ownArray(inbox?.data) ?? []).length > 0)
        throw new Error(
          'OpenCode still has queued input for this session. Resolve it in OpenCode before resuming here.',
        );
      cwd =
        readString(ownRecord(ownRecord(existing?.data)?.location)?.directory) ??
        cwd;
    }
    // A governed session runs a named agent, whose denies its rules keep.
    const sessionAgent = agent ?? stored ?? (floor ? 'build' : undefined);
    if (floor && sessionAgent && !isOpenCodeGovernedMode(sessionAgent))
      throw new ApprovalGovernanceRefusedError(
        governedModeRefusal(sessionAgent),
      );
    // The agent's own rules, read (and the start checked) only when
    // Station's confined rules govern it.
    const agentRules =
      floor === 'confined' && sessionAgent
        ? await this.assertGovernable(lease.client, cwd, floor, sessionAgent)
        : undefined;
    const permissions = floor ? openCodeNativeApprovalRules(floor) : undefined;
    const model = readModelRef(input.modelId);
    if (input.modelId && !cursor)
      await this.assertModel(lease.client, input.modelId);
    // Before the session runs, so its first step sees them.
    await this.addMcpServers(input.threadId, lease.client, mcp);
    if (cursor) {
      sessionId = cursor.sessionId;
      if (agent && agent !== stored)
        await lease.client.request('POST', `/api/session/${sessionId}/agent`, {
          agent,
        });
      // Its rules follow the mode this start asks for. OpenCode ignores
      // `permissions: null` (the old rules stay; 2.3.0 mode-switch capture),
      // so a start without a mode sends `[]`, which clears them.
      await lease.client.request('PATCH', `/api/session/${sessionId}`, {
        permissions: permissions ?? [],
      });
    } else {
      const created = await lease.client.request<{ data?: unknown }>(
        'POST',
        '/api/session',
        {
          location: { directory: lease.cwd },
          ...(sessionAgent ? { agent: sessionAgent } : {}),
          ...(model ? { model } : {}),
          ...(permissions && permissions.length > 0 ? { permissions } : {}),
        },
      );
      const id = readString(ownRecord(created?.data)?.id);
      if (!id) throw new Error('OpenCode did not name the session it created.');
      sessionId = id;
    }
    // Read as the ACP adapter reads it (`AcpAdapter` session record).
    const delegation =
      input.metadata?.delegation &&
      typeof input.metadata.delegation === 'object'
        ? (input.metadata.delegation as InvocationContext['delegation'])
        : undefined;
    const preToolPolicy = await this.preparePreToolPolicy(input, delegation);
    const ledger =
      this.options.acp?.untrustedContentLedger ?? sharedUntrustedContentLedger;
    let onMoved: (move: { sessionId: string; directory: string }) => void =
      () => undefined;
    let onMustStop: () => void = () => undefined;
    const native = new OpenCodeNativeSession({
      steerCustody: openCodeSteerCustody(
        this.options.managedWorkspaceHomeDir ?? resolveHomeDir(),
        bindingKey,
        sessionId!,
      ),
      threadId: input.threadId,
      provider: this.provider,
      engineName: ENGINE_NAME,
      client: lease.client,
      sessionId,
      publish: (event) => this.publish(event),
      ...(mode ? { approvalMode: mode } : {}),
      ...(agentRules ? { agentRules } : {}),
      cwd,
      serverDirectory: lease.cwd,
      configEnv: plan.env,
      agentRulesFor: (name) => this.agentRules(lease.client, name),
      // #4828: the ledger and ancestry the ACP path asks (acp-adapter.ts).
      untrustedRead: () =>
        ledger.conversationHasRead(
          ...untrustedContentAncestry({
            conversationId: input.threadId,
            delegation,
          }),
        ),
      ...(preToolPolicy ? { preToolPolicy } : {}),
      // As the ACP adapter reads it (`record.delegation?.denyApprovals`).
      ...(delegation?.denyApprovals ? { denyApprovals: true } : {}),
      onMoved: (move) => onMoved(move),
      onMustStop: () => onMustStop(),
      ...(this.options.reconnectFirstMs
        ? { reconnectFirstMs: this.options.reconnectFirstMs }
        : {}),
      ...(this.options.failCloseSettleMs
        ? { failCloseSettleMs: this.options.failCloseSettleMs }
        : {}),
      ...(this.options.refusedAsksBounds
        ? { refusedAsksBounds: this.options.refusedAsksBounds }
        : {}),
      ...(this.options.newMessageId
        ? { newMessageId: this.options.newMessageId }
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
      cwd: cwd === lease.cwd ? plan.cwd : cwd,
      bindingKey,
      transport: 'native',
    };
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      cwd: resumeCursor.cwd,
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
      agent: sessionAgent,
      cwd,
      rules: permissions ?? [],
      dirty: false,
      busy: false,
      serverIsSessions: mcp.sessionScoped,
    };
    this.native.set(input.threadId, record);
    onMoved = (move) => void this.onSessionMoved(input.threadId, record, move);
    // The usual stop, as for a move it cannot govern (the session warned).
    onMustStop = () => {
      if (this.native.get(input.threadId) === record)
        void this.stopSession(input.threadId);
    };
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
    // The canonical start is started, then configured, as over ACP; the
    // engine's own model and agent follow on its first step (`onConfigured`).
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.configured',
      sessionId: input.threadId,
      ...(input.modelId ? { model: input.modelId } : {}),
      cwd: resumeCursor.cwd,
      // The same transport facts as the start: the latest configured event
      // is what a later read of the session's metadata finds first.
      metadata: {
        ...input.metadata,
        openCodeTransport: 'native',
        openCodeVersion: plan.version,
      },
    });
    return session;
  }

  /**
   * A session of this tree moved (`session.moved`). OpenCode loads the
   * destination's own configuration and plugins while it resolves the
   * move, before it says so (2.3.0 `core/src/session/move.ts`; `move`
   * capture), so in a governed session (Ask, Auto) the destination is
   * scanned as a start is (#3924): code there stops the session, with a
   * warning that says why. Station's rules deny the agent's own move tool
   * (`openCodeNativeApprovalRules`), so this is the backstop for a move made
   * otherwise. A move of the session itself (not a child) is otherwise
   * followed: the directory the configuration guard and the resume cursor
   * use.
   */
  private async onSessionMoved(
    threadId: string,
    record: NativeRecord,
    move: { sessionId: string; directory: string },
  ): Promise<void> {
    if (this.native.get(threadId) !== record) return;
    const own = move.sessionId === record.cursor.sessionId;
    if (own) {
      record.cwd = move.directory;
      record.cursor.cwd = move.directory;
      record.session = { ...record.session, cwd: move.directory };
    }
    if (acpApprovalFloor(record.native.approvalMode) !== 'confined') return;
    let code: string[];
    try {
      code = await (this.options.findProjectCode ?? defaultFindProjectCode)(
        move.directory,
      );
    } catch (error) {
      code = [
        `the new directory could not be scanned (${errorMessage(error)})`,
      ];
    }
    if (code.length === 0 || this.native.get(threadId) !== record) return;
    this.warn(
      threadId,
      OPENCODE_SESSION_MOVED_UNGOVERNABLE,
      `Station stopped this OpenCode chat: ${own ? 'it' : 'one of its subagents'} moved to ${move.directory}, where ${openCodeProjectCodeRefusal(code)}. OpenCode loaded that configuration on the move, so Station's approval mode no longer covers what the chat runs.`,
      { directory: move.directory, sessionId: move.sessionId },
    );
    // The usual stop: OpenCode's execution is interrupted, its asks
    // rejected, and the session released.
    await this.stopSession(threadId);
  }

  /** The server died under a live session: its turn aborts and the session exits. */
  private async onServerExit(
    threadId: string,
    record: NativeRecord,
  ): Promise<void> {
    if (this.native.get(threadId) !== record) return;
    this.native.delete(threadId);
    await record.native.stop('exited');
    this.revokeMcpAuth(threadId);
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
      if (input.modelId) {
        const session = (await this.inner.listSessions()).find(
          (item) => item.threadId === input.threadId,
        );
        if (input.modelId !== session?.model)
          throw new SendTurnRefusedError(
            'Changing the model in this chat requires the OpenCode native transport. Start a new chat with the selected model.',
            'input_unsupported',
          );
      }
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
    // Images go as prompt files, data URIs, as OpenCode's own ACP layer
    // sends them (`cli/src/acp/turn.ts`); other files are refused, as on ACP.
    let decoded: ReturnType<typeof decodeChatAttachments>;
    try {
      decoded = decodeChatAttachments(input.attachments);
    } catch (error) {
      throw new SendTurnRefusedError(errorMessage(error), 'input_unsupported');
    }
    try {
      rejectFileAttachments(ENGINE_NAME, decoded);
    } catch (error) {
      throw new AttachmentInputUnsupportedError(errorMessage(error));
    }
    // Busy from here, before anything is awaited: a second turn sent while
    // this one applies its settings is refused, not set up alongside it.
    if (record.busy)
      throw new SendTurnRefusedError(
        'This OpenCode session is already running a turn.',
        'busy',
      );
    record.native.assertIdle();
    record.busy = true;
    try {
      const configured = (await this.options.getConnections()).some(
        (connection) => connection.id === record.cursor.connectionId,
      );
      if (!configured || this.native.get(input.threadId) !== record)
        throw new SendTurnRefusedError(
          'This engine is disconnected. Continue with another agent.',
          'session_gone',
        );
      return await this.sendNativeTurn(
        record,
        input,
        decoded.map(({ attachment, base64 }) => ({
          uri: `data:${attachment.mimeType};base64,${base64}`,
          name: attachment.name,
        })),
      );
    } finally {
      record.busy = false;
    }
  }

  private async assertModel(
    client: OpenCodeServeLease['client'],
    modelId: string,
  ) {
    const model = readModelRef(modelId);
    if (!model)
      throw new SendTurnRefusedError(
        `OpenCode requires a provider/model selector: ${modelId}`,
        'input_unsupported',
      );
    const available = await client.request<{ data?: unknown }>(
      'GET',
      '/api/model',
    );
    if (
      !(ownArray(available?.data) ?? []).some((entry) => {
        const candidate = ownRecord(entry);
        return (
          candidate?.id === model.id &&
          candidate?.providerID === model.providerID &&
          candidate?.enabled !== false
        );
      })
    )
      throw new SendTurnRefusedError(
        `OpenCode model is unavailable: ${modelId}`,
        'input_unsupported',
      );
    return model;
  }

  private async sendNativeTurn(
    record: NativeRecord,
    input: ProviderSendTurnInput,
    files: Array<{ uri: string; name: string }>,
  ): Promise<ProviderTurnStartResult> {
    const assertCurrent = () => {
      if (this.native.get(input.threadId) !== record || record.native.isStopped)
        throw new SendTurnRefusedError(
          'This OpenCode session has stopped.',
          'unavailable',
        );
    };
    assertCurrent();
    if (record.modelUnconfirmed && !input.modelId)
      throw new SendTurnRefusedError(
        'Select a model again to confirm the OpenCode session model before sending.',
        'unavailable',
      );
    if (input.modelId) {
      const model = await this.assertModel(record.lease.client, input.modelId);
      assertCurrent();
      try {
        await record.lease.client.request(
          'POST',
          `/api/session/${record.cursor.sessionId}/model`,
          { model },
        );
      } catch (error) {
        record.modelUnconfirmed = true;
        throw new SendTurnRefusedError(
          `OpenCode did not confirm the model change, so this message was not sent: ${errorMessage(error)}`,
          'unavailable',
        );
      }
      assertCurrent();
      record.modelUnconfirmed = false;
      record.session.model = input.modelId;
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
        method: 'session.configured',
        sessionId: input.threadId,
        model: input.modelId,
      });
    }
    assertCurrent();
    await this.applyTurnSettings(record, input);
    assertCurrent();
    const turnId = crypto.randomUUID();
    const displayText = input.displayInput ?? input.input;
    // A turn with attachments is a prompt, never a command (as on ACP).
    const invocation =
      files.length === 0 ? readSlashCommandInvocation(input.input) : undefined;
    const result = {
      threadId: input.threadId,
      turnId,
      resumeCursor: record.cursor,
    };
    if (!invocation) {
      await record.native.sendTurn({
        turnId,
        text: input.input,
        ...(files.length > 0 ? { files } : {}),
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
          if (!target) return { kind: 'answered', text: 'Nothing to rewind.' };
          return rewindCommandOutcome(
            await native.rewind(target, { commandTurnId: turnId }),
          );
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

  /**
   * #3290 on the native transport: a turn that names an approval mode or an
   * agent moves the live OpenCode session to it before its prompt is sent,
   * as the ACP adapter does at its turn boundary. The agent is switched, the
   * session's ruleset replaced (`PATCH`; it depends on the mode only), and
   * the grants made under the old mode dropped. Station's record of the
   * agent, rules and mode changes only as each is applied; a failure part
   * way marks the record dirty, so the next turn applies everything again.
   * Anything that cannot be applied refuses the turn before the prompt,
   * except a failed move to a looser mode, which runs under the stricter
   * rules it already has, with a warning.
   */
  private async applyTurnSettings(
    record: NativeRecord,
    input: ProviderSendTurnInput,
  ): Promise<void> {
    const requestedMode = readApprovalMode(input.modelOptions);
    const requestedAgent = requestedAcpSessionMode(input.modelOptions);
    const current = record.native.approvalMode;
    const mode: AcpAppliedApprovalMode | undefined = requestedMode
      ? acpAppliedApprovalMode(requestedMode, input.confinement)
      : current;
    const agent = requestedAgent ?? record.agent;
    if (!record.dirty && mode === current && agent === record.agent) return;
    const floor = acpApprovalFloor(mode);
    const currentFloor = acpApprovalFloor(current);
    const sessionAgent = agent ?? (floor ? 'build' : undefined);
    if (floor && sessionAgent && !isOpenCodeGovernedMode(sessionAgent))
      throw new ApprovalGovernanceRefusedError(
        governedModeRefusal(sessionAgent),
      );
    const client = record.lease.client;
    const sessionId = record.cursor.sessionId;
    const agentChanged = record.dirty || sessionAgent !== record.agent;
    // The new agent's own rules, for whichever of the old and the new mode
    // the confined rules govern (a failed PATCH leaves the old one).
    const newAgentRules =
      sessionAgent && (floor === 'confined' || currentFloor === 'confined')
        ? floor === 'confined'
          ? await this.assertGovernable(client, record.cwd, floor, sessionAgent)
          : await this.agentRules(client, sessionAgent)
        : undefined;
    const rules = floor ? openCodeNativeApprovalRules(floor) : [];
    if (sessionAgent && agentChanged) {
      try {
        await client.request('POST', `/api/session/${sessionId}/agent`, {
          agent: sessionAgent,
        });
      } catch (error) {
        // OpenCode may have switched anyway: the next turn asks again.
        record.dirty = true;
        throw new SendTurnRefusedError(
          `OpenCode did not switch to the ${sessionAgent} agent, so this message was not sent: ${redactSecrets(errorMessage(error))}.`,
          'unavailable',
        );
      }
      record.agent = sessionAgent;
      // The engine runs the new agent under the rules it still has: Station
      // keeps that agent's denies under them from now on.
      record.native.setApprovalMode(
        current,
        currentFloor === 'confined' ? newAgentRules : undefined,
      );
    }
    if (
      record.dirty ||
      JSON.stringify(rules) !== JSON.stringify(record.rules)
    ) {
      try {
        await client.request('PATCH', `/api/session/${sessionId}`, {
          permissions: rules,
        });
      } catch (error) {
        record.dirty = true;
        const reason = redactSecrets(errorMessage(error));
        // What was asked for, and what OpenCode still runs under.
        const target =
          floor === 'full'
            ? "Station's full-access rules"
            : floor === 'confined'
              ? "Station's approval rules"
              : 'its own approval settings';
        const remains =
          currentFloor === 'full'
            ? 'it is still running with full access'
            : currentFloor === 'confined'
              ? "it's still asking first as before"
              : "it's still using its own settings";
        const message = `Couldn't switch OpenCode to ${target}; ${remains}`;
        // A turn may run only under rules at least as strict as the pick:
        // only a failed move from Ask or Auto to full access still runs.
        if (currentFloor !== 'confined' || floor !== 'full')
          throw new ApprovalGovernanceRefusedError(
            `${message}, so this message was not sent: ${reason}.`,
          );
        this.warn(
          input.threadId,
          ACP_APPROVAL_TAKEOVER_FAILED_CODE,
          `${message}: ${reason}.`,
          {
            ...(mode ? { requestedApprovalMode: mode } : {}),
            reason,
            ...(current ? { appliedApprovalMode: current } : {}),
          },
        );
        return;
      }
      record.rules = rules;
    }
    record.dirty = false;
    record.native.setApprovalMode(
      mode,
      floor === 'confined' ? newAgentRules : undefined,
    );
  }

  /** `/rewind <turnId>`, or with none the turn before the last. */
  private rewindTarget(
    native: OpenCodeNativeSession,
    args: string,
  ): string | undefined {
    const named = args.trim();
    if (named) return named;
    // No turn named: take back the last one.
    return native.rewindPoints().at(-1);
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
          catalogRoute: {
            providerId,
            modelId: id,
            displayName: readString(model?.name),
          },
        },
      ];
    });
    return options?.maxEntries ? models.slice(0, options.maxEntries) : models;
  }

  sessionDurability(threadId: string) {
    if (this.overAcp.has(threadId))
      return this.inner.sessionDurability?.(threadId);
    if (!this.native.has(threadId)) return undefined;
    return {
      ...ACP_ENGINE_DURABILITY,
      steerPlacement: {
        state: 'native' as const,
        boundary: 'engine-defined' as const,
        detail:
          'Additional input is acknowledged when OpenCode delivers it to the active execution.',
      },
    };
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

  /**
   * Rewind to before `turnId` (upstream's generic session action). Native:
   * OpenCode's revert stage and commit (`OpenCodeNativeSession.rewind`).
   * Over ACP: the inner ACP adapter's rewind, by what the engine declared.
   */
  async rewindSession(
    threadId: string,
    turnId: string,
  ): Promise<SessionRewindOutcome> {
    if (this.overAcp.has(threadId))
      return (
        this.inner.rewindSession?.(threadId, turnId) ?? {
          kind: 'refused',
          reason: 'unsupported',
        }
      );
    const record = this.native.get(threadId);
    if (!record) return { kind: 'refused', reason: 'not-live' };
    if (record.busy) return { kind: 'refused', reason: 'send-preparing' };
    return record.native.rewind(turnId);
  }

  /**
   * This session's continuity. Native: rewind in place; no fork, since
   * Station has no generic fork action for one to answer. Over ACP: what
   * the engine declared at `initialize`.
   */
  sessionContinuity(threadId: string): SessionLiveContinuity {
    if (this.overAcp.has(threadId))
      return (
        this.inner.sessionContinuity?.(threadId) ?? {
          live: false,
          rewind: 'none',
          fork: 'none',
        }
      );
    const record = this.native.get(threadId);
    if (!record || record.native.isStopped)
      return { live: false, rewind: 'none', fork: 'none' };
    return { live: true, rewind: 'in-place', fork: 'none' };
  }

  /**
   * Reconnect one of the session's MCP servers. Native: OpenCode's own
   * disconnect then connect (`/api/experimental/mcp/{server}/…`), which
   * restarts a configured server; OpenCode 2 has no OAuth step Station can
   * start. Over ACP: the inner ACP adapter's, by what the engine declared.
   */
  async reconnectMcpServer(
    threadId: string,
    serverName: string,
    options: { startOAuth: boolean },
  ): Promise<EngineCommandOutcome> {
    if (this.overAcp.has(threadId))
      return (
        this.inner.reconnectMcpServer?.(threadId, serverName, options) ?? {
          kind: 'not-declared',
        }
      );
    return this.requireNative(threadId).native.reconnectMcp(
      serverName,
      options,
    );
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
    try {
      await record.native.stop('stopped');
    } finally {
      if (record.serverIsSessions) record.lease.discard();
      else record.lease.release();
      this.revokeMcpAuth(threadId);
    }
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
      for (const threadId of [...this.preflightLeases.keys()])
        this.takePreflightLease(threadId)?.lease.release();
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

/** A `/rewind` command's rewind, as the line its turn shows. */
function rewindCommandOutcome(
  outcome: SessionRewindOutcome,
): EngineCommandOutcome {
  if (outcome.kind === 'rewound')
    return {
      kind: 'answered',
      success: true,
      text: `${ENGINE_NAME} rewound to before that turn.`,
    };
  if (outcome.kind === 'failed') return outcome;
  return { kind: 'failed', message: REWIND_REFUSAL_TEXT[outcome.reason] };
}

const REWIND_REFUSAL_TEXT: Record<
  Extract<SessionRewindOutcome, { kind: 'refused' }>['reason'],
  string
> = {
  unsupported: 'this session declared no rewind.',
  'not-live': 'no engine process holds this session.',
  'turn-running': 'a turn is running; stop it before rewinding.',
  'send-preparing': 'a message is being sent; try again once it runs.',
  'rewind-pending': 'an earlier rewind is still with the engine.',
  'unknown-turn':
    'that turn has no OpenCode message on this session, so it cannot be a rewind point.',
};
