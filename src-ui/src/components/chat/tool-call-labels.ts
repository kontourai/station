/**
 * Per-call labeling for work activities: classify a tool name into a small
 * verb taxonomy and derive a verb-first, human label for ONE call — "Read
 * app.tsx", "Ran npm run build:ui", "Searched anchor contract".
 *
 * Split out of `tool-call-groups.ts` (archive#2652 redesign) because the
 * collapsed activity ROW is eager — every settled and streaming tool call
 * renders one — while the multi-call batch summary machinery
 * (`summarizeCalls`, the plural-noun phrasing) stays inside the lazily
 * loaded `ToolCallBatch` chunk. This module is the smallest piece the eager
 * path needs; `tool-call-groups.ts` composes it.
 *
 * Labels are phrased by VERB, not by internal tool name (`Ran <command>`,
 * not `shell_exec`) — `formatToolName` (from `chat-progress.ts`, the same
 * module the streaming progress indicator uses) is the shared fallback so
 * this doesn't invent a second naming scheme.
 */
import {
  formatToolName,
  isProgrammaticToolName,
} from '../../utils/chat-progress';
import { toolDisplayView } from './tool-display-view';

export type ToolCallKind =
  | 'read'
  | 'write'
  | 'delete'
  | 'exec'
  | 'search'
  | 'other';

interface KindVerbs {
  /** Sentence-initial past-tense verb, e.g. "Read". */
  verb: string;
  /** Sentence-initial present-progressive verb, e.g. "Reading". */
  progressiveVerb: string;
  /** Bare-infinitive form for a call whose work is NOT known to have
   * happened, e.g. "Edit" — past tense would claim work that has not
   * happened, and the progressive would claim work in flight. Used for a
   * proposed call awaiting approval and for an unresolved one alike. */
  pendingVerb: string;
}

const KIND_VERBS: Record<ToolCallKind, KindVerbs> = {
  read: { verb: 'Read', progressiveVerb: 'Reading', pendingVerb: 'Read' },
  write: { verb: 'Edited', progressiveVerb: 'Editing', pendingVerb: 'Edit' },
  delete: {
    verb: 'Deleted',
    progressiveVerb: 'Deleting',
    pendingVerb: 'Delete',
  },
  exec: { verb: 'Ran', progressiveVerb: 'Running', pendingVerb: 'Run' },
  search: {
    verb: 'Searched',
    progressiveVerb: 'Searching',
    pendingVerb: 'Search',
  },
  other: { verb: 'Used', progressiveVerb: 'Using', pendingVerb: 'Use' },
};

/**
 * How far the call has actually got — decides the verb tense.
 *
 * `'done'` is the only phase that claims the work happened, so it is derived
 * from an OBSERVED successful completion, never used as a fallback. Anything
 * that did not complete successfully — denied by the user, blocked by Station,
 * cancelled, failed, or started and never resolved (a replayed `state: 'call'`
 * after a reconnect) — is `'unresolved'` and takes the bare infinitive. The
 * row's status badge says WHICH of those it was; the verb's only job is not to
 * claim an edit that never landed.
 */
export type ToolCallPhase = 'done' | 'running' | 'proposed' | 'unresolved';

export interface ToolCallPhaseInput {
  needsApproval?: boolean;
  error?: unknown;
  errorText?: unknown;
  result?: unknown;
  output?: unknown;
  cancelled?: unknown;
  state?: unknown;
  approvalStatus?: unknown;
}

/**
 * Whether a tool part is still waiting on an explicit grant. One predicate
 * for the collapsed batch and the expanded row — a second copy eventually
 * disagrees about `state: 'error'` with no text, `unresolved` that still
 * carries `needsApproval`, or `result: null`.
 *
 * `runtime-event-projection.ts` stamps `state: 'awaiting-approval'` on
 * `request.opened`; matching `needsApproval` alone is not enough to claim
 * the work is only proposed.
 */
export function isToolCallAwaitingApproval(part: ToolCallPhaseInput): boolean {
  if (part.needsApproval !== true) return false;
  const { error, result } = toolDisplayView(part);
  const cancelled = part.cancelled === true || part.state === 'cancelled';
  const failed = Boolean(error) || part.state === 'error';
  const unresolved = part.state === 'unresolved';
  return !failed && !unresolved && result === undefined && !cancelled;
}

/**
 * Same derivation `ToolCallDisplay` uses for the row verb. `done` is only
 * returned when a successful completion was observed — never as the
 * leftover of "not running".
 */
