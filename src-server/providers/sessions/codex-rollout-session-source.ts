import { createHash } from 'node:crypto';
import { existsSync, lstatSync, opendirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectCodexToolOutput } from '../adapters/codex-tool-output.js';
import type {
  AttachedSessionCursor,
  AttachedSessionDescriptor,
  AttachedSessionDiscoveryResult,
  AttachedSessionReadResult,
  AttachedSessionSource,
  AttachedSessionSourceOutcome,
} from './attached-session-source.js';
import { readLeadingLine, readWindow } from './transcript-file-io.js';

const DEFAULT_MAX_CANDIDATES = 128;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 128 * 1024;
const DEFAULT_MAX_EVENTS = 512;
const DEFAULT_MAX_TRAVERSAL_ENTRIES = 1024;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_READ_YIELD_EVERY_LINES = 256;
const MAX_CANDIDATES_CEILING = 512;
const MAX_BYTES_CEILING = 2 * 1024 * 1024;
const MAX_LINE_BYTES_CEILING = 128 * 1024;
const MAX_EVENTS_CEILING = 512;
const MAX_TRAVERSAL_ENTRIES_CEILING = 4096;
const MAX_DEPTH_CEILING = 16;
// Worst-case JSON escaping still fits the common 128 KiB source-state ceiling.
const MAX_OPEN_TOOLS = 24;
const MAX_CURSOR_TEXT_BYTES = 192;
const MAX_OPEN_TOOL_STATE_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_TEXT_CHUNK_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_TEXT_BYTES = 4096;
const EPOCH = '1970-01-01T00:00:00.000Z';

interface CodexCursorState extends Record<string, unknown> {
  version: 1;
  activityObserved?: true;
  pendingTurn?: { turnId: string; createdAt: string; lineOffset: number };
  openTools?: Array<{ callId: string; toolName: string; turnId: string }>;
  skipOversizedLine?: true;
}

interface ParserState {
  turnId?: string;
  codex: CodexCursorState;
}

interface SourceRegistration {
  path: string;
  relativePath: string;
  fileIdentity: string;
  descriptor: AttachedSessionDescriptor;
}

interface MappedRecord {
  events: CanonicalRuntimeEvent[];
  state: ParserState;
}

export interface CodexRolloutSessionSourceOptions {
  /** Codex config directory, not its sessions child. */
  homeDir?: string;
  maxCandidates?: number;
  maxBytes?: number;
  maxLineBytes?: number;
  maxEvents?: number;
  maxTraversalEntries?: number;
  maxDepth?: number;
  readYieldEveryLines?: number;
  /** Test seam for the bounded event-loop yield. */
  yieldFn?: () => Promise<void>;
}

/**
 * Read-only, bounded importer for CODEX_HOME/sessions JSONL rollouts.
 * Each rollout is discovered independently in this first slice: sidechain
 * lineage and control of the original Codex process are deliberately absent.
 */
export class CodexRolloutSessionSource implements AttachedSessionSource {
  readonly provider = 'codex';
  readonly kind = 'codex-rollout';
  private readonly sessionsDir: string;
  private readonly maxCandidates: number;
  private readonly maxBytes: number;
  private readonly maxLineBytes: number;
  private readonly maxEvents: number;
  private readonly maxTraversalEntries: number;
  private readonly maxDepth: number;
  private readonly readYieldEveryLines: number;
  private readonly yieldFn: () => Promise<void>;
  private readonly handles = new Map<string, SourceRegistration>();

  constructor(options: CodexRolloutSessionSourceOptions = {}) {
    const homeDir =
      options.homeDir ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    this.sessionsDir = join(homeDir, 'sessions');
    this.maxCandidates = boundedInteger(
      'maxCandidates',
      options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      MAX_CANDIDATES_CEILING,
    );
    this.maxBytes = boundedInteger(
      'maxBytes',
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      MAX_BYTES_CEILING,
    );
    if (this.maxBytes < 2) {
      throw new RangeError('maxBytes must leave room for a JSONL newline.');
    }
    this.maxLineBytes = boundedInteger(
      'maxLineBytes',
      options.maxLineBytes ??
        Math.min(DEFAULT_MAX_LINE_BYTES, this.maxBytes - 1),
      Math.min(MAX_LINE_BYTES_CEILING, this.maxBytes - 1),
    );
    this.maxEvents = boundedInteger(
      'maxEvents',
      options.maxEvents ?? DEFAULT_MAX_EVENTS,
      MAX_EVENTS_CEILING,
    );
    this.maxTraversalEntries = boundedInteger(
      'maxTraversalEntries',
      options.maxTraversalEntries ?? DEFAULT_MAX_TRAVERSAL_ENTRIES,
      MAX_TRAVERSAL_ENTRIES_CEILING,
    );
    this.maxDepth = boundedInteger(
      'maxDepth',
      options.maxDepth ?? DEFAULT_MAX_DEPTH,
      MAX_DEPTH_CEILING,
    );
    this.readYieldEveryLines = boundedInteger(
      'readYieldEveryLines',
      options.readYieldEveryLines ?? DEFAULT_READ_YIELD_EVERY_LINES,
      DEFAULT_READ_YIELD_EVERY_LINES,
    );
    this.yieldFn =
      options.yieldFn ??
      (() => new Promise<void>((resolve) => setImmediate(resolve)));
  }

