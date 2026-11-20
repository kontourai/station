import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Real `initialize` and `session/list` frames captured from the ACP agents
 * installed on a development Mac (2026-11-15): Antigravity 1.5.8, Factory
 * Droid 0.190.0, Hermes 0.17.0, Cursor Agent 2026.05.01 (signed out) and
 * Kiro CLI 3.3.0 (no `session/list`). Each frame is as the agent wrote it,
 * except that session ids, folders, titles and times are replaced with
 * synthetic values of the same format: the repository is public.
 */
export interface CapturedFrame {
  capture: string;
  dir: 'C->E' | 'E->C';
  msg: {
    id?: number;
    method?: string;
    result?: Record<string, any>;
    error?: { code: number; message: string; data?: unknown };
  };
}

const FRAMES: CapturedFrame[] = readFileSync(
  join(import.meta.dirname, 'fixtures', 'acp-session-list-frames.jsonl'),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as CapturedFrame);

export type CapturedAgent =
  | 'antigravity-1.5.8'
  | 'factory-droid-0.190.0'
  | 'hermes-agent-0.17.0'
  | 'cursor-agent-2026.05.01'
  | 'kiro-cli-3.3.0';

/** The agent's `initialize` result and its `session/list` answer, if it sent one. */
export function capturedAgent(agent: CapturedAgent): {
  initialize: Record<string, any>;
  list?: CapturedFrame['msg'];
} {
  const frames = FRAMES.filter(
    (frame) => frame.capture === `${agent}-session-list`,
  );
  const answers = frames.filter((frame) => frame.dir === 'E->C');
  const initialize = answers[0]?.msg.result;
  if (!initialize) throw new Error(`no initialize frame for ${agent}`);
  return { initialize, list: answers[1]?.msg };
}

/** A `session/list` answer as the SDK connection delivers it: result, or a thrown error. */
export async function answerFromFrame(
  frame: CapturedFrame['msg'] | undefined,
): Promise<unknown> {
  if (!frame) throw new Error('method not found');
  if (frame.error) {
    throw Object.assign(new Error(frame.error.message), frame.error);
  }
  return frame.result;
}
