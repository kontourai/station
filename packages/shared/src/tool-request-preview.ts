import { MAX_SANITIZED_TEXT_LENGTH, redactSecrets } from './redaction.js';

/**
 * Where a `request.opened` payload's tool NAME lives, most specific first.
 * Exported so no consumer re-derives the list: the Claude adapter writes
 * `toolName`, the station-agent adapter writes `toolName`/`tool`.
 */
export const TOOL_REQUEST_NAME_FIELDS = ['toolName', 'tool'] as const;

/**
 * Where a `request.opened` payload's tool ARGUMENTS live, most specific first.
 * Every adapter picked its own name and they are all in production:
 * `toolInput` (claude-adapter.ts `canUseTool`), `toolArgs` (station-agent
 * adapter, and the Claude PreToolUse hook path), `rawInput` (acp-adapter.ts
 * `session/request_permission`, so every ACP engine incl. Gemini). `arguments`
 * and `args` are the shapes a future/external producer is most likely to use.
 *
 * Exported for the same reason as the derivation itself: the client toast read
 * only `toolInput` for one release, so ACP and station-agent approvals showed a
 * bare tool name in the toast while the durable inbox row — which did read all
 * five — showed the command. Two readers of one payload, one of them wrong.
 */
export const TOOL_REQUEST_ARGS_FIELDS = [
  'toolInput',
  'toolArgs',
  'rawInput',
  'arguments',
  'args',
] as const;

/**
 * The tool name and arguments a `request.opened` payload carries, whatever the
 * publishing adapter called them. Use this rather than indexing the payload:
 * see `TOOL_REQUEST_ARGS_FIELDS` for what indexing one name costs.
 */
export function toolRequestFromPayload(
  payload: Record<string, unknown> | undefined,
): { toolName?: string; toolInput?: unknown } {
  if (!payload) return {};
  let toolName: string | undefined;
  for (const key of TOOL_REQUEST_NAME_FIELDS) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      toolName = value.trim();
      break;
    }
  }
  let toolInput: unknown;
  for (const key of TOOL_REQUEST_ARGS_FIELDS) {
    if (payload[key] !== undefined) {
      toolInput = payload[key];
      break;
    }
  }
  return {
    ...(toolName ? { toolName } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
  };
}

/**
 * `toolRequestPreview` over a whole `request.opened` payload — the form both
 * approval surfaces use, because it also handles the engines that name no
 * argument bag at all.
 *
 * When no `TOOL_REQUEST_ARGS_FIELDS` name matches, the payload IS the arguments.
 * An engine with no Station pre-tool seam publishes its raw request params as
 * the payload: Codex's `item/commandExecution/requestApproval` carries
 * `command` (which lands in the Bash family) and its
 * `item/fileChange/requestApproval` carries `changes[].path`. Without this
 * fallback those approvals showed a bare title on the toast and named no file at
 * all on either surface, which made the conformance doc's "every approval
 * carries a preview" false for the one engine Station cannot intercept.
 *
 * Deliberately not folded into `toolRequestFromPayload`: that function answers
 * "what did the adapter say the arguments are", and for these payloads the
 * answer is genuinely nothing. Guessing belongs here, where the caller has
 * already asked for a best-effort preview.
 */
export function toolRequestPreviewFromPayload(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const { toolName, toolInput } = toolRequestFromPayload(payload);
  if (toolInput !== undefined) return toolRequestPreview(toolName, toolInput);
  if (!payload) return undefined;
  // Named fields and `changes[]` only. The whole-input serializer is off here
  // because a payload is not an argument bag: dumping one renders the request's
  // own scaffolding — `toolCallId`, `reason`, `_meta`, `options` — as if it were
  // the call. Better to say nothing and let the surface fall back to the tool
  // name than to show `{"toolCallId":"x"}`.
  return toolRequestPreview(toolName, payload, {
    serializeWholeInput: false,
  });
}

/**
 * Inherited from the `MAX_ARGS_SUMMARY_LENGTH` bound this replaced in
 * `request-presentation.ts`, so the durable notification body it feeds keeps
 * the budget it already had rather than growing. Long enough for a real shell
 * command; short enough to sit on one line of a toast beside three buttons.
 */
export const MAX_TOOL_REQUEST_PREVIEW_LENGTH = 160;