  async discover(): Promise<AttachedSessionDiscoveryResult> {
    const root = this.canonicalSessionsRoot();
    if (!root) return { outcome: 'missing_root', sessions: [] };
    this.handles.clear();

    const candidates: Array<{ path: string; modifiedAt: number }> = [];
    let visitedEntries = 0;
    let candidateLimitSeen = false;
    let traversalExhausted = false;
    let rejected = false;
    const visit = (directory: string, depth: number): void => {
      if (traversalExhausted) return;
      if (depth > this.maxDepth) {
        candidateLimitSeen = true;
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
            traversalExhausted = true;
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
          } else if (stat.isDirectory()) {
            const canonical = canonicalInside(root, candidate);
            if (canonical) visit(canonical, depth + 1);
            else rejected = true;
          } else if (stat.isFile() && entry.name.endsWith('.jsonl')) {
            const canonical = canonicalRegularFile(root, candidate);
            if (canonical) {
              candidates.push({ path: canonical, modifiedAt: stat.mtimeMs });
              if (candidates.length > this.maxCandidates) {
                candidates.sort(compareCandidates);
                candidates.length = this.maxCandidates;
                candidateLimitSeen = true;
              }
            } else {
              rejected = true;
            }
          }
          entry = directoryHandle.readSync();
        }
      } finally {
        directoryHandle.closeSync();
      }
    };
    visit(root, 0);

    const sourceIdentity = filesystemIdentity(root);
    const sessions: AttachedSessionDescriptor[] = [];
    let outcome: AttachedSessionSourceOutcome =
      candidateLimitSeen || traversalExhausted
        ? 'candidate_limit'
        : rejected
          ? 'rejected_candidate'
          : 'ok';
    for (const candidate of candidates.sort(compareCandidates)) {
      const result = this.discoverFile(root, sourceIdentity, candidate.path);
      if (!result.registration) {
        outcome = mergeOutcome(outcome, result.outcome);
        continue;
      }
      this.handles.set(
        result.registration.descriptor.sourceHandle,
        result.registration,
      );
      sessions.push(result.registration.descriptor);
    }
    return { outcome, sessions };
  }

  async read(
    session: AttachedSessionDescriptor,
    previousCursor: AttachedSessionCursor = 0,
  ): Promise<AttachedSessionReadResult> {
    const registration = this.handles.get(session.sourceHandle);
    if (!registration || !sameDescriptor(registration.descriptor, session)) {
      return { outcome: 'unknown_source', events: [], cursor: 0 };
    }
    const root = this.canonicalSessionsRoot();
    const canonical = root
      ? canonicalRegularFile(root, registration.path)
      : null;
    if (!canonical || canonical !== registration.path) {
      return {
        outcome: 'rejected_candidate',
        events: [],
        cursor: previousCursor,
      };
    }
    const refreshed = this.discoverFile(
      root!,
      filesystemIdentity(root!),
      canonical,
    );
    if (
      !refreshed.registration ||
      !sameDescriptor(
        registration.descriptor,
        refreshed.registration.descriptor,
      )
    ) {
      return {
        outcome: 'rejected_candidate',
        events: [],
        cursor: previousCursor,
      };
    }

    const cursor = decodeCursor(previousCursor);
    if (!cursor) {
      return {
        outcome: 'rejected_candidate',
        events: [],
        cursor: previousCursor,
      };
    }
    let fileSize: number;
    let content: Buffer;
    try {
      fileSize = lstatSync(canonical).size;
      if (cursor.offset > fileSize) {
        return {
          outcome: 'rejected_candidate',
          events: [],
          cursor: previousCursor,
        };
      }
      content = readWindow(
        canonical,
        cursor.offset,
        Math.min(this.maxBytes, fileSize - cursor.offset),
      );
      if (filesystemIdentity(canonical) !== registration.fileIdentity) {
        return {
          outcome: 'rejected_candidate',
          events: [],
          cursor: previousCursor,
        };
      }
    } catch {
      return {
        outcome: 'rejected_candidate',
        events: [],
        cursor: previousCursor,
      };
    }

    const byteLimited = cursor.offset + content.length < fileSize;
    let outcome: AttachedSessionSourceOutcome = byteLimited
      ? 'byte_limit'
      : 'ok';
    let localOffset = 0;
    let state = cloneState(cursor.state);
    const events: CanonicalRuntimeEvent[] = [];
    let linesScanned = 0;

    if (state.codex.skipOversizedLine) {
      const newline = content.indexOf(0x0a);
      if (newline < 0) {
        return {
          outcome: 'line_limit',
          events,
          cursor: encodeCursor(cursor.offset + content.length, state),
        };
      }
      localOffset = newline + 1;
      delete state.codex.skipOversizedLine;
      outcome = mergeOutcome(outcome, 'line_limit');
    }

    while (localOffset < content.length && events.length < this.maxEvents) {
      linesScanned += 1;
      if (linesScanned % this.readYieldEveryLines === 0) {
        await this.yieldFn();
      }
      const lineStart = localOffset;
      const newline = content.indexOf(0x0a, lineStart);
      if (newline < 0) {
        const fragmentLength = content.length - lineStart;
        if (fragmentLength > this.maxLineBytes) {
          state.codex.skipOversizedLine = true;
          outcome = mergeOutcome(outcome, 'line_limit');
          localOffset = content.length;
        } else {
          outcome = mergeOutcome(outcome, 'incomplete_tail');
        }
        break;
      }

      const lineLength = newline - lineStart;
      if (lineLength > this.maxLineBytes) {
        outcome = mergeOutcome(outcome, 'line_limit');
        localOffset = newline + 1;
        continue;
      }
      const line = content.subarray(lineStart, newline).toString('utf8').trim();
      if (!line) {
        localOffset = newline + 1;
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        outcome = mergeOutcome(outcome, 'malformed_record');
        localOffset = newline + 1;
        continue;
      }

      const absoluteLineStart = cursor.offset + lineStart;
      const beforeRecord = cloneState(state);
      const mapped = mapCodexRecord(
        record,
        session,
        registration.relativePath,
        absoluteLineStart,
        beforeRecord,
      );
      const alreadyEmitted =
        cursor.offset === absoluteLineStart ? cursor.eventIndex : 0;
      if (alreadyEmitted > mapped.events.length) {
        return {
          outcome: 'rejected_candidate',
          events: [],
          cursor: previousCursor,
        };
      }
      const remaining = mapped.events.slice(alreadyEmitted);
      const capacity = this.maxEvents - events.length;
      if (remaining.length > capacity) {
        events.push(...remaining.slice(0, capacity));
        return {
          outcome,
          events,
          cursor: encodeCursor(
            absoluteLineStart,
            beforeRecord,
            alreadyEmitted + capacity,
          ),
        };
      }
      events.push(...remaining);
      state = mapped.state;
      localOffset = newline + 1;
    }

    return {
      outcome,
      events,
      cursor: encodeCursor(cursor.offset + localOffset, state),
    };
  }

  private canonicalSessionsRoot(): string | null {
    try {
      if (!existsSync(this.sessionsDir)) return null;
      const stat = lstatSync(this.sessionsDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      return realpathSync(this.sessionsDir);
    } catch {
      return null;
    }
  }

  private discoverFile(
    root: string,
    sourceIdentity: string,
    file: string,
  ): {
    outcome: AttachedSessionSourceOutcome;
    registration?: SourceRegistration;
  } {
    try {
      const first = readLeadingLine(file, this.maxLineBytes);
      if (first === null) return { outcome: 'line_limit' };
      if (!first) return { outcome: 'malformed_record' };
      const record = JSON.parse(first);
      if (!isRecord(record) || record.type !== 'session_meta') {
        return { outcome: 'malformed_record' };
      }
      const payload = asRecord(record.payload);
      const sessionId = boundedText(payload?.id);
      const cwd = boundedPathText(payload?.cwd);
      if (!sessionId || !cwd) return { outcome: 'malformed_record' };
      const relativePath = relative(root, file);
      if (!relativePath || relativePath.startsWith(`..${sep}`)) {
        return { outcome: 'rejected_candidate' };
      }
      const fileIdentity = filesystemIdentity(file);
      const threadId = `external:codex:${digest([sourceIdentity, sessionId])}`;
      const descriptor: AttachedSessionDescriptor = {
        provider: this.provider,
        sessionId,
        threadId,
        cwd,
        createdAt: timestamp(record.timestamp ?? payload?.timestamp),
        sourceHandle: digest([
          this.kind,
          sourceIdentity,
          fileIdentity,
          relativePath,
          sessionId,
        ]),
      };
      return {
        outcome: 'ok',
        registration: { path: file, relativePath, fileIdentity, descriptor },
      };
    } catch {
      return { outcome: 'malformed_record' };
    }
  }
}

