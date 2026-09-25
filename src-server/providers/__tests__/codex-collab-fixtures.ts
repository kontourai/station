/**
 * #2458: live captures of codex-cli 0.155.1's `app-server` JSON-RPC stream
 * while a session spawns subagents, one JSON object per line:
 * `{ t, dir: 'client->server' | 'server->client', msg }`, every message in
 * both directions, in order.
 *
 * SCRUBBED, not byte-identical: thread/turn/item ids are rewritten to
 * `00000000-0000-7000-8000-00000000000N` / `call_000N` / `msg_000N`, paths to
 * `/workspace/repo` and `/home/user/.codex`, and the user agent to
 * `collab-capture/0.155.1 (scrubbed)`, and command-execution OS pids
 * (`processId`) to the placeholder `"10000"`. The capture driver's own non-protocol
 * timeout note was dropped from the end of the v1 client-interrupt file
 * (the parent hung there; the file simply stops). v1/v2 is the subagent
 * item format the model's hidden per-model setting chose: v1 is
 * `collabAgentToolCall` (gpt-5.5), v2 is `subAgentActivity` (gpt-6-luna).
 *
 * Every file is read by a LITERAL module-anchored URL (the path-read pin
 * boundary cannot see a read through a helper parameter).
 *
 * #2486 added two more: `codex-0.155.1-collab-v1-client-interrupt-
 * unblocks-parent.jsonl` (a client child interrupt followed by a client
 * PARENT interrupt, which unblocks it in ~4ms) and `codex-0.155.1-collab-
 * v1-parent-stop-cascades-children.jsonl` (two children interrupted before
 * the parent).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  CodexAdapterTransport,
  createCodexSessionRecord,
} from '../adapters/codex-adapter-transport.js';
import type {
  CodexProcessLike,
  CodexSessionRecord,
} from '../adapters/codex-adapter-types.js';

const lines = (text: string): readonly string[] =>
  text.split('\n').filter((line) => line.length > 0);

/** v1: spawnAgent, wait, the child completes and replies "done". */
export const CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED = lines(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/codex-0.155.1-collab-v1-spawn-wait-completed.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

/** v2: subAgentActivity started, wait, the child completes and replies "done". */
export const CODEX_COLLAB_V2_SPAWN_WAIT_COMPLETED = lines(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/codex-0.155.1-collab-v2-spawn-wait-completed.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

/**
 * v1: the CLIENT sends `turn/interrupt {threadId: child, turnId}`; the
 * child's own `turn/completed` says `interrupted`, and the parent, never
 * told, re-waits until the capture gave up.
 */
export const CODEX_COLLAB_V1_CLIENT_TURN_INTERRUPT = lines(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/codex-0.155.1-collab-v1-client-turn-interrupt.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

/** v2: the same client interrupt; the parent's waits time out and it ends. */
export const CODEX_COLLAB_V2_CLIENT_TURN_INTERRUPT = lines(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/codex-0.155.1-collab-v2-client-turn-interrupt.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

/** v2: the MODEL interrupts its child (`subAgentActivity` kind `interrupted`). */
export const CODEX_COLLAB_V2_MODEL_INTERRUPT_AGENT = lines(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/codex-0.155.1-collab-v2-model-interrupt-agent.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

/**
 * v1: the MODEL closes its child. The child's `turn/completed` says
 * `interrupted` first; the `closeAgent` result then ECHOES its previous
 * status, `running`.
 */
export const CODEX_COLLAB_V1_MODEL_CLOSE_AGENT = lines(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/codex-0.155.1-collab-v1-model-close-agent.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

/** v2: `spawn_agent` rejected (unknown model): no subagent item on the wire. */
export const CODEX_COLLAB_V2_SPAWN_REJECTED = lines(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/codex-0.155.1-collab-v2-spawn-rejected-no-wire-item.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

/**
 * #2486: one child, running a real command. Captures the CLIENT interrupting
 * the child, then ALSO interrupting the PARENT's own active turn right
 * after — the mechanism research proved unblocks it. The parent's own
 * `turn/completed{interrupted}` arrives ~4ms after the parent interrupt
 * request, instead of the 100s+ (or never, within the capture window) the
 * "wait" collabAgentToolCall takes to notice on its own (see
 * `CODEX_COLLAB_V1_CLIENT_TURN_INTERRUPT` above).
 */
export const CODEX_COLLAB_V1_CLIENT_INTERRUPT_UNBLOCKS_PARENT = lines(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/codex-0.155.1-collab-v1-client-interrupt-unblocks-parent.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

/**
 * #2486: two children running concurrently. Captures the CLIENT interrupting
 * both children FIRST, then the parent — both children's own
 * `turn/completed{interrupted}` land before the parent's own does, ~19ms
 * after the parent interrupt request.
 */
export const CODEX_COLLAB_V1_PARENT_STOP_CASCADES_CHILDREN = lines(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/codex-0.155.1-collab-v1-parent-stop-cascades-children.jsonl',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);

export const CODEX_COLLAB_STATION_THREAD = 'thread-codex';

interface CaptureLine {
  dir: string;
  msg: Record<string, unknown>;
}

function parse(line: string): CaptureLine {
  return JSON.parse(line) as CaptureLine;
}

/** The parent thread id and turn id, as the capture's own responses name them. */
export function codexCaptureIds(capture: readonly string[]): {
  parentThreadId: string;
  parentTurnId: string;
} {
  let parentThreadId: string | undefined;
  let parentTurnId: string | undefined;
  for (const line of capture) {
    const { dir, msg } = parse(line);
    if (dir !== 'server->client' || !msg.result) continue;
    const result = msg.result as Record<string, { id?: string } | undefined>;
    if (!parentThreadId && result.thread?.id) parentThreadId = result.thread.id;
    if (!parentTurnId && result.turn?.id) parentTurnId = result.turn.id;
  }
  if (!parentThreadId || !parentTurnId) {
    throw new Error('capture names no parent thread/turn');
  }
  return { parentThreadId, parentTurnId };
}

/**
 * #2486: every server->client message in `capture`, up to (not including)
 * the first `client->server turn/interrupt` line. Past that point the
 * ORIGINAL capture driver's own interrupt requests (and the request ids
 * they used) stop being something a different adapter instance under test
 * would ever generate itself — a test replays this PREFIX through the real
 * adapter to reach "the child is running", then drives its own stop/
 * interrupt calls and asserts what the adapter itself sends.
 */
export function codexCaptureServerMessagesBeforeClientInterrupt(
  capture: readonly string[],
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const line of capture) {
    const { dir, msg } = parse(line);
    if (dir === 'client->server' && msg.method === 'turn/interrupt') break;
    if (dir === 'server->client') messages.push(msg);
  }
  return messages;
}

/** A process double that does nothing; replays feed lines directly. */
export class InertCodexProcess implements CodexProcessLike {
  readonly stdin = { write: () => true } as unknown as NodeJS.WritableStream;
  readonly stdout = {} as NodeJS.ReadableStream;
  readonly stderr = {} as NodeJS.ReadableStream;
  readonly exitCode = null;
  readonly signalCode = null;
  kill(): boolean {
    return true;
  }
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
}

export interface CodexCaptureReplay {
  events: CanonicalRuntimeEvent[];
  record: CodexSessionRecord;
  transport: CodexAdapterTransport;
  /** Ends the session through the transport's own stop door. */
  stop: () => Promise<void>;
}

/**
 * Feeds every server→client line of a capture through
 * `CodexAdapterTransport.handleStdoutLine` — the transport's own routing,
 * where a child thread's notifications are told apart from the session's —
 * for a session whose codex thread is the capture's parent thread, with its
 * turn active. `limit` stops after that many capture lines.
 */
export function replayCodexCapture(
  capture: readonly string[],
  options: { limit?: number } = {},
): CodexCaptureReplay {
  const nowIso = () => '2026-09-23T00:00:00.000Z';
  const transport = new CodexAdapterTransport(
    () => new Date('2026-09-23T00:00:00.000Z'),
    async () => {},
  );
  const events: CanonicalRuntimeEvent[] = [];
  transport.publish = (event) => {
    events.push(event);
  };
  const record = createCodexSessionRecord({
    externalThreadId: CODEX_COLLAB_STATION_THREAD,
    process: new InertCodexProcess(),
    provider: 'codex',
    threadId: CODEX_COLLAB_STATION_THREAD,
    model: 'gpt-5.5',
    nowIso,
  });
  transport.registerSession(record);
  const { parentThreadId, parentTurnId } = codexCaptureIds(capture);
  transport.setCodexThreadId(record, parentThreadId);
  record.activeTurnId = parentTurnId;
  for (const line of capture.slice(0, options.limit ?? capture.length)) {
    const { dir, msg } = parse(line);
    if (dir !== 'server->client') continue;
    transport.handleStdoutLine(record, JSON.stringify(msg));
  }
  return {
    events,
    record,
    transport,
    stop: () => transport.stopSession(CODEX_COLLAB_STATION_THREAD, nowIso),
  };
}
