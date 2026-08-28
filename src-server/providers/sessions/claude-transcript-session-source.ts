import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  AttachedSessionCursor,
  AttachedSessionDescriptor,
  AttachedSessionDiscoveryResult,
  AttachedSessionReadResult,
  AttachedSessionSource,
  AttachedSessionSourceOutcome,
  AttachedSessionUsageAccumulator,
} from './attached-session-source.js';

const DEFAULT_MAX_CANDIDATES = 128;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 128 * 1024;
const DEFAULT_MAX_EVENTS = 512;
/**
 * archive#1997: how many transcript lines `read()` parses between event-loop
 * yields. Without an interior yield, a full `maxBytes` window (2MB of JSONL
 * with per-line JSON.parse + record mapping) runs as ONE synchronous slab on
 * the main thread — profiled live as the dominant non-idle stack while
 * identity probes timed out ("tolerating (slow is not dead)"). 256 lines
 * bounds each slab to a few hundred KB worst-case while keeping steady-state
 * delta reads (a handful of lines) yield-free.
 */
const DEFAULT_READ_YIELD_EVERY_LINES = 256;
const EPOCH = '1970-01-01T00:00:00.000Z';

export interface ClaudeTranscriptSessionSourceOptions {
  /** Claude config directory, not its projects child. */
  configDir?: string;
  maxCandidates?: number;
  maxBytes?: number;
  maxLineBytes?: number;
  maxEvents?: number;
  maxTraversalEntries?: number;
  maxDepth?: number;
  /** Lines parsed between event-loop yields in `read()` (archive#1997). */
  readYieldEveryLines?: number;
  /** Test seam: observe/replace the interior yield (archive#1997). */
  yieldFn?: () => Promise<void>;
}

/**
 * Bounded, read-only adapter for Claude Code's local JSONL transcript format.
 * The filesystem path is deliberately retained only behind an opaque source
 * handle; no result includes a path or emits it as an identifier.
 */
export class ClaudeTranscriptSessionSource implements AttachedSessionSource {
  readonly provider = 'claude';
  private readonly projectsDir: string;
  private readonly maxCandidates: number;
  private readonly maxBytes: number;
  private readonly maxLineBytes: number;
  private readonly maxEvents: number;
  private readonly maxTraversalEntries: number;
  private readonly maxDepth: number;
  private readonly handles = new Map<string, string>();
  private readonly readYieldEveryLines: number;
  private readonly yieldFn: () => Promise<void>;

  constructor(options: ClaudeTranscriptSessionSourceOptions = {}) {
    const configDir =
      options.configDir ??
      process.env.CLAUDE_CONFIG_DIR ??
      join(homedir(), '.claude');
    this.projectsDir = join(configDir, 'projects');
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxTraversalEntries =
      options.maxTraversalEntries ?? this.maxCandidates * 8;
    this.maxDepth = options.maxDepth ?? 16;
    this.readYieldEveryLines =
      Number.isInteger(options.readYieldEveryLines) &&
      (options.readYieldEveryLines ?? 0) > 0
        ? options.readYieldEveryLines!
        : DEFAULT_READ_YIELD_EVERY_LINES;
    this.yieldFn =
      options.yieldFn ??
      (() => new Promise<void>((resolve) => setImmediate(resolve)));
  }

