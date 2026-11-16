import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isRecord } from '../../utils/is-record.js';
import { type CliCommandResult, runCliCommand } from '../auth/cli-auth.js';

/**
 * Which `muse serve` hosts Station drives, by the MSP stable-surface schema
 * their `initialize` reports (`schema.version`, `schema.fingerprint`).
 *
 * - A fingerprint this adapter was verified against
 *   ({@link MUSE_SERVE_VERIFIED_SCHEMA_FINGERPRINTS}) is accepted.
 * - Any other fingerprint with `schema.version` 1 is checked structurally:
 *   the binary exports its own stable schema (`muse schema
 *   generate-json-schema`, offline), and every method, notification, server
 *   request and `$defs` member Station sends or reads
 *   ({@link MUSE_SERVE_REQUIRED_SURFACE}) must still be there. The export
 *   is trusted only when `muse --version`, run right before and right after
 *   it, names the version the host reported (`serverInfo.version`): the
 *   launcher auto-updates, and an export from another binary proves nothing
 *   about this host.
 * - Anything else (another schema version, a missing member, a failed or
 *   mismatched export, no export runner) refuses the host, and the session
 *   falls back to `muse exec`.
 *
 * The fingerprint is not derivable from the exported bytes (checked on
 * 1.4.20: neither the file's nor a canonical JSON digest matches), so the
 * export cannot be matched to the fingerprint itself; the version check is
 * what ties the two together.
 */

/**
 * Stable-surface fingerprints of the hosts this adapter was verified against:
 * Muse Code 1.3.0-R3401.1; 1.4.18, re-checked for every request, result and
 * notification shape the adapter reads (only additive members changed); and
 * 1.4.20, whose stable export differs from 1.4.18's only by the optional
 * `SessionStartParams.clear`, which Station does not send.
 */
const MUSE_SERVE_VERIFIED_SCHEMA_FINGERPRINTS: ReadonlySet<string> = new Set([
  'sha256:7469c9e352e67def4a59df7e439984d7194fa351e1c8b7abb34060fd977ced81',
  'sha256:77dda18550adef14e257b015fe4e6490b722723f7d526df5ba4867939fff68a3',
  'sha256:283b1b125dcc9172928fb5d6711a92a353796d030a7c186988ed527a13cf07f0',
]);

/** The only MSP schema major the structural check understands. */
const MUSE_SERVE_SCHEMA_VERSION = 1;
/** Bound on the whole export: two `--version` runs and the export itself. */
const MUSE_SERVE_SCHEMA_EXPORT_TIMEOUT_MS = 15_000;
/** A 1.4.20 stable export is ~480 KB; anything far larger is refused. */
const MUSE_SCHEMA_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const MUSE_VERSION_OUTPUT_MAX_BYTES = 4_096;
/** Fingerprints whose verdict is remembered per adapter. */
const MUSE_SCHEMA_VERDICTS_MAX = 16;
/** Missing members named in a refusal; the rest are counted. */
const MUSE_SCHEMA_GAPS_NAMED_MAX = 6;
const MUSE_FINGERPRINT_LABEL_MAX_CHARS = 80;
const MUSE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
/** `muse --version`: `Muse Code 1.4.20 (1.4.20-R8619.1)`. */
const MUSE_VERSION_LINE = /^Muse Code ([^\s()]+)(?:\s|$)/;

/** What a `$defs` entry must still declare for Station's use of it. */
export interface MuseServeSurfaceDef {
  /** Properties Station writes; each must still be declared. */
  sends?: readonly string[];
  /** Properties Station relies on; each must still be declared and required. */
  requires?: readonly string[];
  /** Optional properties Station reads; each must still be declared. */
  reads?: readonly string[];
  /** Enum members Station sends or maps; each must still be a member. */
  members?: readonly string[];
  /** Properties whose schema must still point at this manifest's def. */
  refs?: Readonly<Record<string, string>>;
}

export interface MuseServeSurfaceCall {
  params?: string;
  result?: string;
}

export interface MuseServeRequiredSurface {
  /** Client requests Station sends. */
  methods: Readonly<Record<string, MuseServeSurfaceCall>>;
  /** Notifications Station sends (`initialized`) or handles. */
  notifications: Readonly<Record<string, MuseServeSurfaceCall>>;
  /** Server requests Station answers. */
  requests: Readonly<Record<string, MuseServeSurfaceCall>>;
  defs: Readonly<Record<string, MuseServeSurfaceDef>>;
}

