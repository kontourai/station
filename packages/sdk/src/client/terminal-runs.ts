/**
 * Commands an agent asked to run in a terminal (#3994, `terminal_run`) and
 * the person's answer to each. Every run is approved or declined on its own;
 * approving one never approves the next.
 */
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { unwrapProjectResponse as unwrapOrThrow } from './project-response';

export type TerminalRunState =
  | 'needs_approval'
  | 'declined'
  | 'expired'
  | 'starting'
  | 'running'
  | 'exited'
  | 'failed';

export interface TerminalRun {
  runId: string;
  state: TerminalRunState;
  /** Exactly what runs. */
  command: string;
  /** The absolute directory it runs in. */
  cwd: string;
  conversationId: string;
  projectSlug: string;
  /** The terminal session binding it runs in (`thread:<session id>`). */
  bindingKey: string;
  createdAt: string;
  /** An unanswered request expires then. */
  expiresAt: string;
  terminalId?: string;
  exitCode?: number | null;
  signal?: number;
  failure?: string;
}

/**
 * `GET /api/terminal/runs?conversationId=` — the conversation's runs that
 * wait for an answer or are still starting or running. Empty when this
 * Station has no terminal runs (404).
 */
export async function listConversationTerminalRuns(
  apiBase: string,
  conversationId: string,
  opts?: ClientRequestOptions,
): Promise<TerminalRun[]> {
  const response = await getJson(
    `${apiBase}/api/terminal/runs?conversationId=${encodeURIComponent(conversationId)}`,
    opts,
  );
  if (response.status === 404) return [];
  return (
    await unwrapOrThrow<{ runs: TerminalRun[] }>(
      response,
      'Failed to list terminal runs',
    )
  ).runs;
}

/** `POST /api/terminal/runs/:runId/approve` — runs this one command once. */
export async function approveTerminalRun(
  apiBase: string,
  runId: string,
  opts?: ClientRequestOptions,
): Promise<TerminalRun> {
  return unwrapOrThrow<TerminalRun>(
    await mutateJson(
      `${apiBase}/api/terminal/runs/${encodeURIComponent(runId)}/approve`,
      'POST',
      opts,
    ),
    'Failed to approve the command',
  );
}

/** `POST /api/terminal/runs/:runId/decline` — the command never runs. */
export async function declineTerminalRun(
  apiBase: string,
  runId: string,
  opts?: ClientRequestOptions,
): Promise<TerminalRun> {
  return unwrapOrThrow<TerminalRun>(
    await mutateJson(
      `${apiBase}/api/terminal/runs/${encodeURIComponent(runId)}/decline`,
      'POST',
      opts,
    ),
    'Failed to decline the command',
  );
}
