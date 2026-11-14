/**
 * GitHub Copilot through the Copilot SDK: a vendor-native Station engine,
 * behind the `copilot-sdk-engine` Feature Preview
 * (docs/decisions/copilot-sdk-engine.md). The existing ACP built-in
 * (`copilot --acp`) is a separate connection and is unchanged.
 *
 * One Copilot runtime per Station session: the SDK spawns the person's own
 * installed Copilot CLI in headless stdio mode, with Station's child
 * environment and the session's own TMPDIR. How each SDK capability binds to
 * a generic Station seam:
 *
 * - create/resume: `createSession` / `resumeSession`; the resume cursor is
 *   `{ copilotSessionId }`, scoped by `nativeResumeBindingKey` to the
 *   runtime's configuration home. A session whose runtime did not apply
 *   `permissionMode: 'manual'` is refused.
 * - turns: `send({ mode: 'enqueue', clientTurnId })`; a turn ends on the
 *   `session.idle` after its own `user.message`, or on a root
 *   `session.error` for its message (the SDK's own `sendAndWait` matching).
 * - steer: `send({ mode: 'immediate' })` into the running turn.
 * - interrupt: `abort()`, confirmed by the turn's own `session.idle`.
 * - approvals: `onPermissionRequest` → `request.opened` / `respondToRequest`
 *   (`copilot-sdk-approval.ts`); the mode is derived again on every turn.
 * - rewind: `session.history.rewind` at the turn's `user.message` event id,
 *   restoring captured files (`enableFileChangeTracking`).
 * - subagents, usage, MCP status, reroutes: `copilot-sdk-events.ts`.
 * - MCP reconnect: `session.mcp.restartServer`.
 * - runtime death: the connection watch settles the turn and ends the session.
 *
 * Every entry point that starts work selects the preview again, so turning
 * it off stops new sessions and new turns at once. Stop, interrupt and
 * answering an open request stay available so nothing is stranded.
 */
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ModelInfo,
  PermissionRequest,
  PermissionRequestResult,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import { STEERING_ENGINE_DURABILITY } from '@kontourai/station-contracts/engine-capability-matrix';
import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import {
  ACP_SESSION_REWOUND_CODE,
  type ApprovalMode,
  type ModelLaunchCapabilities,
  NATIVE_RESUME_BINDING_METADATA_KEY,
  PROVIDER_COPILOT_SDK,
  readApprovalMode,
  SESSION_REWIND_AFFECTED_PATHS_MAX,
  type SessionLiveContinuity,
  type SessionRewindOutcome,
  type StationConfinement,
} from '@kontourai/station-contracts/provider';
import {
  FEATURE_PREVIEW_DISABLED_CODE,
  SESSION_RECOVERY_FAILED_CODE,
  SESSION_START_IN_FLIGHT_CODE,
} from '@kontourai/station-contracts/provider-failure';
import type { ProviderRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import {
  assertEngineAllowedByManagedPolicy,
  managedEnginePrerequisites,
} from '../../security/managed-engine-limits.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import { ensureEngineSpawnTmpDir } from '../../services/infra/engine-spawn-tmpdir.js';
import {
  commitEngineLaunch,
  engineSessionTmpDir,
  stampLaunchExit,
} from '../../services/infra/session-tmpdir.js';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { errorMessage } from '../../utils/error-message.js';
import type { Logger } from '../../utils/logger.js';
import {
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderInterruptTurnResult,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  ProviderTurnEndedError,
  type ProviderTurnStartResult,
  SendTurnRefusedError,
  SessionRewindingError,
  SessionStartRefusedError,
} from '../adapter-shape.js';
import {
  buildCliRuntimePrerequisites,
  findCliBinary,
  resolveAugmentedPathSync,
} from '../auth/cli-auth.js';
import { providerFailureForCode } from '../provider-failure.js';
import {
  AsyncEventQueue,
  type AsyncEventStreamOptions,
} from '../sessions/async-event-queue.js';
import {
  type CopilotAppliedApprovalMode,
  copilotAppliedApprovalMode,
  copilotManagedApprovalRequired,
  copilotModeAllows,
  copilotPermissionResult,
  copilotPermissionView,
  copilotRealPath,
  copilotSessionGrantKey,
} from './copilot-sdk-approval.js';
import {
  type CopilotEventBody,
  CopilotSdkEventTranslator,
} from './copilot-sdk-events.js';
import {
  type CopilotSdkClientFactory,
  type CopilotSdkClientPort,
  type CopilotSdkLaunch,
  type CopilotSdkSessionPort,
  createCopilotSdkClient,
} from './copilot-sdk-port.js';
import { nativeResumeBindingKey } from './native-resume-binding.js';

const COPILOT_SDK_DISPLAY_NAME = 'GitHub Copilot (SDK)';
const PREVIEW_DISABLED_MESSAGE =
  'Turn on GitHub Copilot through the Copilot SDK in Settings → Advanced → Feature previews.';

/** How long an interrupt waits for the runtime's own `session.idle`. */
const COPILOT_SDK_INTERRUPT_SETTLE_MS = 10_000;
/** How long a model catalogue read is reused. */
const MODEL_CATALOG_TTL_MS = 5 * 60_000;
/** Restored file paths a failed rewind's message names. */
const REWIND_FAILURE_PATHS_SHOWN = 5;

const COPILOT_SDK_MODEL_LAUNCH: ModelLaunchCapabilities = {
  defaultAtStart: 'engine-selected',
  omissionAtResume: 'retain-session-model',
  omissionPerTurn: 'retain-session-model',
  overrideAtStart: true,
  overrideAtResume: true,
  overridePerTurn: false,
};

type CopilotLogger = Pick<Logger, 'warn' | 'info'>;

interface CopilotSdkAdapterOptions {
  /** The `copilot-sdk-engine` preview; selected at every entry point. */
  preview: FeaturePreviewSelector;
  clientFactory?: CopilotSdkClientFactory;
  /** Resolves the Copilot CLI to launch, or `null` when none is installed. */
  resolveCliPath?: () => string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  newId?: () => string;
  logger?: CopilotLogger;
  interruptSettleMs?: number;
  /** Only for the readiness tests: replaces running `copilot --version`. */
  findBinary?: (command: string) => string | null;
}

/** The resume cursor this adapter writes and reads. */
interface CopilotResumeCursor {
  copilotSessionId: string;
}

function readResumeCursor(value: unknown): CopilotResumeCursor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as { copilotSessionId?: unknown }).copilotSessionId;
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    ? { copilotSessionId: id }
    : undefined;
}

