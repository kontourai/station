import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEngineCapabilityMatrix } from '../packages/contracts/src/engine-capability-matrix.js';
import { normalizeToolName } from '../packages/shared/src/mcp-tool-selection.js';

type Verdict = 'pass' | 'fail' | 'unverified';
type Api = (
  path: string,
  body?: unknown,
  method?: string,
) => Promise<{ data?: unknown }>;
type Event = {
  method: string;
  toolName?: string;
  turnId?: string;
  toolCallId?: string;
  arguments?: unknown;
  status?: string;
};
type Evidence = {
  declared: string;
  probe?: Verdict;
  reason?: string;
  turnId?: string;
  checks?: string[];
};
type Setup = {
  api: Api;
  engine: string;
  connectionId: string;
  cwd: string;
  model: string;
  delivery: Record<string, Evidence>;
  deferCleanup: (label: string, run: () => Promise<unknown>) => void;
};
type State = {
  serverId: string;
  skillId: string;
  nonce: string;
  artifact: string;
  inventory: string[];
  policy: boolean;
  skill: boolean;
};
type Context = Setup & {
  state: State;
  send: (
    prompt: string,
    model: string,
    expected: string | null,
    artifact: string | undefined,
    artifactContent: string | undefined,
    evaluate?: (turn: {
      text: string;
      storedOutputs: string[];
      events: Event[];
      turnId: string;
      identityChecks: Record<string, Verdict>;
    }) => Record<string, Verdict>,
  ) => Promise<{ checks: Record<string, Verdict> }>;
};

// These are MCP action ids, not invented native-tool names. The preflight
// tools/list inventory must contain them before a disable can be judged.
export const DISABLED_TOOL_IDS = {
  'station-agent': 'blocked',
  claude: 'blocked',
  codex: 'blocked',
} as const;

type SkillInvocationShape = {
  toolName: string;
  skillArgument: string;
  readToolName: string;
  readPathArgument: string;
  fixture: string;
  readFixture: string;
  mapper: string;
};

// Captured CLI tool execution with loopback fixture inference, not live-model proof.
const SKILL_INVOCATION_SHAPES: Record<string, SkillInvocationShape | null> = {
  claude: {
    toolName: 'Skill',
    skillArgument: 'skill',
    readToolName: 'Read',
    readPathArgument: 'file_path',
    fixture:
      'src-server/providers/__tests__/fixtures/claude-2.1.296-skill-invocation-local.jsonl',
    readFixture:
      'src-server/providers/__tests__/fixtures/claude-2.1.296-script-read-local.jsonl',
    mapper: 'src-server/providers/adapters/claude-adapter-events.ts',
  },
  'station-agent': null,
  codex: null,
  acp: null,
  muse: null,
};

function argument(event: Event, key: string): unknown {
  const input = event.arguments;
  return input && typeof input === 'object' && !Array.isArray(input)
    ? Reflect.get(input, key)
    : undefined;
}