/**
 * A one-line preview naming WHICH COMMAND, or WHICH FILE, a pending tool call
 * will touch — derived from the `request.opened` payload's tool name and input
 * (#1545). Not what the call will do: see NOT A FULL DISCLOSURE below.
 *
 * Approval surfaces used to render the tool NAME alone — "<Agent> wants to use
 * Bash" — which is not a decision an operator can make: `Bash` is both
 * `git status` and `rm -rf /`. This carries the one field per tool family that
 * says which of those it is.
 *
 * VALUES, DELIBERATELY. The durable inbox summary this feeds
 * (`request-presentation.ts`) previously reduced arguments to a shape summary,
 * field names only, on the reasoning that values may carry secrets. That is
 * the right default for a log line and the wrong one for a consent prompt: a
 * field list is identical for the safe and the destructive call, so it cannot
 * inform the only decision the surface exists to support. `redactSecrets` (not
 * `sanitizeFreeText`) is the middle ground — it removes known credential
 * shapes and contextual secret fields while KEEPING paths and URLs, which a
 * preview must show to be worth reading at all.
 *
 * NOT A FULL DISCLOSURE, in two ways. The result is bounded and single-line, so
 * a long command's tail is not shown and a trailing `; rm -rf /` can hide past
 * the cap. And it is ONE field per tool family: for `Edit`/`Write`/
 * `NotebookEdit` that is the file path, never the content being written, so a
 * reader learns which file is about to change and not what it will say. It is
 * an aid to recognising the call, never a complete description of it — no
 * caller should present it as the whole of what is being approved.
 *
 * "Secret-redacted" means `redactSecrets` — KNOWN credential shapes and
 * contextual secret-looking field names (see its docblock in `redaction.ts` for
 * the exact inventory). It is not a guarantee that no secret survives: an
 * unrecognised token in an unrecognised field is rendered as written.
 *
 * BUNDLE NOTE (correcting this branch's earlier commit message, which claimed
 * this was the entry bundle's first eager consumer of `redaction.ts`): the UI's
 * `terminalSelectionHandoff` and `sshLauncher` modules already import it. The
 * measured gzip cost of importing this module at the eager approval-handler
 * site is what it is; the attribution of which part of it is `redaction.ts` was
 * a guess and is not load-bearing for anything.
 *
 * @param toolName the raw tool name as the adapter reported it
 * @param toolInput the raw tool arguments
 * @returns the preview, or `undefined` when the input says nothing useful
 */
export function toolRequestPreview(
  toolName: string | undefined,
  toolInput: unknown,
  options?: { serializeWholeInput?: boolean },
): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') {
    return renderValue(toolInput);
  }

  const args = toolInput as Record<string, unknown>;
  if (Object.keys(args).length === 0) return undefined;

  for (const field of previewFieldsFor(toolName)) {
    const rendered = renderValue(readField(args, field));
    if (rendered) return rendered;
  }

  // A patch-shaped call names its files in `changes[].path` — Codex's
  // `item/fileChange/requestApproval` payload and the `apply_patch` tool
  // arguments `deriveToolArguments` builds from it. Serializing that object
  // whole would spend the whole line on the first diff body, so read the paths.
  const changed = changedPathsPreview(args.changes);
  if (changed) return changed;

  if (options?.serializeWholeInput === false) return undefined;

  // Reached when no named field carried anything — an MCP tool (whose arguments
  // are the server's vocabulary, not Station's, so no field name can be claimed
  // ahead of time) or a tool shape Station has not seen. Serialize the whole
  // input: within one bounded line that shows every key AND its value, which is
  // strictly more than either a field-name list or a single hand-picked
  // argument, and it does not have to guess which argument matters.
  //
  // Only safe because the caller HANDED us an argument bag. A payload read as
  // arguments by `toolRequestPreviewFromPayload` must not reach here — see the
  // `whole` flag there.
  return renderValue(args);
}

/** The paths a patch-shaped `changes` array touches, bounded like any preview. */
function changedPathsPreview(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const paths: string[] = [];
  for (const entry of value) {
    const path =
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>).path
        : undefined;
    if (typeof path === 'string' && path.trim()) paths.push(path.trim());
  }
  if (paths.length === 0) return undefined;
  // Name up to three and count the rest: an apply_patch can touch hundreds, and
  // "and N more" is the honest way to say so inside one line.
  const shown = paths.slice(0, MAX_CHANGED_PATHS);
  const more = paths.length - shown.length;
  return boundedPreviewLine(
    more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', '),
  );
}

const MAX_CHANGED_PATHS = 3;

/**
 * How long a run at the pre-redaction cut may be and still be treated as a
 * possibly-truncated credential token. 64 is comfortably above the largest
 * minimum body length in `SECRET_PATTERNS` (36, for `ghp_`), so anything longer
 * that IS a recognised shape matches its own pattern anyway and does not need
 * trimming — while anything longer that is not is an ordinary argument the
 * preview should keep.
 */
const MAX_TRUNCATED_TOKEN_TRIM = 64;

/**
 * `Allow <this> for this session`, and the subject of "wants to use <this>".
 * Collapses the SDK's `mcp__<server>__<tool>` wire name into the shape a
 * person reads, and bounds it — a tool name reaches here from an external
 * engine and is no more trustworthy than any other adapter-supplied string.
 */
export function toolRequestDisplayName(
  toolName: string | undefined,
): string | undefined {
  const trimmed = toolName?.trim();
  if (!trimmed) return undefined;
  const mcp = MCP_TOOL_NAME.exec(trimmed);
  return boundedPreviewLine(mcp ? `${mcp[1]}.${mcp[2]}` : trimmed);
}