  async discover(): Promise<AttachedSessionDiscoveryResult> {
    const root = this.canonicalProjectsRoot();
    if (!root) return { outcome: 'missing_root', sessions: [] };

    // Handles are capabilities for the current bounded discovery snapshot,
    // rather than an append-only record of every transcript ever observed.
    this.handles.clear();

    const candidates: Array<{ path: string; modifiedAt: number }> = [];
    let rejected = false;
    let candidatesTruncated = false;
    let visitedEntries = 0;
    const visit = (directory: string, depth: number): void => {
      visitedEntries += 1;
      if (visitedEntries > this.maxTraversalEntries || depth > this.maxDepth) {
        candidatesTruncated = true;
        return;
      }
      let directoryHandle: import('node:fs').Dir;
      try {
        directoryHandle = opendirSync(directory);
      } catch {
        rejected = true;
        return;
      }
      try {
        let entry = directoryHandle.readSync();
        while (entry) {
          visitedEntries += 1;
          if (visitedEntries > this.maxTraversalEntries) {
            candidatesTruncated = true;
            return;
          }
          const candidate = join(directory, entry.name);
          let stat: import('node:fs').Stats;
          try {
            stat = lstatSync(candidate);
          } catch {
            rejected = true;
            entry = directoryHandle.readSync();
            continue;
          }
          if (stat.isSymbolicLink()) {
            rejected = true;
            entry = directoryHandle.readSync();
            continue;
          }
          if (stat.isDirectory()) {
            const canonical = this.canonicalInside(root, candidate);
            if (!canonical) {
              rejected = true;
              entry = directoryHandle.readSync();
              continue;
            }
            visit(canonical, depth + 1);
          } else if (stat.isFile() && entry.name.endsWith('.jsonl')) {
            const canonical = this.canonicalInside(root, candidate);
            if (!canonical) {
              rejected = true;
              entry = directoryHandle.readSync();
              continue;
            }
            candidates.push({ path: canonical, modifiedAt: stat.mtimeMs });
          }
          entry = directoryHandle.readSync();
        }
      } finally {
        directoryHandle.closeSync();
      }
    };
    visit(root, 0);
    const candidateLimit =
      candidatesTruncated || candidates.length > this.maxCandidates;
    const files = candidates
      .sort(
        (left, right) =>
          right.modifiedAt - left.modifiedAt ||
          left.path.localeCompare(right.path),
      )
      .slice(0, this.maxCandidates)
      .map((candidate) => candidate.path);

    const sessions: AttachedSessionDescriptor[] = [];
    let outcome: AttachedSessionSourceOutcome = candidateLimit
      ? 'candidate_limit'
      : rejected
        ? 'rejected_candidate'
        : 'ok';
    for (const file of files) {
      const descriptor = this.discoverFile(file);
      if (!descriptor.session) {
        if (descriptor.outcome !== 'ok') outcome = descriptor.outcome;
        continue;
      }
      this.handles.set(descriptor.session.sourceHandle, file);
      sessions.push(descriptor.session);
    }
    return { outcome, sessions };
  }