function checkSkillInvocation(
  engine: string,
  skillId: string,
  events: Event[],
  scriptObserved: boolean,
): { verdict: Verdict; reason: string } {
  const shape = SKILL_INVOCATION_SHAPES[engine];
  if (!shape)
    return {
      verdict: 'unverified',
      reason: `No captured skill-invocation shape for ${engine}`,
    };
  const invoked = events.filter(
    (event) =>
      event.method === 'tool.started' &&
      event.toolName === shape.toolName &&
      argument(event, shape.skillArgument) === skillId,
  );
  if (!invoked.length) {
    const read = events.some((event) => {
      const path = argument(event, shape.readPathArgument);
      return (
        event.method === 'tool.started' &&
        event.toolName === shape.readToolName &&
        typeof path === 'string' &&
        path.replaceAll('\\', '/').endsWith(`/${skillId}/scripts/probe.mjs`)
      );
    });
    if (read)
      return {
        verdict: 'fail',
        reason: 'Probe script was read without a skill invocation',
      };
    return {
      verdict: 'unverified',
      reason: 'No skill-invocation event recorded in this turn',
    };
  }
  const failed = invoked.some(
    (call) =>
      call.toolCallId &&
      events.some(
        (event) =>
          event.method === 'tool.completed' &&
          event.toolCallId === call.toolCallId &&
          ['error', 'cancelled', 'unresolved'].includes(event.status ?? ''),
      ),
  );
  if (failed) return { verdict: 'fail', reason: 'Skill invocation failed' };
  const completed = invoked.some(
    (call) =>
      call.toolCallId &&
      events.some(
        (event) =>
          event.method === 'tool.completed' &&
          event.toolCallId === call.toolCallId &&
          event.status === 'success',
      ),
  );
  if (!completed)
    return {
      verdict: 'unverified',
      reason: 'Skill invocation completion was not observed',
    };
  return scriptObserved
    ? {
        verdict: 'pass',
        reason: 'Recorded skill invocation and script nonce or output observed',
      }
    : {
        verdict: 'fail',
        reason: 'Skill invoked without a script nonce or output',
      };
}

function disabledId(engine: string): string | undefined {
  return Object.entries(DISABLED_TOOL_IDS).find(([id]) => id === engine)?.[1];
}

export function checkDisabledTool(
  engine: string,
  inventory: string[],
  calls: string[],
  serverId: string,
): Verdict {
  const id = disabledId(engine);
  if (!id) return 'unverified';
  if (!inventory.includes(id)) return 'fail';
  return calls.some((name) => toolNames(serverId, id).includes(name))
    ? 'fail'
    : 'pass';
}

function toolNames(serverId: string, name: string) {
  return [
    `${serverId}/${name}`,
    `${serverId}_${name}`,
    normalizeToolName(`${serverId}_${name}`),
    `mcp__${serverId}__${name}`,
  ];
}

function callsIn(events: Event[]) {
  return events
    .filter((event) => event.method === 'tool.started')
    .map((event) => event.toolName ?? '');
}

async function data<T>(
  api: Api,
  path: string,
  body?: unknown,
  method?: string,
) {
  return (await api(path, body, method)).data as T;
}

function identityVerdict(checks: Record<string, Verdict>): Verdict {
  const values = Object.values(checks);
  return values.includes('fail')
    ? 'fail'
    : values.length > 0 && values.every((value) => value === 'pass')
      ? 'pass'
      : 'unverified';
}

function record(
  delivery: Setup['delivery'],
  claim: string,
  checks: Record<string, Verdict>,
  names: string[],
  turnId: string,
) {
  delivery[claim].turnId = turnId;
  delivery[claim].checks = [...names, 'deliveryIdentity'];
  const values = delivery[claim].checks.map(
    (name) => checks[name] ?? 'unverified',
  );
  delivery[claim].probe = values.includes('fail')
    ? 'fail'
    : values.every((value) => value === 'pass')
      ? 'pass'
      : 'unverified';
}

