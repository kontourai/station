import { Transform, type TransformCallback } from 'node:stream';

/**
 * #2932: the structured reason fields the Claude CLI writes on a
 * `can_use_tool` control request (`decision_reason_type`,
 * `classifier_approvable`, `decision_reason_code`, `requires_user_interaction`).
 * The installed Agent SDK 0.3.289 forwards reason and interaction fields;
 * the classifier approval fact still requires the tap. Read from the CLI's
 * stdout by {@link ClaudePermissionFrameTap}, keyed by the frame's
 * `request_id`, which the SDK hands the callback as `requestId`.
 *
 * `decisionReasonType` is absent when the engine attached no reason: the
 * ordinary ask of an MCP tool, WebFetch, or a file edit inside the working
 * directories (Claude Code 2.1.278).
 */
type ClaudePermissionAsk = {
  decisionReasonType?: string;
  classifierApprovable?: boolean;
  decisionReasonCode?: string;
  requiresUserInteraction?: true;
};

/** Unread asks kept per engine process. */
export const MAX_RECORDED_PERMISSION_ASKS = 256;
/**
 * The longest stdout line the tap inspects. A longer line is forwarded
 * unrecorded, so an ask on it reads as missing and prompts.
 */
const MAX_PERMISSION_FRAME_BYTES = 8 * 1024 * 1024;
/** Bound on a recorded id or enum-like value; a longer one is refused. */
const MAX_FIELD_LENGTH = 200;

const NEWLINE = 0x0a;
const CAN_USE_TOOL_MARKER = '"can_use_tool"';

/** `initialize` requests whose response is still awaited. */
const MAX_AWAITED_INITIALIZE_RESPONSES = 8;
const INITIALIZE_MARKER = '"initialize"';
/** Two frames gave one request id different reasons. */
const CONFLICTING = Symbol('conflicting');

function sameAsk(a: ClaudePermissionAsk, b: ClaudePermissionAsk): boolean {
  return (
    a.decisionReasonType === b.decisionReasonType &&
    a.classifierApprovable === b.classifierApprovable &&
    a.decisionReasonCode === b.decisionReasonCode &&
    a.requiresUserInteraction === b.requiresUserInteraction
  );
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= MAX_FIELD_LENGTH
  );
}

/**
 * The asks recorded for one engine process. A record is consumed when it is
 * read. The map never grows past its cap: recording into a full map drops
 * the oldest unread record, which then reads as missing.
 */
export class ClaudePermissionAsks {
  private readonly records = new Map<
    string,
    ClaudePermissionAsk | typeof CONFLICTING
  >();
  private readonly awaitedInitialize = new Set<string>();

  constructor(private readonly maxRecords = MAX_RECORDED_PERMISSION_ASKS) {}

  get size(): number {
    return this.records.size;
  }

  /**
   * Whether the ask was kept. A malformed request id is refused. The same
   * ask recorded again for a request id (a live frame and its replay) is
   * kept once. A different ask for an id already recorded is a conflict:
   * the id then reads as missing, whatever is recorded for it afterwards,
   * until it is read.
   */
  record(requestId: unknown, ask: ClaudePermissionAsk): boolean {
    if (!validId(requestId)) return false;
    const existing = this.records.get(requestId);
    if (existing !== undefined) {
      if (existing !== CONFLICTING && sameAsk(existing, ask)) return true;
      this.records.set(requestId, CONFLICTING);
      return false;
    }
    if (this.records.size >= this.maxRecords) {
      const oldest = this.records.keys().next();
      if (!oldest.done) this.records.delete(oldest.value);
    }
    this.records.set(requestId, ask);
    return true;
  }

  /** The ask recorded for this request, removed; undefined when none was. */
  take(requestId: unknown): ClaudePermissionAsk | undefined {
    if (typeof requestId !== 'string') return undefined;
    const ask = this.records.get(requestId);
    if (ask !== undefined) this.records.delete(requestId);
    return ask === CONFLICTING ? undefined : ask;
  }

  /** The host sent an `initialize` request with this id. */
  awaitInitializeResponse(requestId: unknown): void {
    if (!validId(requestId)) return;
    if (this.awaitedInitialize.size >= MAX_AWAITED_INITIALIZE_RESPONSES) {
      const oldest = this.awaitedInitialize.values().next();
      if (!oldest.done) this.awaitedInitialize.delete(oldest.value);
    }
    this.awaitedInitialize.add(requestId);
  }

  /** Whether a response with this id answers an `initialize`; asked once. */
  takeInitializeResponse(requestId: unknown): boolean {
    return (
      typeof requestId === 'string' && this.awaitedInitialize.delete(requestId)
    );
  }
}

/**
 * Notes an `initialize` control request the host writes to the engine's
 * stdin, so the tap can tell that request's response from any other. The
 * SDK writes one whole frame per write; anything else is ignored, and the
 * replay on that response is then not read (those asks prompt). It never
 * throws: the chunk's type and size are checked before it is decoded, and
 * parsing is guarded.
 */