const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * What the `acceptForSession` decision grants for one approval request. The
 * Claude adapter that honours the answer and every surface that offers it
 * (the toast, the inline card and the durable inbox card) compute it with
 * `toolRequestSessionGrant` from the same request fields, so the offer and
 * the honouring cannot drift apart.
 *
 * - `tool` (#2299): Station grants every later call to the same tool in
 *   this session, and the engine's suggestions are forwarded as they are.
 * - `edit-mode` (#2915): a plain Claude file edit (Edit, Write, MultiEdit,
 *   NotebookEdit) outside plan mode and full access. The session answer
 *   allows this call and forwards only the engine's `acceptEdits` mode
 *   change, which lets the
 *   engine pass later file edits inside the working directories itself while
 *   it keeps asking for sensitive files; Station grants nothing, since a tool
 *   grant would add only a bypass of those safety checks. Answered through
 *   the orchestration command route, the service then records an `auto`
 *   approval-mode decision for the conversation, so the answer lasts until
 *   the user changes mode; other paths send a one-call accept, and the
 *   inbox card does not offer it.
 * - `read-folder` / `folder` (#2915): the request escalates beyond the call
 *   (or is a Claude read, which the engine asks for only then), and the
 *   session answer forwards only the engine's directory suggestions (read
 *   rules; or a working directory / file-edit rules). Station grants nothing.
 * - `none`: the session answer is a one-call accept, so none is offered. A
 *   plan exit (#2916); a sandbox network-host ask or an ask flagged
 *   `suppressAlwaysAllowRule` (#2932); an escalation or read with no directory to forward
 *   (an ask rule, a safety check, a read of `/`, a Claude ask whose
 *   structured reason was not read); or a file edit with
 *   no mode change to forward or asked in plan mode or under full access
 *   (`bypassPermissions`).
 */
export type ToolRequestSessionGrant =
  | 'tool'
  | 'edit-mode'
  | 'read-folder'
  | 'folder'
  | 'none';

/** The request fields a session grant depends on (Claude's `canUseTool`). */
export type ToolRequestGrantInput = {
  toolName?: string;
  suggestions?: unknown;
  blockedPath?: unknown;
  matchedAskRule?: unknown;
  /** The engine's permission mode when it asked (Claude: `plan`, …). */
  permissionMode?: unknown;
  /**
   * The engine's kind for the tool call, where it reports one (ACP's
   * `toolCall.kind`; `switch_mode` is a mode change such as leaving plan
   * mode).
   */
  toolKind?: unknown;
  /** The call's arguments; `dangerouslyDisableSandbox` is read from them. */
  toolInput?: unknown;
  /** Claude's `canUseTool` `decisionReason` text, matched only exactly. */
  decisionReason?: unknown;
  /**
   * Ask flags the Claude CLI sends on `can_use_tool`. Agent SDK 0.3.278
   * forwards `suppressAlwaysAllowRule` and `defaultToNo` to `canUseTool`
   * and still drops `requiresUserInteraction`, which the Claude adapter
   * reads from the engine's frame. Read when present.
   */
  suppressAlwaysAllowRule?: unknown;
  defaultToNo?: unknown;
  requiresUserInteraction?: unknown;
  /**
   * #2932: the structured reason the Claude adapter read from the engine's
   * `can_use_tool` frame (a `ClaudeAskReason`). Left undefined by an engine
   * that reports none, which says nothing. Anything else that is not an
   * object, `null` included, is a Claude ask whose frame was not read: it
   * escalates (see `claudeAskEscalates`).
   */
  claudeAsk?: unknown;
  /**
   * Asserted ONLY by an adapter that established the call is an authentic
   * call to the in-process `station-browser` server (the engine generated the
   * name from the config key Station delivered it under, and no authored
   * server squats on the id). Never derived from the tool name here: an
   * external server named to look like `station-browser` produces the same
   * name. See `toolRequestServerGrant`.
   */
  authenticStationBrowser?: unknown;
};

/**
 * The server-wide session grant a request can additionally offer. `server`
 * (owner decision, #90 N2 follow-up): the person may allow every later call to
 * the in-process Station browser server in this session, instead of one
 * approval per browser tool. It is a second choice beside the per-tool
 * `acceptForSession`, answered with the typed `sessionGrantScope: 'server'`.
 */
export type ToolRequestServerGrant = 'server' | 'none';

/** The words of the server-wide Station browser grant, on every surface. */
export const STATION_BROWSER_SERVER_GRANT_LABEL =
  'Allow the Station browser for this session';

/**
 * #2932: the reason fields of a Claude Code `can_use_tool` frame that Agent
 * SDK 0.3.278 does not hand to `canUseTool`. `decisionReasonType` is the
 * engine's `decision_reason_type` (`rule`, `mode`, `subcommandResults`,
 * `permissionPromptTool`, `hook`, `asyncAgent`, `sandboxOverride`,
 * `workingDir`, `safetyCheck`, `classifier`, `other`), absent when the
 * engine attached no reason. `classifierApprovable` is set when a safety
 * check is involved, nested ones included.
 */
export type ClaudeAskReason = {
  decisionReasonType?: string;
  classifierApprovable?: boolean;
  decisionReasonCode?: string;
};

/** Tools that leave plan mode (see `toolRequestIsPlanExit`). */
const PLAN_EXIT_TOOLS: ReadonlySet<string> = new Set(['exitplanmode']);
/**
 * Tools whose request gets no standing answer: a plan exit and a harness
 * question, which are addressed to a person, and Claude Code's sandbox
 * network ask (#2932; input `{host}`). The engine remembers an allowed host
 * for the session itself, and a Station grant on that tool would answer
 * every later host (see `toolRequestNeedsPerson`).
 */
const TOOLS_WITHOUT_SESSION_GRANT: ReadonlySet<string> = new Set([
  'askuserquestion',
  'sandboxnetworkaccess',
  ...PLAN_EXIT_TOOLS,
]);
/**
 * #2932: `decisionReason` texts Claude Code sends verbatim (read in 2.1.261,
 * byte-identical in 2.1.278) for an ask
 * that is an escalation or a policy floor, not a plain call: the sandbox
 * override, a tool whose approval card is the user's interaction surface,
 * and the MCP organization ceiling (`effectiveMaxPermission: 'ask'`). The
 * engine's other reasons (Bash safety prose, the working-directory text) are
 * not matched here: their wording is not a stable contract.
 */
const ESCALATION_DECISION_REASONS: ReadonlySet<string> = new Set([
  'dangerouslyDisableSandbox',
  'requiresUserInteraction',
  'Your organization requires approval for this tool',
]);
/**
 * #2932: the `decisionReason` texts Claude Code 2.1.278 sends with reason
 * type `other` for an ordinary ask: a single Bash command that no rule
 * matched. Every other `other` reason is a check of some kind (shell
 * operators, an unparseable command, a `cd` before a write, a sed write),
 * so it escalates. If a later CLI rewords this text, the ordinary ask
 * escalates too and prompts; it never widens.
 */
const ORDINARY_OTHER_DECISION_REASONS: ReadonlySet<string> = new Set([
  'This command requires approval',
]);
/**
 * #2932: Claude Code's shell tools. Their ordinary ask carries a reason
 * type in 2.1.278 (`other` for Bash, `subcommandResults` for PowerShell),
 * unlike an MCP tool, WebFetch or a file edit, whose ordinary ask carries
 * none. Matched exactly, as the engine names them.
 */
const CLAUDE_SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
/**
 * Claude Code's read-only tools. The engine allows reads inside the session's
 * working directories itself, so a prompt for one is always an escalation,
 * even when it carries no signal (an ask rule or a safety check, whose reason
 * type the SDK drops). Matched exactly: another engine's `read` tool gets an
 * ordinary tool grant.
 */
const CLAUDE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LSP',
]);
/**
 * Claude Code's file-permission rule names. A rule under one of these names is
 * a path glob (`//abs/dir/**`, `~/dir/**`, `dir/**`); a Bash or PowerShell
 * rule is a command pattern, even when it mentions a path.
 */
const CLAUDE_READ_RULE_TOOLS: ReadonlySet<string> = new Set(['Read']);
/** Engine modes a forwarded `acceptEdits` would leave (#2916, #2915). */
const MODES_WITHOUT_EDIT_MODE_GRANT: ReadonlySet<string> = new Set([
  'plan',
  'bypassPermissions',
]);
/** Claude Code's file-editing tools; `acceptEdits` covers all of them. */
const CLAUDE_FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);
const CLAUDE_FILE_RULE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

