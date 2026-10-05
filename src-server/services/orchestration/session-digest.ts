/**
 * station#3413: the digest behind Station Control's `get_session_digest`, a
 * compact account of one Session assembled ONLY from facts the event store
 * already recorded (`EventStore.readTurnDigestFacts`). Nothing here summarizes
 * with a model, and nothing is named that nothing computes: every field is a
 * count, a clip or a copy of a recorded value, and a fact that was not
 * recorded is absent rather than guessed.
 *
 * Bounds, each a REFUSAL or a stated clip, never a silent cut:
 * - a page holds at most {@link SESSION_DIGEST_PAGE_MAX_BYTES} serialized
 *   bytes of turns; a window of turns that would not fit ends the page early
 *   and hands back a cursor, so paging covers every turn exactly once;
 * - `turnLimit` above {@link SESSION_DIGEST_MAX_TURNS} is refused by the route;
 * - each field of a turn is bounded (request clip, tool names, files, pull
 *   requests, children), so one turn always fits a page. A clipped or
 *   collapsed field says so (`requestClipped`, `otherTools`,
 *   `filesTotal`, `pullRequestsTotal`, `delegatedChildrenTotal`).
 */
import { SESSION_DIGEST_PAGE_MAX_BYTES } from '../../routes/orchestration/project-activity-limits.js';
import {
  clipSerialized,
  serializedBytes,
} from '../../utils/serialized-clip.js';
import {
  TURN_DIGEST_PROMPT_PREFIX_CHARS,
  type TurnDigestFacts,
} from './event-store.js';

const REQUEST_MAX_BYTES = 240;
const TOOLS_PER_TURN = 8;
const TOOL_NAME_MAX_BYTES = 64;
const FILES_PER_TURN = 8;
const FILE_PATH_MAX_BYTES = 200;
const PULL_REQUESTS_PER_TURN = 5;
const CHILDREN_PER_TURN = 5;
const CHILD_TITLE_MAX_BYTES = 80;

export type DigestTurnOutcome =
  | 'completed'
  | 'failed'
  | 'interrupted'
  /** No terminal event is recorded for the turn: it is running, or it ended without one. */
  | 'open';

export interface DigestPullRequest {
  host: string;
  repository: string;
  ref: string;
}

export interface DigestDelegatedChild {
  sessionId: string;
  title?: string;
}

export interface DigestTurn {
  turnId: string;
  startedAt: string;
  /** The request's first non-empty line, clipped; absent when the turn had no prompt. */
  request?: string;
  requestClipped?: true;
  /** The engine opened this turn on its own: there is no request. */
  providerTriggered?: true;
  outcome: DigestTurnOutcome;
  /** Tool calls by name, most used first. */
  toolCalls: Array<{ tool: string; calls: number }>;
  /** Calls of tools beyond the listed names. */
  otherTools?: { names: number; calls: number };
  /** Files an engine reported editing, deleting or moving, when it reported any. */
  files?: string[];
  filesTotal?: number;
  pullRequests?: DigestPullRequest[];
  pullRequestsTotal?: number;
  delegatedChildren?: DigestDelegatedChild[];
  delegatedChildrenTotal?: number;
}

/**
 * How a turn ended, from its last recorded terminal event: the same reading
 * the lifecycle fold takes (a `turn.aborted`, or a `turn.completed` that
 * finished `cancelled`, is a stop; a `runtime.error` is a failure).
 */
export function digestTurnOutcome(
  terminal: TurnDigestFacts['terminal'],
): DigestTurnOutcome {
  if (!terminal) return 'open';
  if (terminal.method === 'runtime.error') return 'failed';
  if (terminal.method === 'turn.aborted') return 'interrupted';
  return terminal.finishReason === 'cancelled' ? 'interrupted' : 'completed';
}

function firstLine(prompt: string): { line: string; clipped: boolean } {
  const lines = prompt.split(/\r?\n/u);
  const index = lines.findIndex((candidate) => candidate.trim().length > 0);
  const trimmed = index < 0 ? '' : lines[index]!.trim();
  const line = clipSerialized(trimmed, REQUEST_MAX_BYTES);
  // The line itself was cut, or it runs to the end of a prompt prefix the
  // store had to cut: more of that line exists than is shown.
  const prefixCut =
    index === lines.length - 1 &&
    Array.from(prompt).length >= TURN_DIGEST_PROMPT_PREFIX_CHARS;
  return { line, clipped: line.length < trimmed.length || prefixCut };
}