/**
 * Every MSP member the serve session, its child work and the discovery reads
 * use, derived from `muse-serve-session.ts`, `muse-serve-child-work.ts`,
 * `muse-serve-discovery.ts` and `harness-questions.ts` (Muse's question
 * form) and checked against the 1.4.18 and 1.4.20 stable exports. A field
 * Station starts sending or reading belongs here too, by hand: the
 * coverage tests in `muse-serve-adapter.test.ts` fail only on a wire METHOD
 * or notification this manifest does not name (replayed captures, and every
 * method Station sent), not on an unlisted field.
 */
export const MUSE_SERVE_REQUIRED_SURFACE: MuseServeRequiredSurface = {
  methods: {
    initialize: { params: 'InitializeParams', result: 'InitializeResult' },
    'session/start': {
      params: 'SessionStartParams',
      result: 'SessionStartResult',
    },
    'session/resume': {
      params: 'SessionResumeParams',
      result: 'SessionResumeResult',
    },
    'session/setApprovalMode': {
      params: 'SessionSetApprovalModeParams',
      result: 'SessionSetApprovalModeResult',
    },
    'session/setModel': { params: 'SessionSetModelParams' },
    'session/compact': {
      params: 'SessionCompactParams',
      result: 'SessionCompactResult',
    },
    'turn/start': { params: 'TurnStartParams', result: 'TurnStartResult' },
    'turn/interrupt': { params: 'TurnInterruptParams' },
    'turn/steer': { params: 'TurnSteerParams', result: 'TurnSteerResult' },
    'approval/decide': { params: 'ApprovalDecideParams' },
    'approval/listPending': {
      params: 'ApprovalListPendingParams',
      result: 'ApprovalListPendingResult',
    },
    'userInput/answer': { params: 'UserInputAnswerParams' },
    'userInput/cancel': { params: 'UserInputCancelParams' },
    'goal/pause': { params: 'GoalPauseParams' },
    'goal/clear': { params: 'GoalClearParams' },
    'task/stop': { params: 'TaskStopParams' },
    'subagent/stop': { params: 'SubagentOwnerReasonParams' },
    'subagent/sendMessage': { params: 'SubagentInputParams' },
    'model/list': { result: 'ModelListResult' },
    'usage/read': { result: 'UsageReadResult' },
  },
  notifications: {
    initialized: {},
    'session/goalChanged': { params: 'SessionGoalChangedParams' },
    'turn/started': { params: 'TurnStartedParams' },
    'turn/completed': { params: 'TurnCompletedParams' },
    'item/started': { params: 'ItemStartedParams' },
    'item/updated': { params: 'ItemUpdatedParams' },
    'item/completed': { params: 'ItemCompletedParams' },
    'item/delta': { params: 'ItemDeltaParams' },
    'session/tokenUsage': { params: 'SessionTokenUsageParams' },
    'session/contextUsage': { params: 'SessionContextUsageParams' },
    'session/todoListChanged': { params: 'SessionTodoListChangedParams' },
    'session/modelChanged': { params: 'SessionModelChangedParams' },
    'session/modelRouteUnserved': { params: 'SessionModelRouteUnservedParams' },
    'turn/retryScheduled': { params: 'TurnRetryScheduledParams' },
    'turn/modelRetryScheduled': { params: 'TurnModelRetryScheduledParams' },
    'approval/requested': { params: 'ApprovalRequestParams' },
    'approval/updated': { params: 'ApprovalUpdatedParams' },
    'approval/resolved': { params: 'ApprovalResolvedParams' },
    'approval/reviewing': { params: 'ApprovalRequestParams' },
    'userInput/requested': { params: 'UserInputRequestParams' },
    'userInput/settled': { params: 'UserInputSettledParams' },
  },
  requests: {
    'approval/request': {
      params: 'ApprovalRequestParams',
      result: 'RequestReceipt',
    },
    'userInput/request': {
      params: 'UserInputRequestParams',
      result: 'RequestReceipt',
    },
  },
  defs: {
    InitializeParams: {
      sends: ['clientInfo', 'capabilities'],
      refs: { clientInfo: 'ClientInfo', capabilities: 'ClientCapabilities' },
    },
    ClientInfo: { sends: ['name', 'title', 'version'] },
    ClientCapabilities: { sends: ['experimentalApi'] },
    InitializeResult: {
      requires: ['schema', 'serverInfo'],
      reads: [
        'sandboxAvailability',
        'sandboxUnavailableReason',
        'sessionDurability',
      ],
      refs: {
        schema: 'SchemaInfo',
        serverInfo: 'ServerInfo',
        sandboxAvailability: 'SandboxAvailability',
        sessionDurability: 'SessionDurability',
      },
    },
    SchemaInfo: { requires: ['fingerprint', 'version'] },
    ServerInfo: { requires: ['version'] },
    SandboxAvailability: { members: ['available', 'unavailable'] },
    SessionDurability: { members: ['durable'] },
    SessionStartParams: {
      sends: ['commandId', 'workspaceRoot', 'approvalMode', 'modelId'],
      refs: { approvalMode: 'ApprovalMode' },
    },
    ApprovalMode: { members: ['allowAll', 'promptUnmatched', 'onRequest'] },
    SessionStartResult: { requires: ['session'], refs: { session: 'Session' } },
    Session: {
      requires: ['sessionId', 'modelId'],
      reads: ['approvalMode'],
      refs: { approvalMode: 'EffectiveApprovalModeState' },
    },
    EffectiveApprovalModeState: {
      requires: ['mode'],
      refs: { mode: 'ApprovalMode' },
    },
    SessionResumeParams: {
      sends: ['commandId', 'sessionId', 'excludeItems', 'modelId'],
    },
    SessionResumeResult: {
      requires: ['session'],
      refs: { session: 'Session' },
    },
    SessionSetApprovalModeParams: {
      sends: ['commandId', 'sessionId', 'mode'],
      refs: { mode: 'ApprovalMode' },
    },
    SessionSetApprovalModeResult: {
      requires: ['effectiveMode', 'applyOutcome'],
      refs: { effectiveMode: 'EffectiveApprovalModeState' },
    },
    SessionSetModelParams: {
      sends: ['commandId', 'sessionId', 'model'],
      refs: { model: 'ModelSelection' },
    },
    ModelSelection: { sends: ['modelId'] },
    SessionCompactParams: { sends: ['commandId', 'sessionId'] },
    SessionCompactResult: {
      requires: ['status'],
      reads: ['reason'],
      refs: { status: 'CompactStatus' },
    },
    CompactStatus: { members: ['accepted', 'noop'] },
    TurnStartParams: {
      sends: ['commandId', 'sessionId', 'reasoningEffort', 'input'],
      refs: { reasoningEffort: 'ReasoningEffort', input: 'TurnInputPart' },
    },
    TurnInputPart: {
      sends: ['type', 'text', 'mediaType', 'base64Data'],
      refs: { type: 'TurnInputPartType' },
    },
    TurnInputPartType: { members: ['text', 'image'] },
    ReasoningEffort: {
      members: [
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ],
    },
    TurnStartResult: { requires: ['turnId'] },
    TurnInterruptParams: { sends: ['commandId', 'sessionId', 'turnId'] },
    TurnSteerParams: {
      sends: ['commandId', 'sessionId', 'expectedTurnId', 'input'],
      refs: { input: 'TurnInputPart' },
    },
    TurnSteerResult: { requires: ['turnId'] },
    ApprovalDecideParams: {
      sends: [
        'commandId',
        'sessionId',
        'approvalId',
        'choiceId',
        'requirementId',
        'feedback',
      ],
      refs: { requirementId: 'ApprovalRequirementRef' },
    },
    ApprovalRequirementRef: {
      sends: ['approvalId', 'sourceIndex'],
      requires: ['approvalId', 'sourceIndex'],
    },
    ApprovalListPendingParams: { sends: ['sessionId'] },
    ApprovalListPendingResult: {
      requires: ['approvals', 'userInputs'],
      refs: {
        approvals: 'ApprovalRequestParams',
        userInputs: 'UserInputRequestParams',
      },
    },
    UserInputAnswerParams: {
      sends: ['commandId', 'sessionId', 'userInputId', 'answers'],
      refs: { answers: 'UserInputAnswer' },
    },
    UserInputAnswer: {
      sends: ['questionId', 'selectedLabel', 'selectedLabels', 'freeText'],
    },
    UserInputCancelParams: {
      sends: ['commandId', 'sessionId', 'userInputId', 'reason'],
    },
    GoalPauseParams: { sends: ['commandId', 'sessionId'] },
    GoalClearParams: { sends: ['commandId', 'sessionId'] },
    TaskStopParams: { sends: ['commandId', 'sessionId', 'taskId'] },
    SubagentOwnerReasonParams: {
      sends: ['commandId', 'sessionId', 'subagentId', 'reason'],
    },
    SubagentInputParams: {
      sends: ['commandId', 'sessionId', 'subagentId', 'body'],
    },
    ModelListResult: {
      requires: ['models'],
      refs: { models: 'ModelCatalogEntry' },
    },
    ModelCatalogEntry: {
      requires: ['modelId', 'displayLabel', 'contextLimit'],
      reads: ['variants', 'reasoningEffortVariants'],
      refs: { reasoningEffortVariants: 'ModelDescribedReasoningEffort' },
    },
    ModelDescribedReasoningEffort: {
      requires: ['tier'],
      reads: ['description'],
      refs: { tier: 'ReasoningEffort' },
    },
    UsageReadResult: { reads: ['usage'], refs: { usage: 'SubscriptionUsage' } },
    SubscriptionUsage: {
      requires: ['observedAtMs', 'window', 'weekly', 'tier'],
      refs: {
        window: 'SubscriptionUsageWindow',
        weekly: 'SubscriptionUsageWeekly',
      },
    },
    SubscriptionUsageWindow: {
      requires: ['usedPercent', 'windowDurationMins', 'resetsAtMs'],
    },
    SubscriptionUsageWeekly: { requires: ['usedPercent', 'resetsAtMs'] },
    SessionGoalChangedParams: {
      requires: ['sessionId', 'goal'],
      refs: { goal: 'Goal' },
    },
    Goal: { requires: ['objective', 'status'] },
    TurnStartedParams: { requires: ['sessionId', 'turnId'] },
    TurnCompletedParams: {
      requires: ['sessionId', 'turnId', 'terminal'],
      reads: ['error', 'reason'],
      refs: { terminal: 'TurnTerminal', error: 'TurnError' },
    },
    TurnTerminal: { members: ['completed', 'failed', 'cancelled'] },
    TurnError: { requires: ['message', 'retryable'] },
    ItemStartedParams: {
      requires: ['sessionId', 'item'],
      refs: { item: 'Item' },
    },
    ItemUpdatedParams: {
      requires: ['sessionId', 'item'],
      refs: { item: 'Item' },
    },
    ItemCompletedParams: {
      requires: ['sessionId', 'item'],
      refs: { item: 'Item' },
    },
    Item: {
      requires: ['itemId', 'kind', 'status'],
      reads: [
        'turnId',
        'text',
        'callId',
        'tool',
        'args',
        'visibleOutput',
        'failureReason',
        'bashTitle',
        'workflowRunId',
        'children',
        'background',
        'message',
        'subagentId',
        'result',
        'usage',
        'durationMs',
        'role',
        'objective',
        'depth',
      ],
      refs: {
        kind: 'ItemKind',
        status: 'ItemStatus',
        children: 'WorkflowChild',
        result: 'SubagentResult',
        usage: 'TokenUsage',
      },
    },
    ItemKind: {
      members: [
        'agentMessage',
        'reasoning',
        'toolCall',
        'workflow',
        'subagent',
      ],
    },
    ItemStatus: { members: ['inProgress', 'completed', 'cancelled'] },
    ItemDeltaParams: {
      requires: ['sessionId', 'itemId', 'delta'],
      reads: ['field'],
    },
    WorkflowChild: {
      requires: ['childId', 'status'],
      reads: ['label', 'durationMs', 'terminal', 'usage'],
      refs: { terminal: 'TurnTerminal', usage: 'TokenUsage' },
    },
    SubagentResult: { requires: ['summary'] },
    TokenUsage: {
      requires: ['inputTokens', 'outputTokens'],
      reads: ['cacheReadTokens', 'cacheWriteTokens'],
    },
    SessionTokenUsageParams: {
      requires: ['sessionId', 'turnId', 'usage', 'cumulative'],
      refs: { usage: 'TokenUsage', cumulative: 'CumulativeTokenUsage' },
    },
    CumulativeTokenUsage: { reads: ['cost'], refs: { cost: 'CumulativeCost' } },
    CumulativeCost: { requires: ['usd', 'partial'] },
    SessionContextUsageParams: {
      requires: ['sessionId', 'usedTokens'],
      reads: ['windowTokens'],
    },
    SessionTodoListChangedParams: {
      requires: ['sessionId', 'items'],
      refs: { items: 'TodoItem' },
    },
    TodoItem: { requires: ['text', 'status'], refs: { status: 'TodoStatus' } },
    TodoStatus: { members: ['pending', 'inProgress', 'completed'] },
    SessionModelChangedParams: {
      requires: ['sessionId', 'modelId', 'source'],
      refs: { source: 'ModelChangeSource' },
    },
    ModelChangeSource: { members: ['policy'] },
    SessionModelRouteUnservedParams: {
      requires: ['sessionId', 'modelId', 'installedProviderId'],
    },
    TurnRetryScheduledParams: {
      requires: [
        'sessionId',
        'turnId',
        'nextAttempt',
        'maxAttempts',
        'retryDelayMs',
        'reason',
      ],
      reads: ['errorKind', 'httpStatus'],
    },
    TurnModelRetryScheduledParams: {
      requires: [
        'sessionId',
        'turnId',
        'nextAttempt',
        'maxAttempts',
        'retryDelayMs',
      ],
      reads: ['errorKind', 'httpStatus'],
    },
    ApprovalRequestParams: {
      requires: [
        'sessionId',
        'approvalId',
        'availableChoices',
        'currentRequirementId',
        'subject',
        'toolName',
        'toolCallId',
        'turnId',
        'rawArgs',
      ],
      reads: ['subagentOrigin'],
      refs: {
        availableChoices: 'ApprovalChoice',
        currentRequirementId: 'ApprovalRequirementRef',
        subject: 'ApprovalSubject',
        subagentOrigin: 'ApprovalSubagentOrigin',
      },
    },
    ApprovalUpdatedParams: {
      requires: [
        'sessionId',
        'approvalId',
        'availableChoices',
        'currentRequirementId',
        'subject',
      ],
      refs: {
        availableChoices: 'ApprovalChoice',
        currentRequirementId: 'ApprovalRequirementRef',
        subject: 'ApprovalSubject',
      },
    },
    ApprovalSubject: {
      requires: ['kind'],
      reads: ['command', 'workspaceRoot', 'stages'],
      refs: { stages: 'ApprovalStage' },
    },
    ApprovalStage: {
      requires: ['argv', 'argvComplete', 'requirementId', 'resolution'],
      refs: {
        requirementId: 'ApprovalRequirementRef',
        resolution: 'ApprovalStageResolution',
      },
    },
    ApprovalStageResolution: { requires: ['kind'] },
    ApprovalChoice: {
      requires: ['choiceId', 'decision', 'scope'],
      reads: ['acceptsFeedback'],
      refs: { decision: 'ApprovalDecision', scope: 'ApprovalChoiceScope' },
    },
    ApprovalChoiceScope: { members: ['once'] },
    ApprovalSubagentOrigin: { requires: ['subagentId'] },
    ApprovalResolvedParams: {
      requires: ['sessionId', 'approvalId', 'decision', 'resolvedBy'],
      refs: { decision: 'ApprovalDecision' },
    },
    ApprovalDecision: {
      members: [
        'approved',
        'approvedForSession',
        'approvedPolicyAmendment',
        'denied',
        'deniedPolicyAmendment',
        'timedOut',
        'abort',
      ],
    },
    UserInputRequestParams: {
      requires: [
        'sessionId',
        'userInputId',
        'questions',
        'turnId',
        'toolName',
        'toolCallId',
      ],
      reads: ['autoResolutionMs'],
      refs: { questions: 'UserInputQuestion' },
    },
    UserInputQuestion: {
      requires: ['id', 'header', 'question', 'options', 'selection'],
      refs: { options: 'UserInputOption', selection: 'UserInputSelection' },
    },
    UserInputOption: { requires: ['label'], reads: ['description'] },
    UserInputSelection: {
      requires: ['mode'],
      reads: ['minSelections', 'maxSelections'],
      refs: { mode: 'UserInputSelectionMode' },
    },
    UserInputSelectionMode: { members: ['single', 'multiple'] },
    UserInputSettledParams: {
      requires: ['sessionId', 'userInputId', 'outcome'],
      refs: { outcome: 'UserInputOutcome' },
    },
    UserInputOutcome: { members: ['answered', 'clarified', 'timedOut'] },
  },
};

