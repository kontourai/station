import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import type { ProviderSessionSourceAffinity } from '@kontourai/station-contracts/provider';
import type {
  CanonicalRuntimeEvent,
  EngineToolKind,
} from '@kontourai/station-contracts/runtime-events';
import { isManagedAcpWorkspace } from '../../services/acp/managed-acp-workspace.js';
import { isRecord } from '../../utils/is-record.js';
import { PARAGRAPH_BREAK } from '../adapters/paragraph-boundary.js';
import {
  boundedPrompt,
  projectBoundedToolOutput,
  truncateJsonString,
  utf8Chunks,
} from '../tool-output-projection.js';
import type {
  AttachedSessionCursor,
  AttachedSessionDescriptor,
  AttachedSessionDiscoveryResult,
  AttachedSessionReadResult,
  AttachedSessionSource,
  AttachedSessionSourceOutcome,
} from './attached-session-source.js';
import {
  GrokSessionIndex,
  type IndexedInspection,
  mergeOutcome,
} from './grok-session-index.js';
import {
  deriveConfigHomeAffinity,
  readWindow,
  resolveConfigHomeAffinity,
} from './transcript-file-io.js';

/**
 * Read-only, bounded importer for the Grok Build CLI's local session store.
 *
 * Grok writes `GROK_HOME/sessions/<encoded-cwd>/<session-id>/` (default
 * `~/.grok`). `updates.jsonl` is the authoritative, append-only log of ACP
 * `session/update` notifications plus `_x.ai/session/update` extensions, each
 * wrapped as `{timestamp, method, params}` (xai-org/grok-build,
 * `xai-grok-shell/src/session/storage`). A rewind appends a marker instead of
 * truncating, so a byte offset is a stable cursor. The working directory comes
 * from `summary.json` `info.cwd`, never from the directory name: that name is
 * URL-encoded but becomes a lossy slug-plus-hash for long paths.
 *
 * Station's own Grok engine runs through ACP and also writes sessions here;
 * `ownedNativeSessionId` lets the follower recognize those as Station-owned.
 */

