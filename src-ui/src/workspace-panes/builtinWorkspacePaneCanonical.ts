import {
  isCanonicalBasisWorkspacePaneDescriptor,
  WORKSPACE_BASIS_PANE_DESCRIPTOR,
} from '@kontourai/station-basis-pane/workspace-basis-pane';
import { WORKSPACE_BOARD_PANE_DESCRIPTOR } from '@kontourai/station-board-pane/workspace-board-pane';
import { WORKSPACE_ACTIVITY_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-activity-pane';
import {
  WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_NAME,
} from '@kontourai/station-contracts/workspace-browser-preview';
import { WORKSPACE_CHAT_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-chat-pane';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import {
  WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_FILE_PREVIEW_PANE_RENDERER_NAME,
} from '@kontourai/station-contracts/workspace-file-preview';
import { WORKSPACE_HOME_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-home-pane';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  isRegisteredBuiltinWorkspacePaneRendererName,
  BUILTIN_WORKSPACE_PANE_RENDERER_NAMES as SHARED_BUILTIN_WORKSPACE_PANE_RENDERER_NAMES,
} from '@kontourai/station-contracts/workspace-pane-builtin-renderers';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-spatial-board';
import {
  WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
  WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-task-room';

/**
 * Which built-in renderers this host build admits, and whether a given
 * descriptor is the exact declaration each of them was registered for.
 *
 * This is deliberately separate from the component table in
 * `builtinWorkspacePaneRegistry.tsx`. Both answer questions about the same
 * built-ins, but only one of them needs React: presence is a comparison
 * between a candidate descriptor and a frozen contract constant, and the
 * renderer-selection path (`selectClientWorkspacePaneRenderer`) asks only
 * that question. Keeping them in one module meant every caller of the
 * selector also loaded Chat, the Coding panels, Flow and the evidence
 * inspectors — measured at ~800kB of statically-reachable chunk. Home is
 * a Pane on the root route, so it is the caller that made that cost visible.
 *
 * `flow-run-console` is the one legacy exception to exact-descriptor
 * comparison. It has several host-derived builtin descriptors rather than a
 * single frozen contract constant. It is therefore admitted only when its
 * descriptor retains builtin provenance; a plugin may not reach it merely by
 * reusing its renderer name.
 *
 * The two modules cannot drift: `BuiltinWorkspacePaneRendererName` below is
 * the key type of the component table, so a name registered here without a
 * component (or a component without a name) fails to typecheck.
 */

/**
 * Every built-in Workspace Pane renderer name this host build registers.
 *
 * station#3798 moved the inventory itself into the contracts package, because
 * the SERVER decides whether a builtin layout contributes a Pane at all and
 * cannot import this module. Deriving the union from that one list keeps the
 * two halves in lockstep by construction rather than by a duplicate literal:
 * the component table below is a `Record` over this union, so a name in the
 * inventory without a component (or a component without a name) still fails
 * to typecheck.
 */
export type BuiltinWorkspacePaneRendererName =
  (typeof SHARED_BUILTIN_WORKSPACE_PANE_RENDERER_NAMES)[number];

function canonicalBuiltinCoding(projectId: string, layoutSlug: string) {
  return paneAdaptationFromLayoutTab(
    {
      id: 'coding',
      label: 'Coding',
      component: { kind: 'builtin-component', name: 'coding' },
    },
    {
      layoutSlug,
      instanceScope: `project:${projectId}:source:builtin:coding`,
      modeContextRequirement: { project: true, source: true },
      boundContext: { projectId, sourceId: 'builtin:coding' },
    },
  );
}

function isCanonicalBuiltinCodingDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  const prefix = 'pane:builtin:';
  const suffix = ':coding';
  if (!descriptor.id.startsWith(prefix) || !descriptor.id.endsWith(suffix)) {
    return false;
  }
  let layoutSlug: string;
  try {
    layoutSlug = decodeURIComponent(
      descriptor.id.slice(prefix.length, -suffix.length),
    );
  } catch {
    return false;
  }
  const expected = canonicalBuiltinCoding('identity-only', layoutSlug);
  return (
    !!expected &&
    descriptor.id === expected.descriptor.id &&
    descriptor.rendererId === expected.descriptor.rendererId &&
    descriptor.provenance.origin === 'builtin'
  );
}

function isCanonicalBuiltinFlowRunConsoleDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  // Flow's descriptors are generated by more than one host, so there is no
  // single descriptor constant to compare. Its builtin provenance remains a
  // required part of the admission boundary.
  return (
    descriptor.renderer.kind === 'builtin-component' &&
    descriptor.renderer.name === 'flow-run-console' &&
    descriptor.provenance.origin === 'builtin' &&
    descriptor.provenance.pluginId === undefined &&
    descriptor.provenance.mcpServerId === undefined
  );
}