export const scenarios = [
  {
    id: 'delivery',
    scope: 'engine',
    maxTurns: 2,
    async prepare(ctx: Setup) {
      const matrix = resolveEngineCapabilityMatrix(undefined, {
        engineId: ctx.engine === 'station-agent' ? 'station' : ctx.engine,
      });
      const skill = matrix.skills.state !== 'unsupported';
      const policy = disabledId(ctx.engine) !== undefined;
      ctx.delivery.skills = {
        declared: matrix.skills.state,
        probe: 'unverified',
        reason: SKILL_INVOCATION_SHAPES[ctx.engine]
          ? 'No skill-invocation event observed yet'
          : `No captured skill-invocation shape for ${ctx.engine}`,
      };
      ctx.delivery.script = { declared: matrix.skills.state };
      ctx.delivery.toolServers = { declared: matrix.toolServers.state };
      ctx.delivery.nativeToolPolicy = {
        declared: matrix.toolPolicy.state,
        probe: 'unverified',
        reason:
          'This probe exercises MCP selection only, not native pre-tool blocking or grants',
      };
      ctx.delivery.disabledTool = {
        declared: policy ? 'MCP selection' : 'unsupported',
        reason: policy
          ? undefined
          : 'No per-tool selection channel; native tool disables are not claimed',
      };
      if (matrix.toolServers.state === 'unsupported')
        return {
          skipReason: 'Engine declares no tool-server delivery channel',
        };
      const suffix = randomUUID().replaceAll('-', '');
      const serverId = `probe${suffix}`;
      const skillId = `delivery-${suffix}`;
      const artifact = `delivery-${suffix}.txt`;
      const nonce = randomUUID();
      const endpoint = process.env.STATION_DELIVERY_PROBE_MCP_ENDPOINT;
      if (endpoint && ctx.engine === 'acp')
        return { skipReason: 'ACP authored MCP passthrough is stdio-only' };
      ctx.deferCleanup(`tool server ${serverId}`, () =>
        ctx.api(`/integrations/${serverId}`, undefined, 'DELETE'),
      );
      await ctx.api(
        '/integrations',
        endpoint
          ? {
              id: serverId,
              kind: 'mcp',
              transport: 'streamable-http',
              endpoint,
            }
          : {
              id: serverId,
              kind: 'mcp',
              transport: 'stdio',
              command: process.execPath,
              args: [
                fileURLToPath(
                  new URL('./fixtures/delivery-probe-mcp.mjs', import.meta.url),
                ),
              ],
            },
      );
      // Probe via Station's actual MCP handshake before enabling or sending chat.
      let probed: { probe?: { ok: boolean; error?: string } };
      try {
        probed = await data(ctx.api, `/integrations/${serverId}/reconnect`, {});
      } catch (error) {
        if (endpoint)
          return {
            skipReason: `Third-party MCP preflight failed: ${String(error)}`,
          };
        throw error;
      }
      if (!probed.probe?.ok) {
        if (endpoint)
          return {
            skipReason: `Third-party MCP endpoint unreachable: ${probed.probe?.error ?? 'handshake failed'}`,
          };
        throw new Error(
          `Local MCP fixture could not be probed: ${probed.probe?.error ?? 'handshake failed'}`,
        );
      }
      const integrations = await data<
        Array<{ id: string; tools: Array<{ toolName: string }> }>
      >(ctx.api, '/integrations');
      const inventory =
        integrations
          .find((entry) => entry.id === serverId)
          ?.tools.map((tool) => tool.toolName) ?? [];
      if (
        !inventory.includes('ping') ||
        (policy && !inventory.includes(disabledId(ctx.engine) ?? ''))
      )
        throw new Error(
          'Probe tool id missing from Station tool inventory; refusing vacuous disable check',
        );
      if (policy)
        await ctx.api(`/integrations/${serverId}/tools/apply`, {
          disabledTools: [disabledId(ctx.engine)],
        });
      await ctx.api(`/integrations/${serverId}/enabled`, { enabled: true });
      if (skill) {
        ctx.deferCleanup(`skill ${skillId}`, () =>
          ctx.api(`/api/skills/${skillId}`, undefined, 'DELETE'),
        );
        const body = `Resolve the bundled scripts/probe.mjs relative to this SKILL.md, then run Node with that script path while keeping the session working directory. It prints a receipt and writes ${artifact}. Call Station's declare_output with {"file":{"path":"${artifact}"}}. Reply with the receipt printed by the script. Do not substitute reading the script for running it.`;
        await ctx.api('/api/skills/local', {
          name: skillId,
          body,
          description: 'Temporary engine delivery probe',
          global: true,
        });
        const installed = await data<{ path: string }>(
          ctx.api,
          `/api/skills/${skillId}`,
        );
        // The current skill API authors SKILL.md but has no resource-upload API.
        // Add the bundled script to the API-created package on the SAME host.
        if (
          !isAbsolute(installed.path) ||
          !(await readFile(join(installed.path, 'SKILL.md'), 'utf8')).includes(
            body,
          )
        )
          throw new Error(
            'Delivery probes require a co-located Station skill package',
          );
        await mkdir(join(installed.path, 'scripts'));
        await writeFile(
          join(installed.path, 'scripts/probe.mjs'),
          `import { writeFileSync } from 'node:fs';\nconst nonce = ${JSON.stringify(nonce)};\nwriteFileSync(${JSON.stringify(artifact)}, nonce, { flag: 'wx' });\nconsole.log(nonce);\n`,
          { flag: 'wx' },
        );
      }
      // Register compensation before POST: an acknowledgement may be lost.
      ctx.deferCleanup(`agent ${skillId}`, () =>
        ctx.api(`/agents/${skillId}`, undefined, 'DELETE'),
      );
      await ctx.api('/agents', {
        name: skillId,
        slug: skillId,
        prompt: '',
        model: ctx.model,
        execution: {
          ...(ctx.engine === 'station-agent'
            ? {}
            : { agentConnectionId: ctx.connectionId }),
          approvalMode: 'auto',
        },
        ...(skill ? { skills: [skillId] } : {}),
        tools: {
          mcpServers: [serverId, 'station-control'],
          mcpMode: 'replace',
        },
      });
      return {
        metadata: { agentSlug: skillId },
        state: { serverId, skillId, nonce, artifact, inventory, policy, skill },
      };
    },
    async run(ctx: Context) {
      const state = ctx.state;
      const allCalls: string[] = [];
      if (state.skill) {
        await ctx.send(
          `Use the ${state.skillId} skill now. Follow its instructions and return its script receipt.`,
          ctx.model,
          null,
          undefined,
          undefined,
          ({ text, storedOutputs, events, identityChecks, turnId }) => {
            allCalls.push(...callsIn(events));
            const nonceObserved = text.includes(state.nonce);
            const outputObserved = storedOutputs.includes(state.artifact);
            const invocation = checkSkillInvocation(
              ctx.engine,
              state.skillId,
              events,
              nonceObserved || outputObserved,
            );
            const checks: Record<string, Verdict> = {
              deliveryIdentity: identityVerdict(identityChecks),
              skillDelivery: invocation.verdict,
              scriptExecuted: nonceObserved || outputObserved ? 'pass' : 'fail',
            };
            ctx.delivery.skills.reason = invocation.reason;
            ctx.delivery.script.reason = `Answer nonce ${nonceObserved ? 'observed' : 'absent'}; declared script output ${outputObserved ? 'observed' : 'absent'}`;
            record(ctx.delivery, 'skills', checks, ['skillDelivery'], turnId);
            record(ctx.delivery, 'script', checks, ['scriptExecuted'], turnId);
            return checks;
          },
        );
      }
      await ctx.send(
        `Call ping on the configured MCP server ${state.serverId}. Also try its blocked action if available. Reply STATION_DELIVERY_OK.`,
        ctx.model,
        null,
        undefined,
        undefined,
        ({ events, identityChecks, turnId }) => {
          const currentCalls = callsIn(events);
          const calls = [...allCalls, ...currentCalls];
          const checks: Record<string, Verdict> = {
            deliveryIdentity: identityVerdict(identityChecks),
            toolServerUsed: currentCalls.some((name) =>
              toolNames(state.serverId, 'ping').includes(name),
            )
              ? 'pass'
              : 'fail',
            disabledTool: state.policy
              ? checkDisabledTool(
                  ctx.engine,
                  state.inventory,
                  calls,
                  state.serverId,
                )
              : 'unverified',
          };
          record(
            ctx.delivery,
            'toolServers',
            checks,
            ['toolServerUsed'],
            turnId,
          );
          if (state.policy)
            record(
              ctx.delivery,
              'disabledTool',
              checks,
              ['toolServerUsed', 'disabledTool'],
              turnId,
            );
          return checks;
        },
      );
    },
  },
];
