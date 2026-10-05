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
 * 1.18.18, `config/config.ts`). Station uses that channel to set ONE floor:
 * the `build` and `plan` agents ask before every action that is not a read.
 * Station then answers each request by the chat's approval mode
 * (`acp-adapter.ts`), so a mode change takes effect on the next request, with
 * no engine round trip and no restart.
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
 *   Station cannot govern a subagent, so none is started. A `* deny` rule
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

/** The configuration Station adds to every OpenCode session it launches. */
export function stationOpenCodeApprovalConfig(): Record<string, unknown> {
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
      mergeConfig(base, stationOpenCodeApprovalConfig()),
    ),
  };
}
