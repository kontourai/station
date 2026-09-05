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

/** `toolRequestPreview` over a whole `request.opened` payload. */
export function toolRequestPreviewFromPayload(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const { toolName, toolInput } = toolRequestFromPayload(payload);
  return toolRequestPreview(toolName, toolInput);
}

/**
 * Inherited from the `MAX_ARGS_SUMMARY_LENGTH` bound this replaced in
 * `request-presentation.ts`, so the durable notification body it feeds keeps
 * the budget it already had rather than growing. Long enough for a real shell
 * command; short enough to sit on one line of a toast beside three buttons.
 */
export const MAX_TOOL_REQUEST_PREVIEW_LENGTH = 160;

/**
 * A one-line preview of what a pending tool call will actually do, derived
 * from the `request.opened` payload's tool name and input (#1545).
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
 * this was the entry bundle's first eager consumer of `redaction.ts`):
 * `src-ui/src/components/coding-layout/terminalSelectionHandoff.ts` and
 * `src-ui/src/platform/native/sshLauncher.ts` already import it. The measured
 * 1192-gzip-byte cost of importing this module at the eager approval-handler
 * site is what it is; the attribution of which part is `redaction.ts` was a
 * guess and is not load-bearing for anything.
 *
 * @param toolName the raw tool name as the adapter reported it
 * @param toolInput the raw tool arguments
 * @returns the preview, or `undefined` when the input says nothing useful
 */
export function toolRequestPreview(
  toolName: string | undefined,
  toolInput: unknown,
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

  // Reached when no named field carried anything — an MCP tool (whose arguments
  // are the server's vocabulary, not Station's, so no field name can be claimed
  // ahead of time) or a tool shape Station has not seen. Serialize the whole
  // input: within one bounded line that shows every key AND its value, which is
  // strictly more than either a field-name list or a single hand-picked
  // argument, and it does not have to guess which argument matters.
  return renderValue(args);
}

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
  // hazard attached. The direction is the safe one: the prefix is a superset of
  // what survives the final bound, so nothing reaches the output that redaction
  // has not seen. Truncating AFTER redaction would be equally safe but not
  // equally cheap; truncating to near the OUTPUT bound before redacting would
  // not be safe, because collapsing whitespace afterwards pulls later
  // characters into view.
  const oneLine = redactSecrets(value.slice(0, MAX_SANITIZED_TEXT_LENGTH))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing raw control characters into spaces is the point.
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!oneLine) return undefined;
  return oneLine.length <= MAX_TOOL_REQUEST_PREVIEW_LENGTH
    ? oneLine
    : `${oneLine.slice(0, MAX_TOOL_REQUEST_PREVIEW_LENGTH - 1)}…`;
}
