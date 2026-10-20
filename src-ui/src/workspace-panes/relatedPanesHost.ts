import type { LayoutCatalogContribution } from '@kontourai/station-contracts/layout';
import {
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneBoundContext,
  type WorkspacePaneInstance,
  type WorkspacePaneRelationRole,
  type WorkspacePaneSuppliableContexts,
  workspacePaneModesSatisfiableBy,
} from '@kontourai/station-contracts/workspace-pane';
import type {
  PaneRelatedPanesHost,
  RelatedPaneOpenOutcome,
  RelatedPaneOpenRequest,
  RelatedPanePresentation,
  RelatedPaneTarget,
  RelatedPaneUnavailable,
  RelatedPaneUnavailableReason,
} from '@kontourai/station-contracts/workspace-pane-host-contract';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { isDistinctFrameOrigin } from '../components/mcp-ui/frameOrigin';
import { pluginRelatedPaneBudget } from '../components/plugins/plugin-frame-budget';
import { useConfig } from '../contexts/ConfigContext';
import { navigationStore } from '../contexts/navigation-store';
import {
  openRelatedOccurrence,
  type RelatedOpenModel,
  type RelatedOpenRefusal,
  relatedOccurrenceExists,
  revealRelatedOccurrence,
} from '../contexts/openRelatedOccurrence';
import {
  type PaneRelationsValue,
  usePaneRelations,
} from '../contexts/PaneRelationsContext';
import {
  type RegionModelValue,
  useRegionModelOptional,
} from '../contexts/RegionModelContext';
import type { PaneOpener, PaneRelation } from '../regions/pane-relations';
import { occupiedRegion } from '../regions/region-model';
import { forgetRegionPaneState } from '../regions/region-surface-panes';
import {
  createPluginPaneStatePreparation,
  isBoundedPaneText,
  mintPluginPaneId,
  PLUGIN_PANE_ID,
  type PluginPaneScope,
  type PluginPaneState,
} from './pluginPaneOccurrence';
import {
  type ResolvedWorkspacePaneCatalogEntry,
  useResolvedWorkspacePaneCatalog,
} from './resolvedWorkspacePaneCatalog';
import { useDockProject } from './useDockProject';
import {
  resolveClientTrustedPluginLayout,
  selectClientWorkspacePaneRenderer,
} from './workspacePaneRendererSelection';

/**
 * The host half of `PaneRelatedPanesHost` (docs/design/pane-relationships.md):
 * ONE implementation for both transports. A trusted direct plugin pane gets
 * it through the SDK provider (`useRelatedPanes`); a sandboxed frame's
 * messages are decoded by `framePaneHost` and call these same members. So
 * admission, the budget and every refusal agree by construction.
 *
 * What the host owns and the plugin never supplies: the opener (the caller's
 * occurrence), the exact Station, the captured scope (the caller's own
 * identity fields, never widened), the installed generation and the
 * presentation. Placement runs through the shared related-occurrence
 * pipeline (`openRelatedOccurrence`): guards first, then a locked, freshly
 * read commit that a refusal rolls back.
 */

/** The occurrence a capability is bound to, as its mounter knows it. */
export interface RelatedPaneCaller {
  /** Its region surface id, else its pane instance id. */
  readonly occurrenceId: string;
  /** The installed plugin that owns its renderer. */
  readonly pluginId: string;
  /** That plugin's installed generation (`pluginInstallGeneration`). */
  readonly generation: string;
  readonly projectId: string;
  readonly projectSlug: string;
  /** The Project layout it is a tab of, if it is one. */
  readonly layoutSlug: string | null;
  /** Its captured scope; a related pane gets at most this. */
  readonly scope: PluginPaneScope;
  /** What a related pane's Up names. */
  readonly label: string;
  /** For a related occurrence itself: the target it was opened for. */
  readonly target: RelatedPaneTarget | null;
}

const SCOPE_KEYS = [
  'taskId',
  'sessionId',
  'runId',
  'workspaceId',
  'sourceId',
] as const;

/**
 * The installed plugin a contribution names, as the generation a related
 * occurrence records: its id, version and installation source. A disabled or
 * removed plugin offers no contribution, and an update changes the version,
 * so either makes an occurrence opened under the old one unavailable; the
 * same installation enabled again is the same generation.
 */
