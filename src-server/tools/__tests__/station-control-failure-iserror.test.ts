/**
 * #2795 (catch s5-436): a station-control tool that could not do its job
 * answers an MCP error. The native invoke route (and every MCP host)
 * recognises a failed tool only by `isError`; a failure in any other shape
 * — `{ success: false }`, `{ status: 'unavailable' }`, `{ installed: false }`,
 * `{ ok: false }` — reads as a success.
 *
 * By behaviour, not by reading source: every registered tool's handler runs
 * twice against a Station that refuses everything — once as a caller-less
 * request (the tool-side authority check refuses the guarded tools), once as
 * a bound operator (each tool's own failure path). In that environment no
 * tool can succeed, so every result must be an MCP error (`isError`, or a
 * throw, which the MCP SDK turns into one). The only exceptions are pinned by
 * name with their reason; a new refusal shape without `isError`, in any
 * family, adds a tool to the observed set and fails the pin.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import { createStationControlMcpServer } from '../station-control-mcp-server.js';
import {
  stationControlCallerPrincipal,
  withStationControlCallerContext,
} from '../station-control-shared.js';

type Handler = (args: unknown, extra?: unknown) => Promise<unknown>;
type ToolResult = { isError?: boolean; content?: Array<{ text?: unknown }> };

const PER_TOOL_TIMEOUT_MS = 3_000;

function registeredTools(): Record<string, { handler: Handler }> {
  return (
    createStationControlMcpServer() as unknown as {
      _registeredTools: Record<string, { handler: Handler }>;
    }
  )._registeredTools;
}

/**
 * Minimal valid arguments for the tools whose handlers validate their input
 * before any request: without them a tool throws on its own argument check
 * and its real refusal path never runs. (The same shapes as
 * `station-control-policy-routes.test.ts`.) Every other tool runs with `{}`.
 */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  continue_task: { taskId: 'task:1', message: 'One more thing' },
  propose_plugin_install: { source: '/tmp/plugin', rationale: 'Needed.' },
  validate_plugin: { source: '/tmp/plugin' },
  update_config: { updates: { theme: 'dark' } },
  run_independent_review: {
    request: {
      requestId: 'request-1',
      mode: 'initial',
      target: {
        kind: 'git-range',
        projectSlug: 'p',
        baseRevision: 'origin/main',
        headRevision: 'HEAD',
      },
      implementerAgentSlug: 'terra',
      reviewers: [
        {
          reviewerId: 'reviewer-1',
          executorAgentSlug: 'reviewer-agent',
          lens: { id: 'failure-totality', instructions: 'Review.' },
        },
      ],
    },
  },
};

/**
 * The context the MCP SDK hands every handler: `mcpReq` is always present
 * (its `signal` is the request's cancellation). `wait_session` forwards that
 * signal to its held route call, so a bare `{}` is not a shape any host
 * produces; it threw a TypeError that this test then read as the tool
 * throwing.
 */
const REQUEST_CONTEXT = () => ({
  mcpReq: {
    id: 1,
    method: 'tools/call',
    signal: new AbortController().signal,
  },
});

async function run(
  name: string,
  handler: Handler,
  caller: 'none' | 'bound',
): Promise<unknown> {
  const call = withStationControlCallerContext(
    {
      token: undefined,
      resolve: () =>
        caller === 'bound'
          ? {
              sessionId: 'claims-operator',
              assurance: 'bound' as const,
              principal: stationControlCallerPrincipal(
                LOCAL_OPERATOR_PRINCIPAL_ID,
                'session-owner',
              ),
            }
          : null,
    },
    () => handler(MINIMAL_ARGS[name] ?? {}, REQUEST_CONTEXT()),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('timed-out'), PER_TOOL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return 'threw';
  } finally {
    clearTimeout(timer);
  }
}

const previousBase = process.env.STATION_API_BASE;
beforeEach(() => {
  process.env.STATION_API_BASE = 'http://127.0.0.1:65011';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      const respond = (body: unknown, status: number) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/.well-known/station/v1'))
        return respond({ environmentId: 'env-self', capabilities: {} }, 200);
      return respond(
        {
          success: false,
          code: 'station_control_caller_required',
          error: 'This action needs a verified calling session.',
        },
        403,
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (previousBase === undefined) delete process.env.STATION_API_BASE;
  else process.env.STATION_API_BASE = previousBase;
});

/**
 * Deliberate non-errors in a refusing environment, each with its reason. The
 * basis and session-inventory tools are MCP App views: when their read is
 * unavailable they answer a rendered "unavailable" state with an explicit
 * `isError: false` (`buildStationBasisUnavailableToolResult`,
 * `buildStationSessionInventoryUnavailableToolResult`), which the app view
 * displays as a state rather than as a failed call. Caller-less, the
 * tool-side check refuses them first, so they are errors there.
 */
const NOT_AN_ERROR_BY_DESIGN: Record<'none' | 'bound', readonly string[]> = {
  none: [],
  bound: ['get_basis', 'get_session_inventory', 'get_task_basis'],
};

/**
 * Tools that still answer a refusal by throwing. None today: the delegation
 * tools answer through `delegationToolResult`, and every other family through
 * `jsonToolResult`. A throw is still an MCP error, but it reaches the invoke
 * route as `tool_threw` with no typed code, so a new one must be named here.
 */
const STILL_THROWS: Record<'none' | 'bound', readonly string[]> = {
  none: [],
  bound: [],
};

describe('every station-control failure is an MCP error (#2795)', () => {
  test.each(['none', 'bound'] as const)(
    'caller %s: only the pinned app views answer without an MCP error',
    async (caller) => {
      const tools = registeredTools();
      const names = Object.keys(tools).sort();
      expect(names.length).toBeGreaterThan(80);
      const notErrors: string[] = [];
      const threw: string[] = [];
      for (const name of names) {
        const result = await run(name, tools[name]!.handler, caller);
        if (result === 'threw') {
          threw.push(name);
          continue;
        }
        if ((result as ToolResult | undefined)?.isError === true) continue;
        notErrors.push(name);
      }
      expect(notErrors).toEqual(NOT_AN_ERROR_BY_DESIGN[caller]);
      // A throw is still an MCP error, but it reaches the invoke route as
      // `tool_threw` with no typed code; the tools that still do are pinned.
      expect(threw).toEqual(STILL_THROWS[caller]);
    },
    120_000,
  );
});