function pullRequestOf(descriptor: unknown): DigestPullRequest | undefined {
  if (!descriptor || typeof descriptor !== 'object') return undefined;
  const value = descriptor as {
    kind?: unknown;
    host?: unknown;
    ref?: unknown;
    repository?: { owner?: unknown; name?: unknown };
  };
  if (
    value.kind !== 'pull-request' ||
    typeof value.host !== 'string' ||
    typeof value.ref !== 'string' ||
    typeof value.repository?.owner !== 'string' ||
    typeof value.repository.name !== 'string'
  )
    return undefined;
  return {
    host: value.host,
    repository: `${value.repository.owner}/${value.repository.name}`,
    ref: value.ref,
  };
}

/** One turn's digest, every field bounded. */
export function digestTurn(
  facts: TurnDigestFacts,
  children: readonly DigestDelegatedChild[],
): DigestTurn {
  const request =
    facts.promptPrefix !== undefined
      ? firstLine(facts.promptPrefix)
      : undefined;
  const listedTools = facts.toolCalls.slice(0, TOOLS_PER_TURN);
  const otherTools = facts.toolCalls.slice(TOOLS_PER_TURN);
  const pullRequests = facts.declaredPullRequests
    .map(pullRequestOf)
    .filter((entry): entry is DigestPullRequest => entry !== undefined);
  const turn: DigestTurn = {
    turnId: facts.turnId,
    startedAt: facts.startedAt,
    ...(request && request.line.length > 0 ? { request: request.line } : {}),
    // A prompt longer than the prefix the store read is clipped too.
    ...(request?.clipped ? { requestClipped: true as const } : {}),
    ...(facts.providerTriggered ? { providerTriggered: true as const } : {}),
    outcome: digestTurnOutcome(facts.terminal),
    toolCalls: listedTools.map((entry) => ({
      tool: clipSerialized(entry.toolName, TOOL_NAME_MAX_BYTES),
      calls: entry.calls,
    })),
  };
  if (otherTools.length > 0)
    turn.otherTools = {
      names: otherTools.length,
      calls: otherTools.reduce((sum, entry) => sum + entry.calls, 0),
    };
  if (facts.filesTotal > 0) {
    turn.files = facts.files
      .slice(0, FILES_PER_TURN)
      .map((path) => clipSerialized(path, FILE_PATH_MAX_BYTES));
    turn.filesTotal = facts.filesTotal;
  }
  if (pullRequests.length > 0) {
    turn.pullRequests = pullRequests.slice(0, PULL_REQUESTS_PER_TURN);
    turn.pullRequestsTotal = pullRequests.length;
  }
  if (children.length > 0) {
    turn.delegatedChildren = children
      .slice(0, CHILDREN_PER_TURN)
      .map((child) => ({
        sessionId: child.sessionId,
        ...(child.title !== undefined
          ? { title: clipSerialized(child.title, CHILD_TITLE_MAX_BYTES) }
          : {}),
      }));
    turn.delegatedChildrenTotal = children.length;
  }
  return turn;
}

/**
 * The longest prefix of `turns` (newest first) whose serialized form fits
 * {@link SESSION_DIGEST_PAGE_MAX_BYTES}. At least one turn is always taken
 * while any remain, which is why every turn field is bounded; a first turn
 * that still does not fit is an error, never a truncated answer.
 */
export function fitDigestPage(turns: readonly DigestTurn[]): {
  turns: DigestTurn[];
  bytes: number;
} {
  const page: DigestTurn[] = [];
  let bytes = 2;
  for (const turn of turns) {
    const size = serializedBytes(turn) + 1;
    if (bytes + size > SESSION_DIGEST_PAGE_MAX_BYTES) {
      if (page.length > 0) break;
      throw new Error('A digest turn exceeds the page byte cap.');
    }
    page.push(turn);
    bytes += size;
  }
  return { turns: page, bytes };
}

interface DigestCursor {
  conversationId: string;
  /** The `startSequence` of the oldest turn already returned. */
  before: number;
}

export function encodeDigestCursor(cursor: DigestCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, c: cursor.conversationId, b: cursor.before }),
    'utf8',
  ).toString('base64url');
}

export function decodeDigestCursor(value: string): DigestCursor | undefined {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      parsed?.v !== 1 ||
      typeof parsed.c !== 'string' ||
      !Number.isSafeInteger(parsed.b) ||
      parsed.b < 1
    )
      return undefined;
    return { conversationId: parsed.c, before: parsed.b };
  } catch {
    return undefined;
  }
}