type DirectoryUpdateKind = 'read' | 'access';

/**
 * #2915: whether a suggested permission update widens the session's reach
 * to a directory: `addDirectories`, or an allow rule for a file tool.
 * Returns what it widens (`read` for read rules only), or undefined.
 */
export function directoryPermissionUpdateKind(
  update: unknown,
): DirectoryUpdateKind | undefined {
  if (!isRecord(update)) return undefined;
  if (update.type === 'addDirectories') return 'access';
  if (update.type !== 'addRules' || !Array.isArray(update.rules))
    return undefined;
  const fileRules = update.rules.filter(
    (rule): rule is { toolName: string; ruleContent: string } =>
      isRecord(rule) &&
      typeof rule.toolName === 'string' &&
      CLAUDE_FILE_RULE_TOOLS.has(rule.toolName) &&
      typeof rule.ruleContent === 'string' &&
      rule.ruleContent.trim() !== '',
  );
  if (fileRules.length === 0) return undefined;
  return fileRules.every((rule) => CLAUDE_READ_RULE_TOOLS.has(rule.toolName))
    ? 'read'
    : 'access';
}

function isAcceptEditsModeUpdate(update: unknown): boolean {
  return (
    isRecord(update) &&
    update.type === 'setMode' &&
    update.mode === 'acceptEdits'
  );
}

/**
 * The suggested updates a session answer forwards for this grant: all of
 * them for a tool grant, the `acceptEdits` mode change for an edit-mode
 * grant, the directory updates for a folder grant, and none otherwise.
 */
export function sessionGrantPermissionUpdates<T>(
  grant: ToolRequestSessionGrant,
  suggestions: readonly T[] = [],
): T[] {
  switch (grant) {
    case 'tool':
      return [...suggestions];
    case 'edit-mode':
      return suggestions.filter(isAcceptEditsModeUpdate);
    case 'read-folder':
    case 'folder':
      return suggestions.filter(
        (update) => directoryPermissionUpdateKind(update) !== undefined,
      );
    case 'none':
      return [];
  }
}