function refName(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.$ref !== 'string') return undefined;
  const prefix = '#/$defs/';
  return value.$ref.startsWith(prefix)
    ? value.$ref.slice(prefix.length)
    : undefined;
}

/** Whether `value`'s schema subtree references `#/$defs/<target>`. */
function mentionsDef(value: unknown, target: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value))
    return value.some((entry) => mentionsDef(entry, target, depth + 1));
  if (!isRecord(value)) return false;
  if (refName(value) === target) return true;
  return Object.values(value).some((entry) =>
    mentionsDef(entry, target, depth + 1),
  );
}

function ownRecord(
  container: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(container, key)) return undefined;
  const value = container[key];
  return isRecord(value) ? value : undefined;
}

/**
 * The members of `surface` an exported MSP schema (`msp.schema.json`) no
 * longer has, as short labels; empty when every one is there. Structural
 * only: a member that kept its name but changed its meaning is not caught,
 * which is why a fingerprint nobody verified is announced, never silent.
 */
export function museServeSchemaSurfaceGaps(
  schema: unknown,
  surface: MuseServeRequiredSurface = MUSE_SERVE_REQUIRED_SURFACE,
): string[] {
  if (!isRecord(schema)) return ['the schema'];
  const sections = {
    methods: ownRecord(schema, 'methods'),
    notifications: ownRecord(schema, 'notifications'),
    requests: ownRecord(schema, 'requests'),
  };
  const defs = ownRecord(schema, '$defs');
  if (
    !defs ||
    !sections.methods ||
    !sections.notifications ||
    !sections.requests
  )
    return ['the schema'];
  const gaps: string[] = [];
  const label = {
    methods: 'method',
    notifications: 'notification',
    requests: 'request',
  } as const;
  for (const section of ['methods', 'notifications', 'requests'] as const) {
    const exported = sections[section]!;
    for (const [name, call] of Object.entries(surface[section])) {
      const entry = ownRecord(exported, name);
      if (!entry) {
        gaps.push(`${label[section]} ${name}`);
        continue;
      }
      for (const part of ['params', 'result'] as const) {
        const expected = call[part];
        if (expected && refName(entry[part]) !== expected)
          gaps.push(`${label[section]} ${name} ${part} ${expected}`);
      }
    }
  }
  for (const [name, def] of Object.entries(surface.defs)) {
    const exported = ownRecord(defs, name);
    if (!exported) {
      gaps.push(name);
      continue;
    }
    const properties = ownRecord(exported, 'properties') ?? {};
    const required = Array.isArray(exported.required) ? exported.required : [];
    const declared = (property: string) => Object.hasOwn(properties, property);
    for (const property of [...(def.sends ?? []), ...(def.reads ?? [])]) {
      if (!declared(property)) gaps.push(`${name}.${property}`);
    }
    for (const property of def.requires ?? []) {
      if (!declared(property)) gaps.push(`${name}.${property}`);
      else if (!required.includes(property))
        gaps.push(`${name}.${property} (no longer required)`);
    }
    const members = Array.isArray(exported.enum) ? exported.enum : [];
    for (const member of def.members ?? []) {
      if (!members.includes(member)) gaps.push(`${name} member ${member}`);
    }
    for (const [property, target] of Object.entries(def.refs ?? {})) {
      if (declared(property) && !mentionsDef(properties[property], target))
        gaps.push(`${name}.${property} → ${target}`);
    }
  }
  return [...new Set(gaps)];
}