  async read(
    session: AttachedSessionDescriptor,
    previousCursor: AttachedSessionCursor = 0,
  ): Promise<AttachedSessionReadResult> {
    const file = this.handles.get(session.sourceHandle);
    if (!file || session.provider !== this.provider) {
      return { outcome: 'unknown_source', events: [], cursor: 0 };
    }
    const root = this.canonicalProjectsRoot();
    const canonical = root ? this.canonicalRegularFile(root, file) : null;
    if (!canonical) {
      return { outcome: 'rejected_candidate', events: [], cursor: 0 };
    }
    const cursorOffset =
      typeof previousCursor === 'number'
        ? previousCursor
        : previousCursor.offset;
    const cursorEventIndex =
      typeof previousCursor === 'number' ? 0 : (previousCursor.eventIndex ?? 0);
    let activeTurnId =
      typeof previousCursor === 'number' ? undefined : previousCursor.turnId;
    let usage =
      typeof previousCursor === 'number' ? undefined : previousCursor.usage;
    // A persisted numeric cursor, or an unmarked nonzero object cursor,
    // predates turn aggregation. It may be in the middle of a turn whose
    // earlier calls we cannot honestly reconstruct. Missing `usage` is not a
    // legacy signal: a cursor written immediately after a flush also lacks it,
    // and deferring there would skip the next complete turn.
    let usageDeferred =
      typeof previousCursor === 'number'
        ? cursorOffset > 0
        : (previousCursor.usageAggregationVersion === undefined &&
            cursorOffset > 0) ||
          (previousCursor.usageDeferred ?? false);
    let content: Buffer;
    let windowStart: number;
    let byteLimited = false;
    try {
      const stat = lstatSync(canonical);
      windowStart =
        cursorOffset > 0 && cursorOffset <= stat.size
          ? cursorOffset
          : Math.max(0, stat.size - this.maxBytes);
      const bytesToRead = Math.min(this.maxBytes, stat.size - windowStart);
      byteLimited = windowStart > 0 || windowStart + bytesToRead < stat.size;
      content = readWindow(canonical, windowStart, bytesToRead);
    } catch {
      return {
        outcome: 'rejected_candidate',
        events: [],
        cursor: previousCursor,
      };
    }
    let start = 0;
    if (windowStart > 0 && cursorOffset === 0) {
      const firstNewline = content.indexOf(0x0a);
      if (firstNewline < 0) {
        return { outcome: 'byte_limit', events: [], cursor: windowStart };
      }
      start = firstNewline + 1;
    }
    const finalNewline = content.lastIndexOf(0x0a);
    const completeEnd = finalNewline < start ? start : finalNewline + 1;
    const incompleteTail = completeEnd < content.length;
    const events: CanonicalRuntimeEvent[] = [];
    let outcome: AttachedSessionSourceOutcome = byteLimited
      ? 'byte_limit'
      : incompleteTail
        ? 'incomplete_tail'
        : 'ok';
    let offset = start;
    let linesScanned = 0;

    // A bounded first window can also start halfway through a turn.
    if (windowStart > 0 && cursorOffset === 0 && !usage) usageDeferred = true;

    while (offset < completeEnd && events.length < this.maxEvents) {
      // archive#1997: a fresh cursor over a large window otherwise parses the
      // whole slab (JSON.parse per line + record mapping) without ever
      // letting the event loop breathe — the profiled starvation source.
      linesScanned += 1;
      if (linesScanned % this.readYieldEveryLines === 0) {
        await this.yieldFn();
      }
      const lineStart = offset;
      const newline = content.indexOf(0x0a, offset);
      const lineEnd = newline < 0 ? completeEnd : newline;
      const lineLength = lineEnd - offset;
      if (lineLength > this.maxLineBytes) {
        outcome = 'line_limit';
        offset = lineEnd + 1;
        continue;
      }
      const line = content.subarray(offset, lineEnd).toString('utf8').trim();
      offset = lineEnd + 1;
      if (!line) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        outcome = 'malformed_record';
        continue;
      }
      const mapped = mapClaudeRecord(
        record,
        session,
        windowStart + lineStart,
        activeTurnId,
      );
      // `turn_duration` is only an optional early close signal. A string user
      // message definitively starts the next turn, so flush the prior complete
      // accumulator before mapping that new turn. A final file turn remains in
      // the cursor at EOF (93 of 2,075 turns across the 120 most recently
      // modified local transcripts): emitting it partially here would mislabel
      // an incomplete turn as a per-turn usage event.
      const usageEventAtNextTurn =
        mapped.startsTurn && hasClaudeUsage(usage)
          ? usageEventForTurn(usage, mapped.startsTurn, session.sessionId)
          : null;
      let nextUsage = usage;
      let nextUsageDeferred = usageDeferred;
      if (mapped.startsTurn) {
        nextUsage = { turnId: mapped.nextTurnId! };
        nextUsageDeferred = false;
      }
      if (mapped.usage && !nextUsageDeferred) {
        nextUsage = addClaudeUsage(nextUsage, mapped.usage, mapped.nextTurnId!);
      }
      const usageEventAtTurnDuration =
        mapped.completesTurn &&
        hasClaudeUsage(nextUsage) &&
        nextUsage.turnId === mapped.nextTurnId
          ? usageEventForTurn(
              nextUsage,
              mapped.completesTurn,
              session.sessionId,
            )
          : null;
      const mappedEvents = [
        ...(usageEventAtNextTurn ? [usageEventAtNextTurn] : []),
        ...(usageEventAtTurnDuration
          ? [
              ...mapped.events.slice(0, -1),
              usageEventAtTurnDuration,
              mapped.events.at(-1)!,
            ]
          : mapped.events),
      ];
      const absoluteLineStart = windowStart + lineStart;
      const alreadyEmitted =
        cursorOffset === absoluteLineStart ? cursorEventIndex : 0;
      const remaining = mappedEvents.slice(alreadyEmitted);
      const capacity = this.maxEvents - events.length;
      if (remaining.length > capacity) {
        events.push(...remaining.slice(0, capacity));
        return {
          outcome,
          events,
          cursor: {
            offset: absoluteLineStart,
            usageAggregationVersion: 1,
            eventIndex: alreadyEmitted + capacity,
            ...(mapped.nextTurnId ? { turnId: mapped.nextTurnId } : {}),
            ...(usage ? { usage } : {}),
            ...(usageDeferred ? { usageDeferred } : {}),
          },
        };
      }
      events.push(...remaining);
      activeTurnId = mapped.nextTurnId;
      usage = mapped.completesTurn ? undefined : nextUsage;
      usageDeferred = nextUsageDeferred;
    }

