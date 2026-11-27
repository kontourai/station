/**
 * Station's approval modes on OpenCode 2.x's native transport (PLAN A.5).
 *
 * Over `opencode serve`, Station does not need a launch overlay
 * (`opencode-approval-launch.ts` is the 1.x/ACP route): a session carries
 * its own permission ruleset (`session.create` / `session.update`
 * `permissions`), which OpenCode appends after the agent's configured rules
 * (`core/src/permission.ts` `configured`: `merge(agent.permissions,
 * session.permissions)`), so it is evaluated last among them.
 *
 * What it does not outrank is an approval the person saved ("always"):
 * OpenCode evaluates the configured rules for a deny first, then the
 * configured rules followed by every saved approval for the project, last
 * match wins (`evaluateInput`). A saved allow for a governed action
 * therefore lets that action run without asking, whatever the session's
 * rules say. Station reads the saved approvals and the agent's rules before
 * a governed start and refuses one it could not govern
 * ({@link openCodeSavedApprovalOverrides}), and never saves one itself:
 * a session grant stays in the adapter and is answered `once` (ruling R4).
 */
import { isAbsolute, resolve } from 'node:path';
import type { AcpAppliedApprovalMode } from '../../providers/adapters/acp-approval-mode.js';
import { untrustedPersistenceTarget } from '../plugins/untrusted-persistence-protection.js';

export type OpenCodeRuleEffect = 'allow' | 'deny' | 'ask';

/** One OpenCode 2.x permission rule (`Permission.Rule`). */
export interface OpenCodeNativeRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: OpenCodeRuleEffect;
}

/** One approval the person saved (`GET /api/permission/saved`). */
export interface OpenCodeSavedApproval {
  readonly action: string;
  readonly resource: string;
}

/** OpenCode's wildcard (`core/src/util/wildcard.ts`): `*` any run, `?` one char. */
function openCodeWildcard(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(input.replaceAll('\\', '/'));
}

/** The last rule matching (`Permission.evaluate`); unmatched asks. */
function evaluateOne(
  action: string,
  resource: string,
  rules: readonly OpenCodeNativeRule[],
): OpenCodeRuleEffect {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index] as OpenCodeNativeRule;
    if (
      openCodeWildcard(action, rule.action) &&
      openCodeWildcard(resource, rule.resource)
    )
      return rule.effect;
  }
  return 'ask';
}

/**
 * What OpenCode decides for a request before asking anyone, mirroring
 * `evaluateInput` (2.3.0) without its plugin hook: a configured deny for any
 * resource denies; otherwise the configured rules followed by the saved
 * approvals decide each resource (last match wins), and any resource that
 * would ask makes the request ask.
 */
export function evaluateOpenCodeRules(
  input: { readonly action: string; readonly resources: readonly string[] },
  configured: readonly OpenCodeNativeRule[],
  saved: readonly OpenCodeSavedApproval[],
): OpenCodeRuleEffect {
  if (
    input.resources.some(
      (resource) => evaluateOne(input.action, resource, configured) === 'deny',
    )
  )
    return 'deny';
  const all: OpenCodeNativeRule[] = [
    ...configured,
    ...saved.map((rule) => ({
      action: rule.action,
      resource: rule.resource,
      effect: 'allow' as const,
    })),
  ];
  const effects = input.resources.map((resource) =>
    evaluateOne(input.action, resource, all),
  );
  return effects.includes('ask') ? 'ask' : 'allow';
}

/**
 * The actions Station governs below full access, in OpenCode 2.3.0's names:
 * `shell` (the 1.x `bash`), `edit` (write, edit and patch), `webfetch`,
 * `websearch`, and `external_directory` (any path outside the project).
 * MCP tools are named `<server>_<tool>`, so `*_*` covers them. Reads, search
 * and `question` are left to OpenCode and the person's rules.
 */
const OPENCODE_NATIVE_ASK_ACTIONS = [
  'shell',
  'edit',
  'webfetch',
  'websearch',
  'external_directory',
  '*_*',
] as const;

export type OpenCodeNativeFloor = 'confined' | 'full';

