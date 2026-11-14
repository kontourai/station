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
import type { AcpAppliedApprovalMode } from '../../providers/adapters/acp-approval-mode.js';

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
 * `stationOpenCodeApprovalConfig`):
 *
 * - `confined` (Ask, Auto, and full access confined to Auto): each governed
 *   action asks, and Station answers by the mode. `subagent` is denied: a
 *   child session is created with its own agent's rules, not these.
 * - `full` (full access in a host session): everything is allowed.
 */
export function openCodeNativeApprovalRules(
  floor: OpenCodeNativeFloor,
): OpenCodeNativeRule[] {
  if (floor === 'full')
    return [{ action: '*', resource: '*', effect: 'allow' }];
  return [
    ...OPENCODE_NATIVE_ASK_ACTIONS.map((action) => ({
      action,
      resource: '*',
      effect: 'ask' as const,
    })),
    { action: 'subagent', resource: '*', effect: 'deny' },
  ];
}

const STRICTNESS: Record<OpenCodeRuleEffect, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * The session ruleset Station sends for `floor` on an agent whose own rules
 * are `agentRules`. OpenCode evaluates the agent's rules and then the
 * session's, last match wins, so Station's rules alone would outrank an
 * agent's deny: the plan agent's `edit * deny` would become Station's
 * `edit * ask` (or full access's allow), and a mode that answers edits would
 * then let them run. Station's rules never weaken a deny: each deny the
 * agent's rules still decide by is appended after them, followed by the
 * agent's later, narrower rules for the same action (the plan agent's own
 * plan-file exception), each made no looser than Station's rule for it.
 */
export function openCodeNativeSessionRules(
  floor: OpenCodeNativeFloor,
  agentRules: readonly OpenCodeNativeRule[],
): OpenCodeNativeRule[] {
  const station = openCodeNativeApprovalRules(floor);
  const kept: OpenCodeNativeRule[] = [];
  agentRules.forEach((rule, index) => {
    if (rule.effect !== 'deny') return;
    // A deny a later agent rule overrides does not decide; restoring it
    // would make Station stricter than the agent itself.
    if (evaluateOne(rule.action, rule.resource, agentRules) !== 'deny') return;
    kept.push(rule);
    for (const later of agentRules.slice(index + 1)) {
      if (later.action !== rule.action || later.effect === 'deny') continue;
      const stationEffect = evaluateOne(later.action, later.resource, station);
      kept.push({
        ...later,
        effect:
          STRICTNESS[stationEffect] > STRICTNESS[later.effect]
            ? stationEffect
            : later.effect,
      });
    }
  });
  return [...station, ...kept];
}

/**
 * Whether a session grant covers a request (ruling R4, scoped): the grant
 * holds the action and the patterns the person allowed (OpenCode's `save`
 * patterns for the ask, else its exact resources), and covers a later
 * request for the same action only when every resource it names matches one
 * of them.
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
  const configured = [
    ...agentRules,
    ...openCodeNativeSessionRules(floor, agentRules),
  ];
  return saved.filter((approval) =>
    OPENCODE_NATIVE_ASK_ACTIONS.some((governed) => {
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