export function pluginInstallGeneration(
  contribution: LayoutCatalogContribution | undefined,
): string | null {
  const pluginId = contribution?.provenance?.pluginId;
  const source = contribution?.sourceIdentity;
  if (contribution?.provenance?.origin !== 'plugin' || !pluginId || !source)
    return null;
  return `plugin:${pluginId}@${contribution.version}:${source.kind}:${source.id}:${source.source}`;
}

function scopeOf(context: WorkspacePaneBoundContext | undefined) {
  const scope: PluginPaneScope = {};
  for (const key of SCOPE_KEYS) {
    const value = context?.[key];
    if (isBoundedPaneText(value, 256)) scope[key] = value;
  }
  return scope;
}

/**
 * The caller a mounted plugin occurrence is, or null when its instance names
 * no installed plugin contribution (a draft, an MCP pane).
 */
export function relatedPaneCaller(input: {
  occurrenceId: string;
  instance: WorkspacePaneInstance;
  projectId: string;
  projectSlug: string;
  layoutSlug: string | null;
  label: string;
  target?: RelatedPaneTarget | null;
}): RelatedPaneCaller | null {
  const contribution = input.instance.boundContext?.contribution;
  const generation = pluginInstallGeneration(contribution);
  const pluginId = contribution?.provenance.pluginId;
  if (!generation || !pluginId) return null;
  return {
    occurrenceId: input.occurrenceId,
    pluginId,
    generation,
    projectId: input.projectId,
    projectSlug: input.projectSlug,
    layoutSlug: input.layoutSlug,
    scope: scopeOf(input.instance.boundContext),
    label: input.label.slice(0, 160) || 'Plugin pane',
    target: input.target ?? null,
  };
}

/**
 * The catalog entry a plugin may open as a related pane: one of ITS OWN
 * descriptors, with the server-issued Project-bound contribution of that same
 * plugin. Another plugin's descriptor, a built-in or an MCP pane is unknown
 * to the caller by construction.
 */
export function ownedPluginDescriptor(
  entries: readonly ResolvedWorkspacePaneCatalogEntry[],
  pluginId: string,
  descriptorId: string,
): ResolvedWorkspacePaneCatalogEntry | undefined {
  return entries.find(
    (entry) =>
      String(entry.descriptor.id) === descriptorId &&
      entry.descriptor.provenance.origin === 'plugin' &&
      entry.descriptor.provenance.pluginId === pluginId &&
      entry.instance?.boundContext?.contribution?.provenance?.origin ===
        'plugin' &&
      entry.instance.boundContext.contribution.provenance.pluginId === pluginId,
  );
}

/** The occurrence a related plugin pane renders as, with its catalog authority. */
export function relatedPluginPaneInstance(
  id: string,
  state: Pick<PluginPaneState, 'descriptorId' | 'projectId' | 'scope'>,
  contribution: LayoutCatalogContribution,
): WorkspacePaneInstance | null {
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: state.descriptorId,
    instanceId: id,
    stateKey: id,
    boundContext: {
      projectId: state.projectId,
      ...state.scope,
      contribution,
    },
  });
}

interface RendererSupport {
  mcpAppsEnabled: boolean;
  pluginFramesEnabled: boolean;
}

/**
 * Whether the live plugin registry admits this descriptor's plugin renderer
 * for an occurrence bound to `contribution` now. Only plugin-component
 * renderers open as related panes; any other renderer kind is not offered.
 */
export function relatedPluginRendererAdmitted(
  entry: ResolvedWorkspacePaneCatalogEntry,
  instance: WorkspacePaneInstance,
  support: RendererSupport,
): boolean {
  const selection = selectClientWorkspacePaneRenderer(entry.descriptor, {
    ...support,
    instance,
  });
  return (
    selection.state === 'selected' &&
    selection.candidate.renderer.kind === 'plugin-component' &&
    resolveClientTrustedPluginLayout(
      entry.descriptor,
      selection.candidate,
      instance,
    ) !== null
  );
}

/** The live shell facts a request is admitted against, read when it arrives. */
export interface LiveRelatedPanes {
  model: (RelatedOpenModel & Pick<RegionModelValue, 'removePane'>) | null;
  relations: PaneRelationsValue;
  catalog: {
    projectId?: string;
    projectSlug?: string;
    entries: readonly ResolvedWorkspacePaneCatalogEntry[];
  };
  dockProject: { projectId: string | null; projectSlug: string | null };
  rendererSupport: RendererSupport;
}

type AdmissionRefusal = Extract<
  RelatedPaneUnavailableReason,
  | 'unsupported'
  | 'context-mismatch'
  | 'not-authorized'
  | 'unknown-descriptor'
  | 'mode-unsatisfiable'