const DEFAULT_MAX_CANDIDATES = 128;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
// Tool results carry whole file contents: 139 of 27,468 real lines exceed
// 128 KiB, 7 exceed 1 MiB. Those 7 are skipped with a reported line limit.
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENTS = 512;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 131_072;
const DEFAULT_MAX_STATS = 16_384;
const DEFAULT_MAX_SWEEP_STATS = 1024;
const DEFAULT_MAX_INSPECTIONS = 1024;
const DEFAULT_READ_YIELD_EVERY_LINES = 256;
const MAX_CANDIDATES_CEILING = 512;
const MAX_BYTES_CEILING = 8 * 1024 * 1024;
const MAX_EVENTS_CEILING = 512;
const MAX_DIRECTORY_ENTRIES_CEILING = 1_048_576;
const MAX_STATS_CEILING = 65_536;
const MAX_INSPECTIONS_CEILING = 4096;
/** Leading bytes searched for a user prompt; Station's ACP probes have none. */
const PROMPT_SCAN_BYTES = 64 * 1024;
const MAX_SUMMARY_BYTES = 256 * 1024;
const MAX_CWD_MARKER_BYTES = 4096;
const MAX_GROUP_CACHE = 65_536;
const MAX_OPEN_TOOLS = 24;
const MAX_CURSOR_TEXT_BYTES = 192;
const MAX_OPEN_TOOL_STATE_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_TEXT_CHUNK_BYTES = 16 * 1024;
const EPOCH = '1970-01-01T00:00:00.000Z';
const SOURCE_HOME_NAMESPACE = 'grok-config-home';
const PROVIDER = 'grok-build';
const ACP_METHOD = 'session/update';
const XAI_METHOD = '_x.ai/session/update';
const TOOL_KINDS: ReadonlySet<string> = new Set<EngineToolKind>([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

interface GrokCursorState extends Record<string, unknown> {
  version: 1;
  /** Agent output or a tool call was seen in the open turn. */
  activityObserved?: true;
  /** The open turn already has assistant text; the next message opens a paragraph. */
  assistantTextObserved?: true;
  /** User chunks of one prompt arrive as consecutive lines. */
  pendingTurn?: {
    turnId: string;
    createdAt: string;
    lineOffset: number;
    promptIndex?: number;
    prompt?: string;
    omittedBytes?: number;
    hiddenInput?: true;
  };
  openTools?: Array<{ callId: string; toolName: string; turnId: string }>;
  skipOversizedLine?: true;
  /** A user chunk with `_meta.promptIndex` has been seen in this session. */
  promptIndexSeen?: true;
}

interface ParserState {
  turnId?: string;
  grok: GrokCursorState;
}

interface SourceRegistration {
  path: string;
  fileIdentity: string;
  descriptor: AttachedSessionDescriptor;
}

type Inspection = IndexedInspection;

interface GrokSessionSourceOptions {
  /** Grok home directory (`GROK_HOME`), not its sessions child. */
  homeDir?: string;
  maxCandidates?: number;
  maxBytes?: number;
  maxLineBytes?: number;
  maxEvents?: number;
  /** Directory entries listed per poll (names only, no stat). */
  maxDirectoryEntries?: number;
  /** Session-directory stats per poll; unvisited directories wait for later polls. */
  maxStats?: number;
  /** Of those, stats spent re-checking older prompt-less sessions per poll. */
  maxSweepStats?: number;
  /** Uncached session inspections per discovery; the rest wait for later polls. */
  maxInspections?: number;
  /** Test seam for the recency window. */
  now?: () => number;
  readYieldEveryLines?: number;
  /** Test seam for the bounded event-loop yield. */
  yieldFn?: () => Promise<void>;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export class GrokSessionSource implements AttachedSessionSource {
  readonly provider = PROVIDER;
  readonly kind = 'grok-session';
  private readonly homeDir: string;
  private readonly sessionsDir: string;
  private readonly maxCandidates: number;
  private readonly maxBytes: number;
  private readonly maxLineBytes: number;
  private readonly maxEvents: number;
  private readonly maxDirectoryEntries: number;
  private readonly maxStats: number;
  private readonly maxSweepStats: number;
  private readonly maxInspections: number;
  private readonly now: () => number;
  private readonly readYieldEveryLines: number;
  private readonly yieldFn: () => Promise<void>;
  private readonly logger?: GrokSessionSourceOptions['logger'];
  private readonly handles = new Map<string, SourceRegistration>();
  private readonly index: GrokSessionIndex;
  /** Group name -> whether it is a Station workspace; names never change cwd. */
  private readonly stationGroups = new Map<string, boolean>();
  private readonly formatWarnings = new Set<string>();

  constructor(options: GrokSessionSourceOptions = {}) {
    this.homeDir =
      options.homeDir ??
      process.env.STATION_EXTERNAL_GROK_SOURCE_ROOT ??
      process.env.GROK_HOME ??
      join(homedir(), '.grok');
    this.sessionsDir = join(this.homeDir, 'sessions');
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
      this.maxBytes - 1,
    );
    this.maxEvents = boundedInteger(
      'maxEvents',
      options.maxEvents ?? DEFAULT_MAX_EVENTS,
      MAX_EVENTS_CEILING,
    );
    this.maxDirectoryEntries = boundedInteger(
      'maxDirectoryEntries',
      options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES,
      MAX_DIRECTORY_ENTRIES_CEILING,
    );
    this.maxStats = boundedInteger(
      'maxStats',
      options.maxStats ?? DEFAULT_MAX_STATS,
      MAX_STATS_CEILING,
    );
    if (this.maxStats < 2) {
      throw new RangeError('maxStats must leave room for the sweep.');
    }
    // The sweep has its own share so recent directories cannot starve it.
    this.maxSweepStats = boundedInteger(
      'maxSweepStats',
      options.maxSweepStats ??
        Math.min(DEFAULT_MAX_SWEEP_STATS, Math.floor(this.maxStats / 2)),
      this.maxStats - 1,
    );
    this.now = options.now ?? Date.now;
    this.maxInspections = boundedInteger(
      'maxInspections',
      options.maxInspections ?? DEFAULT_MAX_INSPECTIONS,
      MAX_INSPECTIONS_CEILING,
    );
    this.readYieldEveryLines = boundedInteger(
      'readYieldEveryLines',
      options.readYieldEveryLines ?? DEFAULT_READ_YIELD_EVERY_LINES,
      DEFAULT_READ_YIELD_EVERY_LINES,
    );
    this.yieldFn =
      options.yieldFn ??
      (() => new Promise<void>((resolve) => setImmediate(resolve)));
    this.logger = options.logger;
    this.index = new GrokSessionIndex({
      maxEntries: this.maxDirectoryEntries,
      maxStats: this.maxStats,
      maxSweepStats: this.maxSweepStats,
      maxInspections: this.maxInspections,
      now: () => this.now(),
      yieldFn: () => this.yieldFn(),
      includeGroup: (groupPath, name) =>
        !this.isStationWorkspaceGroup(groupPath, name),
    });
  }

  /**
   * Station drives Grok as an ACP connection, so its own Grok sessions are
   * persisted under provider `acp` with the agent-issued session id in the
   * resume cursor. Grok writes that same id as its session directory.
   *
   * Any ACP connection counts, not only the built-in `grok-build` one: the
   * persisted session records a connection id, not the command it ran, so a
   * user-defined connection that launches `grok` cannot be told apart, and
   * excluding it would import that Station chat a second time. The id is
   * issued by the agent (a UUIDv7 from Grok), so another engine's session id
   * matching a session in this store is not a realistic collision.
   */
  ownedNativeSessionId(session: {
    provider: string;
    resumeCursor?: unknown;
  }): string | undefined {
    if (session.provider !== 'acp' || !isRecord(session.resumeCursor)) {
      return undefined;
    }
    return boundedText(session.resumeCursor.acpSessionId);
  }

  async discover(): Promise<AttachedSessionDiscoveryResult> {
    const sourceHome = deriveConfigHomeAffinity(
      SOURCE_HOME_NAMESPACE,
      this.homeDir,
    );
    if (!sourceHome) return { outcome: 'missing_root', sessions: [] };
    const root = this.canonicalSessionsRoot(sourceHome.canonicalRoot);
    if (!root) return { outcome: 'missing_root', sessions: [] };
    this.handles.clear();

    // Layout and work bounds: see GrokSessionIndex.
    const refreshed = await this.index.refresh(root, (sessionDir, dirName) =>
      this.inspect(root, { sessionDir, dirName }),
    );
    let outcome = refreshed.outcome;
    const candidates = refreshed.sessions;

    const sourceIdentity = filesystemIdentity(root);
    const sessions: AttachedSessionDescriptor[] = [];
    for (const candidate of candidates) {
      if (sessions.length >= this.maxCandidates) {
        outcome = mergeOutcome(outcome, 'candidate_limit');
        break;
      }
      const inspection = candidate.inspection;
      if (!inspection.session) continue;
      const canonical = canonicalRegularFile(
        root,
        join(candidate.sessionDir, 'updates.jsonl'),
      );
      if (!canonical) {
        outcome = mergeOutcome(outcome, 'rejected_candidate');
        continue;
      }
      const fileIdentity = safeFilesystemIdentity(canonical);
      if (!fileIdentity) continue;
      const { sessionId, cwd, createdAt } = inspection.session;
      const descriptor: AttachedSessionDescriptor = {
        provider: this.provider,
        sessionId,
        threadId: `external:${PROVIDER}:${digest([sourceIdentity, sessionId])}`,
        cwd,
        createdAt,
        sourceHandle: digest([
          this.kind,
          sourceIdentity,
          fileIdentity,
          canonical,
          sessionId,
        ]),
        affinity: sourceHome.affinity,
      };
      this.handles.set(descriptor.sourceHandle, {
        path: canonical,
        fileIdentity,
        descriptor,
      });
      sessions.push(descriptor);
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
    const rejected = (): AttachedSessionReadResult => ({
      outcome: 'rejected_candidate',
      events: [],
      cursor: previousCursor,
    });
    const sourceHome = this.resolveSourceHome(session.affinity);
    const root = sourceHome ? this.canonicalSessionsRoot(sourceHome) : null;
    const canonical = root
      ? canonicalRegularFile(root, registration.path)
      : null;
    if (!canonical || canonical !== registration.path) return rejected();
    const cursor = decodeCursor(previousCursor);
    if (!cursor) return rejected();

    let fileSize: number;
    let content: Buffer;
    try {
      fileSize = lstatSync(canonical).size;
      // Grok only appends; a shorter file is a different file.
      if (cursor.offset > fileSize) return rejected();
      content = readWindow(
        canonical,
        cursor.offset,
        Math.min(this.maxBytes, fileSize - cursor.offset),
      );
      if (filesystemIdentity(canonical) !== registration.fileIdentity) {
        return rejected();
      }
    } catch {
      return rejected();
    }

    let outcome: AttachedSessionSourceOutcome =
      cursor.offset + content.length < fileSize ? 'byte_limit' : 'ok';
    let localOffset = 0;
    let state = cloneState(cursor.state);
    const events: CanonicalRuntimeEvent[] = [];
    let linesScanned = 0;

    if (state.grok.skipOversizedLine) {
      const newline = content.indexOf(0x0a);
      if (newline < 0) {
        return {
          outcome: 'line_limit',
          events,
          cursor: encodeCursor(cursor.offset + content.length, state),
        };
      }
      localOffset = newline + 1;
      delete state.grok.skipOversizedLine;
      outcome = mergeOutcome(outcome, 'line_limit');
    }

    while (localOffset < content.length && events.length < this.maxEvents) {
      linesScanned += 1;
      if (linesScanned % this.readYieldEveryLines === 0) await this.yieldFn();
      const lineStart = localOffset;
      const newline = content.indexOf(0x0a, lineStart);
      if (newline < 0) {
        // Grok appends each line non-atomically: wait for its newline.
        if (content.length - lineStart > this.maxLineBytes) {
          state.grok.skipOversizedLine = true;
          outcome = mergeOutcome(outcome, 'line_limit');
          localOffset = content.length;
        } else {
          outcome = mergeOutcome(outcome, 'incomplete_tail');
        }
        break;
      }
      if (newline - lineStart > this.maxLineBytes) {
        outcome = mergeOutcome(outcome, 'line_limit');
        localOffset = newline + 1;
        continue;
      }
      const line = content.subarray(lineStart, newline).toString('utf8').trim();
      if (!line) {
        localOffset = newline + 1;
        continue;
      }
      const envelope = parseEnvelope(line);
      if (!envelope) {
        outcome = mergeOutcome(outcome, 'malformed_record');
        localOffset = newline + 1;
        continue;
      }
      const absoluteLineStart = cursor.offset + lineStart;
      const beforeRecord = cloneState(state);
      const mapped = mapGrokUpdate(
        envelope,
        session,
        absoluteLineStart,
        beforeRecord,
      );
      const alreadyEmitted =
        cursor.offset === absoluteLineStart ? cursor.eventIndex : 0;
      if (alreadyEmitted > mapped.events.length) return rejected();
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

  resolveSourceHome(
    affinity: ProviderSessionSourceAffinity | undefined,
  ): string | null {
    return resolveConfigHomeAffinity(
      SOURCE_HOME_NAMESPACE,
      this.homeDir,
      affinity,
    );
  }

  private canonicalSessionsRoot(configRoot: string): string | null {
    try {
      if (!existsSync(this.sessionsDir)) return null;
      const stat = lstatSync(this.sessionsDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      const canonical = realpathSync(this.sessionsDir);
      return canonical.startsWith(`${configRoot}${sep}`) ? canonical : null;
    } catch {
      return null;
    }
  }

  /**
   * Station runs Grok in private ACP workspaces (its own and other Station
   * homes' probe and session workspaces). Their sessions are Station's, never
   * user conversations, so those groups are skipped before any stat. The
   * group name is Grok's URL-encoded cwd, or for a long cwd a slug-and-hash
   * whose real cwd Grok records in the group's `.cwd` file. A group whose cwd
   * cannot be decoded is kept.
   */
  private isStationWorkspaceGroup(groupPath: string, name: string): boolean {
    const cached = this.stationGroups.get(name);
    if (cached !== undefined) return cached;
    const cwd = decodeGroupCwd(groupPath, name);
    const excluded = cwd !== undefined && isManagedAcpWorkspace(cwd);
    if (this.stationGroups.size >= MAX_GROUP_CACHE) this.stationGroups.clear();
    this.stationGroups.set(name, excluded);
    return excluded;
  }

  /**
   * A session is listed once its log holds a user prompt. Station's own ACP
   * capability probes create thousands of prompt-less sessions here.
   */
  private inspect(
    root: string,
    candidate: { sessionDir: string; dirName: string },
  ): Inspection {
    const updates = join(candidate.sessionDir, 'updates.jsonl');
    const stat = safeLstat(updates);
    // A session directory gets its log with its first update.
    if (!stat) return { outcome: 'ok', cacheable: true };
    let head: Buffer;
    try {
      if (!canonicalRegularFile(root, updates)) {
        return { outcome: 'rejected_candidate', cacheable: true };
      }
      head = readWindow(updates, 0, PROMPT_SCAN_BYTES);
    } catch {
      return { outcome: 'rejected_candidate', cacheable: false };
    }
    let offset = 0;
    let prompted = false;
    let first = true;
    while (offset < head.length) {
      const newline = head.indexOf(0x0a, offset);
      if (newline < 0) break;
      const line = head.subarray(offset, newline).toString('utf8').trim();
      offset = newline + 1;
      if (!line) continue;
      const envelope = parseEnvelope(line);
      if (first && !envelope) {
        this.warnUnknownFormat('updates.jsonl');
        return { outcome: 'malformed_record', cacheable: true };
      }
      first = false;
      if (envelope?.update.sessionUpdate === 'user_message_chunk') {
        prompted = true;
        break;
      }
    }
    // Not prompted yet: cached by directory mtime, which the next append changes.
    if (!prompted) return { outcome: 'ok', cacheable: true };

    const summary = readSummary(join(candidate.sessionDir, 'summary.json'));
    if (summary === undefined) {
      // Grok writes summary.json with an atomic rename; absence is transient.
      return { outcome: 'malformed_record', cacheable: false };
    }
    const info = summary ? asRecord(summary.info) : undefined;
    const sessionId = boundedText(info?.id);
    const cwd = boundedPathText(info?.cwd);
    if (!summary || !sessionId || !cwd || sessionId !== candidate.dirName) {
      this.warnUnknownFormat('summary.json');
      return { outcome: 'malformed_record', cacheable: true };
    }
    // A subagent's child session belongs to its parent's conversation; this
    // importer does not follow that lineage, so it is not listed on its own.
    if (summary.session_kind === 'subagent') {
      return { outcome: 'ok', cacheable: true };
    }
    return {
      outcome: 'ok',
      cacheable: true,
      session: { sessionId, cwd, createdAt: timestamp(summary.created_at) },
    };
  }

  /**
   * One warning per unrecognized file kind (a fixed set of two), not per
   * session or poll: an unrecognized format is skipped, never guessed.
   */
  private warnUnknownFormat(file: 'updates.jsonl' | 'summary.json'): void {
    if (this.formatWarnings.has(file)) return;
    this.formatWarnings.add(file);
    this.logger?.warn(
      'Grok session store has an unrecognized format; those sessions are not imported',
      { source: this.kind, file },
    );
  }
}

/** The cwd a group folder stands for, per Grok's `decode_cwd_from_dirname`. */
function decodeGroupCwd(groupPath: string, name: string): string | undefined {
  try {
    const decoded = decodeURIComponent(name);
    if (isAbsolute(decoded) || /^[A-Za-z]:[\\/]/.test(decoded)) return decoded;
  } catch {
    // Not URL-encoded: the slug-and-hash form below.
  }
  try {
    const marker = join(groupPath, '.cwd');
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.size > MAX_CWD_MARKER_BYTES) return undefined;
    const cwd = readWindow(marker, 0, stat.size).toString('utf8').trim();
    return cwd || undefined;
  } catch {
    return undefined;
  }
}

interface GrokEnvelope {
  method: typeof ACP_METHOD | typeof XAI_METHOD;
  timestamp?: number;
  meta?: Record<string, unknown>;
  update: Record<string, unknown> & { sessionUpdate: string };
}

function parseEnvelope(line: string): GrokEnvelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.method !== ACP_METHOD && raw.method !== XAI_METHOD) return null;
  const params = asRecord(raw.params);
  const update = asRecord(params?.update);
  if (!update || typeof update.sessionUpdate !== 'string') return null;
  return {
    method: raw.method,
    ...(typeof raw.timestamp === 'number' ? { timestamp: raw.timestamp } : {}),
    ...(asRecord(params?._meta) ? { meta: asRecord(params?._meta) } : {}),
    update: update as GrokEnvelope['update'],
  };
}

/** `null`: present but not a JSON object. `undefined`: absent or unreadable. */
function readSummary(path: string): Record<string, unknown> | null | undefined {
  let content: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > MAX_SUMMARY_BYTES) return null;
    content = readWindow(path, 0, stat.size);
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(content.toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapGrokUpdate(
  envelope: GrokEnvelope,
  session: AttachedSessionDescriptor,
  lineOffset: number,
  previous: ParserState,
): { events: CanonicalRuntimeEvent[]; state: ParserState } {
  const state = cloneState(previous);
  const update = envelope.update;
  const kind = update.sessionUpdate;
  const createdAt = envelopeTime(envelope);
  const base = { provider: PROVIDER, threadId: session.threadId, createdAt };
  const id = (index: number, label: string): string =>
    eventId(session, lineOffset, index, label);

  if (envelope.method === ACP_METHOD && kind === 'user_message_chunk') {
    const meta = asRecord(update._meta);
    const promptIndex = isOffset(meta?.promptIndex)
      ? (meta.promptIndex as number)
      : undefined;
    const hidden = meta?.hideFromScrollback === true;
    const text = hidden ? undefined : renderContent(update.content);
    // Upstream's turn counting (`UserRunTurnTracker`): once any chunk has
    // carried `promptIndex`, a chunk without it does not start a turn.
    // Upstream also merges queued prompts into one prompt before the turn
    // runs, so a changed `promptIndex` is a genuinely separate turn.
    const phantom =
      promptIndex === undefined && state.grok.promptIndexSeen === true;
    if (promptIndex !== undefined) state.grok.promptIndexSeen = true;
    // Interjections, host-turn echoes and direct `!command` echoes are written
    // without `promptIndex` while a turn is open, and Grok shows them to the
    // user: they are imported as in-turn input (a steer on the open turn),
    // never as a new or aborted turn.
    // An open pending prompt has already set `state.turnId`.
    const openTurnId = state.turnId;
    if ((phantom || meta?.interjection === true) && openTurnId) {
      if (!text) return { events: [], state };
      const events = flushPendingTurn(state, session);
      const bounded = boundedPrompt(text, {
        maxBytes: MAX_PROMPT_BYTES,
        source: 'grok-session',
      });
      events.push({
        ...base,
        eventId: id(events.length, 'turn-steer'),
        method: 'turn.started',
        turnId: openTurnId,
        inputKind: 'steer',
        prompt: bounded.value,
        metadata: { source: 'grok-session', ...bounded.metadata },
      });
      return { events, state };
    }
    const pending = state.grok.pendingTurn;
    if (pending && pending.promptIndex === promptIndex) {
      appendPrompt(pending, text, hidden);
      return { events: [], state };
    }
    const events = flushPendingTurn(state, session);
    // A new prompt while the previous turn never recorded `turn_completed`
    // (Grok crashed or was killed): that turn and its open tools end here.
    if (state.turnId) {
      events.push(
        ...abortOpenTurn(
          state,
          base,
          (index, label) => id(index, label),
          events.length,
        ),
      );
    }
    const turnId =
      boundedText(envelope.meta?.eventId) ?? `grok-turn:${lineOffset}`;
    state.turnId = turnId;
    delete state.grok.activityObserved;
    delete state.grok.assistantTextObserved;
    const opened: NonNullable<GrokCursorState['pendingTurn']> = {
      turnId,
      createdAt,
      lineOffset,
      ...(promptIndex !== undefined ? { promptIndex } : {}),
    };
    appendPrompt(opened, text, hidden);
    state.grok.pendingTurn = opened;
    return { events, state };
  }

  if (envelope.method === ACP_METHOD && kind === 'agent_message_chunk') {
    const events = flushPendingTurn(state, session);
    const turnId = state.turnId;
    const rendered = renderContent(update.content);
    if (!turnId || !rendered) return { events, state };
    // Grok persists each model message as one chunk line, so a later line in
    // the same turn is a new message.
    const outputText =
      state.grok.assistantTextObserved && !rendered.startsWith(PARAGRAPH_BREAK)
        ? `${PARAGRAPH_BREAK}${rendered}`
        : rendered;
    state.grok.assistantTextObserved = true;
    state.grok.activityObserved = true;
    const itemId = `grok-message:${digest([session.sessionId, lineOffset])}`;
    for (const [chunk, delta] of utf8Chunks(
      outputText,
      MAX_TEXT_CHUNK_BYTES,
    ).entries()) {
      events.push({
        ...base,
        eventId: id(events.length, `text-${chunk}`),
        method: 'content.text-delta',
        turnId,
        itemId,
        delta,
      });
    }
    return { events, state };
  }

  if (envelope.method === ACP_METHOD && kind === 'agent_thought_chunk') {
    const events = flushPendingTurn(state, session);
    const turnId = state.turnId;
    const rendered = renderContent(update.content);
    if (!turnId || !rendered) return { events, state };
    state.grok.activityObserved = true;
    const itemId = `grok-thought:${digest([session.sessionId, lineOffset])}`;
    for (const [chunk, delta] of utf8Chunks(
      rendered,
      MAX_TEXT_CHUNK_BYTES,
    ).entries()) {
      events.push({
        ...base,
        eventId: id(events.length, `reasoning-${chunk}`),
        method: 'content.reasoning-delta',
        turnId,
        itemId,
        delta,
      });
    }
    return { events, state };
  }

  if (envelope.method === ACP_METHOD && kind === 'tool_call') {
    const callId = boundedText(update.toolCallId);
    const turnId = state.turnId;
    if (!callId || !turnId) return { events: [], state };
    const events = flushPendingTurn(state, session);
    const toolName = grokToolName(update);
    // The ACP kind arrives on a later update; Grok's own tool kind is here.
    const toolKind =
      engineToolKind(update.kind) ??
      engineToolKind(asRecord(asRecord(update._meta)?.['x.ai/tool'])?.kind);
    const projected = projectBoundedToolOutput(update.rawInput);
    state.grok.activityObserved = true;
    events.push({
      ...base,
      eventId: id(events.length, 'tool-started'),
      method: 'tool.started',
      turnId,
      itemId: callId,
      toolCallId: callId,
      toolName,
      ...(toolKind ? { toolKind } : {}),
      ...(projected.value !== undefined ? { arguments: projected.value } : {}),
    });
    if (projected.receipt) {
      events.push({
        ...base,
        eventId: id(events.length, 'tool-arguments-bounded'),
        method: 'runtime.warning',
        turnId,
        severity: 'warning',
        code: 'external_tool_arguments_bounded',
        message: 'Grok tool arguments exceeded the retained activity limit.',
        details: { toolCallId: callId, receipt: projected.receipt },
      });
    }
    const evicted = rememberOpenTool(state.grok, { callId, toolName, turnId });
    if (evicted > 0) {
      events.push({
        ...base,
        eventId: id(events.length, 'tool-state-limit'),
        method: 'runtime.warning',
        turnId,
        severity: 'warning',
        code: 'external_tool_state_limit',
        message:
          'Grok session exceeded the bounded open-tool tracking limit; a later result may lack call attribution.',
        details: { omittedOpenToolCount: evicted },
      });
    }
    return { events, state };
  }

  if (envelope.method === ACP_METHOD && kind === 'tool_call_update') {
    const status = update.status;
    // Non-terminal updates only backfill title/arguments of a started call.
    if (status !== 'completed' && status !== 'failed') {
      return { events: [], state };
    }
    const callId = boundedText(update.toolCallId);
    if (!callId) return { events: [], state };
    const open = state.grok.openTools?.find((tool) => tool.callId === callId);
    const turnId = open?.turnId ?? state.turnId;
    if (!turnId) return { events: [], state };
    if (open) {
      state.grok.openTools = state.grok.openTools?.filter(
        (tool) => tool.callId !== callId,
      );
      if (!state.grok.openTools?.length) delete state.grok.openTools;
    }
    const output = toolOutput(update);
    const projected = projectBoundedToolOutput(output);
    return {
      events: [
        {
          ...base,
          eventId: id(0, 'tool-completed'),
          method: 'tool.completed',
          turnId,
          itemId: callId,
          toolCallId: callId,
          toolName: open?.toolName ?? grokToolName(update),
          status: status === 'failed' ? 'error' : 'success',
          ...(projected.value !== undefined ? { output: projected.value } : {}),
          ...(projected.receipt ? { outputReceipt: projected.receipt } : {}),
        },
      ],
      state,
    };
  }

  if (envelope.method === ACP_METHOD && kind === 'plan') {
    const turnId = state.turnId;
    if (!turnId || !Array.isArray(update.entries)) return { events: [], state };
    const events = flushPendingTurn(state, session);
    const entries = update.entries.flatMap((entry) => {
      const record = asRecord(entry);
      const content = text(record?.content);
      const status = record?.status;
      if (
        !content ||
        (status !== 'pending' &&
          status !== 'in_progress' &&
          status !== 'completed')
      ) {
        return [];
      }
      // Narrowed by the check above.
      const entryStatus: 'pending' | 'in_progress' | 'completed' = status;
      return [
        {
          content: truncateJsonString(content, MAX_TEXT_CHUNK_BYTES).value,
          status: entryStatus,
        },
      ];
    });
    events.push({
      ...base,
      eventId: id(events.length, 'plan'),
      method: 'plan.updated',
      turnId,
      entries,
    });
    return { events, state };
  }

  if (envelope.method === XAI_METHOD && kind === 'turn_completed') {
    const turnId = state.turnId;
    if (!turnId) return { events: [], state };
    const events = flushPendingTurn(state, session);
    const usage = usageEvent(asRecord(update.usage), {
      ...base,
      turnId,
      eventId: id(events.length, 'usage'),
    });
    if (usage) events.push(usage);
    events.push({
      ...base,
      eventId: id(events.length, 'turn-completed'),
      method: 'turn.completed',
      turnId,
      finishReason: finishReason(update.stop_reason),
    });
    delete state.turnId;
    delete state.grok.activityObserved;
    delete state.grok.assistantTextObserved;
    return { events, state };
  }

  if (envelope.method === XAI_METHOD && kind === 'rewind_marker') {
    // Grok's rewind appends this marker and its own replay drops the turns
    // after the target prompt (`filter_rewind_by`). Station keeps them: by the
    // time the marker is written, a live follower has already published those
    // turns into an append-only event log that has no retraction event, and
    // dropping them only on a cold import would make two imports of one
    // session disagree. The marker is recorded as an extension notification;
    // nothing binds it for display yet, so the transcript does not show it.
    const target = isOffset(update.target_prompt_index)
      ? update.target_prompt_index
      : undefined;
    const events = flushPendingTurn(state, session);
    events.push({
      ...base,
      ...(state.turnId ? { turnId: state.turnId } : {}),
      eventId: id(events.length, 'rewound'),
      method: 'extension.notification',
      namespace: 'grok-session',
      type: 'conversation-rewound',
      payload: target !== undefined ? { targetPromptIndex: target } : {},
    });
    return { events, state };
  }

  if (envelope.method === XAI_METHOD && kind === 'compaction_checkpoint') {
    const events = flushPendingTurn(state, session);
    events.push({
      ...base,
      ...(state.turnId ? { turnId: state.turnId } : {}),
      eventId: id(events.length, 'context-compacted'),
      method: 'extension.notification',
      namespace: 'grok-session',
      type: 'context-compacted',
      payload: { source: 'provider-event' },
    });
    return { events, state };
  }

  return { events: [], state };
}

function appendPrompt(
  pending: NonNullable<GrokCursorState['pendingTurn']>,
  text: string | undefined,
  hidden: boolean,
): void {
  if (hidden) pending.hiddenInput = true;
  if (!text) return;
  const joined = pending.prompt ? `${pending.prompt}\n\n${text}` : text;
  const bounded = truncateJsonString(joined, MAX_PROMPT_BYTES);
  pending.prompt = bounded.value;
  if (bounded.omittedBytes > 0) {
    pending.omittedBytes = (pending.omittedBytes ?? 0) + bounded.omittedBytes;
  }
}

function flushPendingTurn(
  state: ParserState,
  session: AttachedSessionDescriptor,
): CanonicalRuntimeEvent[] {
  const pending = state.grok.pendingTurn;
  if (!pending) return [];
  delete state.grok.pendingTurn;
  const metadata = {
    ...(pending.omittedBytes
      ? {
          sourceTextTruncated: true,
          omittedUtf8Bytes: pending.omittedBytes,
          source: 'grok-session',
        }
      : {}),
    // Grok wrote this input without showing it as a user message (for
    // example a wake-up after a background task finished).
    ...(pending.hiddenInput && !pending.prompt
      ? { source: 'grok-session', hiddenInput: true }
      : {}),
  };
  return [
    {
      provider: PROVIDER,
      threadId: session.threadId,
      createdAt: pending.createdAt,
      eventId: eventId(session, pending.lineOffset, 0, 'turn-started'),
      method: 'turn.started',
      turnId: pending.turnId,
      ...(pending.prompt ? { prompt: pending.prompt } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  ];
}

/** Text of one ACP content block; images and other binaries are named, never inlined. */
function renderContent(raw: unknown): string | undefined {
  const content = asRecord(raw);
  if (!content) return undefined;
  if (content.type === 'text') {
    // Interjections and locally expanded slash skills carry the model-facing
    // frame or expansion in `text` and what the user typed in
    // `_meta.displayText` (upstream `queue_text_from_blocks`). Station shows
    // the typed text, as Grok does; the model-facing text is not imported,
    // like the hidden input this source already omits.
    const display = asRecord(content._meta)?.displayText;
    if (typeof display === 'string' && display.trim()) return display.trim();
    return text(content.text);
  }
  if (content.type === 'image') return '[image]';
  if (content.type === 'resource') {
    const resource = asRecord(content.resource);
    return text(resource?.text) ?? text(resource?.uri) ?? '[resource]';
  }
  return undefined;
}

/** Ends an open turn that never completed, with its open tools unresolved. */
function abortOpenTurn(
  state: ParserState,
  base: { provider: string; threadId: string; createdAt: string },
  id: (index: number, label: string) => string,
  offset: number,
): CanonicalRuntimeEvent[] {
  const turnId = state.turnId;
  if (!turnId) return [];
  const events: CanonicalRuntimeEvent[] = [];
  const open = state.grok.openTools ?? [];
  for (const tool of open.filter((candidate) => candidate.turnId === turnId)) {
    events.push({
      ...base,
      eventId: id(offset + events.length, `tool-abandoned:${tool.callId}`),
      method: 'tool.completed',
      turnId,
      itemId: tool.callId,
      toolCallId: tool.callId,
      toolName: tool.toolName,
      status: 'unresolved',
    });
  }
  const remaining = open.filter((candidate) => candidate.turnId !== turnId);
  if (remaining.length) state.grok.openTools = remaining;
  else delete state.grok.openTools;
  events.push({
    ...base,
    eventId: id(offset + events.length, 'turn-abandoned'),
    method: 'turn.aborted',
    turnId,
    reason:
      'Grok started a new prompt without recording this turn as complete.',
  });
  delete state.turnId;
  delete state.grok.activityObserved;
  delete state.grok.assistantTextObserved;
  return events;
}

function grokToolName(update: Record<string, unknown>): string {
  const meta = asRecord(asRecord(update._meta)?.['x.ai/tool']);
  return boundedText(meta?.name) ?? boundedText(update.title) ?? 'tool';
}

function engineToolKind(value: unknown): EngineToolKind | undefined {
  return typeof value === 'string' && TOOL_KINDS.has(value)
    ? (value as EngineToolKind)
    : undefined;
}

/** ACP tool content is the display output; rawOutput is the fallback. */
function toolOutput(update: Record<string, unknown>): unknown {
  if (Array.isArray(update.content)) {
    const texts = update.content.flatMap((item) => {
      const block = asRecord(item);
      if (block?.type !== 'content') return [];
      const rendered = renderContent(block.content);
      return rendered ? [rendered] : [];
    });
    if (texts.length > 0) return texts.join('\n');
  }
  return update.rawOutput;
}

function finishReason(
  value: unknown,
): 'stop' | 'max-tokens' | 'cancelled' | 'other' {
  if (value === 'end_turn') return 'stop';
  if (value === 'max_tokens') return 'max-tokens';
  if (value === 'cancelled') return 'cancelled';
  return 'other';
}

/** Grok reports each turn's own totals; `inputTokens` includes cache reads. */
function usageEvent(
  usage: Record<string, unknown> | undefined,
  base: {
    provider: string;
    threadId: string;
    createdAt: string;
    turnId: string;
    eventId: string;
  },
): CanonicalRuntimeEvent | null {
  if (!usage) return null;
  const promptTokens = tokenFigure(usage.inputTokens);
  const completionTokens = tokenFigure(usage.outputTokens);
  const totalTokens = tokenFigure(usage.totalTokens);
  const cacheReadTokens = tokenFigure(usage.cachedReadTokens);
  const cacheWriteTokens = tokenFigure(usage.cacheCreationTokens);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }
  return {
    ...base,
    method: 'token-usage.updated',
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

function envelopeTime(envelope: GrokEnvelope): string {
  const millis = envelope.meta?.agentTimestampMs;
  if (
    typeof millis === 'number' &&
    Number.isSafeInteger(millis) &&
    millis > 0
  ) {
    return new Date(millis).toISOString();
  }
  // The envelope's own timestamp is in whole seconds.
  const seconds = envelope.timestamp;
  if (
    typeof seconds === 'number' &&
    Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    seconds < 1e11
  ) {
    return new Date(seconds * 1000).toISOString();
  }
  return EPOCH;
}

function decodeCursor(previous: AttachedSessionCursor): {
  offset: number;
  eventIndex: number;
  state: ParserState;
} | null {
  if (typeof previous === 'number') {
    return previous === 0
      ? { offset: 0, eventIndex: 0, state: { grok: { version: 1 } } }
      : null;
  }
  if (!isOffset(previous.offset)) return null;
  if (previous.sourceState === undefined && previous.offset > 0) return null;
  const eventIndex = previous.eventIndex ?? 0;
  if (!isOffset(eventIndex)) return null;
  const grok = decodeSourceState(previous.sourceState);
  if (!grok || (previous.turnId && !boundedText(previous.turnId))) return null;
  return {
    offset: previous.offset,
    eventIndex,
    state: {
      ...(previous.turnId ? { turnId: previous.turnId } : {}),
      grok,
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
    sourceState: structuredClone(state.grok),
    ...(eventIndex ? { eventIndex } : {}),
    ...(state.turnId ? { turnId: state.turnId } : {}),
  };
}

function decodeSourceState(
  raw: Record<string, unknown> | undefined,
): GrokCursorState | null {
  if (raw === undefined) return { version: 1 };
  if (!isPlainRecord(raw) || raw.version !== 1) return null;
  const allowed = [
    'version',
    'activityObserved',
    'assistantTextObserved',
    'pendingTurn',
    'openTools',
    'skipOversizedLine',
    'promptIndexSeen',
  ];
  if (!Object.keys(raw).every((key) => allowed.includes(key))) return null;
  for (const flag of [
    'activityObserved',
    'assistantTextObserved',
    'skipOversizedLine',
    'promptIndexSeen',
  ]) {
    if (raw[flag] !== undefined && raw[flag] !== true) return null;
  }
  const state: GrokCursorState = { version: 1 };
  if (raw.activityObserved) state.activityObserved = true;
  if (raw.assistantTextObserved) state.assistantTextObserved = true;
  if (raw.skipOversizedLine) state.skipOversizedLine = true;
  if (raw.promptIndexSeen) state.promptIndexSeen = true;
  if (raw.pendingTurn !== undefined) {
    const pending = asRecord(raw.pendingTurn);
    if (
      !pending ||
      !Object.keys(pending).every((key) =>
        [
          'turnId',
          'createdAt',
          'lineOffset',
          'promptIndex',
          'prompt',
          'omittedBytes',
          'hiddenInput',
        ].includes(key),
      ) ||
      !boundedText(pending.turnId) ||
      !isTimestamp(pending.createdAt) ||
      !isOffset(pending.lineOffset) ||
      (pending.promptIndex !== undefined && !isOffset(pending.promptIndex)) ||
      (pending.prompt !== undefined &&
        (typeof pending.prompt !== 'string' ||
          Buffer.byteLength(JSON.stringify(pending.prompt)) >
            MAX_PROMPT_BYTES)) ||
      (pending.omittedBytes !== undefined && !isOffset(pending.omittedBytes)) ||
      (pending.hiddenInput !== undefined && pending.hiddenInput !== true)
    ) {
      return null;
    }
    state.pendingTurn = {
      turnId: pending.turnId as string,
      createdAt: new Date(pending.createdAt as string).toISOString(),
      lineOffset: pending.lineOffset as number,
      ...(pending.promptIndex !== undefined
        ? { promptIndex: pending.promptIndex as number }
        : {}),
      ...(pending.prompt ? { prompt: pending.prompt as string } : {}),
      ...(pending.omittedBytes
        ? { omittedBytes: pending.omittedBytes as number }
        : {}),
      ...(pending.hiddenInput ? { hiddenInput: true as const } : {}),
    };
  }
  if (raw.openTools !== undefined) {
    if (
      !Array.isArray(raw.openTools) ||
      raw.openTools.length > MAX_OPEN_TOOLS ||
      Buffer.byteLength(JSON.stringify(raw.openTools)) >
        MAX_OPEN_TOOL_STATE_BYTES
    ) {
      return null;
    }
    const seen = new Set<string>();
    const openTools: NonNullable<GrokCursorState['openTools']> = [];
    for (const value of raw.openTools) {
      const tool = asRecord(value);
      const callId = boundedText(tool?.callId);
      const toolName = boundedText(tool?.toolName);
      const turnId = boundedText(tool?.turnId);
      if (
        !tool ||
        Object.keys(tool).length !== 3 ||
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
    if (openTools.length > 0) state.openTools = openTools;
  }
  return state;
}

function rememberOpenTool(
  state: GrokCursorState,
  tool: { callId: string; toolName: string; turnId: string },
): number {
  const retained = (state.openTools ?? []).filter(
    (candidate) => candidate.callId !== tool.callId,
  );
  retained.push(tool);
  let evicted = 0;
  while (
    retained.length > MAX_OPEN_TOOLS ||
    Buffer.byteLength(JSON.stringify(retained)) > MAX_OPEN_TOOL_STATE_BYTES
  ) {
    retained.shift();
    evicted += 1;
  }
  state.openTools = retained;
  return evicted;
}

function cloneState(state: ParserState): ParserState {
  return {
    ...(state.turnId ? { turnId: state.turnId } : {}),
    grok: structuredClone(state.grok),
  };
}

function eventId(
  session: AttachedSessionDescriptor,
  lineOffset: number,
  index: number,
  kind: string,
): string {
  return `attached:${PROVIDER}:${digest([
    session.threadId,
    session.sessionId,
    lineOffset,
    index,
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
    actual.sourceHandle === expected.sourceHandle &&
    actual.affinity?.kind === expected.affinity?.kind &&
    actual.affinity?.ref === expected.affinity?.ref
  );
}

function canonicalRegularFile(root: string, candidate: string): string | null {
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const canonical = realpathSync(candidate);
    return canonical.startsWith(`${root}${sep}`) ? canonical : null;
  } catch {
    return null;
  }
}

function safeLstat(path: string): import('node:fs').Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function filesystemIdentity(path: string): string {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}`;
}

function safeFilesystemIdentity(path: string): string | undefined {
  try {
    return filesystemIdentity(path);
  } catch {
    return undefined;
  }
}

function digest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function isPlainRecord(value: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
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
  return valueText &&
    isAbsolute(valueText) &&
    Buffer.byteLength(valueText) <= 4096
    ? valueText
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
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