/** How a host's reported schema was judged. */
export type MuseServeSchemaVerdict =
  | { kind: 'verified'; fingerprint: string }
  /** An unverified fingerprint whose exported schema has every member Station uses. */
  | { kind: 'compatible'; fingerprint: string; museVersion: string }
  | { kind: 'refused'; reason: string };

/** Judges one `initialize` result; never rejects. */
export type MuseServeSchemaCheck = (
  initializeResult: unknown,
) => Promise<MuseServeSchemaVerdict>;

interface ReportedSchema {
  fingerprint?: string;
  version?: unknown;
  museVersion?: string;
}

function reportedSchema(initializeResult: unknown): ReportedSchema {
  const result = isRecord(initializeResult) ? initializeResult : {};
  const schema = isRecord(result.schema) ? result.schema : {};
  const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : {};
  return {
    ...(typeof schema.fingerprint === 'string' && schema.fingerprint
      ? { fingerprint: schema.fingerprint }
      : {}),
    version: schema.version,
    ...(typeof serverInfo.version === 'string' &&
    MUSE_VERSION.test(serverInfo.version)
      ? { museVersion: serverInfo.version }
      : {}),
  };
}

function fingerprintLabel(fingerprint: string | undefined): string {
  if (!fingerprint) return '(none)';
  return fingerprint.length > MUSE_FINGERPRINT_LABEL_MAX_CHARS
    ? `${fingerprint.slice(0, MUSE_FINGERPRINT_LABEL_MAX_CHARS - 1)}…`
    : fingerprint;
}