>;

function suppliableContexts(
  caller: RelatedPaneCaller,
): WorkspacePaneSuppliableContexts {
  const kinds = new Set<
    'project' | 'source' | 'workspace' | 'task' | 'session' | 'run'
  >(['project']);
  if (caller.scope.sourceId) kinds.add('source');
  if (caller.scope.workspaceId) kinds.add('workspace');
  if (caller.scope.taskId) kinds.add('task');
  if (caller.scope.sessionId) kinds.add('session');
  if (caller.scope.runId) kinds.add('run');
  return kinds;
}

/**
 * Admission, asked when a request arrives and again inside the lock after
 * any guard answered: the caller's Project is the one on screen, its plugin
 * is still the installed generation it was mounted under, and the target is
 * that plugin's own descriptor, in a mode the caller's own scope satisfies,
 * whose renderer the live registry admits now.
 */
export function admitRelatedPluginTarget(
  caller: RelatedPaneCaller,
  target: Pick<RelatedPaneTarget, 'descriptorId' | 'modeId'>,
  live: LiveRelatedPanes,
):
  | { ok: true; entry: ResolvedWorkspacePaneCatalogEntry }
  | { ok: false; reason: AdmissionRefusal } {
  if (!live.model) return { ok: false, reason: 'unsupported' };
  if (
    live.catalog.projectId !== caller.projectId ||
    live.catalog.projectSlug !== caller.projectSlug ||
    live.dockProject.projectId !== caller.projectId ||
    live.dockProject.projectSlug !== caller.projectSlug
  )
    return { ok: false, reason: 'context-mismatch' };
  const stillInstalled = live.catalog.entries.some(
    (entry) =>
      entry.descriptor.provenance.pluginId === caller.pluginId &&
      pluginInstallGeneration(entry.instance?.boundContext?.contribution) ===
        caller.generation,
  );
  if (!stillInstalled) return { ok: false, reason: 'not-authorized' };
  const entry = ownedPluginDescriptor(
    live.catalog.entries,
    caller.pluginId,
    target.descriptorId,
  );
  if (!entry) return { ok: false, reason: 'unknown-descriptor' };
  const satisfiable = workspacePaneModesSatisfiableBy(
    entry.descriptor,
    suppliableContexts(caller),
  ).some((mode) => mode.id === target.modeId);
  if (!satisfiable) return { ok: false, reason: 'mode-unsatisfiable' };
  const contribution = entry.instance?.boundContext?.contribution;
  const probe =
    contribution &&
    relatedPluginPaneInstance(
      mintPluginPaneId(),
      {
        descriptorId: target.descriptorId,
        projectId: caller.projectId,
        scope: caller.scope,
      },
      contribution,
    );
  if (
    pluginInstallGeneration(contribution) !== caller.generation ||
    entry.availability.state !== 'available' ||
    !probe ||
    !relatedPluginRendererAdmitted(entry, probe, live.rendererSupport)
  )
    return { ok: false, reason: 'not-authorized' };
  return { ok: true, entry };
}

const LIMITS = { descriptorId: 256, modeId: 128, key: 256, title: 160 };
const REQUEST_KEYS = ['descriptorId', 'modeId', 'key', 'title'];

/** Closed decode with the contract's bounds: refused past them, never cut. */
export function decodeRelatedPaneOpenRequest(
  value: unknown,
): RelatedPaneOpenRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const request = value as Record<string, unknown>;
  if (
    !Object.keys(request).every((key) => REQUEST_KEYS.includes(key)) ||
    !isBoundedPaneText(request.descriptorId, LIMITS.descriptorId) ||
    !isBoundedPaneText(request.modeId, LIMITS.modeId) ||
    !isBoundedPaneText(request.key, LIMITS.key) ||
    !(
      request.title === undefined ||
      isBoundedPaneText(request.title, LIMITS.title)
    )
  )
    return null;
  return {
    descriptorId: request.descriptorId,
    modeId: request.modeId,
    key: request.key,
    ...(request.title !== undefined ? { title: request.title } : {}),
  };
}

function unavailable(
  reason: RelatedPaneUnavailableReason,
): RelatedPaneUnavailable {
  return { status: 'unavailable', reason };
}

