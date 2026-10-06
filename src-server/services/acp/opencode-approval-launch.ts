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
 * Every OpenCode action that is not a read asks first (permission keys as
 * OpenCode 1.18.18 names them in `tool/*.ts` and `session/*.ts`):
 *
 * - `bash`, `edit` (which covers write, edit and apply_patch), `webfetch`,
 *   `websearch`, `codesearch`, `external_directory` (any path outside the
 *   project, read or write);
 * - `*_*`: an MCP tool is keyed `<server>_<tool>` (`mcp/catalog.ts`
 *   `toolName`), so this covers every MCP tool, Station's own included. It
 *   also covers `doom_loop`, `plan_enter`, `plan_exit` and
 *   `workflow_tool_approval`, which then ask as well.
 * - `task: deny`: a subagent runs in a child session. OpenCode's ACP server
 *   forwards permission requests only for sessions it created
 *   (`acp/permission.ts` drops the rest without a reply, so the child would
 *   wait forever), and the child's rules are the subagent's own, not these.
 *   Below full access a subagent could not be governed, so none is started
 *   (full access allows the built-in ones, `FULL_ACCESS`). A `* deny` rule
 *   also hides the tool from the model (`Permission.disabled`).
 *
 * Not listed, so left to OpenCode's defaults and the user's rules: `read`
 * (OpenCode asks for `.env` files), `glob`, `grep`, `list`, `lsp`, `skill`,
 * `todowrite`, `question`. A built-in tool a later OpenCode adds without an
 * underscore in its name is not covered until it is named here.
 */
const ASK_BEFORE_ACTING: OpenCodePermissionRules = {
  bash: 'ask',
  edit: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  codesearch: 'ask',
  external_directory: 'ask',
  '*_*': 'ask',
  task: 'deny',
};

/**
 * Plan mode keeps its own meaning, "Disallows all edit tools", at every
 * approval mode: edits are denied (so no Station answer can allow one),
 * except the plan file OpenCode's experimental plan mode writes inside the
 * project. Everything else asks as in `build`.
 */
const PLAN_ASK_BEFORE_ACTING: OpenCodePermissionRules = {
  ...ASK_BEFORE_ACTING,
  edit: { '*': 'deny', '.opencode/plans/*.md': 'allow' },
};

/**
 * Full access: every action is allowed, so nothing reaches
 * `session/request_permission`, and the `task` tool may start the built-in
 * `general` and `explore` subagents (`plan`, as OpenCode itself does, only
 * `explore`). A subagent's permission requests never reach ACP (see
 * `ASK_BEFORE_ACTING`), so its rules must not ask either:
 *
 * - `external_directory` is restated as `allow`, because a child session
 *   inherits its parent's `external_directory` rules after its own
 *   (`agent/subagent-permissions.ts`, applied last in `session/prompt.ts`),
 *   and OpenCode's default for it is `ask`.
 * - `general` gets `* allow`, overriding OpenCode's and the user's asks
 *   (`.env` reads, outside paths, `doom_loop`).
 * - `explore` keeps its read-only `* deny` and has each tool it is given
 *   restated as `allow`, so a user `ask` cannot reach it.
 *
 * Any other subagent (the user's own) is denied: its rules are unknown and
 * could ask.
 */
const FULL_ACCESS_TASK = {
  '*': 'deny',
  general: 'allow',
  explore: 'allow',
} as const;
const FULL_ACCESS: OpenCodePermissionRules = {
  '*': 'allow',
  external_directory: 'allow',
  task: { ...FULL_ACCESS_TASK },
};
const PLAN_FULL_ACCESS: OpenCodePermissionRules = {
  ...FULL_ACCESS,
  edit: { '*': 'deny', '.opencode/plans/*.md': 'allow' },
  task: { '*': 'deny', explore: 'allow' },
};
const EXPLORE_FULL_ACCESS: OpenCodePermissionRules = Object.fromEntries(
  [
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
  ].map((tool) => [tool, 'allow' as const]),
);

/** Which launch configuration an OpenCode session runs under (#3290). */
export type OpenCodeApprovalFloor = 'confined' | 'full';

/** The configuration Station adds to an OpenCode session it governs. */
export function stationOpenCodeApprovalConfig(
  floor: OpenCodeApprovalFloor,
): Record<string, unknown> {
  if (floor === 'full') {
    return {
      agent: {
        build: { permission: { ...FULL_ACCESS } },
        plan: { permission: { ...PLAN_FULL_ACCESS } },
        general: { permission: { '*': 'allow' } },
        explore: { permission: { ...EXPLORE_FULL_ACCESS } },
      },
    };
  }
  return {
    agent: {
      build: { permission: { ...ASK_BEFORE_ACTING } },
      plan: { permission: { ...PLAN_ASK_BEFORE_ACTING } },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Objects merge key by key; anything else from `overlay` replaces. */
function mergeConfig(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? mergeConfig(existing, value)
        : value;
  }
  return merged;
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
    const parsed: unknown = parse(inherited, errors, {
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