/**
 * The session ruleset for a floor (the v2 counterpart of
 * `stationOpenCodeApprovalConfig`). For the actions the agent's rules
 * govern, Station only ever adds `ask` rules: an `allow` would let an
 * action past the agent's own rules, and a `deny` appended after them
 * would change what they decide for other resources. The one `deny` is
 * for a tool no agent rule governs ({@link OPENCODE_SESSION_MOVE_ACTION}).
 *
 * - `confined` (Ask, Auto, and full access confined to Auto): each governed
 *   action asks, and `subagent` asks and Station rejects it
 *   ({@link openCodeNativeStationRejects}): delegated child work stays out of
 *   a governed session (child-work authority is not Station's yet). A child
 *   OpenCode starts anyway (a `subtask: true` command needs no `subagent`
 *   permission) inherits these rules (`core/src/session.ts` create), so its
 *   asks reach Station too, decided with its own agent's rules.
 *   Because OpenCode lets the last matching rule decide, these asks also
 *   reach Station for actions the agent's own rules deny; Station rejects
 *   those itself ({@link openCodeNativeStationRejects}).
 *   Last, Code Mode's `opencode.session_move` is denied: it moves the
 *   session to another directory without asking when the destination is
 *   inside the project, and OpenCode loads the destination's own
 *   configuration and plugins while it resolves it, before anything is
 *   published (2.3.0 `core/src/session/move.ts`; `move` capture), so no
 *   check after the event can keep that code from running. A wholly denied
 *   tool is left out of the catalog (`core/src/tool.ts` `whollyDisabled`;
 *   `move-denied` capture), and a child inherits the rule.
 * - `full` (full access in a host session): none. The agent's rules decide,
 *   OpenCode asks only where they say ask, and Station answers `once`.
 */
export function openCodeNativeApprovalRules(
  floor: OpenCodeNativeFloor,
): OpenCodeNativeRule[] {
  if (floor === 'full') return [];
  return [
    ...[...OPENCODE_NATIVE_ASK_ACTIONS, 'subagent'].map((action) => ({
      action,
      resource: '*',
      effect: 'ask' as const,
    })),
    { action: OPENCODE_SESSION_MOVE_ACTION, resource: '*', effect: 'deny' },
  ];
}

/**
 * The permission action of Code Mode's `opencode.session_move` (a tool's
 * action is its effective name, `<namespace>_<tool>`: 2.3.0
 * `core/src/tool/runtime.ts` `effectiveName`). It asserts no permission of
 * its own for a destination inside the project, and no agent's rules name
 * it, so a governed session denies it outright
 * ({@link openCodeNativeApprovalRules}).
 */
export const OPENCODE_SESSION_MOVE_ACTION = 'opencode_session_move';

/**
 * #4828 on the native transport: the file an OpenCode ask would change at a
 * known agent-instruction or git-hook location, or undefined. OpenCode asks
 * `edit` for every write, edit and patch (moves and deletes included), naming
 * the files as its resources (relative to the session's directory) and in
 * `metadata.files[].file`; they are classified as the ACP path classifies a
 * write's locations (`acpPersistenceTarget`). A shell command's ask is not:
 * ACP declines only file changes, and leaves a command to the staged
 * evaluator, which the native transport runs for a session started as an
 * Agent as ACP does (`OpenCodeNativeSession` `decideAsk`).
 */
export function openCodeNativePersistenceTarget(
  ask: {
    readonly action: string;
    readonly resources: readonly string[];
    readonly files?: readonly string[];
  },
  /**
   * The asking session's directory, which OpenCode names a file relative
   * to: a relative file is also classified at its absolute path there, so a
   * custom `core.hooksPath` (read for an absolute path only) is found.
   */
  cwd?: string,
): string | undefined {
  if (ask.action !== 'edit') return undefined;
  for (const file of [...ask.resources, ...(ask.files ?? [])]) {
    const paths =
      cwd && !isAbsolute(file) ? [file, resolve(cwd, file)] : [file];
    for (const candidate of paths) {
      const verdict = untrustedPersistenceTarget('edit', { path: candidate });
      if (verdict) return verdict.target;
    }
  }
  return undefined;
}

/**
 * Whether Station rejects an ask, without a person, in a session governed
 * by the confined rules: a request to start a subagent (see
 * {@link openCodeNativeApprovalRules}), and an action the asking agent's own
 * rules deny (evaluated alone, as OpenCode would without Station's asks
 * after them), which stays denied.
 */
export function openCodeNativeStationRejects(
  agentRules: readonly OpenCodeNativeRule[],
  request: { readonly action: string; readonly resources: readonly string[] },
): boolean {
  if (request.action === 'subagent') return true;
  return evaluateOpenCodeRules(request, agentRules, []) === 'deny';
}

