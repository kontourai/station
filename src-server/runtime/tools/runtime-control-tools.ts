/**
 * Classification of the station-control tool surface (S3 item 4).
 *
 * Every tool the station-control MCP server registers is classified as
 * either READ-ONLY (list/get/navigate/status — safe for auto-approve, never
 * policy-gated), BOUNDED-WRITE (writes something bounded and owner-directed —
 * auto-approved, not a platform mutation; #2584) or MUTATING (platform
 * create/update/delete, installs, scheduler actions, config writes, agent
 * dispatch — subject to the platform-mutation gate in policy-opted
 * workspaces). The classification
 * completeness test in `src-server/tools/__tests__` asserts the union covers
 * the full registered tool surface, so a new tool cannot ship unclassified.
 */

import {
  STATION_CONTROL_TOOL_POLICY,
  type StationControlToolClass,
} from '../../tools/station-control-policy.js';

/**
 * #2377 slice A: the three lists are DERIVED from the one station-control
 * authority table (`tools/station-control-policy.ts`, `toolClass`), never
 * kept by hand beside it. A hand list drifted twice: `list_layouts`/
 * `get_layout` stayed classified after their tools were removed, and the
 * Basis and session-inventory tools were never added, so the fail-safe
 * default gated three reads as mutations.
 *
 * - read-only: list/get/navigate/status — safe for auto-approve, never
 *   policy-gated.
 * - bounded-write (#2584): writes something bounded and owner-directed, so
 *   it is auto-approved for every agent and is not a platform mutation
 *   (`notify_user`: one redacted, capped, rate-limited inbox record for the
 *   calling session's own readers).
 * - mutating: platform create/update/delete, installs, scheduler actions,
 *   config writes, agent dispatch — subject to the platform-mutation gate in
 *   policy-opted workspaces.
 */
function toolNamesOfClass(toolClass: StationControlToolClass): string[] {
  return Object.entries(STATION_CONTROL_TOOL_POLICY)
    .filter(([, policy]) => policy.toolClass === toolClass)
    .map(([name]) => name);
}

const SC_READ_ONLY_TOOL_NAMES = toolNamesOfClass('read-only');
const SC_MUTATING_TOOL_NAMES = toolNamesOfClass('mutating');
const SC_AUTO_APPROVED_SIDE_EFFECT_TOOL_NAMES =
  toolNamesOfClass('bounded-write');

const SC_TOOL_NAME_PREFIXES = ['station-control_', 'stationControl_'];

export const SC_READ_ONLY_TOOLS = SC_READ_ONLY_TOOL_NAMES.map(
  (toolName) => `station-control_${toolName}`,
);

export const SC_MUTATING_TOOLS = SC_MUTATING_TOOL_NAMES.map(
  (toolName) => `station-control_${toolName}`,
);

export const SC_AUTO_APPROVED_SIDE_EFFECT_TOOLS =
  SC_AUTO_APPROVED_SIDE_EFFECT_TOOL_NAMES.map(
    (toolName) => `station-control_${toolName}`,
  );

/** Every station-control tool an agent may call without an approval prompt. */
export const SC_AUTO_APPROVED_TOOLS = [
  ...SC_READ_ONLY_TOOLS,
  ...SC_AUTO_APPROVED_SIDE_EFFECT_TOOLS,
];

const READ_ONLY_SET: ReadonlySet<string> = new Set(SC_READ_ONLY_TOOL_NAMES);
const MUTATING_SET: ReadonlySet<string> = new Set(SC_MUTATING_TOOL_NAMES);
const BOUNDED_WRITE_SET: ReadonlySet<string> = new Set(
  SC_AUTO_APPROVED_SIDE_EFFECT_TOOL_NAMES,
);

/** Strip the integration prefix a tool loader may have applied. */
export function bareControlToolName(toolName: string): string {
  for (const prefix of SC_TOOL_NAME_PREFIXES) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}

type ControlToolClass = StationControlToolClass;

/**
 * Classify a station-control tool name (prefixed or bare). Unknown names
 * classify as MUTATING — fail-safe: a new unclassified tool gets gated until
 * it is explicitly classified, never silently waved through.
 */
export function classifyControlTool(toolName: string): ControlToolClass {
  const bare = bareControlToolName(toolName);
  if (READ_ONLY_SET.has(bare)) return 'read-only';
  if (BOUNDED_WRITE_SET.has(bare)) return 'bounded-write';
  if (MUTATING_SET.has(bare)) return 'mutating';
  return 'mutating';
}

/** True when the bare name is explicitly classified in one of the three lists. */
export function isClassifiedControlTool(toolName: string): boolean {
  const bare = bareControlToolName(toolName);
  return (
    READ_ONLY_SET.has(bare) ||
    BOUNDED_WRITE_SET.has(bare) ||
    MUTATING_SET.has(bare)
  );
}
