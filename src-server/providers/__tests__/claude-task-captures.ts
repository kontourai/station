/**
 * #2457: every committed live capture of Claude Code task frames, in one
 * place, for the suites that replay them (the adapter child-work suite, the
 * conformance tripwire, the child-work projection and service suites).
 *
 * Suites import this module rather than reading the captures by path, for
 * the reason `claude-provider-turns-fixtures.ts` gives: the path-read pin
 * scanner never pins `fixtures/`, so an import edge is what keeps them
 * scheduled.
 *
 * Two line formats are committed:
 * - `claude-task-subagents.jsonl` (claude 2.1.261, #2456): one SDK message
 *   per line;
 * - `claude-2.1.281-*.jsonl`: `{t, msg}` for an SDK message and `{t, probe}`
 *   for what the capturing host did (`STOP_TASK <id>`, `CLOSE INPUT`,
 *   `QUERY CLOSE`, `ITERATOR END`, `CAN_USE_TOOL {...}`).
 * Recorded by `fixtures/capture-claude-task-fixtures.mjs`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  markClaudeChildStopRequested,
  settleOpenClaudeChildren,
} from '../adapters/claude-adapter-child-work.js';
import {
  type ClaudeMessageState,
  mapClaudeSdkMessage,
} from '../adapters/claude-adapter-events.js';
import { recordClaudeTurnDispatched } from '../adapters/claude-sdk-turns.js';

const CLAUDE_TASK_CAPTURE_FILES = {
  /** A foreground and a backgrounded Task subagent (2.1.261). */
  'task-subagents': 'claude-task-subagents.jsonl',
  /** A backgrounded agent that runs a subagent-owned Bash call (2.1.281). */
  'background-agent': 'claude-2.1.281-background-agent.jsonl',
  /** `Query.stopTask` on a running background agent (2.1.281). */
  'stop-task': 'claude-2.1.281-stop-task.jsonl',
  /** Input closed, then the query closed, with an agent running (2.1.281). */
  'close-kills': 'claude-2.1.281-close-kills.jsonl',
  /** `agentProgressSummaries` over four subagent Bash calls (2.1.281). */
  'progress-summary': 'claude-2.1.281-progress-summary.jsonl',
  /** `canUseTool` for a subagent's Bash call (2.1.281). */
  'subagent-permission': 'claude-2.1.281-subagent-permission.jsonl',
  /** An agent spawning an agent, which is then resumed (2.1.281). */
  'nested-agent': 'claude-2.1.281-nested-agent.jsonl',
} as const;

export type ClaudeTaskCaptureName = keyof typeof CLAUDE_TASK_CAPTURE_FILES;

export const CLAUDE_TASK_CAPTURES = Object.keys(
  CLAUDE_TASK_CAPTURE_FILES,
) as ClaudeTaskCaptureName[];

/** One capture line: an SDK message, or what the capturing host did. */
export type ClaudeTaskCaptureLine =
  | { message: SDKMessage; probe?: undefined }
  | { probe: string; message?: undefined };

export function loadClaudeTaskCapture(
  name: ClaudeTaskCaptureName,
): ClaudeTaskCaptureLine[] {
  return readFileSync(
    fileURLToPath(
      new URL(`./fixtures/${CLAUDE_TASK_CAPTURE_FILES[name]}`, import.meta.url),
    ),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.probe === 'string') return { probe: parsed.probe };
      return {
        message: ('msg' in parsed ? parsed.msg : parsed) as SDKMessage,
      };
    });
}

/**
 * Replays a capture through the adapter's own mapper, as the live adapter
 * feeds it: turn-1 dispatched first (#2324 turn identity), a `STOP_TASK`
 * probe recorded as the stop request `stopProviderTask` records, and the
 * session end (`ITERATOR END`, or the end of a capture without probes)
 * settled as `consumeMessages`' `finally` settles it.
 */
export function replayClaudeTaskCapture(
  name: ClaudeTaskCaptureName,
  options: {
    threadId?: string;
    /** Probes to act on in addition to the capture's own (by line index). */
    extraProbes?: Record<number, string>;
  } = {},
): { events: CanonicalRuntimeEvent[]; record: ClaudeMessageState } {
  const threadId = options.threadId ?? 'thread-claude';
  const events: CanonicalRuntimeEvent[] = [];
  const publish = (event: CanonicalRuntimeEvent) => events.push(event);
  const record: ClaudeMessageState = {
    session: {
      provider: 'claude',
      threadId,
      status: 'running',
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    },
    lastSessionState: 'running',
  };
  recordClaudeTurnDispatched(record, 'turn-1');
  const endSession = () =>
    settleOpenClaudeChildren({
      provider: 'claude',
      record,
      publish,
      createdAt: '2026-09-23T01:00:00.000Z',
    });
  const act = (probe: string) => {
    if (probe.startsWith('STOP_TASK ')) {
      const taskId = probe.slice('STOP_TASK '.length);
      if (!taskId.startsWith('RESOLVED') && !taskId.startsWith('REJECTED')) {
        markClaudeChildStopRequested(record, taskId);
      }
    }
    if (probe === 'ITERATOR END') endSession();
  };
  loadClaudeTaskCapture(name).forEach((line, index) => {
    const extra = options.extraProbes?.[index];
    if (extra) act(extra);
    if (line.probe !== undefined) {
      act(line.probe);
      return;
    }
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      message: line.message,
      publish,
    });
  });
  endSession();
  return { events, record };
}