    return {
      outcome,
      events,
      cursor: {
        offset: windowStart + offset,
        usageAggregationVersion: 1,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        ...(usage ? { usage } : {}),
        ...(usageDeferred ? { usageDeferred } : {}),
      },
    };
  }

  private canonicalProjectsRoot(): string | null {
    try {
      if (!existsSync(this.projectsDir)) return null;
      const stat = lstatSync(this.projectsDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      return realpathSync(this.projectsDir);
    } catch {
      return null;
    }
  }

  private canonicalInside(root: string, candidate: string): string | null {
    try {
      const canonical = realpathSync(candidate);
      return isInside(root, canonical) ? canonical : null;
    } catch {
      return null;
    }
  }

  private canonicalRegularFile(root: string, candidate: string): string | null {
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      return this.canonicalInside(root, candidate);
    } catch {
      return null;
    }
  }

  private discoverFile(file: string): {
    outcome: AttachedSessionSourceOutcome;
    session?: AttachedSessionDescriptor;
  } {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { outcome: 'rejected_candidate' };
      }
      const first = readLeadingLine(file, this.maxLineBytes);
      if (first === null) return { outcome: 'line_limit' };
      if (first === undefined) return { outcome: 'malformed_record' };
      if (!first) return { outcome: 'malformed_record' };
      const record = JSON.parse(first) as Record<string, unknown>;
      const sessionId = text(record.sessionId);
      const cwd = text(record.cwd);
      if (!sessionId || !cwd) return { outcome: 'malformed_record' };
      const sourceHandle = opaqueHandle(file);
      return {
        outcome: 'ok',
        session: {
          provider: 'claude',
          sessionId,
          threadId: claudeAttachedThreadId(sessionId),
          cwd,
          createdAt: timestamp(record.timestamp),
          sourceHandle,
        },
      };
    } catch {
      return { outcome: 'malformed_record' };
    }
  }
}

function mapClaudeRecord(
  raw: unknown,
  session: AttachedSessionDescriptor,
  lineOffset: number,
  activeTurnId?: string,
): {
  events: CanonicalRuntimeEvent[];
  nextTurnId?: string;
  startsTurn?: { createdAt: string; recordId: string; threadId: string };
  usage?: ClaudeUsage;
  completesTurn?: { createdAt: string; recordId: string; threadId: string };
} {
  if (!isRecord(raw)) return { events: [], nextTurnId: activeTurnId };
  const type = text(raw.type);
  const recordId = text(raw.uuid) ?? `offset-${lineOffset}`;
  const createdAt = timestamp(raw.timestamp);
  const parentId = text(raw.parentUuid);
  const base = {
    provider: 'claude' as const,
    threadId: session.threadId,
    createdAt,
  };
  const message = isRecord(raw.message) ? raw.message : undefined;

  if (type === 'user') {
    const content = message ? message.content : undefined;
    if (typeof content === 'string') {
      const turnId = recordId;
      return {
        events: [
          {
            ...base,
            turnId,
            eventId: eventId(session.sessionId, recordId, 0, 'user'),
            method: 'turn.started',
            prompt: content,
          },
        ],
        nextTurnId: turnId,
        startsTurn: { createdAt, recordId, threadId: session.threadId },
      };
    }
    if (Array.isArray(content)) {
      const turnId = activeTurnId ?? parentId ?? recordId;
      return {
        events: content.flatMap((block, index) =>
          mapToolResult(
            block,
            { ...base, turnId },
            session.sessionId,
            recordId,
            index,
          ),
        ),
        nextTurnId: turnId,
      };
    }
    return { events: [], nextTurnId: activeTurnId };
  }

  if (type === 'assistant' && message) {
    const turnId = activeTurnId ?? parentId ?? recordId;
    const content = Array.isArray(message.content) ? message.content : [];
    const usage = decodeClaudeUsage(message.usage);
    return {
      events: [
        ...content.flatMap((block, index) =>
          mapAssistantBlock(
            block,
            { ...base, turnId },
            session.sessionId,
            recordId,
            index,
          ),
        ),
      ],
      nextTurnId: turnId,
      ...(usage ? { usage } : {}),
    };
  }

  if (type === 'system' && text(raw.subtype) === 'turn_duration') {
    const turnId = activeTurnId ?? parentId ?? recordId;
    return {
      events: [
        {
          ...base,
          turnId,
          eventId: eventId(session.sessionId, recordId, 0, 'completed'),
          method: 'turn.completed',
          finishReason: 'stop',
        },
      ],
      nextTurnId: turnId,
      completesTurn: { createdAt, recordId, threadId: session.threadId },
    };
  }
  return { events: [], nextTurnId: activeTurnId };
}