export function toolCallPhase(part: ToolCallPhaseInput): ToolCallPhase {
  const error = part.error ?? part.errorText;
  const result = part.result ?? part.output;
  const cancelled = part.cancelled === true || part.state === 'cancelled';
  const failed = Boolean(error) || part.state === 'error';
  const sessionUnresolved = part.state === 'unresolved';
  const denied =
    part.approvalStatus === 'user-denied' ||
    part.approvalStatus === 'policy-denied';
  if (isToolCallAwaitingApproval(part)) return 'proposed';
  if (part.state === 'running' && !failed && !cancelled) return 'running';
  const completed =
    !failed &&
    !cancelled &&
    !denied &&
    !sessionUnresolved &&
    (part.state === 'completed' ||
      part.state === 'result' ||
      result !== undefined);
  return completed ? 'done' : 'unresolved';
}

/**
 * Whether a batch containing this call must not claim flight or completion.
 * Proposed, session-unresolved, denied, and cancelled suppress the live
 * headline. A plain failure does not — its `failedCount` badge is the
 * disclosure, and a running sibling should still headline.
 */
export function isToolCallBatchPending(part: ToolCallPhaseInput): boolean {
  if (isToolCallAwaitingApproval(part)) return true;
  if (part.state === 'unresolved') return true;
  if (
    part.approvalStatus === 'user-denied' ||
    part.approvalStatus === 'policy-denied'
  ) {
    return true;
  }
  return part.cancelled === true || part.state === 'cancelled';
}

const READ_TOKENS = new Set(['read', 'cat', 'view', 'list', 'ls']);
/** Calls that change or move a file without deleting it. */
const WRITE_TOKENS = new Set([
  'write',
  'edit',
  'patch',
  'move',
  'mv',
  'rename',
  'copy',
  'cp',
  'mkdir',
  'touch',
  'append',
  'insert',
  'replace',
  'overwrite',
  'chmod',
  'chown',
]);
/** Calls that destroy something. Labelled "Deleting", never as a read. */
const DELETE_TOKENS = new Set([
  'delete',
  'del',
  'remove',
  'rm',
  'rmdir',
  'unlink',
  'erase',
  'trash',
  'destroy',
  'purge',
]);
const EXEC_TOKENS = new Set([
  'bash',
  'shell',
  'exec',
  'run',
  'execute',
  'command',
]);
const SEARCH_TOKENS = new Set(['search', 'grep', 'find', 'glob', 'query']);

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** MCP tool calls are often named `server/tool` — classify on the tool half. */
function baseToolName(toolName: string): string {
  const slashIndex = toolName.lastIndexOf('/');
  return slashIndex >= 0 ? toolName.slice(slashIndex + 1) : toolName;
}

export function classifyToolName(toolName: string | undefined): ToolCallKind {
  if (!toolName?.trim()) return 'other';
  // Whole words only (`readme_remove` is a delete, not a read), and the
  // destructive classes first: a name with both a read and a write word
  // shown as a read is the unsafe direction.
  const tokens = tokenize(baseToolName(toolName));
  if (tokens.some((t) => DELETE_TOKENS.has(t))) return 'delete';
  if (tokens.some((t) => WRITE_TOKENS.has(t))) return 'write';
  if (tokens.some((t) => READ_TOKENS.has(t))) return 'read';
  if (tokens.some((t) => EXEC_TOKENS.has(t))) return 'exec';
  if (tokens.some((t) => SEARCH_TOKENS.has(t))) return 'search';
  return 'other';
}

/**
 * The engine's own category (ACP `ToolKind`) in this row taxonomy. `fetch`,
 * `think` and `switch_mode` have no verb of their own here and stay `other`.
 */
const ENGINE_KIND: Readonly<Record<string, ToolCallKind>> = {
  read: 'read',
  edit: 'write',
  delete: 'delete',
  move: 'write',
  search: 'search',
  execute: 'exec',
  fetch: 'other',
  think: 'other',
  switch_mode: 'other',
  other: 'other',
};