/**
 * #2915: whether a request asks for more than the tool call (the rule #2911
 * set for Codex: a tool grant covers calls to the tool, never escalations).
 * Read against the Claude Code engine the lockfile pins (Agent SDK 0.3.278,
 * bundling Claude Code 2.1.278; first read in 2.1.261):
 *
 * - a directory suggestion. Read, Glob, Grep and LSP ask for a path outside
 *   the working directories with no `blockedPath`, a `Read(//dir/**)` rule
 *   suggestion and the workingDir reason text; Edit and Write suggest
 *   `addDirectories`.
 * - `blockedPath`: the Bash/PowerShell path checks (and a few other tools).
 * - `matchedAskRule`: a user-configured `permissions.ask` rule forced the
 *   prompt; the SDK asks host-side auto-approval to leave it to a human.
 * - #2932: a call that runs outside the sandbox
 *   (`dangerouslyDisableSandbox: true` in its input), a `decisionReason` in
 *   `ESCALATION_DECISION_REASONS`, or any of the ask flags
 *   `suppressAlwaysAllowRule`, `defaultToNo` or `requiresUserInteraction`.
 * - #2932: the engine's structured reason (`claudeAskEscalates`): an ask
 *   rule on a single command, a safety check (in any part of a chained
 *   command too), every PowerShell ask, or a Claude ask whose frame was
 *   not read. The literal rules above stay as a second layer.
 */
export function toolRequestEscalates(request: ToolRequestGrantInput): boolean {
  return (
    request.blockedPath != null ||
    request.matchedAskRule != null ||
    (isRecord(request.toolInput) &&
      request.toolInput.dangerouslyDisableSandbox === true) ||
    (typeof request.decisionReason === 'string' &&
      ESCALATION_DECISION_REASONS.has(request.decisionReason)) ||
    request.suppressAlwaysAllowRule === true ||
    request.defaultToNo === true ||
    request.requiresUserInteraction === true ||
    claudeAskEscalates(request) ||
    suggestionList(request.suggestions).some(
      (update) => directoryPermissionUpdateKind(update) !== undefined,
    )
  );
}

/**
 * #2932: whether the structured reason of a Claude ask marks it as more
 * than a plain call. Read against Claude Code 2.1.278:
 *
 * - no `claudeAsk` at all (`undefined`): another engine; no opinion.
 * - a `claudeAsk` that is not an object: the frame was not read. It
 *   escalates, so a changed or dropped frame costs a prompt, never a grant.
 * - `classifierApprovable` set, either way: a safety check is involved,
 *   in the ask itself or in any part of a chained command. The engine
 *   sets it exactly then, and sends `decisionReason` text with a chained
 *   command only then (captured from 2.1.278).
 * - a `decisionReasonCode`: the engine sets one only for a block a host
 *   may act on (`outside_reads_blocked`, `memory_paused`,
 *   `classifier_transcript_too_long`), never for an ordinary ask.
 * - a reason type other than `other` and `subcommandResults`: an ask rule
 *   (`rule`), a safety check, a sandbox override, a path outside the
 *   working directories, a mode, hook, classifier or headless-agent ask,
 *   and any type added later.
 * - type `subcommandResults` on any tool but Bash. PowerShell wraps every
 *   ask in it, a single command's security warning (Invoke-Expression,
 *   download-and-execute, elevation) included, and sends nothing that
 *   tells that from an ordinary command, so every PowerShell ask
 *   escalates.
 * - type `subcommandResults` on Bash (a chained command: `a && b`, `a; b`,
 *   a pipeline) with any `decisionReason` text or a `matchedAskRule`.
 *   Otherwise it is a PLAIN call (owner decision, #2932): a Bash grant
 *   answers chained commands. The engine does not send the reasons of a
 *   chain's parts, so three things a part raised are NOT visible here and
 *   a grant can answer them, as it could before this reader existed:
 *   (i) any `permissions.ask` rule that applies to the chain or to one of
 *   its parts, exact or prefix, whenever the chain arrives as
 *   `subcommandResults`, which is when more than one part needs approval
 *   (the engine sets no `matched_ask_rule` for it; that clause is only a
 *   second layer for a rule the engine does report); (ii) a write or delete outside the
 *   working directories in an `&&` or `;` chain, or in a pipeline with an
 *   output redirect, which arrives with no blocked path and no directory
 *   suggestion; (iii) a part's warning that is not a safety check.
 *   Closing these needs the engine to send the nested reasons.
 * - type `other` with any reason text but the ordinary one.
 * - no reason type on a shell tool (Bash, PowerShell). An ordinary Bash
 *   ask carries `other`, so an ask without a type is never the ordinary
 *   one. The engine does send such asks (a Bash path check, which also
 *   carries a blocked path), and an engine that dropped the field must not
 *   turn every shell ask into a plain call.
 *
 * A plain call is therefore an ask with no reason type on any other tool
 * (an MCP tool, WebFetch, a file edit inside the working directories),
 * `other` with the ordinary Bash text, or a chained Bash command with no
 * safety check. The signals `toolRequestEscalates` reads beside this one
 * (a blocked path, a directory suggestion, a sandbox override, the ask
 * flags) apply to a chained command when the engine sends them.
 */