/**
 * The verdict that needs no export: a verified fingerprint is accepted, and
 * anything else is refused. Hosts are judged this way when no export runner
 * is configured, and the structural check starts from it.
 */
export function museServeKnownSchemaVerdict(
  initializeResult: unknown,
): MuseServeSchemaVerdict {
  const { fingerprint } = reportedSchema(initializeResult);
  return fingerprint && MUSE_SERVE_VERIFIED_SCHEMA_FINGERPRINTS.has(fingerprint)
    ? { kind: 'verified', fingerprint }
    : {
        kind: 'refused',
        reason: `unverified MSP schema fingerprint ${fingerprintLabel(fingerprint)}`,
      };
}

/** Runs one unattended `muse` command for the schema check. */
export type MuseSchemaCommandRunner = (input: {
  command: string;
  args: readonly string[];
  /** Layered over Station's spawn env (see `runCliCommand`). */
  env: Record<string, string>;
  /** Inherited variables removed from the run. */
  omitEnv?: readonly string[];
  timeoutMs: number;
}) => Promise<CliCommandResult | null>;

export const runMuseSchemaCommand: MuseSchemaCommandRunner = ({
  command,
  args,
  env,
  omitEnv,
  timeoutMs,
}) =>
  runCliCommand(command, [...args], undefined, env, {
    timeoutMs,
    maxBuffer: MUSE_VERSION_OUTPUT_MAX_BYTES * 16,
    killSignal: 'SIGKILL',
    ...(omitEnv?.length ? { omitEnv } : {}),
  });

