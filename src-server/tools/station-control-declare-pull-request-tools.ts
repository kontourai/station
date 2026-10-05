/**
 * `declare_pull_request` (#3161, epic #3167): an agent on ANY engine tells
 * Station "this session's turn produced this pull request".
 *
 * Station's own engine declares an output with its native `declare_output`
 * tool. Claude Code, Codex and ACP agents have no such call, so their pull
 * requests never reached the Task. This tool writes the same declared-output
 * record that native call writes, for the verified caller's own session and
 * the turn it is running now. The declaration lands when that turn completes
 * and is dropped if the turn aborts; a person then keeps it onto a Task.
 *
 * Authority never comes from arguments: the REST side
 * (`routes/orchestration/declare-pull-request.ts`) derives the session from
 * the verified caller. The arguments are the pull request's identity, in the
 * exact shape the conversation link routes accept.
 *
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import { z } from 'zod';

import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

/** Where Station serves the tool's REST side. */
const DECLARE_PULL_REQUEST_API_PATH =
  '/api/orchestration/station-control/declare-pull-request';

const DECLARE_PULL_REQUEST_DESCRIPTION =
  'Declare a pull request this session opened or updated, so Station shows it with the Task\'s work. Call it once for each pull request you open, after the pull request exists. Give the exact forge identity: `provider` ("github" or "gitlab"), `host` (e.g. "github.com"), `repository` {owner, name} and `ref` (the pull request number, as a string). The pull request must be in this session\'s own repository, or the call fails. Returns `declared` (it is held for the rest of this turn, however long that runs, and recorded when the turn completes; a turn that is aborted, interrupted or ends in an error records nothing, and a Station restart before the turn completes drops it, so declare again in a later turn), `already-declared` (nothing to do), or `no-active-turn` (this session is not running a turn). It does not link, keep or close anything: a person keeps a declared pull request onto a Task.';

const declarePullRequestShape = {
  provider: z.string().min(1).max(255).describe('"github" or "gitlab".'),
  host: z
    .string()
    .min(1)
    .max(255)
    .describe('The forge host, e.g. "github.com".'),
  repository: z
    .object({
      owner: z.string().min(1).max(255),
      name: z.string().min(1).max(255),
    })
    .strict()
    .describe('The repository the pull request is in.'),
  ref: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(32)
    .describe('The pull request number, as a string (no leading zeros).'),
  label: z
    .string()
    .min(1)
    .max(240)
    .optional()
    .describe('A short human label shown beside the pull request.'),
};

async function declarePullRequest(args: {
  provider: string;
  host: string;
  repository: { owner: string; name: string };
  ref: string;
  label?: string;
}): Promise<unknown> {
  // `api` forwards this call's caller credential; the route re-verifies it.
  return api(DECLARE_PULL_REQUEST_API_PATH, {
    method: 'POST',
    body: JSON.stringify(args),
  });
}

export function registerDeclarePullRequestTools(
  registry: StationControlToolRegistry,
) {
  registry.tool(
    'declare_pull_request',
    DECLARE_PULL_REQUEST_DESCRIPTION,
    declarePullRequestShape,
    async (args) => jsonToolResult(await declarePullRequest(args)),
  );
}