interface ClaudeUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTokens5m?: number;
  cacheWriteTokens1h?: number;
  serviceTier?: string;
}

function decodeClaudeUsage(raw: unknown): ClaudeUsage | null {
  if (!isRecord(raw)) return null;
  const promptTokens = tokenCount(raw.input_tokens);
  const completionTokens = tokenCount(raw.output_tokens);
  const cacheReadTokens = tokenCount(raw.cache_read_input_tokens);
  const cacheWriteTokens = tokenCount(raw.cache_creation_input_tokens);
  const cacheCreation = isRecord(raw.cache_creation)
    ? raw.cache_creation
    : undefined;
  const cacheWriteTokens5m = tokenCount(
    cacheCreation?.ephemeral_5m_input_tokens,
  );
  const cacheWriteTokens1h = tokenCount(
    cacheCreation?.ephemeral_1h_input_tokens,
  );
  const serviceTier = text(raw.service_tier);

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    cacheWriteTokens5m === undefined &&
    cacheWriteTokens1h === undefined
  )
    return null;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(cacheWriteTokens5m !== undefined ? { cacheWriteTokens5m } : {}),
    ...(cacheWriteTokens1h !== undefined ? { cacheWriteTokens1h } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

function addClaudeUsage(
  previous: AttachedSessionUsageAccumulator | undefined,
  added: ClaudeUsage,
  turnId: string,
): AttachedSessionUsageAccumulator {
  const result: AttachedSessionUsageAccumulator =
    previous?.turnId === turnId ? { ...previous } : { turnId };
  for (const key of [
    'promptTokens',
    'completionTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'cacheWriteTokens5m',
    'cacheWriteTokens1h',
  ] as const) {
    if (added[key] !== undefined) result[key] = (result[key] ?? 0) + added[key];
  }
  if (added.serviceTier) {
    if (result.serviceTier && result.serviceTier !== added.serviceTier) {
      result.serviceTierConflict = true;
      delete result.serviceTier;
    } else if (!result.serviceTierConflict)
      result.serviceTier = added.serviceTier;
  }
  return result;
}

function hasClaudeUsage(
  usage: AttachedSessionUsageAccumulator | undefined,
): usage is AttachedSessionUsageAccumulator {
  return Boolean(
    usage &&
      [
        usage.promptTokens,
        usage.completionTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.cacheWriteTokens5m,
        usage.cacheWriteTokens1h,
      ].some((value) => value !== undefined),
  );
}

function usageEventForTurn(
  usage: AttachedSessionUsageAccumulator,
  completed: { createdAt: string; recordId: string; threadId: string },
  sessionId: string,
): Extract<CanonicalRuntimeEvent, { method: 'token-usage.updated' }> {
  return {
    provider: 'claude',
    threadId: completed.threadId,
    turnId: usage.turnId,
    createdAt: completed.createdAt,
    eventId: eventId(sessionId, completed.recordId, 0, 'usage'),
    method: 'token-usage.updated',
    ...(usage.promptTokens !== undefined
      ? { promptTokens: usage.promptTokens }
      : {}),
    ...(usage.completionTokens !== undefined
      ? { completionTokens: usage.completionTokens }
      : {}),
    ...(usage.promptTokens !== undefined && usage.completionTokens !== undefined
      ? { totalTokens: usage.promptTokens + usage.completionTokens }
      : {}),
    ...(usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: usage.cacheReadTokens }
      : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: usage.cacheWriteTokens }
      : {}),
    ...(usage.cacheWriteTokens5m !== undefined
      ? { cacheWriteTokens5m: usage.cacheWriteTokens5m }
      : {}),
    ...(usage.cacheWriteTokens1h !== undefined
      ? { cacheWriteTokens1h: usage.cacheWriteTokens1h }
      : {}),
    ...(usage.serviceTier ? { serviceTier: usage.serviceTier } : {}),
  };
}