export function claudeAskEscalates(
  request: Pick<
    ToolRequestGrantInput,
    'toolName' | 'claudeAsk' | 'decisionReason' | 'matchedAskRule'
  >,
): boolean {
  const { claudeAsk, decisionReason } = request;
  if (claudeAsk === undefined) return false;
  if (!isRecord(claudeAsk) || Array.isArray(claudeAsk)) return true;
  if (claudeAsk.classifierApprovable !== undefined) return true;
  if (claudeAsk.decisionReasonCode !== undefined) return true;
  const type = claudeAsk.decisionReasonType;
  const toolName = request.toolName?.trim() ?? '';
  if (type === undefined) return CLAUDE_SHELL_TOOLS.has(toolName);
  if (type === 'subcommandResults')
    return (
      toolName !== 'Bash' ||
      request.matchedAskRule != null ||
      (typeof decisionReason === 'string'
        ? decisionReason.trim() !== ''
        : decisionReason != null)
    );
  if (type !== 'other') return true;
  return !(
    typeof decisionReason === 'string' &&
    ORDINARY_OTHER_DECISION_REASONS.has(decisionReason)
  );
}

/**
 * #2916, #2933: whether the request leaves plan mode: Claude's
 * `ExitPlanMode` (matched in any casing or separator), or a call the engine
 * reports with ACP's `switch_mode` tool kind. A plan exit is a request for a
 * person's review of the plan, so no tool-level allowance answers it.
 */
export function toolRequestIsPlanExit(
  toolName: string | null | undefined,
  toolKind?: unknown,
): boolean {
  if (toolKind === 'switch_mode') return true;
  const trimmed = toolName?.trim();
  return !!trimmed && PLAN_EXIT_TOOLS.has(canonicalKey(trimmed));
}

/**
 * Whether the request is addressed to a person, so nothing standing answers
 * it: no session grant is offered or honoured and no `tools.autoApprove`
 * pattern covers it. True for a plan exit (`toolRequestIsPlanExit`), for
 * a harness question (Claude's `AskUserQuestion`, #3021), whose answer is
 * the person's own input, and for Claude's sandbox network-host ask
 * (`SandboxNetworkAccess`, #2932), which is asked per host.
 */
export function toolRequestNeedsPerson(
  toolName: string | null | undefined,
  toolKind?: unknown,
): boolean {
  if (toolRequestIsPlanExit(toolName, toolKind)) return true;
  const trimmed = toolName?.trim();
  return !!trimmed && TOOLS_WITHOUT_SESSION_GRANT.has(canonicalKey(trimmed));
}

export function toolRequestSessionGrant(
  request: ToolRequestGrantInput,
): ToolRequestSessionGrant {
  const toolName = request.toolName?.trim();
  if (
    toolRequestNeedsPerson(toolName, request.toolKind) ||
    // The engine says no standing allowance may answer this ask.
    request.suppressAlwaysAllowRule === true
  )
    return 'none';
  const readOnly =
    toolName !== undefined && CLAUDE_READ_ONLY_TOOLS.has(toolName);
  const escalates = toolRequestEscalates(request);
  if (
    !escalates &&
    toolName !== undefined &&
    CLAUDE_FILE_EDIT_TOOLS.has(toolName)
  )
    // In plan mode the engine still suggests acceptEdits (a sensitive-file
    // safety check runs before its plan-mode refusal); forwarding it would
    // leave plan mode without the plan being reviewed (#2916). Under full
    // access it would silently drop to acceptEdits.
    return !MODES_WITHOUT_EDIT_MODE_GRANT.has(String(request.permissionMode)) &&
      suggestionList(request.suggestions).some(isAcceptEditsModeUpdate)
      ? 'edit-mode'
      : 'none';
  if (!readOnly && !escalates) return 'tool';
  const kinds = suggestionList(request.suggestions)
    .map(directoryPermissionUpdateKind)
    .filter((kind) => kind !== undefined);
  if (kinds.length === 0) return 'none';
  return kinds.every((kind) => kind === 'read') ? 'read-folder' : 'folder';
}

/**
 * #2933: whether a tool-level allowance, such as an agent's
 * `tools.autoApprove` pattern, may answer this request without a person. It
 * covers a plain call to the tool (`tool`, or a plain file edit's
 * `edit-mode`), never an escalation or a plan exit: the rule #2911 and #2915
 * set for session grants. So an escalation (`toolRequestEscalates`), any
 * Claude Read, Glob, Grep or LSP ask (the engine allows reads inside the
 * working directories itself), `ExitPlanMode`, and a file edit asked in plan
 * mode, under full access or with no `acceptEdits` suggestion (a safety
 * check once the session is in `acceptEdits`) all reach a person, as do a
 * sandbox network-host ask and the #2932 escalation signals. For a Claude
 * ask those include the engine's structured reason, so a safety check and
 * an ask rule on a single command reach a person, as does an ask whose
 * frame was not read. A chained Bash command hides an ask rule on one of
 * its parts and some writes outside the working directories; see
 * `claudeAskEscalates`.
 */
