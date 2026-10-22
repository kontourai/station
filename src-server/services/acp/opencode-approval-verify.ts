/**
 * #3290: check that Station's approval rules are what OpenCode will actually
 * enforce, before Station claims to govern an OpenCode session.
 *
 * Station writes its rules into `OPENCODE_CONFIG_CONTENT`
 * (`opencode-approval-launch.ts`), but whether they win is decided by
 * OpenCode's own resolution: the user's and the project's files, an
 * organisation's managed configuration, the user's own spelling of the same
 * keys, or a binary named `opencode` that ignores inline content at all. So
 * Station asks the engine itself. `opencode debug agent <name>`, run with the
 * same environment and working directory as the session, prints the agent's
 * resolved permission rules in evaluation order (`cli/cmd/debug/agent.ts`,
 * OpenCode 1.18.18); Station evaluates them the way OpenCode does (last
 * matching rule wins, `*` and `?` wildcards, an unmatched request asks) and
 * refuses to govern unless every rule it depends on is effective.
 *
 * The check is per permission, over every possible request pattern, not a
 * sample: after the last rule that covers a permission for every pattern
 * (pattern `*`), only rules no looser than Station's may follow.
 */
import { spawnChildWorkload as spawn } from '@kontourai/station-shared/child-workload';
import {
  OPENCODE_ASK_PERMISSIONS,
  OPENCODE_EXPLORE_TOOLS,
  OPENCODE_PLAN_FILE_PATTERN,
  type OpenCodeApprovalFloor,
  stationRuleKey,
} from './opencode-approval-launch.js';

export type OpenCodeRule = {
  permission: string;
  pattern: string;
  action: string;
};

export type OpenCodeResolvedAgent = {
  name?: string;
  permission?: OpenCodeRule[];
  tools?: Record<string, boolean>;
};

/** Runs `<command> debug agent <name>` in the session's environment. */
export type OpenCodeAgentReader = (
  agent: string,
) => Promise<OpenCodeResolvedAgent>;

export type OpenCodeFloorVerification =
  | { ok: true }
  | { ok: false; reason: string };

/** OpenCode's wildcard (`util/wildcard.ts`): `*` any run, `?` one char. */
function wildcard(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(input.replaceAll('\\', '/'));
}

const STRICTNESS: Record<string, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * The loosest action `permission` can resolve to, for any request pattern,
 * ignoring rules `exempt` names. `undefined` when some request could match no
 * rule at all, which OpenCode answers with `ask`.
 */
function loosest(
  rules: readonly OpenCodeRule[],
  permission: string,
  exempt: (rule: OpenCodeRule) => boolean = () => false,
): { action: string; covered: boolean } {
  const matching = rules.filter((rule) =>
    wildcard(permission, rule.permission),
  );
  let catchAll = -1;
  matching.forEach((rule, index) => {
    if (rule.pattern === '*') catchAll = index;
  });
  const effective = (
    catchAll >= 0 ? matching.slice(catchAll) : matching
  ).filter((rule, index) => index === 0 || !exempt(rule));
  const actions = effective.map((rule) => rule.action);
  if (catchAll < 0) actions.push('ask');
  const action = actions.reduce((current, next) =>
    (STRICTNESS[next] ?? 0) < (STRICTNESS[current] ?? 0) ? next : current,
  );
  return { action, covered: catchAll >= 0 };
}

/** The strictest action `permission` can resolve to, for any pattern. */
function strictest(rules: readonly OpenCodeRule[], permission: string): string {
  const matching = rules.filter((rule) =>
    wildcard(permission, rule.permission),
  );
  let catchAll = -1;
  matching.forEach((rule, index) => {
    if (rule.pattern === '*') catchAll = index;
  });
  const actions = (catchAll >= 0 ? matching.slice(catchAll) : matching).map(
    (rule) => rule.action,
  );
  if (catchAll < 0) actions.push('ask');
  return actions.reduce((current, next) =>
    (STRICTNESS[next] ?? 0) > (STRICTNESS[current] ?? 0) ? next : current,
  );
}