function mapAssistantBlock(
  raw: unknown,
  base: {
    provider: 'claude';
    threadId: string;
    createdAt: string;
    turnId: string;
  },
  sessionId: string,
  recordId: string,
  index: number,
): CanonicalRuntimeEvent[] {
  if (!isRecord(raw)) return [];
  const type = text(raw.type);
  const itemId = `${recordId}:${index}`;
  if (type === 'text' && typeof raw.text === 'string') {
    return [
      {
        ...base,
        eventId: eventId(sessionId, recordId, index, 'text'),
        method: 'content.text-delta',
        itemId,
        delta: raw.text,
      },
    ];
  }
  const reasoning = typeof raw.thinking === 'string' ? raw.thinking : raw.text;
  if (
    (type === 'thinking' || type === 'reasoning') &&
    typeof reasoning === 'string'
  ) {
    return [
      {
        ...base,
        eventId: eventId(sessionId, recordId, index, 'reasoning'),
        method: 'content.reasoning-delta',
        itemId,
        delta: reasoning,
      },
    ];
  }
  if (
    type === 'tool_use' &&
    typeof raw.id === 'string' &&
    typeof raw.name === 'string'
  ) {
    return [
      {
        ...base,
        eventId: eventId(sessionId, recordId, index, 'tool-started'),
        method: 'tool.started',
        itemId,
        toolCallId: raw.id,
        toolName: raw.name,
        arguments: raw.input,
      },
    ];
  }
  return [];
}

function mapToolResult(
  raw: unknown,
  base: {
    provider: 'claude';
    threadId: string;
    createdAt: string;
    turnId: string;
  },
  sessionId: string,
  recordId: string,
  index: number,
): CanonicalRuntimeEvent[] {
  if (
    !isRecord(raw) ||
    text(raw.type) !== 'tool_result' ||
    typeof raw.tool_use_id !== 'string'
  )
    return [];
  return [
    {
      ...base,
      eventId: eventId(sessionId, recordId, index, 'tool-completed'),
      method: 'tool.completed',
      itemId: `${recordId}:${index}`,
      toolCallId: raw.tool_use_id,
      toolName: text(raw.name) ?? 'tool',
      status:
        text(raw.is_error) === 'true' || raw.is_error === true
          ? 'error'
          : 'success',
      output: raw.content,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A literal zero is observed data; invalid or absent values stay absent. A
 * token count is a count, so a fraction or a value past `MAX_SAFE_INTEGER` is
 * invalid rather than approximate — and the durable cursor's validator rejects
 * exactly those, so accepting one here would persist a cursor that cannot be
 * restored after a restart.
 */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function timestamp(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : EPOCH;
}

function eventId(
  sessionId: string,
  recordId: string,
  index: number,
  kind: string,
): string {
  return `attached:claude:${createHash('sha256').update(`${sessionId}\u0000${recordId}\u0000${index}\u0000${kind}`).digest('hex')}`;
}

function opaqueHandle(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

export function claudeAttachedThreadId(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return `external:claude:${digest.slice(0, 32)}`;
}

function readLeadingLine(
  path: string,
  maxLineBytes: number,
): string | null | undefined {
  const content = readWindow(path, 0, maxLineBytes + 1);
  const newline = content.indexOf(0x0a);
  if (newline < 0 && content.length > maxLineBytes) return null;
  const end = newline < 0 ? content.length : newline;
  return content.subarray(0, end).toString('utf8').trim() || undefined;
}

function readWindow(path: string, offset: number, length: number): Buffer {
  // O_NOFOLLOW plus the descriptor identity check closes final-component swaps.
  // Replacing a parent directory after discovery remains a local-trust residual
  // on platforms without openat-style directory handles.
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Transcript source is not a regular file.');
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error('Transcript source changed during secure open.');
    }
    const content = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, content, 0, length, offset);
    return content.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')
  );
}
