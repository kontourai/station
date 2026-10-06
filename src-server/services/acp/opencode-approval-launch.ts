/**
 * #3290: the OpenCode launch configuration that lets Station's approval mode
 * govern an OpenCode session over ACP.
 *
 * OpenCode decides which tool calls reach ACP `session/request_permission`
 * from its own permission rules, and ACP has no channel to set them per
 * session. OpenCode reads inline configuration from `OPENCODE_CONFIG_CONTENT`
 * at launch, merged over the user's own configuration files (global, the
 * `OPENCODE_CONFIG` file, the project's, its `.opencode` directories) and
 * below an organisation's managed configuration (checked against OpenCode
 * 1.18.18, `config/config.ts`). Station uses that channel for one of two
 * floors, chosen by the chat's approval mode (`acpApprovalFloor`):
 *
 * - `confined` (Ask, Auto, and full access confined to Auto): the `build`
 *   and `plan` agents ask before every action that is not a read, and Station
 *   answers each request by the mode (`acp-adapter.ts`). Moving between Ask
 *   and Auto takes effect on the next request, with no restart.
 * - `full` (full access in a `host` session): nothing asks, and subagents
 *   may run, with rules that cannot ask either (see `FULL_ACCESS`).
 *
 * A chat at Default with no configured default gets neither: OpenCode is
 * launched with the user's own configuration, as Station leaves Claude and
 * Codex. Moving onto a floor, or between the two, relaunches OpenCode and
 * resumes the same ACP session (`acp-adapter.ts`).
 *
 * Why the agents are overridden in place rather than given approval
 * variants selected through `session/set_config_option`: OpenCode keys plan
 * behaviour on the agent's NAME (`session/reminders.ts` adds the plan-mode
 * reminder only when `agent.name === "plan"`; `plan_exit` switches to the
 * agent literally named `build`), so a renamed copy of `plan` would lose plan
 * mode, and a mode switch out of plan would leave Station's rules behind.
 * Overriding `build` and `plan` keeps their names, prompts and tools, and
 * leaves the session's mode list (`build`, `plan`, and the user's own agents)
 * unchanged.
 *
 * The rules are appended after OpenCode's defaults and the user's own rules
 * (`agent/agent.ts`: `Permission.merge(defaults, builtIn, user, agent)`,
 * evaluated last-match-wins), so for the actions named below they replace
 * the user's own allows and denies inside a Station session. Reads keep
 * whatever OpenCode's defaults and the user's rules say.
 */
import { type ParseError, parse } from 'jsonc-parser';

export const OPENCODE_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT';

type OpenCodePermissionAction = 'ask' | 'allow' | 'deny';
type OpenCodePermissionRules = Record<
  string,
  OpenCodePermissionAction | Record<string, OpenCodePermissionAction>
>;

/**
 * The key Station writes a rule for `permission` under: the name with its
 * last character replaced by `?`, which OpenCode's wildcard matches against
 * that one name (`permission/index.ts` `evaluate`, `util/wildcard.ts`).
 *
 * Why not the plain name: OpenCode evaluates an agent's rules last-match-wins
 * in object-key order, and merges `OPENCODE_CONFIG_CONTENT` over the user's
 * files key by key, so a key the user already has keeps the user's position.
 * With `{"edit": "allow", "*": "allow"}` in the user's `agent.build`,
 * Station's `edit: ask` would land in the first slot and the user's later
 * `*` would win (reproduced against OpenCode 1.18.18). A key the user does
 * not have is appended after all of the user's keys, so it is evaluated last.
 * `opencode-approval-verify.ts` still checks the resolved rules at launch,
 * because a user can use the same spelling, and managed configuration
 * outranks inline content.
 */
export function stationRuleKey(permission: string): string {
  return permission === '*' ? '*?' : `${permission.slice(0, -1)}?`;
}

function rules(
  entries: Record<
    string,
    OpenCodePermissionAction | Record<string, OpenCodePermissionAction>
  >,
): OpenCodePermissionRules {
  return Object.fromEntries(
    Object.entries(entries).map(([permission, action]) => [
      stationRuleKey(permission),
      action,
    ]),
  );
}