export function isCanonicalBuiltinCodingOccurrence(
  instance: WorkspacePaneInstance,
  descriptor?: WorkspacePaneDescriptor,
): boolean {
  if (!descriptor || !isCanonicalBuiltinCodingDescriptor(descriptor))
    return false;
  const projectId = instance.boundContext?.projectId;
  if (!projectId) return false;
  const prefix = 'pane:builtin:';
  const suffix = ':coding';
  let layoutSlug: string;
  try {
    layoutSlug = decodeURIComponent(
      descriptor.id.slice(prefix.length, -suffix.length),
    );
  } catch {
    return false;
  }
  const expected = canonicalBuiltinCoding(projectId, layoutSlug);
  return (
    !!expected &&
    descriptor.id === expected.descriptor.id &&
    instance.descriptorId === expected.instance.descriptorId &&
    instance.instanceId === expected.instance.instanceId &&
    instance.stateKey === expected.instance.stateKey &&
    instance.boundContext?.projectId === projectId &&
    instance.boundContext?.sourceId === 'builtin:coding'
  );
}

function sameBuiltinDescriptor(
  descriptor: WorkspacePaneDescriptor,
  expected: WorkspacePaneDescriptor,
): boolean {
  if (
    descriptor.renderer.kind !== 'builtin-component' ||
    expected.renderer.kind !== 'builtin-component'
  )
    return false;
  const hasSameKeys = (value: object, other: object) => {
    const keys = Object.keys(value);
    return (
      keys.length === Object.keys(other).length &&
      keys.every((key) => Object.hasOwn(other, key))
    );
  };
  return (
    hasSameKeys(descriptor, expected) &&
    hasSameKeys(descriptor.renderer, expected.renderer) &&
    hasSameKeys(descriptor.placement, expected.placement) &&
    hasSameKeys(descriptor.provenance, expected.provenance) &&
    JSON.stringify(descriptor.modes) === JSON.stringify(expected.modes) &&
    hasSameKeys(descriptor.lifecycle, expected.lifecycle) &&
    descriptor.version === expected.version &&
    descriptor.id === expected.id &&
    descriptor.name === expected.name &&
    descriptor.description === expected.description &&
    descriptor.rendererId === expected.rendererId &&
    descriptor.renderer.kind === expected.renderer.kind &&
    descriptor.renderer.name === expected.renderer.name &&
    descriptor.placement.preferredRegion ===
      expected.placement.preferredRegion &&
    descriptor.placement.supportedRegions.join('|') ===
      expected.placement.supportedRegions.join('|') &&
    descriptor.placement.order === expected.placement.order &&
    descriptor.provenance.origin === 'builtin' &&
    descriptor.provenance.pluginId === undefined &&
    descriptor.provenance.mcpServerId === undefined &&
    descriptor.lifecycle.stage === 'preview' &&
    descriptor.lifecycle.since === undefined &&
    descriptor.lifecycle.deprecationNotice === undefined
  );
}

export function isCanonicalBuiltinCodingFileBrowserDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(
    descriptor,
    WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  );
}

export function isCanonicalBuiltinChatDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(descriptor, WORKSPACE_CHAT_PANE_DESCRIPTOR);
}

export function isCanonicalBuiltinTaskRoomChatDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(descriptor, WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR);
}

export function isCanonicalBuiltinTaskRoomEditorDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(
    descriptor,
    WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
  );
}

