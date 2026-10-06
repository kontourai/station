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
 * `'done'` is the only phase that claims the work SUCCEEDED, so it is derived
 * from an OBSERVED successful completion, never used as a fallback.
 *
 * `'failed'` is a plain failure: the tool was invoked and reported an error.
 * It keeps the completed tense ("Ran npm test") beside its Failed badge — the
 * same rule the batch summary applies ("ran 2 commands · 1 failed"), so the
 * collapsed line and the rows it opens never disagree about tense. The badge
 * is the disclosure.
 *
 * Anything else that did not complete — denied by the user, blocked by
 * Station, cancelled, or started and never resolved (a replayed
 * `state: 'call'` after a reconnect) — is `'unresolved'` and takes the bare
 * infinitive: nothing observed the tool run at all.
 */
export type ToolCallPhase =
  | 'done'
  | 'running'
  | 'proposed'
  | 'failed'
  | 'unresolved';

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
  if (completed) return 'done';
  return failed && !cancelled && !denied && !sessionUnresolved
    ? 'failed'
    : 'unresolved';
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
/** Words that reverse or abandon a deletion (`undo_delete`,
 * `restore_from_trash`): the name mentions a delete that does not happen. */
const DELETE_NEGATIONS = new Set([
  'undo',
  'undelete',
  'restore',
  'recover',
  'cancel',
  'revert',
  'untrash',
]);
/** Things whose "removal" edits content rather than deleting a file
 * (`remove_background` on an image). No honest verb is known, so these stay
 * neutral. */
const NON_DELETION_OBJECTS = new Set([
  'background',
  'watermark',
  'noise',
  'whitespace',
  'duplicates',
]);
/** A leading listing verb keeps the call a read when what it lists is
 * only NAMED by a delete word (`list_trash`, `list_deleted_items`) — but
 * never over a real delete or write verb (`list_and_delete`, `ls_rm`). */
const LEADING_READ_TOKENS = new Set(['list', 'ls']);
/** Delete-class words that are also nouns for a place things go. Only a
 * noun as the listing verb's direct object (`list_trash`, `ls_trash_items`);
 * anywhere else it is the verb (`list_and_trash`). */
const DELETE_NOUNS = new Set(['trash']);

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** MCP tool calls are often named `server/tool` or `mcp__server__tool` —
 * classify on the tool half. */
function baseToolName(toolName: string): string {
  const slashIndex = toolName.lastIndexOf('/');
  const tail = slashIndex >= 0 ? toolName.slice(slashIndex + 1) : toolName;
  if (!tail.startsWith('mcp__')) return tail;
  const scopeIndex = tail.lastIndexOf('__');
  return scopeIndex > 3 ? tail.slice(scopeIndex + 2) : tail;
}