function mapCodexRecord(
  raw: unknown,
  session: AttachedSessionDescriptor,
  relativePath: string,
  lineOffset: number,
  previous: ParserState,
): MappedRecord {
  const state = cloneState(previous);
  if (!isRecord(raw)) return { events: [], state };
  const envelopeType = text(raw.type);
  const payload = asRecord(raw.payload) ?? {};
  const payloadType = text(payload?.type);
  const createdAt = timestamp(raw.timestamp);
  const base = {
    provider: 'codex' as const,
    threadId: session.threadId,
    createdAt,
  };
  const id = (index: number, kind: string): string =>
    eventId(session, relativePath, lineOffset, index, kind);

  if (envelopeType === 'event_msg' && payloadType === 'task_started') {
    const turnId = providerTurnId(payload);
    if (!turnId) return { events: [], state };
    const events = flushPendingTurn(state, session, relativePath);
    state.turnId = turnId;
    delete state.codex.activityObserved;
    state.codex.pendingTurn = { turnId, createdAt, lineOffset };
    return { events, state };
  }

  if (envelopeType === 'event_msg' && payloadType === 'user_message') {
    const prompt = text(payload?.message);
    const pending = state.codex.pendingTurn;
    if (!prompt || !state.turnId) {
      return { events: [], state };
    }
    const bounded = boundedPrompt(prompt);
    if (pending && pending.turnId === state.turnId) {
      delete state.codex.pendingTurn;
      return {
        events: [
          turnStartedEvent(
            pending,
            session,
            relativePath,
            bounded.value,
            bounded.metadata,
          ),
        ],
        state,
      };
    }
    if (state.codex.activityObserved) {
      return {
        events: [
          {
            ...base,
            eventId: id(0, 'turn-steer'),
            method: 'turn.started',
            turnId: state.turnId,
            inputKind: 'steer',
            prompt: bounded.value,
            metadata: {
              source: 'codex-rollout',
              inputPhase: 'after-activity',
              ...bounded.metadata,
            },
          },
        ],
        state,
      };
    }
    return {
      events: [
        {
          ...base,
          eventId: id(0, 'additional-input-phase-unknown'),
          method: 'runtime.warning',
          turnId: state.turnId,
          severity: 'warning',
          code: 'external_input_phase_unknown',
          message:
            'Codex rollout preserved additional user input without enough evidence to classify it as initial input or a steer.',
          details: {
            inputText: bounded.value,
            source: 'codex-rollout',
            ...bounded.metadata,
          },
        },
      ],
      state,
    };
  }

  if (
    envelopeType === 'event_msg' &&
    (payloadType === 'task_complete' || payloadType === 'turn_complete')
  ) {
    const turnId = providerTurnId(payload);
    if (!turnId) return { events: [], state };
    const events = flushPendingTurn(state, session, relativePath, turnId);
    const error = asRecord(payload?.error);
    const errorMessage = diagnosticText(error?.message);
    if (errorMessage) {
      events.push({
        ...base,
        eventId: id(events.length, 'turn-error'),
        method: 'runtime.error',
        turnId,
        severity: 'error',
        message: errorMessage,
      });
    }
    events.push({
      ...base,
      eventId: id(events.length, 'turn-completed'),
      method: 'turn.completed',
      turnId,
      finishReason: errorMessage ? 'other' : 'stop',
    });
    if (state.turnId === turnId) {
      delete state.turnId;
      delete state.codex.activityObserved;
    }
    return { events, state };
  }

  if (envelopeType === 'event_msg' && payloadType === 'turn_aborted') {
    const turnId = providerTurnId(payload) ?? state.turnId;
    if (!turnId) return { events: [], state };
    const events = flushPendingTurn(state, session, relativePath, turnId);
    events.push({
      ...base,
      eventId: id(events.length, 'turn-aborted'),
      method: 'turn.aborted',
      turnId,
      reason:
        diagnosticText(payload?.reason) ?? 'unknown provider abort reason',
    });
    if (state.turnId === turnId) {
      delete state.turnId;
      delete state.codex.activityObserved;
    }
    return { events, state };
  }

  if (envelopeType === 'event_msg' && payloadType === 'token_count') {
    const total = asRecord(asRecord(payload?.info)?.total_token_usage);
    if (!total) return { events: [], state };
    const events = flushPendingTurn(state, session, relativePath);
    const usage = tokenUsageEvent(
      total,
      payload,
      base,
      id(events.length, 'usage'),
      state,
    );
    if (usage) events.push(usage);
    return { events, state };
  }

  if (
    (envelopeType === 'event_msg' && payloadType === 'context_compacted') ||
    envelopeType === 'compacted'
  ) {
    const events = flushPendingTurn(state, session, relativePath);
    events.push({
      ...base,
      eventId: id(events.length, 'context-compacted'),
      method: 'extension.notification',
      namespace: 'codex-rollout',
      type: 'context-compacted',
      payload: {
        source:
          envelopeType === 'compacted'
            ? 'transcript-inference'
            : 'provider-event',
      },
    });
    return {
      events,
      state,
    };
  }

  if (envelopeType !== 'response_item' || !payloadType) {
    return { events: [], state };
  }

  if (payloadType === 'message') {
    if (payload?.role !== 'assistant') return { events: [], state };
    const events = flushPendingTurn(state, session, relativePath);
    const eventCountBeforeContent = events.length;
    const content = Array.isArray(payload.content) ? payload.content : [];
    const turnId = state.turnId;
    if (!turnId) return { events, state };
    for (const [contentIndex, block] of content.entries()) {
      const part = asRecord(block);
      if (part?.type !== 'output_text') continue;
      const outputText = text(part.text);
      if (!outputText) continue;
      const itemId =
        boundedText(payload.id) ??
        `codex-rollout-item:${digest([
          session.sessionId,
          relativePath,
          lineOffset,
          contentIndex,
        ])}`;
      for (const [chunkIndex, delta] of utf8Chunks(outputText).entries()) {
        events.push({
          ...base,
          eventId: id(events.length, `assistant-${contentIndex}-${chunkIndex}`),
          method: 'content.text-delta',
          turnId,
          itemId,
          delta,
        });
      }
    }
    if (events.length > eventCountBeforeContent) {
      state.codex.activityObserved = true;
    }
    return { events, state };
  }

  if (payloadType === 'reasoning') {
    const events = flushPendingTurn(state, session, relativePath);
    const eventCountBeforeContent = events.length;
    const turnId = state.turnId;
    if (!turnId) return { events, state };
    const summary = Array.isArray(payload.summary) ? payload.summary : [];
    for (const [summaryIndex, block] of summary.entries()) {
      const part = asRecord(block);
      if (part?.type !== 'summary_text') continue;
      const summaryText = text(part.text);
      if (!summaryText) continue;
      const itemId =
        boundedText(payload.id) ??
        `codex-rollout-reasoning:${digest([
          session.sessionId,
          relativePath,
          lineOffset,
        ])}`;
      for (const [chunkIndex, delta] of utf8Chunks(summaryText).entries()) {
        events.push({
          ...base,
          eventId: id(
            events.length,
            `reasoning-summary-${summaryIndex}-${chunkIndex}`,
          ),
          method: 'content.reasoning-delta',
          turnId,
          itemId,
          delta,
        });
      }
    }
    if (events.length > eventCountBeforeContent) {
      state.codex.activityObserved = true;
    }
    return { events, state };
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const callId = boundedText(payload.call_id);
    const toolName = boundedText(payload.name);
    const turnId = state.turnId;
    if (!callId || !toolName || !turnId) return { events: [], state };
    const events = flushPendingTurn(state, session, relativePath);
    const rawArguments =
      payloadType === 'function_call' ? payload.arguments : payload.input;
    const projectedArguments = projectCodexToolOutput(
      decodeJsonString(rawArguments),
    );
    state.codex.activityObserved = true;
    events.push({
      ...base,
      eventId: id(events.length, 'tool-started'),
      method: 'tool.started',
      turnId,
      itemId: callId,
      toolCallId: callId,
      toolName,
      arguments: projectedArguments.value,
    });
    if (projectedArguments.receipt) {
      events.push({
        ...base,
        eventId: id(events.length, 'tool-arguments-bounded'),
        method: 'runtime.warning',
        turnId,
        severity: 'warning',
        code: 'external_tool_arguments_bounded',
        message: 'Codex tool arguments exceeded the retained activity limit.',
        details: { toolCallId: callId, receipt: projectedArguments.receipt },
      });
    }
    const evicted = rememberOpenTool(state.codex, {
      callId,
      toolName,
      turnId,
    });
    if (evicted.length > 0) {
      events.push({
        ...base,
        eventId: id(events.length, 'tool-state-limit'),
        method: 'runtime.warning',
        turnId,
        severity: 'warning',
        code: 'external_tool_state_limit',
        message:
          'Codex rollout exceeded the bounded open-tool tracking limit; a later result may lack call attribution.',
        details: { omittedOpenToolCount: evicted.length },
      });
    }
    return { events, state };
  }

  if (
    payloadType === 'function_call_output' ||
    payloadType === 'custom_tool_call_output'
  ) {
    const callId = boundedText(payload.call_id);
    if (!callId) return { events: [], state };
    const open = state.codex.openTools?.find((tool) => tool.callId === callId);
    const outputName = boundedText(payload.name);
    const toolName = open?.toolName ?? outputName;
    const turnId = open?.turnId ?? state.turnId;
    if (!toolName || !turnId) return { events: [], state };
    const sanitized = sanitizeEncryptedOutput(decodeJsonString(payload.output));
    if (turnId === state.turnId) state.codex.activityObserved = true;
    const preview = projectCodexToolOutput(sanitized.value);
    return {
      events: [
        {
          ...base,
          eventId: id(0, 'tool-output-observed'),
          method: 'tool.progress',
          turnId,
          itemId: callId,
          toolCallId: callId,
          message: boundedOutputMessage(preview.value),
          ...(preview.receipt ? { outputReceipt: preview.receipt } : {}),
        },
        {
          ...base,
          eventId: id(1, 'tool-result-status-unknown'),
          method: 'runtime.warning',
          turnId,
          severity: 'warning',
          code: 'external_tool_result_status_unknown',
          message: sanitized.redacted
            ? 'Codex rollout preserved tool output without a verdict; encrypted content was omitted.'
            : 'Codex rollout preserved tool output without a success or failure verdict.',
          details: {
            toolCallId: callId,
            toolName,
            ...(sanitized.redacted ? { encryptedContentOmitted: true } : {}),
          },
        },
      ],
      state,
    };
  }

  return { events: [], state };
}

