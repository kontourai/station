/**
 * The REST side of `terminal_run` and `terminal_read` (#3994), and the
 * person's approval of each run in the chat.
 *
 * Agent leaves (`/station-control/terminal-runs`, under `/api/orchestration`):
 * only Station's own station-control tool code calls them, so a request the
 * runtime boundary did not accept as Station's internal principal gets a 404.
 * A run is always the VERIFIED caller's own: its conversation, its thread
 * binding and its session's Project, never a body's choice.
 *
 * Person leaves (`/api/terminal/runs`): the operator (in person or on one of
 * their own devices) with terminal authority, who may send to the
 * conversation. Each approval runs one command once; there is no remembered
 * approval, so the next request asks again.
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import {
  TERMINAL_RUN_MAX_COMMAND_CHARS,
  TERMINAL_RUN_MAX_PENDING_PER_CONVERSATION,
  type TerminalRun,
  type TerminalRunRequests,
} from '../../services/terminal/terminal-runs.js';
import { TerminalSessionRefusal } from '../../services/terminal/terminal-sessions.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import type { AgentSchedulePerson } from './agent-schedule.js';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 16 * 1024;
/** One page of output an agent reads; it asks again from `nextSeq`. */
export const TERMINAL_RUN_OUTPUT_PAGE_BYTES = 256 * 1024;
const MAX_WAIT_SECONDS = 50;

const requestSchema = z
  .object({
    command: z.string().min(1).max(TERMINAL_RUN_MAX_COMMAND_CHARS),
    subdirectory: z.string().min(1).max(4096).optional(),
  })
  .strict();

export interface TerminalRunOutput {
  /** Output after the requested sequence, at most one page. */
  output: string;
  /** Read again from here for more. */
  nextSeq: number;
  lastSeq: number;
  /** Retention dropped output before the requested sequence. */
  reset: boolean;
  /** The command's output passed its cap and it was ended. */
  outputCapped: boolean;
}

/** What the agent and the person see of a run. */
export function publicTerminalRun(run: TerminalRun) {
  return {
    runId: run.id,
    state: run.state,
    command: run.command,
    cwd: run.cwd,
    conversationId: run.conversationId,
    projectSlug: run.projectSlug,
    bindingKey: `thread:${run.sessionId}`,
    createdAt: new Date(run.createdAt).toISOString(),
    expiresAt: new Date(run.expiresAt).toISOString(),
    ...(run.terminalId ? { terminalId: run.terminalId } : {}),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.signal !== undefined && run.signal !== null
      ? { signal: run.signal }
      : {}),
    ...(run.failure ? { failure: run.failure } : {}),
  };
}

const STATE_COPY: Partial<Record<TerminalRun['state'], string>> = {
  needs_approval:
    'Waiting for the person to approve this command in the chat. Call terminal_read with waitSeconds to follow it.',
  declined: 'The person declined this command. It did not run.',
  expired: 'Nobody approved this command in time. It did not run.',
  starting: 'Approved; starting.',
  running: 'Running. Call terminal_read again for more output.',
};

async function readJson(request: Request): Promise<unknown> {
  const read = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (read.status !== 'ok') return undefined;
  try {
    return JSON.parse(read.body);
  } catch {
    return undefined;
  }
}

export interface AgentTerminalRunRoutesDeps {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** Absent: this Station has no terminal sessions (hosted). */
  runs: TerminalRunRequests | undefined;
  /** The caller session's recorded Project. */
  project(projectId: string): { id: string; slug: string } | undefined;
  /**
   * The absolute directory a command in the session's thread binding runs
   * in, with the agent's relative `subdirectory`, read as the session's
   * recorded owner; throws to refuse.
   */
  runDirectory(input: {
    projectId: string;
    sessionId: string;
    ownerId: string;
    subdirectory?: string;
  }): Promise<string>;
  /** One page of a started run's output, after `fromSeq`. */
  output(run: TerminalRun, fromSeq: number): Promise<TerminalRunOutput>;
}