const MUSE_SCHEMA_EXPORT_ARGS = [
  'schema',
  'generate-json-schema',
  '--out',
] as const;

/** The environment one check runs its commands under (the host's own). */
export interface MuseSchemaCheckEnv {
  env: Record<string, string>;
  omitEnv?: readonly string[];
}

export interface MuseServeSchemaVerifierDeps {
  /** The `muse` command the host was launched from; `null` when not found. */
  resolveCommand: () => string | null;
  run: MuseSchemaCommandRunner;
  /** Bound on one export; defaults to {@link MUSE_SERVE_SCHEMA_EXPORT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A failed export: not remembered, so the next host tries again. */
class MuseSchemaExportError extends Error {}

/**
 * One adapter's structural checks. A definitive verdict (compatible, or
 * missing members) is remembered per fingerprint; an export that failed or
 * named another version is not, so the next host checks again. Concurrent
 * checks of one fingerprint share one export.
 */
export class MuseServeSchemaVerifier {
  private readonly verdicts = new Map<
    string,
    Promise<MuseServeSchemaVerdict>
  >();

  constructor(private readonly deps: MuseServeSchemaVerifierDeps) {}

  async check(
    initializeResult: unknown,
    env: MuseSchemaCheckEnv,
  ): Promise<MuseServeSchemaVerdict> {
    const known = museServeKnownSchemaVerdict(initializeResult);
    if (known.kind === 'verified') return known;
    const { fingerprint, version, museVersion } =
      reportedSchema(initializeResult);
    if (!fingerprint) return known;
    if (version !== MUSE_SERVE_SCHEMA_VERSION) {
      return {
        kind: 'refused',
        reason: `unverified MSP schema version ${String(version).slice(0, 16)} (fingerprint ${fingerprintLabel(fingerprint)})`,
      };
    }
    if (!museVersion) {
      return {
        kind: 'refused',
        reason: `unverified MSP schema fingerprint ${fingerprintLabel(fingerprint)}: the host reported no version to check its schema export against`,
      };
    }
    const cached = this.verdicts.get(fingerprint);
    if (cached) {
      const verdict = await cached;
      // A remembered compatible verdict names the version that exported it;
      // this host reported the same schema, so it holds for it too.
      return verdict.kind === 'compatible'
        ? { ...verdict, museVersion }
        : verdict;
    }
    // Never rejects: a check that shares this one gets the same refusal.
    const pending: Promise<MuseServeSchemaVerdict> = this.exportAndCheck(
      fingerprint,
      museVersion,
      env,
    ).catch((error: unknown) => {
      // A failed export says nothing about the schema: not remembered.
      if (this.verdicts.get(fingerprint) === pending)
        this.verdicts.delete(fingerprint);
      return {
        kind: 'refused',
        reason: `unverified MSP schema fingerprint ${fingerprintLabel(fingerprint)}: ${
          error instanceof MuseSchemaExportError
            ? error.message
            : 'its schema could not be exported'
        }`,
      };
    });
    this.remember(fingerprint, pending);
    return pending;
  }