function tokenUsageEvent(
  total: Record<string, unknown>,
  payload: Record<string, unknown>,
  base: { provider: 'codex'; threadId: string; createdAt: string },
  eventIdValue: string,
  state: ParserState,
): CanonicalRuntimeEvent | null {
  const promptTokens = tokenFigure(total.input_tokens);
  const completionTokens = tokenFigure(total.output_tokens);
  const totalTokens = tokenFigure(total.total_tokens);
  const cacheReadTokens = tokenFigure(total.cached_input_tokens);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined
  ) {
    return null;
  }
  const modelContextWindow = tokenFigure(
    asRecord(payload.info)?.model_context_window,
  );
  const turnId = providerTurnId(payload) ?? state.turnId;
  return {
    ...base,
    eventId: eventIdValue,
    method: 'token-usage.updated',
    ...(turnId ? { turnId } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(modelContextWindow !== undefined
      ? { contextWindowTokens: modelContextWindow }
      : {}),
  };
}

function flushPendingTurn(
  state: ParserState,
  session: AttachedSessionDescriptor,
  relativePath: string,
  expectedTurnId?: string,
): CanonicalRuntimeEvent[] {
  const pending = state.codex.pendingTurn;
  if (!pending || (expectedTurnId && pending.turnId !== expectedTurnId)) {
    return [];
  }
  delete state.codex.pendingTurn;
  return [turnStartedEvent(pending, session, relativePath)];
}

