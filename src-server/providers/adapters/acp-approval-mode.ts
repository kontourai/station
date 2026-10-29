/**
 * #3290: how Station's approval mode answers an ACP engine's permission
 * requests, on a connection whose approval rules Station sets at launch
 * (`acpApprovalControl` is `station`; see `opencode-approval-launch.ts`).
 *
 * The engine is launched asking before every action that is not a read, so
 * every such action reaches `session/request_permission`. The mode then
 * decides who answers:
 *
 * - `ask`: a person, through Station's approval card.
 * - `auto`: Station allows a file edit (ACP tool kind `edit`); everything
 *   else goes to a person.
 * - `never` (full access): Station allows every request.
 *
 * A request addressed to a person (a plan exit or a question,
 * `toolRequestNeedsPerson`) is never answered by the mode, and a rule the
 * engine itself denies never reaches Station at all.
 */
import type {
  ApprovalMode,
  StationConfinement,
} from '@kontourai/station-contracts/provider';

export type AcpAppliedApprovalMode = 'ask' | 'auto' | 'never';

/**
 * The mode a Station-governed ACP session applies for a requested one.
 *
 * Nothing requested applies nothing (owner decision, 2026-10-05): as on
 * Claude and Codex, the server sends no mode while a chat is at Default with
 * no Agent or Station default and Station has set no posture on it
 * (`resolveDefaultPick`), and the engine's own configuration decides. A
 * literal `connection-default` is not sent by the server; if one arrives it
 * applies `ask`, the strictest mode. Full access outside a `host` session
 * applies `auto` (#2493): an ACP engine has no process sandbox to confine it
 * with. The server already sends `auto` there (`approval-posture.ts`); this
 * keeps the adapter from widening a request that reaches it some other way.
 */
export function acpAppliedApprovalMode(
  requested: ApprovalMode | undefined,
  confinement: StationConfinement | undefined,
): AcpAppliedApprovalMode | undefined {
  if (requested === undefined) return undefined;
  if (requested === 'never') return confinement === 'host' ? 'never' : 'auto';
  if (requested === 'auto') return 'auto';
  return 'ask';
}

/**
 * The launch configuration an applied mode needs (`opencode-approval-launch.ts`):
 * none while the engine's own configuration decides, `full` for full access,
 * `confined` otherwise. A session whose floor differs is relaunched.
 */
export function acpApprovalFloor(
  mode: AcpAppliedApprovalMode | undefined,
): 'confined' | 'full' | undefined {
  if (mode === undefined) return undefined;
  return mode === 'never' ? 'full' : 'confined';
}

/** Whether `mode` answers a request of this ACP tool kind without a person. */
export function acpApprovalModeAllows(
  mode: AcpAppliedApprovalMode | undefined,
  toolKind: unknown,
): boolean {
  if (mode === 'never') return true;
  return mode === 'auto' && toolKind === 'edit';
}

/** Why an approval mode is refused on an ACP engine that decides for itself. */
export const ACP_ENGINE_DECIDES_APPROVAL_MESSAGE =
  "This engine decides which of its actions ask before they run, so Station's approval mode does not apply to it.";

/**
 * #3290: the OpenCode agents Station sets approval rules for. A user's own
 * primary agent (or a project `default_agent`) keeps its own rules, so while
 * Station governs a session it runs only these.
 */
const OPENCODE_GOVERNED_MODES: readonly string[] = ['build', 'plan'];

export function isOpenCodeGovernedMode(modeId: string): boolean {
  return OPENCODE_GOVERNED_MODES.includes(modeId);
}

export function governedModeRefusal(modeId: string): string {
  return `Station's approval modes cover OpenCode's build and plan agents only; the ${modeId} agent keeps its own permission rules.`;
}