export function toolRequestIsPlainCall(
  request: ToolRequestGrantInput,
): boolean {
  const grant = toolRequestSessionGrant(request);
  return grant === 'tool' || grant === 'edit-mode';
}

/**
 * Whether the request also offers the server-wide Station browser grant. Only
 * a plain call (`tool` grant: never an escalation, plan exit or question) that
 * the adapter asserted is an authentic Station browser call
 * (`authenticStationBrowser`). The adapter honours the answer with this same
 * computation, and the toast, card and inbox offer from the same payload.
 */
export function toolRequestServerGrant(
  request: ToolRequestGrantInput,
): ToolRequestServerGrant {
  return request.authenticStationBrowser === true &&
    toolRequestSessionGrant(request) === 'tool'
    ? 'server'
    : 'none';
}

/** `toolRequestServerGrant` over a whole `request.opened` payload. */
export function toolRequestServerGrantFromPayload(
  payload: Record<string, unknown> | undefined,
): ToolRequestServerGrant {
  const { toolName, toolInput } = toolRequestFromPayload(payload);
  return toolRequestServerGrant({
    toolName,
    toolInput,
    decisionReason: payload?.decisionReason,
    suppressAlwaysAllowRule: payload?.suppressAlwaysAllowRule,
    defaultToNo: payload?.defaultToNo,
    requiresUserInteraction: payload?.requiresUserInteraction,
    claudeAsk: payload?.claudeAsk,
    suggestions: payload?.suggestions,
    blockedPath: payload?.blockedPath,
    matchedAskRule: payload?.matchedAskRule,
    permissionMode: payload?.permissionMode,
    toolKind: payload?.toolKind,
    authenticStationBrowser: payload?.stationBrowserServer,
  });
}

/** `toolRequestSessionGrant` over a whole `request.opened` payload. */
export function toolRequestSessionGrantFromPayload(
  payload: Record<string, unknown> | undefined,
): ToolRequestSessionGrant {
  const { toolName, toolInput } = toolRequestFromPayload(payload);
  return toolRequestSessionGrant({
    toolName,
    toolInput,
    decisionReason: payload?.decisionReason,
    suppressAlwaysAllowRule: payload?.suppressAlwaysAllowRule,
    defaultToNo: payload?.defaultToNo,
    requiresUserInteraction: payload?.requiresUserInteraction,
    claudeAsk: payload?.claudeAsk,
    suggestions: payload?.suggestions,
    blockedPath: payload?.blockedPath,
    matchedAskRule: payload?.matchedAskRule,
    permissionMode: payload?.permissionMode,
    toolKind: payload?.toolKind,
  });
}

/**
 * The label of the session-grant decision (`acceptForSession`), shared by the
 * approval toast, the inline card (#2316) and the inbox card. It names both
 * what is granted and the session scope: "Always Allow" overstated its
 * duration and hid its breadth. Undefined when no session grant is offered.
 *
 * A `tool` grant names the tool only when the request reported one: then the
 * adapter records a standing grant for every later call to it (#2299). With
 * NO reported name the grant's breadth is not one thing the label could name
 * — Codex's adapter derives its own key (every later command, or file
 * change), an ACP engine with no name gets only its own `allow_always` rule
 * (OpenCode's is pattern-scoped) — so the label claims only the session
 * scope. It never names adapter display text: a title (Codex's and
 * OpenCode's are the whole command line) would misstate the grant as
 * covering exactly that string.
 */
export function toolRequestGrantLabel(
  toolName: string | undefined,
  grant: ToolRequestSessionGrant,
): string | undefined {
  switch (grant) {
    case 'none':
      return undefined;
    case 'edit-mode':
      return 'Auto-accept file edits for this session';
    case 'read-folder':
      return 'Allow reading this folder for this session';
    case 'folder':
      return 'Allow access to this folder for this session';
    case 'tool': {
      const displayName = toolRequestDisplayName(toolName);
      return displayName
        ? `Allow ${displayName} for this session`
        : 'Allow for this session';
    }
  }
}