function stringField(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/**
 * Classify by the arguments' SHAPE, for a call whose name is display text.
 * The field names are the ones the engines actually send: OpenCode's shell
 * tool `{command, description}`, its file tools `{filePath, ...}` with
 * `content`/`oldString`/`newString` for a write, `{pattern, path}` for
 * grep/glob.
 */
function hasCommandArgument(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const a = args as Record<string, unknown>;
  const command = a.command ?? a.cmd ?? a.cmdline;
  return (
    (typeof command === 'string' && command.trim().length > 0) ||
    (Array.isArray(command) && command.length > 0)
  );
}

function classifyToolArgs(args: unknown): ToolCallKind {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'other';
  const a = args as Record<string, unknown>;
  if (hasCommandArgument(a)) return 'exec';
  const path = stringField(a, ['file_path', 'filePath', 'filepath', 'path']);
  if (
    path &&
    ['content', 'oldString', 'newString', 'old_string', 'new_string', 'patch']
      .map((key) => a[key])
      .some((value) => typeof value === 'string')
  )
    return 'write';
  if (stringField(a, ['pattern', 'query', 'glob'])) return 'search';
  // A path alone does not say what the call does to it (`delete_file
  // {path}` has the same shape as a read), so the kind stays neutral and the
  // label names the tool and its target.
  return 'other';
}

export interface ToolCallIdentity {
  toolName?: string;
  toolKind?: unknown;
  args?: unknown;
}

/**
 * The row kind for one call, most authoritative evidence first:
 *
 * 1. a command argument: whatever the call is called, if it carries a
 *    command it runs one, and the row must say so and show it — a `read`
 *    kind on `bash {command: 'rm -rf ~'}` must never read "Read bash";
 * 2. the engine's own `toolKind` (ACP engines report one per call);
 * 3. a tool NAME — any single token, including dotted or colon-scoped MCP
 *    names (`fs.write_file`, `filesystem:edit_file`, `shell.exec`) — by its
 *    words; a write shown as a read on an approval card is the unsafe
 *    direction, so these keep name classification;
 * 4. the shape of the arguments, when the name says nothing or is display
 *    text with spaces (an ACP title: a command line).
 *
 * Titles with spaces never go through step 3: tokenizing `cd /tmp && gh api …
 * > gsd.mjs` guessed a read in one render and a search in another.
 */
export function classifyToolCall(call: ToolCallIdentity): ToolCallKind {
  if (hasCommandArgument(call.args)) return 'exec';
  if (typeof call.toolKind === 'string' && call.toolKind in ENGINE_KIND) {
    return ENGINE_KIND[call.toolKind]!;
  }
  const name = call.toolName?.trim();
  if (name && !/\s/.test(name)) {
    const byName = classifyToolName(name);
    if (byName !== 'other') return byName;
  }
  return classifyToolArgs(call.args);
}

const MAX_TARGET_LENGTH = 60;

function truncate(value: string, max = MAX_TARGET_LENGTH): string {
  const collapsed = value.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

function basename(path: string): string {
  const segments = path.split(/[/\\]+/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

function firstLine(value: string): string {
  const idx = value.indexOf('\n');
  return idx >= 0 ? value.slice(0, idx) : value;
}

/** One leading `NAME=value ` whose value is a plain literal: no `$`,
 * backtick, quote, parenthesis, or other shell expansion. */
const LITERAL_ENV_ASSIGNMENT =
  /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_@%+,.:/-]*)\s+/;

/**
 * The only variables a collapsed row may drop: ones that change how output
 * looks or how much is logged, never what runs, what it loads, where it
 * connects or which credentials it uses. An allow-list, not a deny-list —
 * the set of variables that change what a command does (`LD_PRELOAD`,
 * `JAVA_TOOL_OPTIONS`, `npm_config_script_shell`, `EDITOR`, `HTTPS_PROXY`,
 * `KUBECONFIG`, …) is open-ended, so anything not named here stays visible.
 */
const INERT_ENV =
  /^(?:CI|FORCE_COLOR|NO_COLOR|CLICOLOR|CLICOLOR_FORCE|NODE_ENV|DEBUG|VERBOSE|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|COLUMNS|LINES|RUST_LOG|RUST_BACKTRACE|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|STATION_DOCS_[A-Z0-9_]+)$/;

/**
 * The collapsed row's form of a shell command: its first line. For a call
 * that already ran, leading environment assignments are dropped so the
 * command itself is what fits (`STATION_DOCS_FRESHNESS=scoped npm run
 * docs:check` → `npm run docs:check`) — but only when every one of them is a
 * plain literal of an inert variable (`INERT_ENV`); anything else keeps the whole
 * line. A call awaiting approval is never trimmed: what the user is asked to
 * allow is the whole command. The expanded row prints it verbatim.
 */
function commandTarget(command: string, trimEnv: boolean): string {
  const line = firstLine(command).trim();
  if (!trimEnv) return truncate(line);
  let rest = line;
  for (;;) {
    const match = LITERAL_ENV_ASSIGNMENT.exec(rest);
    if (!match) break;
    if (!INERT_ENV.test(match[1]!)) return truncate(line);
    rest = rest.slice(match[0].length);
  }
  // Something still looks like an assignment: it was not a plain literal
  // (`FOO=$(rm -rf /) ls`), so nothing is trimmed.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) return truncate(line);
  return truncate(rest || line);
}

/** A concise, human target for one call — "app.tsx" for a Read, a truncated
 * command for a Bash/shell_exec call. Falls back to the change list on
 * patch-style edits that carry no top-level path. A raw STRING argument (an
 * ACP engine's unstringified pass-through — see archive#3559) is shown as
 * its truncated first line rather than dropped, so a shell command stays
 * visible in the collapsed row on that path too. */
function extractTarget(
  kind: ToolCallKind,
  args: unknown,
  trimEnv: boolean,
): string | null {
  if (typeof args === 'string') {
    if (!args.trim()) return null;
    return kind === 'exec'
      ? commandTarget(args, trimEnv)
      : truncate(firstLine(args));
  }
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;

  if (kind === 'read' || kind === 'write' || kind === 'delete') {
    let pathValue =
      a.file_path ?? a.path ?? a.filePath ?? a.notebook_path ?? a.filename;
    if (
      typeof pathValue !== 'string' &&
      Array.isArray(a.changes) &&
      a.changes.length > 0
    ) {
      const first = a.changes[0];
      if (first && typeof first === 'object') {
        const f = first as Record<string, unknown>;
        pathValue = f.path ?? f.file_path ?? f.filePath;
      }
      if (
        typeof pathValue === 'string' &&
        pathValue.length > 0 &&
        a.changes.length > 1
      ) {
        return `${basename(pathValue)} +${a.changes.length - 1} more`;
      }
    }
    if (typeof pathValue === 'string' && pathValue.length > 0) {
      return basename(pathValue);
    }
    return null;
  }

  if (kind === 'exec') {
    const command = a.command ?? a.cmd ?? a.cmdline;
    if (typeof command === 'string' && command.trim()) {
      return commandTarget(command, trimEnv);
    }
    if (Array.isArray(command) && command.length > 0) {
      return truncate(command.join(' '));
    }
    return null;
  }

  if (kind === 'search') {
    const query = a.pattern ?? a.query ?? a.search;
    if (typeof query === 'string' && query.trim()) {
      return truncate(query);
    }
    return null;
  }

  // An unrecognised tool: its path is the target, its name says what it did.
  const pathValue = stringField(a, [
    'file_path',
    'filePath',
    'filepath',
    'path',
  ]);
  return pathValue ? basename(pathValue) : null;
}

/** e.g. "Read app.tsx" (done), "Running npm run build:ui" (in flight),
 * "Edit approved.txt" (proposed, awaiting approval), "Edit config.json"
 * (unresolved — denied, cancelled, failed, or never resolved). */
export function callLabel(
  kind: ToolCallKind,
  toolName: string,
  args: unknown,
  phase: ToolCallPhase | boolean,
): string {
  const cfg = KIND_VERBS[kind];
  // Boolean form kept for the batch classifier's in-progress flag.
  const resolved: ToolCallPhase =
    typeof phase === 'boolean' ? (phase ? 'running' : 'done') : phase;
  const verb =
    resolved === 'running'
      ? cfg.progressiveVerb
      : resolved === 'proposed' || resolved === 'unresolved'
        ? cfg.pendingVerb
        : cfg.verb;
  // What a user is asked to allow is shown whole (see `commandTarget`).
  const trimEnv = resolved !== 'proposed';
  const target = extractTarget(kind, args, trimEnv);
  if (target && kind === 'other') {
    // No verb is known, so the tool's own name carries it: "Used delete
    // file on secret.txt", never a guessed "Read secret.txt". Display text
    // (an ACP title) already names its target and is shown as written below.
    if (isProgrammaticToolName(toolName)) {
      return `${verb} ${formatToolName(toolName)} on ${target}`;
    }
  } else if (target) {
    return `${verb} ${target}`;
  }
  // No argument named a target, so the name is the target. Display text (an
  // ACP title: the command line, the path) is shown as the engine wrote it,
  // env-trimmed for a command exactly like an argument would be.
  if (toolName.trim() && !isProgrammaticToolName(toolName)) {
    return `${verb} ${kind === 'exec' ? commandTarget(toolName, trimEnv) : truncate(toolName)}`;
  }
  const fallbackName = formatToolName(toolName);
  return fallbackName ? `${verb} ${fallbackName}` : verb;
}