export function noteClaudeHostFrame(
  asks: ClaudePermissionAsks,
  chunk: unknown,
): void {
  // Size is checked in bytes, and before a Buffer is decoded.
  if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return;
  if (Buffer.byteLength(chunk) > MAX_PERMISSION_FRAME_BYTES) return;
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (!text.includes(INITIALIZE_MARKER)) return;
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  if (
    isRecord(frame) &&
    frame.type === 'control_request' &&
    isRecord(frame.request) &&
    frame.request.subtype === 'initialize'
  )
    asks.awaitInitializeResponse(frame.request_id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length <= MAX_FIELD_LENGTH
    ? value
    : null;
}

/**
 * The reason fields of one `can_use_tool` request body, or undefined when a
 * field has a shape this reader does not know. Nothing is recorded then, so
 * the ask reads as missing.
 */
function permissionAskFromRequest(
  request: Record<string, unknown>,
): ClaudePermissionAsk | undefined {
  const decisionReasonType = optionalString(request.decision_reason_type);
  const decisionReasonCode = optionalString(request.decision_reason_code);
  const classifierApprovable = request.classifier_approvable;
  const requiresUserInteraction = request.requires_user_interaction;
  if (
    decisionReasonType === null ||
    decisionReasonCode === null ||
    (classifierApprovable !== undefined &&
      typeof classifierApprovable !== 'boolean') ||
    (requiresUserInteraction !== undefined &&
      typeof requiresUserInteraction !== 'boolean')
  )
    return undefined;
  return {
    ...(decisionReasonType !== undefined ? { decisionReasonType } : {}),
    ...(classifierApprovable !== undefined ? { classifierApprovable } : {}),
    ...(decisionReasonCode !== undefined ? { decisionReasonCode } : {}),
    ...(requiresUserInteraction === true
      ? { requiresUserInteraction: true as const }
      : {}),
  };
}

/** Records one `{type:'control_request', request_id, request}` frame. */
function recordControlRequest(
  asks: ClaudePermissionAsks,
  frame: unknown,
): void {
  if (!isRecord(frame) || frame.type !== 'control_request') return;
  const request = frame.request;
  if (!isRecord(request) || request.subtype !== 'can_use_tool') return;
  const ask = permissionAskFromRequest(request);
  if (ask) asks.record(frame.request_id, ask);
}

/**
 * Records the asks one stdout line carries: a live `can_use_tool` control
 * request, or the requests the response to an `initialize` request replays
 * in `pending_permission_requests` (the SDK calls `canUseTool` for each).
 * A replay on any other response is ignored, as the SDK ignores it.
 * Any other line, and any line that is not JSON, is ignored.
 */
function recordClaudePermissionFrame(
  asks: ClaudePermissionAsks,
  line: Buffer,
): void {
  // Every frame of interest names the subtype; most stdout lines do not.
  if (!line.includes(CAN_USE_TOOL_MARKER)) return;
  let frame: unknown;
  try {
    frame = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  if (!isRecord(frame)) return;
  if (frame.type === 'control_request') {
    recordControlRequest(asks, frame);
    return;
  }
  if (frame.type !== 'control_response' || !isRecord(frame.response)) return;
  const pending = frame.response.pending_permission_requests;
  if (!Array.isArray(pending)) return;
  // The SDK acts on a replay only for its `initialize` request.
  if (!asks.takeInitializeResponse(frame.response.request_id)) return;
  for (const request of pending.slice(0, MAX_RECORDED_PERMISSION_ASKS))
    recordControlRequest(asks, request);
}

/**
 * A pass-through over the Claude CLI's stdout. Every chunk is forwarded
 * unchanged, so the SDK reads the same bytes. Complete lines are inspected
 * for permission asks before the chunk that completes them is forwarded, so
 * a record exists by the time the SDK calls `canUseTool` for it.
 */
export class ClaudePermissionFrameTap extends Transform {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** The current line passed the cap; skip it up to its newline. */
  private oversize = false;

  constructor(
    private readonly asks: ClaudePermissionAsks,
    private readonly maxLineBytes = MAX_PERMISSION_FRAME_BYTES,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes =
      typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
    try {
      this.inspect(bytes);
    } catch {
      // Reading is best-effort; an ask left unrecorded prompts.
      this.pending = [];
      this.pendingBytes = 0;
      this.oversize = true;
    }
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    // A final line with no newline is still a line to the SDK's reader.
    if (!this.oversize && this.pendingBytes > 0) {
      try {
        recordClaudePermissionFrame(this.asks, Buffer.concat(this.pending));
      } catch {
        // As above.
      }
    }
    this.pending = [];
    this.pendingBytes = 0;
    callback();
  }

  private inspect(bytes: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(NEWLINE, start);
      if (newline === -1) break;
      const rest = bytes.subarray(start, newline);
      if (this.pendingBytes === 0 && !this.oversize) {
        // The whole line is in this chunk: read it in place.
        if (rest.length <= this.maxLineBytes)
          recordClaudePermissionFrame(this.asks, rest);
      } else {
        this.append(rest);
        if (!this.oversize)
          recordClaudePermissionFrame(this.asks, Buffer.concat(this.pending));
      }
      this.pending = [];
      this.pendingBytes = 0;
      this.oversize = false;
      start = newline + 1;
    }
    this.append(bytes.subarray(start));
  }

  private append(part: Buffer): void {
    if (this.oversize || part.length === 0) return;
    if (this.pendingBytes + part.length > this.maxLineBytes) {
      this.pending = [];
      this.pendingBytes = 0;
      this.oversize = true;
      return;
    }
    // The chunk belongs to the stream's consumer once forwarded; keep a copy.
    this.pending.push(Buffer.from(part));
    this.pendingBytes += part.length;
  }
}