/**
 * The permissions Station governs below full access, in OpenCode 1.18.18's
 * names (`tool/*.ts`, `session/*.ts`). `opencode-approval-verify.ts` checks
 * each of these in the resolved rules before Station claims to govern.
 *
 * - `bash`, `edit` (which covers write, edit and apply_patch), `webfetch`,
 *   `websearch`, `codesearch`, `external_directory` (any path outside the
 *   project, read or write) ask before they run.
 * - MCP tools ask: an MCP tool is keyed `<server>_<tool>` (`mcp/catalog.ts`
 *   `toolName`), so the rule is written under `*_**`, which OpenCode's
 *   wildcard matches against exactly the names `*_*` does (every name with
 *   an underscore), Station's own MCP tools included. It also covers
 *   `doom_loop`, `plan_enter`, `plan_exit` and `workflow_tool_approval`,
 *   which then ask as well. Not `*_*` itself: a user can hold that key (a
 *   project `{"*_*": "allow"}` kept its earlier position and let an MCP tool
 *   run unasked), and not `*_?`, which matches only one character after the
 *   underscore.
 * - `task` is denied: a subagent runs in a child session. OpenCode's ACP
 *   server forwards permission requests only for sessions it created
 *   (`acp/permission.ts` drops the rest without a reply, so the child would
 *   wait forever), and the child's rules are the subagent's own, not these.
 *   Below full access a subagent could not be governed, so none is started.
 *   A `* deny` rule also hides the tool from the model.
 *
 * Not listed, so left to OpenCode's defaults and the user's rules: `read`
 * (OpenCode asks for `.env` files), `glob`, `grep`, `list`, `lsp`, `skill`,
 * `todowrite`, `question`. A built-in tool a later OpenCode adds without an
 * underscore in its name is not covered until it is named here.
 */
export const OPENCODE_MCP_RULE_KEY = '*_**';

export const OPENCODE_ASK_PERMISSIONS = [
  'bash',
  'edit',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
] as const;

const ASK_BEFORE_ACTING: OpenCodePermissionRules = {
  ...rules(
    Object.fromEntries(
      OPENCODE_ASK_PERMISSIONS.map((permission) => [
        permission,
        'ask' as const,
      ]),
    ),
  ),
  [OPENCODE_MCP_RULE_KEY]: 'ask',
  ...rules({ task: 'deny' }),
};

/** The plan file OpenCode's experimental plan mode writes in the project. */
export const OPENCODE_PLAN_FILE_PATTERN = '.opencode/plans/*.md';

/**
 * Plan mode keeps its own meaning, "Disallows all edit tools", at every
 * approval mode: edits are denied (so no Station answer can allow one),
 * except the plan file. Everything else asks as in `build`.
 */
const PLAN_ASK_BEFORE_ACTING: OpenCodePermissionRules = {
  ...ASK_BEFORE_ACTING,
  ...rules({ edit: { '*': 'deny', [OPENCODE_PLAN_FILE_PATTERN]: 'allow' } }),
};

/**
 * Full access: every action is allowed, so nothing reaches
 * `session/request_permission`, and the `task` tool may start the built-in
 * `general` and `explore` subagents (`plan`, as OpenCode itself does, only
 * `explore`). A subagent's permission requests never reach ACP (see
 * `ASK_BEFORE_ACTING`), so its rules must not ask either:
 *
 * - `external_directory` is restated as `allow` on the parent, because a
 *   child session inherits its parent's `external_directory` rules after its
 *   own (`agent/subagent-permissions.ts`, applied last in
 *   `session/prompt.ts`), and OpenCode's default for it is `ask`.
 * - `general` allows everything except `question` (a question asks a
 *   person, so it would hang) and `task` beyond `explore` (another
 *   subagent's rules are not these).
 * - `explore` keeps its read-only `* deny` and has each tool it is given
 *   restated as `allow`, so a user `ask` cannot reach it.
 *
 * Any other subagent (the user's own) is denied: its rules are unknown and
 * could ask. `opencode-approval-verify.ts` checks the resolved rules of all
 * four agents before Station claims full access.
 */
