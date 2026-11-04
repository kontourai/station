/**
 * `terminal_run` and `terminal_read` (#3994): run a command in a terminal the
 * person can watch, and read what it printed. Every run asks the person:
 * they see the exact command and directory in the chat and approve or
 * decline that one run. Loaded by the stdio station-control child too, so it
 * speaks REST (`api`); the route decides everything from the verified caller.
 */
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const TERMINAL_RUNS_PATH = '/api/orchestration/station-control/terminal-runs';

export function registerTerminalTools(registry: StationControlToolRegistry) {
  registry.tool(
    'terminal_run',
    "Ask to run a shell command in a terminal in this chat's working directory. The person sees the exact command and directory and approves or declines this one run; nothing is remembered, so every run asks again. Returns a runId at once: follow it with terminal_read.",
    {
      command: z
        .string()
        .min(1)
        .describe('The exact command line, run by the platform shell.'),
      subdirectory: z
        .string()
        .min(1)
        .optional()
        .describe("A relative directory inside this chat's working directory."),
    },
    async (args) =>
      jsonToolResult(
        await api(TERMINAL_RUNS_PATH, {
          method: 'POST',
          body: JSON.stringify(args),
        }),
      ),
    { replay: 'unsafe' },
  );

  registry.tool(
    'terminal_read',
    'Read a terminal_run request: its state (needs_approval, declined, expired, running, exited, failed), exit code and output. Output is paged: pass the returned nextSeq as fromSeq to read on. waitSeconds (up to 50) waits for the state to change first.',
    {
      runId: z.string().min(1).describe('The runId terminal_run returned.'),
      fromSeq: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Read output after this sequence; omit for the start.'),
      waitSeconds: z.number().int().min(0).max(50).optional(),
    },
    async ({ runId, fromSeq, waitSeconds }) => {
      const query = new URLSearchParams();
      if (fromSeq !== undefined) query.set('fromSeq', String(fromSeq));
      if (waitSeconds !== undefined)
        query.set('waitSeconds', String(waitSeconds));
      const suffix = query.size ? `?${query}` : '';
      return jsonToolResult(
        await api(
          `${TERMINAL_RUNS_PATH}/${encodeURIComponent(runId)}${suffix}`,
        ),
      );
    },
  );
}