/**
 * Home's built-in declaration, compared field by field like every other
 * built-in. `sameBuiltinDescriptor` requires `provenance.origin === 'builtin'`
 * with no `pluginId`, so a contributed descriptor cannot reach the built-in
 * Home renderer by reusing its renderer name.
 */
export function isCanonicalBuiltinHomeDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(descriptor, WORKSPACE_HOME_PANE_DESCRIPTOR);
}

/**
 * Activity's built-in declaration, compared field by field like every other
 * built-in — a plugin cannot reach the built-in sessions surface by reusing
 * its renderer name.
 */
export function isCanonicalBuiltinActivityDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(descriptor, WORKSPACE_ACTIVITY_PANE_DESCRIPTOR);
}

/**
 * The Console Board's declaration (epic station#4142 M4a) — the first
 * built-in whose descriptor is authored outside the contracts package, in
 * `@kontourai/station-board-pane`. Same field-by-field
 * comparison as every sibling: a plugin cannot reach the built-in Board
 * renderer by reusing its renderer name.
 */
export function isCanonicalBuiltinBoardDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(descriptor, WORKSPACE_BOARD_PANE_DESCRIPTOR);
}

export function isCanonicalBuiltinSpatialBoardDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(
    descriptor,
    WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR,
  );
}

export function isCanonicalBuiltinCodingDiffDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(
    descriptor,
    WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  );
}

export function isCanonicalBuiltinCodingTerminalDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(
    descriptor,
    WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
  );
}

export function isCanonicalBuiltinPlanDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(descriptor, WORKSPACE_PLAN_PANE_DESCRIPTOR);
}

export function isCanonicalBuiltinReadinessDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(descriptor, WORKSPACE_READINESS_PANE_DESCRIPTOR);
}

export function isCanonicalBuiltinTrustDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return sameBuiltinDescriptor(descriptor, WORKSPACE_TRUST_PANE_DESCRIPTOR);
}

export function isCanonicalBuiltinBrowserPreviewDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return (
    descriptor.id === WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.id &&
    descriptor.name === WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.name &&
    descriptor.description ===
      WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.description &&
    descriptor.rendererId ===
      WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.rendererId &&
    descriptor.renderer.kind === 'builtin-component' &&
    descriptor.renderer.name === WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_NAME &&
    descriptor.placement.preferredRegion === 'secondary' &&
    descriptor.placement.supportedRegions.join('|') ===
      WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.placement.supportedRegions.join(
        '|',
      ) &&
    descriptor.placement.order === undefined &&
    descriptor.provenance.origin === 'builtin' &&
    descriptor.provenance.pluginId === undefined &&
    descriptor.provenance.mcpServerId === undefined &&
    JSON.stringify(descriptor.modes) ===
      JSON.stringify(WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.modes) &&
    descriptor.lifecycle.stage === 'preview' &&
    descriptor.lifecycle.since === undefined &&
    descriptor.lifecycle.deprecationNotice === undefined &&
    descriptor.icon === undefined &&
    descriptor.actions === undefined &&
    descriptor.alternativeRenderer === undefined
  );
}

export function isCanonicalBuiltinFilePreviewDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return (
    descriptor.id === WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.id &&
    descriptor.name === WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.name &&
    descriptor.description ===
      WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.description &&
    descriptor.rendererId ===
      WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.rendererId &&
    descriptor.renderer.kind === 'builtin-component' &&
    descriptor.renderer.name === WORKSPACE_FILE_PREVIEW_PANE_RENDERER_NAME &&
    descriptor.placement.preferredRegion === 'secondary' &&
    descriptor.placement.supportedRegions.join('|') ===
      WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.placement.supportedRegions.join(
        '|',
      ) &&
    descriptor.placement.order === undefined &&
    descriptor.provenance.origin === 'builtin' &&
    descriptor.provenance.pluginId === undefined &&
    descriptor.provenance.mcpServerId === undefined &&
    JSON.stringify(descriptor.modes) ===
      JSON.stringify(WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.modes) &&
    descriptor.lifecycle.stage === 'preview' &&
    descriptor.lifecycle.since === undefined &&
    descriptor.lifecycle.deprecationNotice === undefined &&
    descriptor.icon === undefined &&
    descriptor.actions === undefined &&
    descriptor.alternativeRenderer === undefined
  );
}