interface PendingPermission {
  request: PermissionRequest;
  managed: boolean;
  resolve: (result: PermissionRequestResult) => void;
}

interface ActiveTurn {
  turnId: string;
  /** The runtime echoed this turn's `user.message` (its `clientTurnId`). */
  consumed: boolean;
  /** That `user.message`'s `messageId`, which `session.error` names. */
  messageId?: string;
  settled: Promise<void>;
  settle: () => void;
}

interface CopilotSessionRecord {
  session: ProviderSession;
  client: CopilotSdkClientPort;
  copilot: CopilotSdkSessionPort;
  cwd: string;
  /** The working directory's real path; approvals compare against it. */
  realCwd: string;
  /** The mode the last turn (or the start) asked for, before confinement. */
  requestedMode: ApprovalMode | undefined;
  /** The mode answering requests now (`copilotAppliedApprovalMode`). */
  mode: CopilotAppliedApprovalMode;
  grants: Set<string>;
  translator: CopilotSdkEventTranslator;
  pending: Map<string, PendingPermission>;
  activeTurn?: ActiveTurn;
  /** Station turn id → the id of its `user.message` event (the rewind point). */
  rewindPoints: Map<string, string>;
  turnOrder: string[];
  rewinding: boolean;
  stopWatch: () => void;
  ended: boolean;
}

/**
 * On Windows an npm-installed `copilot` is a `.cmd` shim, which the SDK
 * cannot spawn. Its package entry beside it is a `.js` file the SDK runs with
 * Node (`@github/copilot` declares `bin: { copilot: "npm-loader.js" }`).
 */
export function resolveCopilotCliLaunchPath(found: string): string | null {
  if (!/\.(cmd|bat|ps1)$/i.test(found)) return found;
  const entry = join(
    dirname(found),
    'node_modules',
    '@github',
    'copilot',
    'npm-loader.js',
  );
  return existsSync(entry) ? entry : null;
}

/**
 * The Copilot CLI on PATH. A managed policy cannot pin this engine's binary:
 * its engine ids (`managed-policy-engines.ts`) do not name `copilot-sdk`.
 */
function defaultResolveCliPath(): string | null {
  const found = findCliBinary('copilot');
  return found ? resolveCopilotCliLaunchPath(found) : null;
}

/** The configuration home the runtime keeps sessions in (`COPILOT_HOME`). */
function copilotHome(env: NodeJS.ProcessEnv): string {
  return env.COPILOT_HOME || join(homedir(), '.copilot');
}