export function createAgentTerminalRunRoutes(deps: AgentTerminalRunRoutesDeps) {
  const app = new Hono();
  const callerOf = (c: Context) => {
    if (!deps.isInternalRequest(c.req.raw))
      return {
        refused: c.json({ error: { code: 'not_found' } }, 404, NO_STORE),
      } as const;
    const authority = stationControlRequestAuthority(c.req.raw);
    if (authority?.kind !== 'caller')
      return {
        refused: c.json(
          stationControlRefusalBody(
            stationControlRefusal('station_control_caller_required'),
          ),
          403,
          NO_STORE,
        ),
      } as const;
    const { caller } = authority;
    return {
      conversationId: caller.conversationId ?? caller.sessionId,
      sessionId: caller.sessionId,
      caller,
    } as const;
  };
  const unavailable = (c: Context) =>
    c.json(
      {
        success: false,
        code: 'terminal_run_unavailable',
        error: "Terminal runs aren't available on this Station.",
      },
      503,
      NO_STORE,
    );

  app.post('/', async (c) => {
    const caller = callerOf(c);
    if ('refused' in caller) return caller.refused;
    if (!deps.runs) return unavailable(c);
    const parsed = requestSchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success)
      return c.json(
        {
          success: false,
          code: 'terminal_run_invalid',
          error: `terminal_run needs a command of at most ${TERMINAL_RUN_MAX_COMMAND_CHARS} characters and, optionally, a relative subdirectory.`,
        },
        400,
        NO_STORE,
      );
    const project =
      caller.caller.projectIdSource === 'session-record' &&
      caller.caller.localProjectId
        ? deps.project(caller.caller.localProjectId)
        : undefined;
    if (!project)
      return c.json(
        {
          success: false,
          code: 'terminal_run_needs_project',
          error: 'Terminal runs need a chat in a Project.',
        },
        409,
        NO_STORE,
      );
    const ownerId = caller.caller.principal?.id;
    if (!ownerId)
      return c.json(
        {
          success: false,
          code: 'terminal_run_owner_required',
          error: 'Terminal runs need a chat with a recorded owner.',
        },
        409,
        NO_STORE,
      );
    let cwd: string;
    try {
      cwd = await deps.runDirectory({
        projectId: project.id,
        sessionId: caller.sessionId,
        ownerId,
        ...(parsed.data.subdirectory
          ? { subdirectory: parsed.data.subdirectory }
          : {}),
      });
    } catch {
      return c.json(
        {
          success: false,
          code: 'terminal_run_directory_refused',
          error:
            "That directory isn't inside this chat's working directory, or doesn't exist.",
        },
        403,
        NO_STORE,
      );
    }
    const result = deps.runs.request({
      conversationId: caller.conversationId,
      sessionId: caller.sessionId,
      projectId: project.id,
      projectSlug: project.slug,
      command: parsed.data.command,
      cwd,
      ...(parsed.data.subdirectory
        ? { subdirectory: parsed.data.subdirectory }
        : {}),
    });
    if (result.outcome === 'limit-reached')
      return c.json(
        {
          success: false,
          code: 'terminal_run_limit_reached',
          error: `This chat already has ${TERMINAL_RUN_MAX_PENDING_PER_CONVERSATION} commands waiting for approval. Wait for the person to answer one.`,
        },
        409,
        NO_STORE,
      );
    return c.json(
      {
        success: true,
        data: publicTerminalRun(result.run),
        message: STATE_COPY.needs_approval,
      },
      200,
      NO_STORE,
    );
  });

  app.get('/:runId', async (c) => {
    const caller = callerOf(c);
    if ('refused' in caller) return caller.refused;
    if (!deps.runs) return unavailable(c);
    const query = z
      .object({
        waitSeconds: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS),
        fromSeq: z.coerce.number().int().nonnegative().safe(),
      })
      .partial()
      .safeParse(c.req.query());
    if (!query.success)
      return c.json(
        {
          success: false,
          code: 'terminal_run_invalid',
          error: `waitSeconds is 0 to ${MAX_WAIT_SECONDS}; fromSeq is a sequence terminal_read returned.`,
        },
        400,
        NO_STORE,
      );
    const runId = c.req.param('runId');
    const own = () => {
      const run = deps.runs!.get(runId);
      // Another conversation's run reads exactly like one that does not exist.
      return run && run.conversationId === caller.conversationId
        ? run
        : undefined;
    };
    if (!own())
      return c.json(
        {
          success: false,
          code: 'terminal_run_not_found',
          error: 'No such terminal run in this chat.',
        },
        404,
        NO_STORE,
      );
    if (query.data.waitSeconds)
      await deps.runs.waitForChange(runId, query.data.waitSeconds * 1000);
    const run = own()!;
    const output = run.terminalId
      ? await deps.output(run, query.data.fromSeq ?? 0).catch(() => undefined)
      : undefined;
    return c.json(
      {
        success: true,
        data: {
          ...publicTerminalRun(run),
          ...(output ?? {}),
        },
        ...(STATE_COPY[run.state] ? { message: STATE_COPY[run.state] } : {}),
      },
      200,
      NO_STORE,
    );
  });

  return app;
}