/**
 * Whether a session grant covers a request (ruling R4): the grant holds an
 * action and the patterns allowed for it (`*` for the native session's
 * per-action grant), and covers a later request for the same action only
 * when it names at least one resource and every one matches a pattern.
 */
export function openCodeGrantCovers(
  grant: { readonly action: string; readonly patterns: readonly string[] },
  request: { readonly action: string; readonly resources: readonly string[] },
): boolean {
  return (
    grant.action === request.action &&
    request.resources.length > 0 &&
    request.resources.every((resource) =>
      grant.patterns.some((pattern) => openCodeWildcard(resource, pattern)),
    )
  );
}

/**
 * The saved approvals that would let a governed action run without asking
 * in a session with `floor`'s rules after `agentRules`. Each saved approval
 * is evaluated for every governed action its action pattern covers, against
 * the resource it names, the way OpenCode would evaluate a request for it.
 */
export function openCodeSavedApprovalOverrides(
  floor: OpenCodeNativeFloor,
  agentRules: readonly OpenCodeNativeRule[],
  saved: readonly OpenCodeSavedApproval[],
): OpenCodeSavedApproval[] {
  if (floor === 'full') return [];
  const configured = [...agentRules, ...openCodeNativeApprovalRules(floor)];
  // `subagent` too: Station's rules only ask for it, so a saved allow would
  // start a child session without reaching Station.
  return saved.filter((approval) =>
    [...OPENCODE_NATIVE_ASK_ACTIONS, 'subagent'].some((governed) => {
      // The saved action names a concrete action or a pattern; the governed
      // name is checked both ways, since either may be the wider one.
      const action = openCodeWildcard(approval.action, governed)
        ? approval.action
        : openCodeWildcard(governed, approval.action)
          ? governed
          : undefined;
      if (!action) return false;
      return (
        evaluateOpenCodeRules(
          { action, resources: [approval.resource] },
          configured,
          saved,
        ) === 'allow'
      );
    }),
  );
}

/** Why a governed start was refused over saved approvals. */
export function openCodeSavedApprovalRefusal(
  overrides: readonly OpenCodeSavedApproval[],
): string {
  const named = overrides
    .slice(0, 5)
    .map((approval) => `${approval.action} ${approval.resource}`)
    .join(', ');
  return `Station can't apply its approval mode to OpenCode, so the chat was not started: OpenCode has saved approvals that would let actions run without asking (${named}${overrides.length > 5 ? ', …' : ''}). Remove them in OpenCode, or start the chat without a Station approval mode`;
}

/**
 * Whether `mode` answers a request for `action` without a person: full
 * access answers everything, Auto answers edits (as on ACP).
 */
export function openCodeNativeModeAllows(
  mode: AcpAppliedApprovalMode | undefined,
  action: string,
): boolean {
  if (mode === 'never') return true;
  return mode === 'auto' && action === 'edit';
}

/**
 * How Station answers an ask, from the session it runs or a child of it (a
 * child inherits that session's rules; `agentRules` are then the child's
 * own agent's):
 * 1. `reject` without a person when the confined rules govern it and
 *    Station keeps a deny ({@link openCodeNativeStationRejects}; first, so
 *    nothing outranks it);
 * 2. the person, below host full access, for an ask `configNeedsPerson`
 *    says touches OpenCode's own configuration (`opencode.json`,
 *    `.opencode/`, global configuration, anything outside the project):
 *    OpenCode loads it and runs what it declares (MCP servers, plugins)
 *    without asking, so neither a session grant nor a mode answers it;
 * 3. `once` when a session grant or the mode covers it;
 * 4. else the person.
 */
export function openCodeNativeAskAnswer(input: {
  readonly mode: AcpAppliedApprovalMode | undefined;
  /** The asking agent's own rules while the confined rules govern; else undefined. */
  readonly agentRules: readonly OpenCodeNativeRule[] | undefined;
  readonly request: {
    readonly action: string;
    readonly resources: readonly string[];
  };
  readonly granted: boolean;
  /** Read only when a grant or a mode below full access would answer. */
  readonly configNeedsPerson: () => boolean;
}): 'reject' | 'once' | 'person' {
  if (
    input.agentRules &&
    openCodeNativeStationRejects(input.agentRules, input.request)
  )
    return 'reject';
  const covered =
    input.granted || openCodeNativeModeAllows(input.mode, input.request.action);
  if (!covered) return 'person';
  if (input.mode !== 'never' && input.configNeedsPerson()) return 'person';
  return 'once';
}