export class CopilotSdkAdapter implements ProviderAdapterShape {
  readonly provider = PROVIDER_COPILOT_SDK;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: COPILOT_SDK_DISPLAY_NAME,
    description:
      'GitHub Copilot through the Copilot SDK, over your installed Copilot CLI (Feature Preview).',
    capabilities: [
      'agent-runtime',
      'session-lifecycle',
      'external-process',
      'approvals',
    ],
    builtin: true,
    engineId: engineId(PROVIDER_COPILOT_SDK),
    durability: STEERING_ENGINE_DURABILITY,
    continuity: {
      resume: 'same-session',
      fork: 'none',
      rewind: 'in-place',
      nativeReturn: 'same-binding',
    },
    modelLaunch: COPILOT_SDK_MODEL_LAUNCH,
    approvalAcknowledgement: 'in-process',
  };

  private readonly events = new AsyncEventQueue<ProviderRuntimeEvent>();
  private readonly sessions = new Map<string, CopilotSessionRecord>();
  /** Threads whose start is between its first check and its record. */
  private readonly starting = new Set<string>();
  private readonly clientFactory: CopilotSdkClientFactory;
  private readonly resolveCliPath: () => string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly interruptSettleMs: number;
  private modelCatalog?: { at: number; models: ModelInfo[] };

  constructor(private readonly options: CopilotSdkAdapterOptions) {
    this.clientFactory = options.clientFactory ?? createCopilotSdkClient;
    this.resolveCliPath = options.resolveCliPath ?? defaultResolveCliPath;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.interruptSettleMs =
      options.interruptSettleMs ?? COPILOT_SDK_INTERRUPT_SETTLE_MS;
  }

  /** Selects the preview now; never cached (also read by native adoption). */
  previewEnabled(): boolean {
    return this.options.preview.select({
      enabled: () => true,
      disabled: () => false,
    });
  }

  private publish(
    threadId: string,
    turnId: string | undefined,
    body: CopilotEventBody,
  ): void {
    const event = {
      eventId: this.newId(),
      provider: this.provider,
      threadId,
      createdAt: this.now().toISOString(),
      ...(turnId ? { turnId } : {}),
      ...body,
    } as ProviderRuntimeEvent;
    // Lets the session's own TMPDIR be removed once its launch has exited.
    stampLaunchExit(event);
    this.events.push(event);
  }

  private bindingKey(): string {
    return nativeResumeBindingKey(
      PROVIDER_COPILOT_SDK,
      copilotHome(this.env),
      null,
    );
  }

  /**
   * How one runtime starts: the CLI, Station's child environment (the
   * process environment, so the runtime also reads `GH_TOKEN`, `GITHUB_TOKEN`
   * and `COPILOT_*` from it, as the person's own CLI would), and a TMPDIR.
   */
  private runtimeLaunch(
    cliPath: string,
    cwd: string,
    tmpDir: string | undefined,
  ): CopilotSdkLaunch {
    const env = Object.fromEntries(
      Object.entries(
        childProcessEnvironment({
          ...this.env,
          PATH: resolveAugmentedPathSync(),
          TMPDIR: tmpDir ?? ensureEngineSpawnTmpDir(),
        } as Record<string, string | undefined>),
      ).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    return { cliPath, args: [], env, cwd };
  }

  async getPrerequisites(options?: {
    signal?: AbortSignal;
  }): Promise<Prerequisite[]> {
    if (!this.previewEnabled()) {
      return [
        {
          id: 'copilot-sdk-preview',
          name: 'Feature preview',
          description: PREVIEW_DISABLED_MESSAGE,
          status: 'missing',
          category: 'required',
        } as Prerequisite,
      ];
    }
    const managed = managedEnginePrerequisites(
      PROVIDER_COPILOT_SDK,
      'copilot',
      COPILOT_SDK_DISPLAY_NAME,
    );
    if (managed) return managed;
    return buildCliRuntimePrerequisites({
      command: 'copilot',
      displayName: COPILOT_SDK_DISPLAY_NAME,
      versionArgs: ['--version'],
      ...(this.options.findBinary
        ? { findBinary: this.options.findBinary }
        : {}),
      installStep:
        'Install the GitHub Copilot CLI (https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) and ensure `copilot` is on PATH.',
      authStep:
        'Run `copilot login` on the computer Station runs on, or set COPILOT_GITHUB_TOKEN before starting Station.',
      // The CLI has no read-only sign-in check; a missing sign-in surfaces as
      // the first turn's error.
      detectAuthState: async () => 'unknown',
      unverifiedAuthDescription:
        'Copilot has no sign-in check Station can run; a missing sign-in shows on the first message.',
      signal: options?.signal,
    });
  }

  /**
   * A resume must name the configuration home its session was recorded
   * under. A cursor without a recorded binding key (none was stored, or it
   * did not survive) cannot be shown to belong here, so it is refused rather
   * than resumed unchecked.
   */
  async preflightStart(input: ProviderSessionStartInput): Promise<void> {
    this.refuseStartUnlessEnabled();
    assertEngineAllowedByManagedPolicy(PROVIDER_COPILOT_SDK);
    if (
      input.resumeCursor !== undefined &&
      input.nativeResumeBindingKey !== this.bindingKey()
    ) {
      throw new SessionStartRefusedError(
        input.nativeResumeBindingKey === undefined
          ? 'This Copilot session has no recorded configuration home, so Station cannot resume it safely.'
          : 'This Copilot session was recorded under a different Copilot configuration home.',
        SESSION_RECOVERY_FAILED_CODE,
      );
    }
  }

  private refuseStartUnlessEnabled(): void {
    if (!this.previewEnabled())
      throw new SessionStartRefusedError(
        PREVIEW_DISABLED_MESSAGE,
        FEATURE_PREVIEW_DISABLED_CODE,
      );
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const threadId = input.threadId;
    if (this.sessions.has(threadId))
      throw new Error(`Copilot SDK session already exists: ${threadId}`);
    if (this.starting.has(threadId))
      throw new SessionStartRefusedError(
        'This Copilot session is already starting.',
        SESSION_START_IN_FLIGHT_CODE,
      );
    this.starting.add(threadId);
    try {
      return await this.startSessionOnce(input);
    } finally {
      this.starting.delete(threadId);
    }
  }

  private async startSessionOnce(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    await this.preflightStart(input);
    const threadId = input.threadId;
    const cliPath = this.resolveCliPath();
    if (!cliPath)
      throw new Error(
        'The GitHub Copilot CLI is not installed or not on PATH. Install it and run `copilot login`.',
      );
    const cwd = input.cwd ?? process.cwd();
    const realCwd = copilotRealPath(cwd, cwd) ?? cwd;
    // The session's own TMPDIR, as for every Station-launched engine.
    const sessionTmpDir = engineSessionTmpDir(threadId);
    const client = await this.clientFactory(
      this.runtimeLaunch(cliPath, cwd, sessionTmpDir),
    );
    const requestedMode = readApprovalMode(input.modelOptions);
    const mode = copilotAppliedApprovalMode(requestedMode, input.confinement);
    // Filled once the session exists; events before that are held.
    let record: CopilotSessionRecord | undefined;
    const early: SessionEvent[] = [];
    const sessionConfig = {
      clientName: 'station',
      workingDirectory: cwd,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      permissionMode: 'manual',
      enableFileChangeTracking: true,
      ...(input.modelId ? { model: input.modelId } : {}),
      onEvent: (event: SessionEvent) => {
        if (!record) {
          early.push(event);
          return;
        }
        this.onSessionEvent(record, event);
      },
      onPermissionRequest: (
        request: PermissionRequest,
        invocation: { promptRequest?: unknown },
      ) => this.onPermissionRequest(() => record, request, invocation),
    } satisfies Partial<SessionConfig> & Partial<ResumeSessionConfig>;
    const cursor = readResumeCursor(input.resumeCursor);
    let copilot: CopilotSdkSessionPort;
    const rewindPoints = new Map<string, string>();
    const turnOrder: string[] = [];
    try {
      copilot = cursor
        ? await client.resumeSession(cursor.copilotSessionId, sessionConfig)
        : await client.createSession(sessionConfig);
      // A resumed session restores its own mode: refuse unless the runtime
      // reports `manual` applied, so its own automatic approvals never
      // answer for Station.
      const applied = copilot.permissionModeResult;
      if (!applied?.success || applied.mode !== 'manual')
        throw new SessionStartRefusedError(
          `Copilot did not apply manual approvals to this session (${
            applied
              ? `it runs ${applied.mode}`
              : 'it reported no permission mode'
          }), so Station will not run it.`,
          SESSION_RECOVERY_FAILED_CODE,
        );
      // Rewind points survive a resume: the persisted `user.message` events
      // still carry the `clientTurnId` each Station turn sent.
      if (cursor)
        for (const event of await copilot.getEvents()) {
          if (event.type !== 'user.message') continue;
          const turnId = event.data.clientTurnId;
          if (turnId && !rewindPoints.has(turnId)) {
            rewindPoints.set(turnId, event.id);
            turnOrder.push(turnId);
          }
        }
    } catch (error) {
      await client.stop();
      throw error;
    }
    const createdAt = this.now().toISOString();
    const resumeCursor: CopilotResumeCursor = {
      copilotSessionId: copilot.sessionId,
    };
    const created: CopilotSessionRecord = {
      session: {
        provider: this.provider,
        threadId,
        status: 'ready',
        cwd,
        ...(input.modelId ? { model: input.modelId } : {}),
        resumeCursor,
        createdAt,
        updatedAt: createdAt,
      },
      client,
      copilot,
      cwd,
      realCwd,
      requestedMode,
      mode,
      grants: new Set(),
      translator: new CopilotSdkEventTranslator(),
      pending: new Map(),
      rewindPoints,
      turnOrder,
      rewinding: false,
      stopWatch: () => undefined,
      ended: false,
    };
    record = created;
    this.sessions.set(threadId, created);
    created.stopWatch = client.watchConnection((error) =>
      this.onRuntimeLost(created, error),
    );
    commitEngineLaunch(
      threadId,
      sessionTmpDir ? { own: sessionTmpDir } : undefined,
    );
    this.publish(threadId, undefined, {
      method: 'session.started',
      sessionId: copilot.sessionId,
    });
    this.publish(threadId, undefined, {
      method: 'session.configured',
      sessionId: copilot.sessionId,
      cwd,
      ...(input.modelId ? { model: input.modelId } : {}),
      metadata: {
        [NATIVE_RESUME_BINDING_METADATA_KEY]: this.bindingKey(),
        approvalMode: mode,
      },
    });
    for (const event of early) this.onSessionEvent(created, event);
    return created.session;
  }

  private requireRecord(threadId: string): CopilotSessionRecord {
    const record = this.sessions.get(threadId);
    if (!record) throw new Error(`No Copilot SDK session: ${threadId}`);
    return record;
  }

  /**
   * The mode a turn runs under, derived again from what the turn carries:
   * its own approval mode (or the last one asked for) and its confinement.
   * A turn without a confinement is not a `host` session, so full access
   * that was granted to one is withdrawn rather than carried over.
   */
  private applyTurnMode(
    record: CopilotSessionRecord,
    modelOptions: Record<string, unknown> | undefined,
    confinement: StationConfinement | undefined,
  ): void {
    record.requestedMode =
      readApprovalMode(modelOptions) ?? record.requestedMode;
    const next = copilotAppliedApprovalMode(record.requestedMode, confinement);
    if (next === record.mode) return;
    record.mode = next;
    // A narrower mode also drops the grants a person gave under the wider one.
    if (next !== 'never') record.grants.clear();
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    if (!this.previewEnabled())
      throw new SendTurnRefusedError(PREVIEW_DISABLED_MESSAGE, 'unavailable');
    const record = this.requireRecord(input.threadId);
    if (record.rewinding) throw new SessionRewindingError();
    if (record.activeTurn)
      throw new SendTurnRefusedError(
        'A Copilot turn is still running. Wait for it, steer it, or stop it.',
        'busy',
      );
    if (input.attachments?.length)
      throw new SendTurnRefusedError(
        'Attachments are not supported on the Copilot SDK engine yet.',
        'input_unsupported',
      );
    this.applyTurnMode(record, input.modelOptions, input.confinement);
    const turnId = this.newId();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    record.activeTurn = { turnId, consumed: false, settled, settle };
    record.session = { ...record.session, status: 'running' };
    this.publish(input.threadId, turnId, {
      method: 'turn.started',
      turnId,
      prompt: input.displayInput ?? input.input,
      ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}),
      metadata: { approvalMode: record.mode },
    });
    const prompt = input.ambientContext
      ? `${input.ambientContext}\n\n${input.input}`
      : input.input;
    try {
      await record.copilot.send({
        prompt,
        mode: 'enqueue',
        clientTurnId: turnId,
      });
    } catch (error) {
      this.settleTurn(record, {
        method: 'turn.aborted',
        turnId,
        reason: `Copilot did not accept the message: ${errorMessage(error)}`,
      });
      throw error;
    }
    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: record.session.resumeCursor,
    };
  }

  /**
   * Steering joins the running turn under that turn's mode: the steer
   * carries no posture of its own, and orchestration refuses a steer across
   * a confinement change (`confinement-changed`).
   */
  async steerTurn(
    threadId: string,
    input: string,
    turnId: string,
  ): Promise<void> {
    if (!this.previewEnabled())
      throw new SendTurnRefusedError(PREVIEW_DISABLED_MESSAGE, 'unavailable');
    const record = this.requireRecord(threadId);
    if (record.activeTurn?.turnId !== turnId)
      throw new ProviderTurnEndedError();
    const text = input.trim();
    if (!text) throw new Error('Steer input is empty.');
    await record.copilot.send({ prompt: text, mode: 'immediate' });
    this.publish(threadId, turnId, {
      method: 'turn.started',
      turnId,
      prompt: text,
      inputKind: 'steer',
    });
  }

  async interruptTurn(
    threadId: string,
    turnId?: string,
  ): Promise<ProviderInterruptTurnResult> {
    const record = this.sessions.get(threadId);
    const active = record?.activeTurn;
    if (!record || !active) return { outcome: 'no-active-turn' };
    if (turnId && turnId !== active.turnId)
      return { outcome: 'target-mismatch', activeTurnId: active.turnId };
    this.declineOpenRequests(record);
    try {
      await record.copilot.abort();
    } catch (error) {
      // A runtime that cannot take the abort is gone: nothing is running.
      this.onRuntimeLost(record, error);
      return { outcome: 'cancelled', turnId: active.turnId };
    }
    const confirmed = await Promise.race([
      active.settled.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.interruptSettleMs);
        timer.unref?.();
      }),
    ]);
    return confirmed
      ? { outcome: 'cancelled', turnId: active.turnId }
      : { outcome: 'termination-unconfirmed', turnId: active.turnId };
  }

  /**
   * The runtime stopped answering (its process died or its pipe closed): the
   * running turn ends aborted, open requests are answered, and the session
   * ends. A later start resumes it from its cursor.
   */
  private onRuntimeLost(record: CopilotSessionRecord, error: unknown): void {
    if (record.ended) return;
    record.ended = true;
    record.stopWatch();
    const threadId = record.session.threadId;
    if (this.sessions.get(threadId) === record) this.sessions.delete(threadId);
    this.declineOpenRequests(record);
    const active = record.activeTurn;
    if (active)
      this.settleTurn(record, {
        method: 'turn.aborted',
        turnId: active.turnId,
        reason: 'The Copilot runtime stopped.',
      });
    this.options.logger?.warn('Copilot runtime connection lost', {
      threadId,
      error: errorMessage(error),
    });
    void record.client.stop();
    this.publish(threadId, undefined, {
      method: 'session.exited',
      sessionId: record.copilot.sessionId,
      reason: 'The Copilot runtime stopped.',
    });
  }

  private onSessionEvent(
    record: CopilotSessionRecord,
    event: SessionEvent,
  ): void {
    if (record.ended) return;
    const threadId = record.session.threadId;
    const active = record.activeTurn;
    const turnId = active?.turnId;
    if (event.type === 'user.message') {
      const clientTurnId = event.data.clientTurnId;
      if (clientTurnId && !record.rewindPoints.has(clientTurnId)) {
        record.rewindPoints.set(clientTurnId, event.id);
        record.turnOrder.push(clientTurnId);
      }
      if (active && clientTurnId === active.turnId && !event.agentId) {
        active.consumed = true;
        active.messageId = event.data.messageId;
      }
      return;
    }
    for (const body of record.translator.translate(event, {
      threadId,
      turnId,
    }))
      this.publish(threadId, turnId, body);
    if (event.type === 'session.error') {
      this.onSessionError(record, event);
      return;
    }
    // Only the idle after this turn's own message ends it: an idle left over
    // from an earlier run must not complete a turn that has not started.
    if (
      event.type === 'session.idle' &&
      active?.consumed &&
      event.data.mode !== 'autopilot'
    ) {
      this.settleTurn(
        record,
        event.data.aborted
          ? {
              method: 'turn.aborted',
              turnId: active.turnId,
              reason: 'Interrupted.',
            }
          : {
              method: 'turn.completed',
              turnId: active.turnId,
              finishReason: 'stop',
            },
      );
    }
  }

  /**
   * A subagent's error belongs to the subagent (its own failure arrives as
   * `subagent.failed`). A root error the runtime can recover from
   * (`eligibleForAutoSwitch`, for example a rate limit) is a warning. Any
   * other root error is reported; it ends the turn only when it is for this
   * turn's message, as the SDK's own `sendAndWait` reads it.
   */
  private onSessionError(
    record: CopilotSessionRecord,
    event: Extract<SessionEvent, { type: 'session.error' }>,
  ): void {
    if (event.agentId) return;
    const threadId = record.session.threadId;
    const active = record.activeTurn;
    const details = {
      errorType: event.data.errorType,
      ...(event.data.statusCode !== undefined
        ? { statusCode: event.data.statusCode }
        : {}),
    };
    if (event.data.eligibleForAutoSwitch) {
      this.publish(threadId, active?.turnId, {
        method: 'runtime.warning',
        severity: 'warning',
        code: 'copilot_sdk_session_error_recoverable',
        message: event.data.message,
        details,
      });
      return;
    }
    this.publish(threadId, active?.turnId, {
      method: 'runtime.error',
      ...providerFailureForCode(undefined),
      severity: 'error',
      message: event.data.message,
      code: 'copilot_sdk_session_error',
      details,
    });
    if (!active) return;
    const origin = event.data.originatingMessageId;
    const forThisTurn = origin ? origin === active.messageId : active.consumed;
    if (forThisTurn)
      this.settleTurn(record, {
        method: 'turn.aborted',
        turnId: active.turnId,
        reason: event.data.message,
      });
  }

  private settleTurn(
    record: CopilotSessionRecord,
    terminal: Extract<
      CopilotEventBody,
      { method: 'turn.completed' | 'turn.aborted' }
    >,
  ): void {
    const active = record.activeTurn;
    if (!active || active.turnId !== terminal.turnId) return;
    const threadId = record.session.threadId;
    for (const body of record.translator.settleOpenChildren(threadId))
      this.publish(threadId, active.turnId, body);
    record.activeTurn = undefined;
    record.session = {
      ...record.session,
      status: 'ready',
      updatedAt: this.now().toISOString(),
    };
    this.publish(threadId, active.turnId, terminal);
    active.settle();
  }

  private onPermissionRequest(
    current: () => CopilotSessionRecord | undefined,
    request: PermissionRequest,
    invocation: { promptRequest?: unknown } | undefined,
  ): Promise<PermissionRequestResult> | PermissionRequestResult {
    const record = current();
    if (!record || record.ended) return { kind: 'user-not-available' };
    const managed = copilotManagedApprovalRequired(request, invocation);
    if (
      copilotModeAllows(
        record.mode,
        request,
        { realCwd: record.realCwd, grants: record.grants },
        managed,
      )
    )
      return { kind: 'approve-once' };
    const requestId = this.newId();
    const view = copilotPermissionView(request);
    return new Promise<PermissionRequestResult>((resolve) => {
      record.pending.set(requestId, { request, managed, resolve });
      this.publish(record.session.threadId, record.activeTurn?.turnId, {
        method: 'request.opened',
        requestId,
        requestType: 'approval',
        blocking: true,
        title: view.title,
        payload: {
          toolName: view.toolName,
          toolKind: view.toolKind,
          toolInput: view.toolInput,
          ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
          ...(managed ? { managedApprovalRequired: true } : {}),
        },
      });
    });
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
    const record = this.requireRecord(threadId);
    const pending = record.pending.get(requestId);
    if (!pending) throw new Error(`No open Copilot request: ${requestId}`);
    record.pending.delete(requestId);
    if (decision === 'acceptForSession') {
      const key = copilotSessionGrantKey(
        pending.request,
        record.realCwd,
        pending.managed,
      );
      if (key) record.grants.add(key);
    }
    pending.resolve(copilotPermissionResult(decision));
    this.publish(threadId, record.activeTurn?.turnId, {
      method: 'request.resolved',
      requestId,
      blocking: true,
      status:
        decision === 'accept' || decision === 'acceptForSession'
          ? 'approved'
          : decision === 'decline'
            ? 'denied'
            : 'cancelled',
      acknowledgement: 'in-process',
    });
  }

  private declineOpenRequests(record: CopilotSessionRecord): void {
    for (const [requestId, pending] of record.pending) {
      pending.resolve({ kind: 'user-not-available' });
      this.publish(record.session.threadId, record.activeTurn?.turnId, {
        method: 'request.resolved',
        requestId,
        blocking: true,
        status: 'cancelled',
        acknowledgement: 'in-process',
      });
    }
    record.pending.clear();
  }

  sessionContinuity(threadId: string): SessionLiveContinuity {
    return {
      live: this.sessions.has(threadId),
      rewind: this.previewEnabled() ? 'in-place' : 'none',
      fork: 'none',
    };
  }

  async rewindSession(
    threadId: string,
    turnId: string,
  ): Promise<SessionRewindOutcome> {
    if (!this.previewEnabled())
      return { kind: 'refused', reason: 'unsupported' };
    const record = this.sessions.get(threadId);
    if (!record) return { kind: 'refused', reason: 'not-live' };
    if (record.rewinding) return { kind: 'refused', reason: 'rewind-pending' };
    if (record.activeTurn) return { kind: 'refused', reason: 'turn-running' };
    const eventId = record.rewindPoints.get(turnId);
    const index = record.turnOrder.indexOf(turnId);
    if (!eventId || index < 0)
      return { kind: 'refused', reason: 'unknown-turn' };
    record.rewinding = true;
    try {
      const result = await record.copilot.rewind({
        eventId,
        mode: 'conversation-and-files',
      });
      const restored = result.restoredFiles;
      switch (result.outcome) {
        case 'session-busy':
          return { kind: 'refused', reason: 'turn-running' };
        case 'unsupported-remote-session':
          return { kind: 'refused', reason: 'unsupported' };
        case 'success':
        case 'checkpoint-cleanup-failed':
        case 'snapshot-prune-failed': {
          const hiddenTurnIds = record.turnOrder.splice(index);
          for (const hidden of hiddenTurnIds)
            record.rewindPoints.delete(hidden);
          const affectedFiles =
            restored.length > 0
              ? {
                  count: restored.length,
                  paths: restored.slice(0, SESSION_REWIND_AFFECTED_PATHS_MAX),
                }
              : undefined;
          this.publish(threadId, undefined, {
            method: 'runtime.warning',
            severity: 'warning',
            code: ACP_SESSION_REWOUND_CODE,
            message: 'Copilot was rewound to before an earlier message.',
            details: {
              beforeTurnId: turnId,
              hiddenTurnIds,
              ...(affectedFiles
                ? { affectedFileCount: affectedFiles.count }
                : {}),
            },
          });
          return {
            kind: 'rewound',
            beforeTurnId: turnId,
            hiddenTurnIds,
            ...(affectedFiles ? { affectedFiles } : {}),
          };
        }
        default: {
          // files-rolled-back, rollback-incomplete, truncation-failed,
          // file-change-tracking-disabled: the runtime's own refusal or a
          // partial failure, reported as it gave it. Files it restored
          // before failing are named, since they did change.
          const files =
            restored.length > 0
              ? ` It had already restored ${restored.length} file(s): ${restored
                  .slice(0, REWIND_FAILURE_PATHS_SHOWN)
                  .join(', ')}${
                  restored.length > REWIND_FAILURE_PATHS_SHOWN ? ', …' : ''
                }.`
              : '';
          return {
            kind: 'failed',
            message: `Copilot could not rewind (${result.outcome})${
              result.error ? `: ${result.error}` : ''
            }.${files}`,
          };
        }
      }
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    } finally {
      record.rewinding = false;
    }
  }

  async reconnectMcpServer(
    threadId: string,
    serverName: string,
    options: { startOAuth: boolean },
  ): Promise<EngineCommandOutcome> {
    if (!this.previewEnabled())
      return { kind: 'failed', message: PREVIEW_DISABLED_MESSAGE };
    const record = this.sessions.get(threadId);
    if (!record)
      return { kind: 'failed', message: 'The session is not running.' };
    // `restartServer` has no sign-in option; a server that needs one reports
    // `needs-auth` again and the engine's own OAuth flow runs from there.
    if (options.startOAuth) return { kind: 'unsupported' };
    try {
      await record.copilot.restartMcpServer(serverName);
      return { kind: 'answered', success: true };
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    }
  }

  async listModels(options?: {
    signal?: AbortSignal;
    maxEntries?: number;
  }): Promise<Array<{ id: string; name: string; originalId: string }>> {
    if (!this.previewEnabled()) return [];
    const models = await this.readModelCatalog(options?.signal);
    return models
      .slice(0, options?.maxEntries ?? models.length)
      .map((model) => ({
        id: model.id,
        name: model.name,
        originalId: model.id,
      }));
  }

  private async readModelCatalog(signal?: AbortSignal): Promise<ModelInfo[]> {
    const cached = this.modelCatalog;
    if (cached && this.now().getTime() - cached.at < MODEL_CATALOG_TTL_MS)
      return cached.models;
    // A live session's runtime answers without a new process.
    const live = this.sessions.values().next().value as
      | CopilotSessionRecord
      | undefined;
    let models: ModelInfo[];
    if (live) {
      models = await live.client.listModels();
    } else {
      assertEngineAllowedByManagedPolicy(PROVIDER_COPILOT_SDK);
      const cliPath = this.resolveCliPath();
      if (!cliPath) return [];
      signal?.throwIfAborted();
      const cwd = homedir();
      // The same launch as a session's, with Station's shared engine TMPDIR.
      const client = await this.clientFactory(
        this.runtimeLaunch(cliPath, cwd, undefined),
      );
      try {
        models = await client.listModels();
      } finally {
        await client.stop();
      }
    }
    this.modelCatalog = { at: this.now().getTime(), models };
    return models;
  }

  async stopSession(threadId: string): Promise<void> {
    const record = this.sessions.get(threadId);
    if (!record) return;
    this.sessions.delete(threadId);
    record.ended = true;
    record.stopWatch();
    this.declineOpenRequests(record);
    const active = record.activeTurn;
    if (active) {
      await record.copilot.abort().catch(() => undefined);
      this.settleTurn(record, {
        method: 'turn.aborted',
        turnId: active.turnId,
        reason: 'The session stopped.',
      });
    }
    await record.copilot.disconnect().catch(() => undefined);
    const errors = await record.client.stop();
    if (errors.length > 0)
      this.options.logger?.warn('Copilot runtime did not stop cleanly', {
        threadId,
        errors: errors.map((error) => error.message),
      });
    this.publish(threadId, undefined, {
      method: 'session.exited',
      sessionId: record.copilot.sessionId,
      reason: 'stopped',
    });
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()].map((record) => record.session);
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  hasOpenEngineWork(threadId: string): boolean {
    const record = this.sessions.get(threadId);
    return (
      !!record &&
      (record.activeTurn !== undefined ||
        record.translator.openChildIds().length > 0)
    );
  }

  async stopAll(): Promise<void> {
    try {
      await Promise.all(
        [...this.sessions.keys()].map((threadId) => this.stopSession(threadId)),
      );
    } finally {
      this.events.close();
    }
  }

  streamEvents(
    options?: AsyncEventStreamOptions<ProviderRuntimeEvent>,
  ): AsyncIterable<ProviderRuntimeEvent> {
    return this.events.iterable(options);
  }
}