/** The contract's reason for a refusal the shared pipeline names. */
function contractReason(
  reason: RelatedOpenRefusal | AdmissionRefusal | 'unknown-handle',
): RelatedPaneUnavailableReason {
  switch (reason) {
    case 'unsupported':
    case 'context-mismatch':
    case 'not-authorized':
    case 'unknown-descriptor':
    case 'mode-unsatisfiable':
    case 'unknown-handle':
    case 'station-unverified':
    case 'capacity':
    case 'contended':
    case 'superseded':
    case 'guard-cancelled':
      return reason;
    case 'station-changed':
      return 'context-mismatch';
    default:
      return 'refused';
  }
}

function presentationOf(
  model: Pick<RegionModelValue, 'phoneLayer'>,
  surfaceId: string,
  role: WorkspacePaneRelationRole,
): RelatedPanePresentation {
  if (model.phoneLayer?.surfaceId === surfaceId) return 'child';
  return role === 'tool' ? 'tool' : 'beside';
}

/** What the host does for one caller, given the live shell facts. */
export function createRelatedPanesHost(
  caller: RelatedPaneCaller,
  live: () => LiveRelatedPanes,
  now: () => number = Date.now,
): PaneRelatedPanesHost {
  const opener: PaneOpener = {
    occurrenceId: caller.occurrenceId,
    label: caller.label,
    source: {
      kind: 'plugin-occurrence',
      projectSlug: caller.projectSlug,
      layoutSlug: caller.layoutSlug,
    },
  };
  const claim = () => pluginRelatedPaneBudget.claim(caller.pluginId, now());
  const getModel = () => live().model as NonNullable<LiveRelatedPanes['model']>;
  // A handle names a related occurrence THIS caller opened for its own
  // plugin and generation, on the verified Station.
  const ownedRelation = (
    relation: PaneRelation | undefined,
    stationId: string | null,
  ) =>
    relation !== undefined &&
    relation.stationId === stationId &&
    relation.opener.occurrenceId === caller.occurrenceId &&
    relation.generation === caller.generation &&
    relation.target.kind === 'plugin' &&
    relation.target.pluginId === caller.pluginId;
  const roleOf = (entry: ResolvedWorkspacePaneCatalogEntry) =>
    entry.descriptor.relationRole ?? 'destination';

  const open = async (
    request: RelatedPaneOpenRequest,
  ): Promise<RelatedPaneOpenOutcome> => {
    const decoded = decodeRelatedPaneOpenRequest(request);
    if (!decoded) return unavailable('invalid-request');
    if (!claim()) return unavailable('rate-limited');
    const first = admitRelatedPluginTarget(caller, decoded, live());
    if (!first.ok) return unavailable(first.reason);
    const role = roleOf(first.entry);
    const state: PluginPaneState = {
      version: 1,
      projectId: caller.projectId,
      projectSlug: caller.projectSlug,
      pluginId: caller.pluginId,
      generation: caller.generation,
      descriptorId: decoded.descriptorId,
      modeId: decoded.modeId,
      key: decoded.key,
      title: decoded.title ?? first.entry.descriptor.name.slice(0, 160),
      ...(Object.keys(caller.scope).length > 0 ? { scope: caller.scope } : {}),
    };
    const outcome = await openRelatedOccurrence(
      getModel,
      live().relations,
      opener,
      {
        target: {
          kind: 'plugin',
          pluginId: caller.pluginId,
          descriptorId: decoded.descriptorId,
          modeId: decoded.modeId,
          key: decoded.key,
        },
        generation: caller.generation,
        landing: role === 'tool' ? 'bottom' : 'right',
        admit: () => {
          const admitted = admitRelatedPluginTarget(caller, decoded, live());
          return admitted.ok ? null : admitted.reason;
        },
        reveal: (model, instanceId, options) =>
          model.openSurfaceInRegion(instanceId, {
            ...options,
            focusExisting: true,
          }),
        mint: () => {
          const instanceId = mintPluginPaneId();
          const preparation = createPluginPaneStatePreparation(
            window.localStorage,
            instanceId,
            state,
          );
          return {
            instanceId,
            stateKey: instanceId,
            prepare: () => preparation.prepare(),
            rollback: () => preparation.rollback(),
          };
        },
      },
    );
    if (!outcome.ok) return unavailable(contractReason(outcome.reason));
    return {
      status: outcome.disposition ?? 'opened',
      handle: outcome.surfaceId,
      presentation: presentationOf(getModel(), outcome.surfaceId, role),
    };
  };

  const reveal: PaneRelatedPanesHost['reveal'] = async (handle) => {
    if (typeof handle !== 'string' || !PLUGIN_PANE_ID.test(handle))
      return unavailable('unknown-handle');
    if (!claim()) return unavailable('rate-limited');
    const { relations } = live();
    const relation = relations.relationOf(handle);
    if (!ownedRelation(relation, relations.stationId) || !relation)
      return unavailable('unknown-handle');
    const target = relation.target as Extract<
      PaneRelation['target'],
      { kind: 'plugin' }
    >;
    const first = admitRelatedPluginTarget(caller, target, live());
    if (!first.ok) return unavailable(first.reason);
    const role = roleOf(first.entry);
    const outcome = await revealRelatedOccurrence(getModel, relations, handle, {
      landing: role === 'tool' ? 'bottom' : 'right',
      admitRelation: (current) => ownedRelation(current, relations.stationId),
      admit: () => {
        const admitted = admitRelatedPluginTarget(caller, target, live());
        return admitted.ok ? null : admitted.reason;
      },
      reveal: (model, instanceId) =>
        model.openSurfaceInRegion(instanceId, { focusExisting: true }),
    });
    if (!outcome.ok) return unavailable(contractReason(outcome.reason));
    return {
      status: 'focused',
      presentation: presentationOf(getModel(), handle, role),
    };
  };

  const close: PaneRelatedPanesHost['close'] = async (handle) => {
    if (typeof handle !== 'string' || !PLUGIN_PANE_ID.test(handle))
      return unavailable('unknown-handle');
    const { model, relations } = live();
    if (!model) return unavailable('unsupported');
    if (
      !ownedRelation(relations.relationOf(handle), relations.stationId) ||
      !relatedOccurrenceExists(handle) ||
      occupiedRegion(model.regions, handle) === undefined
    )
      return unavailable('unknown-handle');
    // A close that asks the pane's guard puts a question in front of the
    // user, which a loop must not repeat, so it spends from the budget. One
    // that asks nothing only takes away a pane this caller's budgeted open
    // put there, and a refusal would keep a pane the user asked to close.
    if (navigationStore.hasNavigationGuard(handle) && !claim())
      return unavailable('rate-limited');
    // The related pane's own unsaved-changes guard decides; Cancel leaves the
    // pane, its relation and its state exactly as they were. The answer can
    // arrive after the pane moved: only a pane its region still held is
    // removed, and only a removed pane's state and relation are forgotten.
    const proceed = await new Promise<boolean>((resolve) =>
      navigationStore.runNavigationGuards(
        () => resolve(true),
        () => resolve(false),
        { owner: handle },
      ),
    );
    if (!proceed) return unavailable('guard-cancelled');
    const current = live().model;
    const region = current
      ? occupiedRegion(current.regions, handle)
      : undefined;
    if (!current || region === undefined || !current.removePane(region, handle))
      return unavailable('superseded');
    forgetRegionPaneState(handle);
    void live().relations.forget(handle);
    return { status: 'closed' };
  };

  return {
    version: 1,
    open,
    reveal,
    close,
    target: () => Promise.resolve(caller.target),
  };
}