function suggestionList(suggestions: unknown): readonly unknown[] {
  return Array.isArray(suggestions) ? suggestions : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The field that says what the call will DO, per tool family, most specific
 * first. Field names and tool names are both stored canonicalized (lower case,
 * separators removed) and looked up that way, so one entry covers
 * `NotebookEdit`, `notebook_edit` and `notebookedit`, and one field covers
 * `file_path` and `filePath` — engine adapters do not agree on casing.
 */
const PREVIEW_FIELDS_BY_TOOL: ReadonlyArray<{
  tools: readonly string[];
  fields: readonly string[];
}> = [
  {
    tools: ['bash', 'shell', 'shellexec', 'exec', 'run', 'runcommand'],
    fields: ['command', 'cmd'],
  },
  {
    tools: ['edit', 'multiedit', 'write', 'create', 'notebookedit', 'fswrite'],
    fields: ['filepath', 'notebookpath', 'path', 'file'],
  },
  {
    tools: ['read', 'grep', 'glob', 'ls', 'list', 'search', 'fsread'],
    fields: ['pattern', 'filepath', 'path', 'glob', 'query'],
  },
  {
    tools: ['webfetch', 'websearch', 'fetch', 'browse'],
    fields: ['url', 'query', 'prompt'],
  },
];

/**
 * Every family's fields, in family order, as the fallback for a tool name no
 * family claims. A tool Station has never seen still usually carries one of
 * these, so trying them all beats going straight to a JSON dump.
 */
const FALLBACK_PREVIEW_FIELDS: readonly string[] = [
  ...new Set(PREVIEW_FIELDS_BY_TOOL.flatMap((entry) => entry.fields)),
];

function canonicalKey(value: string): string {
  return value.toLowerCase().replace(/[\s._-]/g, '');
}

function previewFieldsFor(toolName: string | undefined): readonly string[] {
  const trimmed = toolName?.trim();
  if (!trimmed) return FALLBACK_PREVIEW_FIELDS;
  // An MCP server is free to expose a tool literally called `read` that takes
  // nothing resembling a path, so the family table must not claim its names.
  if (MCP_TOOL_NAME.test(trimmed)) return [];
  const family = PREVIEW_FIELDS_BY_TOOL.find((entry) =>
    entry.tools.includes(canonicalKey(trimmed)),
  );
  return family ? family.fields : FALLBACK_PREVIEW_FIELDS;
}

function readField(
  args: Record<string, unknown>,
  canonicalField: string,
): unknown {
  for (const key of Object.keys(args)) {
    if (canonicalKey(key) === canonicalField) return args[key];
  }
  return undefined;
}

function renderValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  // Everything, the plain-string branch included, sits inside the try: this
  // runs on adapter-supplied input on a live approval path, and a preview is
  // never worth throwing over. Saying nothing degrades to the old
  // tool-name-only card; throwing would lose the approval.
  try {
    if (typeof value === 'string') return boundedPreviewLine(value);
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return boundedPreviewLine(String(value));
    }
    // `JSON.stringify` returns undefined for a function or a bare symbol, and
    // throws on a circular structure or a BigInt nested in an object.
    const serialized = JSON.stringify(value);
    return serialized ? boundedPreviewLine(serialized) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Single line, secret-redacted, bounded. Control characters become spaces
 * rather than being dropped: a heredoc's second command must stay visible as
 * separate words, and a multi-line value must not be able to push a toast's
 * buttons out of view. An ANSI escape reaching a React text node is inert, but
 * it still renders as a gap that hides what follows it.
 */
function boundedPreviewLine(value: string): string | undefined {
  // Slice to a coarse prefix BEFORE redacting. A tool input is unbounded
  // (a `Write` body, a serialized blob), and running the secret patterns over
  // megabytes to then keep 160 characters is pure cost with a backtracking
  // hazard attached. Two properties make that safe: redaction sees everything
  // that reaches the output (the prefix is a superset of what survives the final
  // bound), and nothing is cut mid-token.
  //
  // The second one needs the trailing-fragment trim below. Several
  // `SECRET_PATTERNS` are LENGTH-ANCHORED — `ghp_` plus 36+ characters, `sk-`
  // plus 20+ — so a token straddling the cut can arrive too short to match, go
  // unredacted, and still land inside the 160-character output, because
  // redaction SHORTENS what precedes it: `password=<4052 chars>;ghp_<40>`
  // becomes `password=[REDACTED];` and pulls the fragment into view.
  //
  // Only a SHORT run at the cut can do that, and that bound is provable rather
  // than guessed: every length-anchored pattern's minimum body is at most 36
  // characters, so a fragment longer than `MAX_TRUNCATED_TOKEN_TRIM` still
  // satisfies its own minimum and is redacted normally. Runs longer than that
  // are therefore left alone — which is the point, because they are ordinary
  // arguments. Trimming unconditionally turned `echo <4091 chars>` into `echo`
  // and threw the preview away, and a `\S+$` class also deleted the whole
  // reviewer counterexample, whose prefix contains no whitespace at all. The
  // class is `[^\s&;]`: `&` and `;` are the delimiters the contextual pass
  // already anchors values on, so they are exactly the boundaries that make a
  // fragment visible.
  const cut = value.slice(0, MAX_SANITIZED_TEXT_LENGTH);
  const trailingRun = /[^\s&;]+$/.exec(cut)?.[0] ?? '';
  const sliced =
    value.length > MAX_SANITIZED_TEXT_LENGTH &&
    trailingRun.length <= MAX_TRUNCATED_TOKEN_TRIM
      ? cut.slice(0, cut.length - trailingRun.length)
      : cut;
  const oneLine = redactSecrets(sliced)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing raw control characters into spaces is the point.
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!oneLine) return undefined;
  return oneLine.length <= MAX_TOOL_REQUEST_PREVIEW_LENGTH
    ? oneLine
    : `${oneLine.slice(0, MAX_TOOL_REQUEST_PREVIEW_LENGTH - 1)}…`;
}