  private remember(
    fingerprint: string,
    verdict: Promise<MuseServeSchemaVerdict>,
  ): void {
    if (this.verdicts.size >= MUSE_SCHEMA_VERDICTS_MAX) {
      const oldest = this.verdicts.keys().next().value;
      if (oldest !== undefined) this.verdicts.delete(oldest);
    }
    this.verdicts.set(fingerprint, verdict);
  }

  private async exportAndCheck(
    fingerprint: string,
    museVersion: string,
    env: MuseSchemaCheckEnv,
  ): Promise<MuseServeSchemaVerdict> {
    const command = this.deps.resolveCommand();
    if (!command) throw new MuseSchemaExportError('muse was not found');
    const deadline =
      Date.now() + (this.deps.timeoutMs ?? MUSE_SERVE_SCHEMA_EXPORT_TIMEOUT_MS);
    const run = async (args: readonly string[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new MuseSchemaExportError('the schema export timed out');
      const result = await this.deps.run({
        command,
        args,
        env: env.env,
        ...(env.omitEnv?.length ? { omitEnv: env.omitEnv } : {}),
        timeoutMs: remaining,
      });
      if (result?.code !== 0) {
        throw new MuseSchemaExportError(
          result?.timedOut
            ? 'the schema export timed out'
            : `muse ${args[0]} exited ${result ? String(result.code) : 'without a result'}`,
        );
      }
      return result;
    };
    // The release (`1.4.20`) is what the host reports; the full line also
    // names the build (`1.4.20-R8619.1`), so two builds of one release that
    // swapped during the export still read as a mismatch.
    const binaryVersion = async () => {
      const line = (await run(['--version'])).stdout
        .slice(0, MUSE_VERSION_OUTPUT_MAX_BYTES)
        .trim();
      return { release: MUSE_VERSION_LINE.exec(line)?.[1], line };
    };
    const dir = await mkdtemp(join(tmpdir(), 'station-muse-schema-'));
    try {
      const beforeRun = await binaryVersion();
      await run([...MUSE_SCHEMA_EXPORT_ARGS, dir]);
      const afterRun = await binaryVersion();
      const before = beforeRun.release;
      const after =
        afterRun.line === beforeRun.line
          ? afterRun.release
          : `${afterRun.release ?? 'unknown'} (another build)`;
      if (before !== museVersion || after !== museVersion) {
        throw new MuseSchemaExportError(
          `the host reported Muse ${museVersion}, but the installed muse is ${
            before === after
              ? (before ?? 'unknown')
              : `${before ?? 'unknown'}, then ${after ?? 'unknown'}`
          }`,
        );
      }
      const manifest = await readExportJson(join(dir, 'manifest.json'));
      if (
        !isRecord(manifest) ||
        manifest.schemaVersion !== MUSE_SERVE_SCHEMA_VERSION ||
        manifest.experimental !== false
      ) {
        throw new MuseSchemaExportError(
          'the export is not the stable version 1 schema',
        );
      }
      const gaps = museServeSchemaSurfaceGaps(
        await readExportJson(join(dir, 'msp.schema.json')),
      );
      if (gaps.length > 0) {
        const named = gaps.slice(0, MUSE_SCHEMA_GAPS_NAMED_MAX).join(', ');
        const more = gaps.length - MUSE_SCHEMA_GAPS_NAMED_MAX;
        // The missing members lead: the fallback warning bounds its detail.
        return {
          kind: 'refused',
          reason: `the MSP schema lacks what Station uses: ${named}${
            more > 0 ? ` and ${more} more` : ''
          } (unverified fingerprint ${fingerprintLabel(fingerprint)})`,
        };
      }
      return { kind: 'compatible', fingerprint, museVersion };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function readExportJson(path: string): Promise<unknown> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new MuseSchemaExportError(`the export wrote no ${pathLabel(path)}`);
  }
  if (size > MUSE_SCHEMA_EXPORT_MAX_BYTES)
    throw new MuseSchemaExportError(
      `the exported ${pathLabel(path)} is too large`,
    );
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new MuseSchemaExportError(
      `the exported ${pathLabel(path)} is not JSON`,
    );
  }
}

function pathLabel(path: string): string {
  return basename(path);
}
