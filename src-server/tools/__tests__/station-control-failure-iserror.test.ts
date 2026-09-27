/**
 * #2795 (catch s5-436): no station-control tool answers `success: false`
 * without MCP `isError`. The native invoke route recognises a failed control
 * tool only by that flag, so a failure body without it reads as a success.
 *
 * Structural, but by behaviour rather than by reading source: every
 * registered tool's handler runs twice — once as a caller-less request (the
 * tool-side authority check refuses the guarded tools), and once as a bound
 * operator while every Station request answers the station-control guard's
 * refusal (each tool's own failure path). Every result whose JSON body says
 * `success: false` must carry `isError: true`. A tool that throws is already
 * an MCP error; a tool that succeeds or answers a non-envelope is outside
 * this rule.
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

function failureEnvelope(result: unknown): boolean {
  const text = (result as ToolResult | undefined)?.content?.[0]?.text;
  if (typeof text !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { success?: unknown }).success === false
    );
  } catch {
    return false;
  }
}

async function run(
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
    () => handler({}, {}),
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

describe('every station-control failure envelope is an MCP error (#2795)', () => {
  test.each(['none', 'bound'] as const)(
    'caller %s: no tool answers success:false without isError',
    async (caller) => {
      const tools = registeredTools();
      const names = Object.keys(tools).sort();
      const failures: string[] = [];
      const unflagged: string[] = [];
      for (const name of names) {
        const result = await run(tools[name]!.handler, caller);
        if (!failureEnvelope(result)) continue;
        failures.push(name);
        if ((result as ToolResult).isError !== true) unflagged.push(name);
      }
      expect(unflagged).toEqual([]);
      // Reachability: the refusal paths really ran. A caller-less request is
      // refused for every guarded tool; a bound operator reaches each tool's
      // own failure path through the stubbed Station.
      expect(failures.length).toBeGreaterThanOrEqual(
        caller === 'none' ? 75 : 60,
      );
    },
    120_000,
  );
});