/**
 * The capability for one mounted plugin occurrence, or undefined where this
 * host cannot place related panes (no region model) or the occurrence names
 * no installed plugin. Stable per caller; its members read the shell facts
 * the latest committed render saw.
 */
export function useRelatedPanesHost(
  caller: RelatedPaneCaller | null,
): PaneRelatedPanesHost | undefined {
  const model = useRegionModelOptional();
  const relations = usePaneRelations();
  const catalog = useResolvedWorkspacePaneCatalog(caller?.projectSlug ?? '');
  const dockProject = useDockProject();
  const config = useConfig();
  const current: LiveRelatedPanes = {
    model,
    relations,
    catalog: {
      projectId: catalog.projectId,
      projectSlug: catalog.projectSlug,
      entries: catalog.entries,
    },
    dockProject,
    rendererSupport: {
      mcpAppsEnabled: config?.mcpUiHost !== false,
      pluginFramesEnabled: isDistinctFrameOrigin(config?.pluginFrameOrigin),
    },
  };
  const liveRef = useRef(current);
  useLayoutEffect(() => {
    liveRef.current = current;
  });
  const callerKey = caller ? JSON.stringify(caller) : null;
  const hasModel = model !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized caller is its identity.
  return useMemo(
    () =>
      caller && hasModel
        ? createRelatedPanesHost(caller, () => liveRef.current)
        : undefined,
    [callerKey, hasModel],
  );
}