function turnStartedEvent(
  pending: NonNullable<CodexCursorState['pendingTurn']>,
  session: AttachedSessionDescriptor,
  relativePath: string,
  prompt?: string,
  metadata?: Record<string, unknown>,
): CanonicalRuntimeEvent {
  return {
    provider: 'codex',
    threadId: session.threadId,
    createdAt: pending.createdAt,
    eventId: eventId(
      session,
      relativePath,
      pending.lineOffset,
      0,
      'turn-started',
    ),
    method: 'turn.started',
    turnId: pending.turnId,
    ...(prompt ? { prompt } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function decodeCursor(previous: AttachedSessionCursor): {
  offset: number;
  eventIndex: number;
  state: ParserState;
} | null {
  if (typeof previous === 'number') {
    return previous === 0
      ? { offset: previous, eventIndex: 0, state: emptyState() }
      : null;
  }
  if (!isOffset(previous.offset)) return null;
  if (
    previous.sourceState === undefined &&
    (previous.offset > 0 ||
      previous.eventIndex !== undefined ||
      previous.turnId)
  ) {
    return null;
  }
  const eventIndex = previous.eventIndex ?? 0;
  if (!isOffset(eventIndex)) return null;
  const sourceState = decodeCodexSourceState(previous.sourceState);
  if (!sourceState || (previous.turnId && !boundedText(previous.turnId))) {
    return null;
  }
  return {
    offset: previous.offset,
    eventIndex,
    state: {
      ...(previous.turnId ? { turnId: previous.turnId } : {}),
      codex: sourceState,
    },
  };
}

function encodeCursor(
  offset: number,
  state: ParserState,
  eventIndex?: number,
): AttachedSessionCursor {
  return {
    offset,
    sourceState: structuredClone(state.codex),
    ...(eventIndex ? { eventIndex } : {}),
    ...(state.turnId ? { turnId: state.turnId } : {}),
  };
}

function emptyState(): ParserState {
  return { codex: { version: 1 } };
}

function decodeCodexSourceState(
  raw: Record<string, unknown> | undefined,
): CodexCursorState | null {
  if (raw === undefined) return { version: 1 };
  if (!isPlainRecord(raw)) return null;
  if (
    !hasOnlyKeys(raw, [
      'version',
      'activityObserved',
      'pendingTurn',
      'openTools',
      'skipOversizedLine',
    ])
  ) {
    return null;
  }
  if (raw.version !== 1) return null;
  if (raw.activityObserved !== undefined && raw.activityObserved !== true) {
    return null;
  }
  if (raw.skipOversizedLine !== undefined && raw.skipOversizedLine !== true) {
    return null;
  }
  let pendingTurn: CodexCursorState['pendingTurn'];
  if (raw.pendingTurn !== undefined) {
    const pending = asRecord(raw.pendingTurn);
    if (
      !pending ||
      !hasOnlyKeys(pending, ['turnId', 'createdAt', 'lineOffset']) ||
      !boundedText(pending.turnId) ||
      !isTimestamp(pending.createdAt) ||
      !isOffset(pending.lineOffset)
    ) {
      return null;
    }
    pendingTurn = {
      turnId: pending.turnId as string,
      createdAt: new Date(pending.createdAt as string).toISOString(),
      lineOffset: pending.lineOffset as number,
    };
  }
  let openTools: CodexCursorState['openTools'];
  if (raw.openTools !== undefined) {
    if (
      !Array.isArray(raw.openTools) ||
      raw.openTools.length > MAX_OPEN_TOOLS
    ) {
      return null;
    }
    if (
      Buffer.byteLength(JSON.stringify(raw.openTools)) >
      MAX_OPEN_TOOL_STATE_BYTES
    ) {
      return null;
    }
    const seen = new Set<string>();
    openTools = [];
    for (const value of raw.openTools) {
      const tool = asRecord(value);
      const callId = boundedText(tool?.callId);
      const toolName = boundedText(tool?.toolName);
      const turnId = boundedText(tool?.turnId);
      if (
        !tool ||
        !hasOnlyKeys(tool, ['callId', 'toolName', 'turnId']) ||
        !callId ||
        !toolName ||
        !turnId ||
        seen.has(callId)
      ) {
        return null;
      }
      seen.add(callId);
      openTools.push({ callId, toolName, turnId });
    }
  }
  return {
    version: 1,
    ...(raw.activityObserved === true ? { activityObserved: true } : {}),
    ...(pendingTurn ? { pendingTurn } : {}),
    ...(openTools?.length ? { openTools } : {}),
    ...(raw.skipOversizedLine === true ? { skipOversizedLine: true } : {}),
  };
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function cloneState(state: ParserState): ParserState {
  return {
    ...(state.turnId ? { turnId: state.turnId } : {}),
    codex: structuredClone(state.codex),
  };
}

function rememberOpenTool(
  state: CodexCursorState,
  tool: { callId: string; toolName: string; turnId: string },
): Array<{ callId: string; toolName: string; turnId: string }> {
  const retained = (state.openTools ?? []).filter(
    (candidate) => candidate.callId !== tool.callId,
  );
  retained.push(tool);
  const evicted: Array<{
    callId: string;
    toolName: string;
    turnId: string;
  }> = [];
  while (
    retained.length > MAX_OPEN_TOOLS ||
    Buffer.byteLength(JSON.stringify(retained)) > MAX_OPEN_TOOL_STATE_BYTES
  ) {
    const omitted = retained.shift();
    if (omitted) evicted.push(omitted);
  }
  state.openTools = retained;
  return evicted;
}

function sanitizeEncryptedOutput(value: unknown): {
  value: unknown;
  redacted: boolean;
} {
  let redacted = false;
  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > 8 || candidate === null || typeof candidate !== 'object') {
      return candidate;
    }
    if (Array.isArray(candidate)) {
      return candidate.map((item) => visit(item, depth + 1));
    }
    const record = candidate as Record<string, unknown>;
    if (record.type === 'encrypted_content') {
      redacted = true;
      return { type: 'encrypted_content', omitted: true };
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === 'encrypted_content') {
        redacted = true;
        continue;
      }
      result[key] = visit(child, depth + 1);
    }
    return result;
  };
  return { value: visit(value, 0), redacted };
}

function boundedOutputMessage(output: unknown): string {
  return typeof output === 'string'
    ? output
    : (safeStringify(output) ?? '[output]');
}

function boundedPrompt(value: string): {
  value: string;
  metadata?: Record<string, unknown>;
} {
  const result = truncateJsonString(value, MAX_PROMPT_BYTES);
  return result.omittedBytes > 0
    ? {
        value: result.value,
        metadata: {
          sourceTextTruncated: true,
          omittedUtf8Bytes: result.omittedBytes,
          source: 'codex-rollout',
        },
      }
    : { value: result.value };
}

function diagnosticText(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText
    ? truncateJsonString(valueText, MAX_DIAGNOSTIC_TEXT_BYTES).value
    : undefined;
}

function utf8Chunks(value: string): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining) {
    const chunk = truncateJsonString(remaining, MAX_TEXT_CHUNK_BYTES).value;
    if (!chunk) break;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

function truncateJsonString(
  value: string,
  maxBytes: number,
): { value: string; omittedBytes: number } {
  const totalBytes = Buffer.byteLength(value);
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) {
    return { value, omittedBytes: 0 };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, middle))) <= maxBytes) {
      low = middle;
    } else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? '')) end -= 1;
  const retained = value.slice(0, end);
  return {
    value: retained,
    omittedBytes: totalBytes - Buffer.byteLength(retained),
  };
}

function decodeJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function providerTurnId(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  return boundedText(payload?.turn_id) ?? boundedText(payload?.turnId);
}

function eventId(
  session: AttachedSessionDescriptor,
  relativePath: string,
  lineOffset: number,
  eventIndex: number,
  kind: string,
): string {
  return `attached:codex:${digest([
    session.threadId,
    session.sessionId,
    relativePath,
    lineOffset,
    eventIndex,
    kind,
  ])}`;
}

function sameDescriptor(
  expected: AttachedSessionDescriptor,
  actual: AttachedSessionDescriptor,
): boolean {
  return (
    actual.provider === expected.provider &&
    actual.sessionId === expected.sessionId &&
    actual.threadId === expected.threadId &&
    actual.cwd === expected.cwd &&
    actual.createdAt === expected.createdAt &&
    actual.sourceHandle === expected.sourceHandle
  );
}

function canonicalInside(root: string, candidate: string): string | null {
  try {
    const canonical = realpathSync(candidate);
    return canonical.startsWith(`${root}${sep}`) ? canonical : null;
  } catch {
    return null;
  }
}

function canonicalRegularFile(root: string, candidate: string): string | null {
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return canonicalInside(root, candidate);
  } catch {
    return null;
  }
}

function isPlainRecord(value: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function filesystemIdentity(path: string): string {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}`;
}

function digest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function compareCandidates(
  left: { path: string; modifiedAt: number },
  right: { path: string; modifiedAt: number },
): number {
  return (
    right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path)
  );
}

function mergeOutcome(
  current: AttachedSessionSourceOutcome,
  next: AttachedSessionSourceOutcome,
): AttachedSessionSourceOutcome {
  const priority: Record<AttachedSessionSourceOutcome, number> = {
    ok: 0,
    incomplete_tail: 1,
    byte_limit: 2,
    line_limit: 3,
    candidate_limit: 4,
    malformed_record: 5,
    rejected_candidate: 6,
    missing_root: 7,
    unknown_source: 8,
  };
  return priority[next] > priority[current] ? next : current;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) return EPOCH;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : EPOCH;
}

function tokenFigure(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function boundedText(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText && Buffer.byteLength(valueText) <= MAX_CURSOR_TEXT_BYTES
    ? valueText
    : undefined;
}

function boundedPathText(value: unknown): string | undefined {
  const valueText = text(value);
  return valueText && Buffer.byteLength(valueText) <= 4096
    ? valueText
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedInteger(name: string, value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(
      `${name} must be an integer from 1 through ${ceiling}.`,
    );
  }
  return value;
}