export interface TerminalRunRoutesDeps {
  runs: TerminalRunRequests;
  /** The operator with this terminal authority; agents never pass. */
  authorizeRequest(request: Request, operation: 'observe' | 'operate'): boolean;
  /** The person making a UI request, or undefined when it is not current. */
  person(c: Context): AgentSchedulePerson | undefined;
  /** Starts the approved command as the person, in its thread binding. */
  start(
    request: Request,
    run: TerminalRun,
  ): Promise<{
    terminalId: string;
    exited: Promise<{ exitCode: number | null; signal: number | null }>;
  }>;
}

/** The person's view and answers, mounted at `/api/terminal/runs`. */
export function createTerminalRunRoutes(deps: TerminalRunRoutesDeps) {
  const app = new Hono();
  const refused = (c: Context) =>
    c.json({ success: false, error: 'Terminal access refused' }, 403, NO_STORE);
  const notFound = (c: Context) =>
    c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
  /** The person's run, or the response refusing it. */
  const personRun = (c: Context) => {
    if (
      requestMayBeAnAgent(c.req.raw) ||
      !deps.authorizeRequest(c.req.raw, 'operate')
    )
      return refused(c);
    const run = deps.runs.get(c.req.param('runId') ?? '');
    if (!run || !deps.person(c)?.mayMutate(run.conversationId))
      return notFound(c);
    return run;
  };
  const settled = (c: Context, runId: string) =>
    c.json(
      {
        success: false,
        code: 'terminal_run_settled',
        error: `This command was already ${deps.runs.get(runId)?.state.replace('_', ' ') ?? 'removed'}.`,
      },
      409,
      NO_STORE,
    );

  app.get('/', (c) => {
    if (
      requestMayBeAnAgent(c.req.raw) ||
      !deps.authorizeRequest(c.req.raw, 'observe')
    )
      return refused(c);
    const conversationId = z
      .string()
      .min(1)
      .max(512)
      .safeParse(c.req.query('conversationId'));
    if (!conversationId.success)
      return c.json(
        { success: false, error: 'conversationId is required' },
        400,
        NO_STORE,
      );
    if (!deps.person(c)?.mayRead(conversationId.data)) return notFound(c);
    return c.json(
      {
        success: true,
        data: {
          runs: deps.runs
            .openForConversation(conversationId.data)
            .map(publicTerminalRun),
        },
      },
      200,
      NO_STORE,
    );
  });

  app.post('/:runId/approve', async (c) => {
    const found = personRun(c);
    if (found instanceof Response) return found;
    const run = deps.runs.claim(found.id);
    if (!run) return settled(c, found.id);
    try {
      const started = await deps.start(c.req.raw, run);
      deps.runs.started(run.id, started.terminalId, started.exited);
    } catch (error) {
      const failure =
        error instanceof TerminalSessionRefusal
          ? error.message
          : 'The command could not start.';
      deps.runs.failed(run.id, failure);
      return c.json(
        { success: false, code: 'terminal_run_failed', error: failure },
        error instanceof TerminalSessionRefusal ? 409 : 503,
        NO_STORE,
      );
    }
    return c.json(
      { success: true, data: publicTerminalRun(deps.runs.get(run.id)!) },
      200,
      NO_STORE,
    );
  });

  app.post('/:runId/decline', (c) => {
    const found = personRun(c);
    if (found instanceof Response) return found;
    if (!deps.runs.decline(found.id)) return settled(c, found.id);
    return c.json(
      { success: true, data: publicTerminalRun(deps.runs.get(found.id)!) },
      200,
      NO_STORE,
    );
  });

  return app;
}