export function classifyToolName(toolName: string | undefined): ToolCallKind {
  if (!toolName?.trim()) return 'other';
  // Whole words only (`readme_remove` is a delete, not a read), and the
  // destructive classes first: a name with both a read and a write word
  // shown as a read is the unsafe direction.
  const tokens = tokenize(baseToolName(toolName));
  if (
    LEADING_READ_TOKENS.has(tokens[0] ?? '') &&
    !tokens.some(
      (t, index) =>
        (DELETE_TOKENS.has(t) && !(index === 1 && DELETE_NOUNS.has(t))) ||
        WRITE_TOKENS.has(t),
    )
  ) {
    return 'read';
  }
  if (tokens.some((t) => DELETE_TOKENS.has(t))) {
    if (tokens.some((t) => NON_DELETION_OBJECTS.has(t))) return 'other';
    if (!tokens.some((t) => DELETE_NEGATIONS.has(t))) return 'delete';
  }
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

/** The argument names the engines use for the one file a call acts on. */
const FILE_PATH_KEYS = [
  'file_path',
  'path',
  'filePath',
  'filepath',
  'notebook_path',
  'filename',
];

function filePathArgument(args: Record<string, unknown>): string | undefined {
  return stringField(args, FILE_PATH_KEYS);
}

const MAX_TARGET_LENGTH = 60;

/** Bidi marks, embeddings, overrides and isolates (LRM, RLM, ALM,
 * U+202A–202E, U+2066–2069). Every label target is untrusted engine or
 * model text and must not reorder what the row shows ("Trojan source"). */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
/** C0/C1 controls. Replaced by a space, not deleted, so "a\tb" does not
 * merge into one word. */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * The displayed form of untrusted text: bidi controls removed, control
 * characters turned into spaces, whitespace collapsed onto one line. Only
 * the label changes; the call's arguments, and the details view that shows
 * them, keep the raw text.
 */
function displayText(value: string): string {
  return value
    .replace(BIDI_CONTROLS, '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeName(value: string): string {
  return displayText(value);
}

/** The shown name of one file: its sanitised basename. */
function fileName(path: string): string {
  return safeName(basename(safeName(path)));
}

function listTarget(first: string, count: number): string {
  const name = fileName(first);
  return count > 1 ? `${name} +${count - 1} more` : name;
}

/** A `paths` entry that looks like a file: it has a directory separator or
 * a file extension. `doc-1` or `github` is an id, not a file. */
function isPathLike(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const name = safeName(value);
  return /[/\\]/.test(name) || /^[^\s/\\]+\.[A-Za-z0-9]{1,10}$/.test(name);
}

/** Each end of a move gets half the room, so a long source cannot push the
 * destination out of the collapsed row. */
const MOVE_END_LENGTH = Math.floor(MAX_TARGET_LENGTH / 2) - 2;

const PATCH_ENVELOPE = '*** Begin Patch';
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/** A patch body: OpenCode's `patch {patchText}`, or Codex's `apply_patch`
 * envelope in `input`/`patch`. */
function patchBody(a: Record<string, unknown>): string | undefined {
  if (typeof a.patchText === 'string' && a.patchText.trim()) {
    return a.patchText;
  }
  for (const key of ['input', 'patch']) {
    const value = a[key];
    if (
      typeof value === 'string' &&
      value.trimStart().startsWith(PATCH_ENVELOPE)
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * What a file call acts on, for its row: a file path, a patch's change list
 * (`apply_patch {changes:[{path}]}`, the Codex shape), several `paths`, a
 * `source`/`destination` pair, or a patch body's file headers.
 *
 * `undefined` means the call names no target at all. Then a read/write/
 * delete word in the tool's name says nothing about FILES — `delete_agent
 * {slug}` deletes an agent — so the row must not claim a file and must not
 * repeat the verb in front of the name. `null` means a target exists but has
 * no short name (a patch body with no file headers); the tool's name is shown.
 *
 * A raw STRING argument (an ACP engine's unstringified pass-through, see
 * archive#3559) counts as a target and is shown as its first line. It is not
 * known to be a file: `read_url 'https://…'` reads "Read https://…" and is
 * counted as a file in a batch. That predates #3364 and is left as is.
 */
function fileCallTarget(args: unknown): string | null | undefined {
  if (typeof args === 'string') {
    const line = safeName(firstLine(args));
    return line ? truncate(line) : undefined;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  const a = args as Record<string, unknown>;
  const single = filePathArgument(a);
  if (single && fileName(single)) return fileName(single);
  if (Array.isArray(a.changes) && a.changes.length > 0) {
    const first = a.changes[0];
    const path =
      first && typeof first === 'object'
        ? stringField(first as Record<string, unknown>, [
            'path',
            'file_path',
            'filePath',
          ])
        : undefined;
    if (path && fileName(path)) return listTarget(path, a.changes.length);
  }
  if (Array.isArray(a.paths)) {
    // One path-like entry says these are files; then every named entry is
    // one (`['Makefile', 'src/a.ts']` is two files).
    if (a.paths.some(isPathLike)) {
      const paths = a.paths.filter(
        (p): p is string => typeof p === 'string' && Boolean(fileName(p)),
      );
      if (paths.length > 0) return listTarget(paths[0]!, paths.length);
    }
  }
  // A move or copy names both ends. A `source` alone is as often an id
  // (`delete_agent {source: 'github'}`) as a file, so it is no target.
  const source = stringField(a, ['source']);
  const destination = stringField(a, ['destination']);
  if (source && destination && fileName(source) && fileName(destination)) {
    return `${truncate(fileName(source), MOVE_END_LENGTH)} → ${truncate(
      fileName(destination),
      MOVE_END_LENGTH,
    )}`;
  }
  const patch = patchBody(a);
  if (patch !== undefined) {
    const files = [...patch.matchAll(PATCH_FILE_HEADER)]
      .map((m) => m[1]!)
      .filter((name) => fileName(name));
    return files.length > 0 ? listTarget(files[0]!, files.length) : null;
  }
  return undefined;
}

function hasCallTarget(args: unknown): boolean {
  return fileCallTarget(args) !== undefined;
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
  const path = filePathArgument(a);
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
    if (byName === 'read' || byName === 'write' || byName === 'delete') {
      // A file verb with no file: the name ("Used delete agent") says what
      // happened, and the batch counts a tool, never a file.
      return hasCallTarget(call.args) ? byName : 'other';
    }
    if (byName !== 'other') return byName;
  }
  return classifyToolArgs(call.args);
}

/** Every displayed target passes through here: sanitised (`displayText`)
 * and cut by code point, so an emoji at the cut is never split into a lone
 * surrogate. */
function truncate(value: string, max = MAX_TARGET_LENGTH): string {
  const codePoints = Array.from(displayText(value));
  if (codePoints.length <= max) return codePoints.join('');
  return `${codePoints.slice(0, max - 1).join('')}…`;
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
      : truncate(safeName(firstLine(args)));
  }
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;

  if (kind === 'read' || kind === 'write' || kind === 'delete') {
    return fileCallTarget(a) ?? null;
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
  const pathValue = filePathArgument(a);
  return pathValue && fileName(pathValue) ? fileName(pathValue) : null;
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