/** OpenCode appends its own tool-output directory as an allowed outside path. */
function isToolOutputAllow(rule: OpenCodeRule): boolean {
  return (
    rule.permission === 'external_directory' &&
    rule.action === 'allow' &&
    /[\\/]tool-output[\\/]\*$/.test(rule.pattern)
  );
}

/** The `task` patterns (subagent names) a ruleset allows. */
function allowedSubagents(rules: readonly OpenCodeRule[]): string[] {
  const matching = rules.filter((rule) => wildcard('task', rule.permission));
  let catchAll = -1;
  matching.forEach((rule, index) => {
    if (rule.pattern === '*') catchAll = index;
  });
  if (catchAll < 0 || matching[catchAll]?.action === 'allow') return ['*'];
  return matching
    .slice(catchAll + 1)
    .filter((rule) => rule.action !== 'deny')
    .map((rule) => rule.pattern);
}

function why(agent: string, permission: string, detail: string): string {
  return `your OpenCode configuration overrides Station's approval rules for ${permission} in the ${agent} agent (${detail})`;
}

/** An MCP tool's name: `<server>_<tool>`, both sanitized (`mcp/catalog.ts`). */
const MCP_NAME = /^[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/;
/** Names a rule must match to cover every MCP tool. */
const MCP_SAMPLES = ['a_b', 'github_create_issue', 'my-server_x-y', 'a__b'];

/**
 * Whether a rule's permission pattern can match some MCP tool name. A glob's
 * matches always include one of these witnesses when they include any MCP
 * name: `*` taken as a name piece with an underscore inside, or as a single
 * letter, and `?` as a letter or an underscore.
 */
function canMatchMcpName(pattern: string): boolean {
  const witnesses = new Set<string>();
  for (const star of ['a_a', 'a']) {
    for (const one of ['a', '_']) {
      witnesses.add(pattern.replaceAll('*', star).replaceAll('?', one));
    }
  }
  return [...witnesses].some(
    (name) => MCP_NAME.test(name) && wildcard(name, pattern),
  );
}

/**
 * Every MCP tool asks: the last rule covering every MCP name (for every
 * request pattern) asks or denies, and no rule after it allows any name an
 * MCP tool could have. Checked against the rules, not one sample name: a
 * user's `github_*: allow` after Station's rule allows only some tools.
 */
function checkMcp(
  agent: string,
  rules: readonly OpenCodeRule[],
): string | undefined {
  let floor = -1;
  rules.forEach((rule, index) => {
    if (
      rule.pattern === '*' &&
      MCP_SAMPLES.every((name) => wildcard(name, rule.permission))
    ) {
      floor = index;
    }
  });
  const floorRule = rules[floor];
  if (!floorRule || floorRule.action === 'allow') {
    return why(agent, 'MCP tools', 'they would run without asking');
  }
  const later = rules
    .slice(floor + 1)
    .find(
      (rule) =>
        rule.action === 'allow' &&
        !isToolOutputAllow(rule) &&
        canMatchMcpName(rule.permission),
    );
  return later
    ? why(agent, 'MCP tools', `${later.permission} would run without asking`)
    : undefined;
}

/** Below full access: each governed action asks, and no subagent starts. */
function checkConfined(
  agent: string,
  rules: readonly OpenCodeRule[],
): string | undefined {
  for (const permission of OPENCODE_ASK_PERMISSIONS) {
    const exemptPlanFile = (rule: OpenCodeRule) =>
      agent === 'plan' &&
      permission === 'edit' &&
      rule.action === 'allow' &&
      rule.pattern === OPENCODE_PLAN_FILE_PATTERN;
    const { action } = loosest(
      rules,
      permission,
      (rule) => isToolOutputAllow(rule) || exemptPlanFile(rule),
    );
    if (action === 'allow') {
      return why(agent, permission, 'it would run without asking');
    }
  }
  const mcp = checkMcp(agent, rules);
  if (mcp) return mcp;
  const subagents = allowedSubagents(rules);
  if (subagents.length > 0) {
    return why(agent, 'task', `it could start ${subagents.join(', ')}`);
  }
  return undefined;
}

/** Full access, primary agents: only the built-in subagents may start. */
function checkFullPrimary(
  agent: string,
  rules: readonly OpenCodeRule[],
): string | undefined {
  const permitted = agent === 'plan' ? ['explore'] : ['general', 'explore'];
  const extra = allowedSubagents(rules).filter(
    (name) => !permitted.includes(name),
  );
  if (extra.length > 0) {
    return why(agent, 'task', `it could start ${extra.join(', ')}`);
  }
  if (strictest(rules, 'external_directory') === 'ask') {
    // A child inherits this rule; an `ask` there would hang it.
    return why(agent, 'external_directory', 'a subagent could ask and hang');
  }
  return undefined;
}

/** OpenCode keys these tools' permission by another name (`Permission.disabled`). */
const TOOL_PERMISSION: Record<string, string> = {
  write: 'edit',
  apply_patch: 'edit',
  list_mcp_resources: 'read',
  list_mcp_resource_templates: 'read',
  read_mcp_resource: 'read',
};

/** Full access, subagents: nothing they can do may ask (it would hang). */
function checkFullSubagent(
  agent: string,
  resolved: OpenCodeResolvedAgent,
): string | undefined {
  const rules = resolved.permission ?? [];
  const tools = Object.entries(resolved.tools ?? {})
    .filter(([, enabled]) => enabled)
    .map(([tool]) => TOOL_PERMISSION[tool] ?? tool);
  const universe = new Set([
    ...tools,
    ...(agent === 'explore' ? OPENCODE_EXPLORE_TOOLS : []),
    'external_directory',
    'doom_loop',
  ]);
  for (const permission of universe) {
    if (permission === 'task' || permission === 'question') continue;
    if (strictest(rules, permission) === 'ask') {
      return why(agent, permission, 'a subagent could ask and hang');
    }
  }
  if (
    universe.has('question') &&
    loosest(rules, 'question').action !== 'deny'
  ) {
    return why(agent, 'question', 'a subagent could ask and hang');
  }
  const extra = allowedSubagents(rules).filter((name) => name !== 'explore');
  if (universe.has('task') && extra.length > 0) {
    return why(agent, 'task', `it could start ${extra.join(', ')}`);
  }
  return undefined;
}

/**
 * Whether `floor`'s rules are what OpenCode resolved for every agent they
 * cover. Any failure to read an agent (an older OpenCode, another binary, a
 * timeout) is a failed check: Station does not claim what it cannot see.
 */
export async function verifyOpenCodeApprovalFloor(
  floor: OpenCodeApprovalFloor,
  read: OpenCodeAgentReader,
): Promise<OpenCodeFloorVerification> {
  const agents =
    floor === 'full'
      ? ['build', 'plan', 'general', 'explore']
      : ['build', 'plan'];
  // One at a time: concurrent first starts of OpenCode in a new project
  // contend for its local database, and one of them can fail.
  const resolved: OpenCodeResolvedAgent[] = [];
  try {
    for (const agent of agents) resolved.push(await read(agent));
  } catch (error) {
    return {
      ok: false,
      reason: `Station could not read OpenCode's resolved approval rules (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  for (const [index, agent] of agents.entries()) {
    const entry = resolved[index];
    const rules = entry?.permission;
    if (!Array.isArray(rules)) {
      return {
        ok: false,
        reason: `OpenCode did not report resolved approval rules for the ${agent} agent`,
      };
    }
    const failure =
      floor === 'confined'
        ? checkConfined(agent, rules)
        : agent === 'build' || agent === 'plan'
          ? checkFullPrimary(agent, rules)
          : checkFullSubagent(agent, entry ?? {});
    if (failure) return { ok: false, reason: failure };
  }
  const unobserved = wildcardUnobserved(
    floor,
    agents.map((agent, index) => ({ agent, resolved: resolved[index] ?? {} })),
  );
  if (unobserved) return { ok: false, reason: unobserved };
  return { ok: true };
}

/**
 * The check above evaluates OpenCode's rules with a model of its wildcard
 * matching; this observes the engine's own. OpenCode hides a tool whose last
 * matching rule denies every pattern, and reports that in `debug agent`'s
 * `tools` (`Permission.disabled`). Below full access Station denies `task`
 * under its `?`-spelled key (`tas?`), and `task` is visible by default on
 * build and plan (checked against 1.18.18), so a hidden `task` shows that this
 * OpenCode matched Station's `?` key the way the model assumes. An engine that
 * does not is refused, whatever its version: a version range would refuse a
 * compatible release and admit an incompatible one.
 *
 * Only an agent whose own rules would leave `task` visible without Station's
 * rule counts: where your configuration denies `task` itself, the tool is
 * hidden either way and shows nothing about Station's key. If no agent counts,
 * Station cannot observe its key and does not govern.
 *
 * Nothing is observed at full access. Station denies no tool there that
 * OpenCode shows by default (`general` already hides `question`), so no
 * observation could tell a matched key from an ignored one. A misread key at
 * full access can only leave OpenCode's own stricter rules in force (a call
 * that asks, or a subagent that asks and waits); it cannot run anything that
 * full access would not.
 */
function wildcardUnobserved(
  floor: OpenCodeApprovalFloor,
  agents: ReadonlyArray<{ agent: string; resolved: OpenCodeResolvedAgent }>,
): string | undefined {
  if (floor !== 'confined') return undefined;
  const telling = agents.filter(
    ({ resolved }) => !hiddenWithoutStation(resolved.permission ?? [], 'task'),
  );
  if (telling.length === 0) {
    return 'your OpenCode configuration denies task itself, so Station cannot observe how this OpenCode reads its approval rules';
  }
  const unapplied = telling.find(
    ({ resolved }) => resolved.tools?.task !== false,
  );
  if (!unapplied) return undefined;
  return `this OpenCode did not apply Station's task rule for the ${unapplied.agent} agent as written, so Station cannot rely on how it reads its approval rules`;
}

/** Whether `tool` would be hidden by the rules other than Station's own key. */
function hiddenWithoutStation(
  rules: readonly OpenCodeRule[],
  tool: string,
): boolean {
  const key = stationRuleKey(tool);
  const last = rules
    .filter(
      (rule) => rule.permission !== key && wildcard(tool, rule.permission),
    )
    .at(-1);
  return last?.pattern === '*' && last.action === 'deny';
}

/** How long one `debug agent` read may take (a cold OpenCode start is ~1-2s). */
export const OPENCODE_AGENT_READ_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Reads agents by running `<command> debug agent <name>` with `env` in `cwd`,
 * the same environment and directory the session's engine is launched with.
 */
export function openCodeAgentReader(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): OpenCodeAgentReader {
  return (agent) =>
    new Promise((resolve, reject) => {
      const child = spawn(input.command, ['debug', 'agent', agent], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, value?: OpenCodeResolvedAgent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? {});
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`debug agent ${agent} timed out`));
      }, input.timeoutMs ?? OPENCODE_AGENT_READ_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(new Error(`debug agent ${agent} printed too much`));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString();
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (code !== 0) {
          const detail = stderr.trim().split('\n').at(-1)?.slice(0, 300);
          finish(
            new Error(
              `debug agent ${agent} exited with code ${code}${detail ? `: ${detail}` : ''}`,
            ),
          );
          return;
        }
        try {
          finish(undefined, JSON.parse(stdout) as OpenCodeResolvedAgent);
        } catch {
          finish(new Error(`debug agent ${agent} printed no JSON`));
        }
      });
    });
}