const FULL_ACCESS: OpenCodePermissionRules = rules({
  '*': 'allow',
  external_directory: 'allow',
  task: { '*': 'deny', general: 'allow', explore: 'allow' },
});
const PLAN_FULL_ACCESS: OpenCodePermissionRules = {
  ...FULL_ACCESS,
  ...rules({
    edit: { '*': 'deny', [OPENCODE_PLAN_FILE_PATTERN]: 'allow' },
    task: { '*': 'deny', explore: 'allow' },
  }),
};
const GENERAL_FULL_ACCESS: OpenCodePermissionRules = rules({
  '*': 'allow',
  question: 'deny',
  task: { '*': 'deny', explore: 'allow' },
});
export const OPENCODE_EXPLORE_TOOLS = [
  'grep',
  'glob',
  'list',
  'bash',
  'webfetch',
  'websearch',
  'codesearch',
  'read',
  'external_directory',
  'doom_loop',
] as const;
const EXPLORE_FULL_ACCESS: OpenCodePermissionRules = rules(
  Object.fromEntries(
    OPENCODE_EXPLORE_TOOLS.map((tool) => [tool, 'allow' as const]),
  ),
);

/** Which launch configuration an OpenCode session runs under (#3290). */
export type OpenCodeApprovalFloor = 'confined' | 'full';

/**
 * The configuration Station adds to an OpenCode session it governs.
 * `default_agent` is pinned to `build`: a user or project `default_agent`
 * would otherwise start the session in an agent Station sets no rules for.
 */
export function stationOpenCodeApprovalConfig(
  floor: OpenCodeApprovalFloor,
): Record<string, unknown> {
  if (floor === 'full') {
    return {
      default_agent: 'build',
      agent: {
        build: { permission: { ...FULL_ACCESS } },
        plan: { permission: { ...PLAN_FULL_ACCESS } },
        general: { permission: { ...GENERAL_FULL_ACCESS } },
        explore: { permission: { ...EXPLORE_FULL_ACCESS } },
      },
    };
  }
  return {
    default_agent: 'build',
    agent: {
      build: { permission: { ...ASK_BEFORE_ACTING } },
      plan: { permission: { ...PLAN_ASK_BEFORE_ACTING } },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Objects merge key by key; anything else from `overlay` replaces. A key
 * `overlay` sets is moved after the base's keys, so where key order is
 * evaluation order (OpenCode permission rules, last match wins) the overlay
 * is evaluated last.
 */
function mergeConfig(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    delete merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? mergeConfig(existing, value)
        : value;
  }
  return merged;
}

/**
 * OpenCode substitutes `{env:NAME}` in its configuration text before parsing
 * it (`config/variable.ts`), so inline content may hold an unquoted token
 * that is not JSON until then. The same substitution is applied here before
 * parsing, with the environment OpenCode will see. `{file:…}` tokens are not
 * resolved: unquoted, they still refuse the launch.
 */
function substituteEnvTokens(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/\{env:([^}]+)\}/g, (_, name: string) => env[name] ?? '');
}

/**
 * The launch environment for a Station-governed OpenCode session: `env` with
 * `OPENCODE_CONFIG_CONTENT` set to the inline configuration it already
 * carried (OpenCode accepts JSONC there) merged under Station's rules, so an
 * inline configuration the user launches Station with is kept, not replaced.
 * Nothing on disk is read or written: OpenCode itself still loads and merges
 * the user's configuration files.
 *
 * Throws when the inherited value is not a JSON object: merging into it is
 * impossible, and replacing it would silently drop the user's configuration.
 */
export function withStationOpenCodeApprovalConfig(
  env: NodeJS.ProcessEnv,
  floor: OpenCodeApprovalFloor,
): NodeJS.ProcessEnv {
  const inherited = env[OPENCODE_CONFIG_CONTENT_ENV];
  let base: Record<string, unknown> = {};
  if (inherited?.trim()) {
    const errors: ParseError[] = [];
    const parsed: unknown = parse(substituteEnvTokens(inherited, env), errors, {
      allowTrailingComma: true,
    });
    if (errors.length > 0 || !isPlainObject(parsed)) {
      throw new Error(
        `Station could not start OpenCode with its approval mode: ${OPENCODE_CONFIG_CONTENT_ENV} in Station's environment is not a JSON object, so Station's approval rules cannot be added to it. Fix or unset it, then start the chat again.`,
      );
    }
    base = parsed;
  }
  return {
    ...env,
    [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify(
      mergeConfig(base, stationOpenCodeApprovalConfig(floor)),
    ),
  };
}