/**
 * Whether this descriptor is the exact declaration one of this build's
 * built-in renderers was registered for. The host admits only direct, stable
 * built-ins; plugin and MCP hosting remain their own boundary.
 */
export function isCanonicalBuiltinWorkspacePaneDescriptor(
  descriptor: WorkspacePaneDescriptor,
  instance?: WorkspacePaneInstance,
): boolean {
  if (descriptor.renderer.kind !== 'builtin-component') return false;
  const name = descriptor.renderer.name;
  if (name === 'flow-run-console') {
    return isCanonicalBuiltinFlowRunConsoleDescriptor(descriptor);
  }
  if (
    name === 'workspace-basis' &&
    !isCanonicalBasisWorkspacePaneDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-chat' &&
    !isCanonicalBuiltinChatDescriptor(descriptor) &&
    !isCanonicalBuiltinTaskRoomChatDescriptor(descriptor)
  )
    return false;
  if (
    name === 'task-room-editor' &&
    !isCanonicalBuiltinTaskRoomEditorDescriptor(descriptor)
  )
    return false;
  if (
    name === 'coding' &&
    !(instance
      ? isCanonicalBuiltinCodingOccurrence(instance, descriptor)
      : isCanonicalBuiltinCodingDescriptor(descriptor))
  )
    return false;
  if (
    name === 'workspace-browser-preview' &&
    !isCanonicalBuiltinBrowserPreviewDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-file-preview' &&
    !isCanonicalBuiltinFilePreviewDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-coding-file-browser' &&
    !isCanonicalBuiltinCodingFileBrowserDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-coding-diff' &&
    !isCanonicalBuiltinCodingDiffDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-coding-terminal' &&
    !isCanonicalBuiltinCodingTerminalDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-plan' &&
    !isCanonicalBuiltinPlanDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-readiness' &&
    !isCanonicalBuiltinReadinessDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-trust' &&
    !isCanonicalBuiltinTrustDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-home' &&
    !isCanonicalBuiltinHomeDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-activity' &&
    !isCanonicalBuiltinActivityDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-board' &&
    !isCanonicalBuiltinBoardDescriptor(descriptor)
  )
    return false;
  if (
    name === 'workspace-spatial-board' &&
    !isCanonicalBuiltinSpatialBoardDescriptor(descriptor)
  )
    return false;
  return isRegisteredBuiltinWorkspacePaneRendererName(name);
}

export function builtinWorkspacePaneRendererPresence(
  descriptor: WorkspacePaneDescriptor,
): 'present' | 'missing' {
  return isCanonicalBuiltinWorkspacePaneDescriptor(descriptor)
    ? 'present'
    : 'missing';
}

/**
 * Every built-in descriptor this build knows, keyed by its id.
 *
 * It exists because a pane's NAME was already sitting on its descriptor while
 * the tab strip printed raw `pane:builtin:…` identifiers at people
 * (station#3971) — a name the product had and did not use. The list is the
 * same one the canonical checks above are written against; adding a built-in
 * without adding it here is caught by the completeness test that walks the
 * renderer-name table.
 */
const BUILTIN_WORKSPACE_PANE_DESCRIPTORS: readonly WorkspacePaneDescriptor[] = [
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_BASIS_PANE_DESCRIPTOR,
  WORKSPACE_BOARD_PANE_DESCRIPTOR,
  WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
  WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR,
  WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
  WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
];

const BUILTIN_WORKSPACE_PANE_NAMES_BY_ID = new Map(
  BUILTIN_WORKSPACE_PANE_DESCRIPTORS.map((descriptor) => [
    descriptor.id,
    descriptor.name,
  ]),
);

/**
 * The built-in pane's own name, or `null` when this build has no built-in
 * under that id — a plugin or MCP-hosted pane, whose name is its host's to
 * supply. Returning null rather than the id keeps the "we do not know this
 * pane" case distinguishable from "this pane is called that".
 */
export function builtinWorkspacePaneName(
  descriptorId: WorkspacePaneDescriptor['id'],
): string | null {
  return BUILTIN_WORKSPACE_PANE_NAMES_BY_ID.get(descriptorId) ?? null;
}
