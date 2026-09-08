import { createHash } from 'node:crypto';
import {
  type AgentId,
  agentId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  LayoutAction,
  LayoutDefinition,
  LayoutSkill,
} from '@kontourai/station-contracts/layout';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import {
  WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION,
  type WorkspacePaneHostActionDispatchResult,
  type WorkspacePaneHostAgentRef,
  type WorkspacePaneHostAgentResolution,
  type WorkspacePaneHostBoundAgent,
  type WorkspacePaneHostCompositionOutcome,
  type WorkspacePaneHostCompositionProjection,
  type WorkspacePaneHostContributionOwner,
  type WorkspacePaneHostContributionV1,
  type WorkspacePaneHostPromptAction,
} from '@kontourai/station-contracts/workspace-pane-host-contribution';

const ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const MAX_ACTIONS = 32;
const MAX_AGENTS = 32;
const MAX_LABEL_BYTES = 160;
const MAX_PROMPT_BYTES = 8 * 1024;

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    bytes(value) <= maximum &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  );
}

function promptText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    bytes(value) <= MAX_PROMPT_BYTES &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        (code <= 31 && code !== 9 && code !== 10 && code !== 13) || code === 127
      );
    })
  );
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (
      keys.some((key) => {
        const descriptor = descriptors[key];
        return (
          !descriptor ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        );
      })
    ) {
      return null;
    }
    return Object.fromEntries(
      keys.map((key) => [key, descriptors[key]!.value]),
    );
  } catch {
    return null;
  }
}

function dataArray(value: unknown, maximum: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || value.length > maximum) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index)) ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return (
          !descriptor ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        );
      })
    ) {
      return null;
    }
    return keys.map((key) => descriptors[key]!.value);
  } catch {
    return null;
  }
}

function exact(value: Record<string, unknown>, fields: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}

function refKey(ref: WorkspacePaneHostAgentRef): string {
  return `${ref.kind}:${ref.agentId}`;
}

function parseAgentRef(value: unknown): WorkspacePaneHostAgentRef | null {
  const ref = dataRecord(value);
  if (!ref || !exact(ref, ['kind', 'agentId'])) return null;
  if (
    (ref.kind !== 'own-plugin-agent' && ref.kind !== 'station-agent') ||
    typeof ref.agentId !== 'string'
  ) {
    return null;
  }
  try {
    return { kind: ref.kind, agentId: agentId(ref.agentId) };
  } catch {
    return null;
  }
}

function parseAction(value: unknown): WorkspacePaneHostPromptAction | null {
  const actionInput = dataRecord(value);
  if (!actionInput) return null;
  const fields = ['id', 'label', 'presentation', 'intent'];
  if (actionInput.icon !== undefined) fields.push('icon');
  const intentInput = dataRecord(actionInput.intent);
  if (
    !exact(actionInput, fields) ||
    typeof actionInput.id !== 'string' ||
    !ID.test(actionInput.id) ||
    !text(actionInput.label, MAX_LABEL_BYTES) ||
    (actionInput.icon !== undefined && !text(actionInput.icon, 32)) ||
    (actionInput.presentation !== 'action' &&
      actionInput.presentation !== 'skill-prompt') ||
    !intentInput
  ) {
    return null;
  }
  const intentFields = [
    'kind',
    intentInput.kind === 'plugin-prompt' ? 'promptId' : 'prompt',
  ];
  if (intentInput.agent !== undefined) intentFields.push('agent');
  if (
    !exact(intentInput, intentFields) ||
    !(
      (intentInput.kind === 'prompt' && promptText(intentInput.prompt)) ||
      (intentInput.kind === 'plugin-prompt' &&
        typeof intentInput.promptId === 'string' &&
        ID.test(intentInput.promptId))
    )
  ) {
    return null;
  }
  const agent =
    intentInput.agent === undefined
      ? undefined
      : parseAgentRef(intentInput.agent);
  if (intentInput.agent !== undefined && !agent) return null;
  return {
    id: actionInput.id,
    label: actionInput.label,
    ...(typeof actionInput.icon === 'string' ? { icon: actionInput.icon } : {}),
    presentation: actionInput.presentation,
    intent: {
      ...(intentInput.kind === 'plugin-prompt'
        ? {
            kind: 'plugin-prompt' as const,
            promptId: intentInput.promptId as string,
          }
        : { kind: 'prompt' as const, prompt: intentInput.prompt as string }),
      ...(agent ? { agent } : {}),
    },
  };
}

export function parseWorkspacePaneHostContribution(
  value: unknown,
): WorkspacePaneHostContributionV1 | null {
  const contribution = dataRecord(value);
  const actionsInput = contribution
    ? dataArray(contribution.actions, MAX_ACTIONS)
    : null;
  const selection = contribution
    ? dataRecord(contribution.agentSelection)
    : null;
  if (
    !contribution ||
    !exact(contribution, ['version', 'actions', 'agentSelection']) ||
    contribution.version !== WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION ||
    !actionsInput ||
    !selection
  ) {
    return null;
  }
  const selectionFields = ['availableAgents'];
  if (selection.defaultAgent !== undefined) {
    selectionFields.push('defaultAgent');
  }
  const availableInput = dataArray(selection.availableAgents, MAX_AGENTS);
  if (!exact(selection, selectionFields) || !availableInput) {
    return null;
  }
  const actions = actionsInput.map(parseAction);
  const availableAgents = availableInput.map(parseAgentRef);
  const defaultAgent =
    selection.defaultAgent === undefined
      ? undefined
      : parseAgentRef(selection.defaultAgent);
  if (
    actions.some((action) => !action) ||
    availableAgents.some((agent) => !agent) ||
    (selection.defaultAgent !== undefined && !defaultAgent)
  ) {
    return null;
  }
  const typedActions = actions as WorkspacePaneHostPromptAction[];
  const typedAgents = availableAgents as WorkspacePaneHostAgentRef[];
  const agentKeys = typedAgents.map(refKey);
  if (
    new Set(typedActions.map((action) => action.id)).size !==
      typedActions.length ||
    new Set(agentKeys).size !== agentKeys.length ||
    (defaultAgent && !agentKeys.includes(refKey(defaultAgent))) ||
    typedActions.some(
      (action) =>
        action.intent.agent && !agentKeys.includes(refKey(action.intent.agent)),
    )
  ) {
    return null;
  }
  return structuredClone({
    version: WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION,
    actions: typedActions,
    agentSelection: {
      availableAgents: typedAgents,
      ...(defaultAgent ? { defaultAgent } : {}),
    },
  });
}

export type LegacyLayoutHostMigration =
  | { readonly state: 'not-applicable' }
  | {
      readonly state: 'migrated';
      readonly contribution: WorkspacePaneHostContributionV1;
    }
  | { readonly state: 'manual-review'; readonly reasons: readonly string[] };

function legacyAgentRef(
  pluginId: string,
  value: unknown,
): WorkspacePaneHostAgentRef | null {
  if (typeof value !== 'string') return null;
  const ownPrefix = `${pluginId}:`;
  const candidate = value.startsWith(ownPrefix)
    ? value.slice(ownPrefix.length)
    : value;
  try {
    return {
      kind: value.startsWith(ownPrefix) ? 'own-plugin-agent' : 'station-agent',
      agentId: agentId(candidate),
    };
  } catch {
    return null;
  }
}

function migratedActionId(
  presentation: 'action' | 'skill-prompt',
  value: LayoutAction | LayoutSkill,
): string {
  const identity =
    presentation === 'action'
      ? [
          presentation,
          (value as LayoutAction).type,
          value.label,
          (value as LayoutAction).data,
          (value as LayoutAction).icon ?? null,
          value.agent ?? null,
        ]
      : [
          presentation,
          (value as LayoutSkill).id,
          value.label,
          (value as LayoutSkill).prompt,
          value.agent ?? null,
        ];
  const digest = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 16);
  return `legacy-${presentation}-${digest}`;
}

export function migrateLegacyLayoutHostContribution(input: {
  readonly pluginId: string;
  readonly layout: Pick<
    LayoutDefinition,
    'actions' | 'globalSkills' | 'availableAgents' | 'defaultAgent'
  >;
}): LegacyLayoutHostMigration {
  if (!isCanonicalPluginId(input.pluginId)) {
    return { state: 'manual-review', reasons: ['plugin-id-invalid'] };
  }
  const hasLegacy = Boolean(
    input.layout.actions?.length ||
      input.layout.globalSkills?.length ||
      input.layout.availableAgents?.length ||
      input.layout.defaultAgent,
  );
  if (!hasLegacy) return { state: 'not-applicable' };
  const reasons: string[] = [];
  const availableAgents = (input.layout.availableAgents ?? []).flatMap(
    (value, index) => {
      const parsed = legacyAgentRef(input.pluginId, value);
      if (!parsed) reasons.push(`available-agent-${index}-invalid`);
      return parsed ? [parsed] : [];
    },
  );
  const defaultAgent = input.layout.defaultAgent
    ? legacyAgentRef(input.pluginId, input.layout.defaultAgent)
    : undefined;
  if (input.layout.defaultAgent && !defaultAgent) {
    reasons.push('default-agent-invalid');
  }
  if (
    defaultAgent &&
    !availableAgents.some(
      (candidate) => refKey(candidate) === refKey(defaultAgent),
    )
  ) {
    reasons.push('default-agent-not-available');
  }
  const actions: WorkspacePaneHostPromptAction[] = [];
  const availableAgentKeys = new Set(availableAgents.map(refKey));
  for (const [index, action] of (input.layout.actions ?? []).entries()) {
    if (action.type === 'prompt') {
      // Legacy `prompt` was used both for literal text and command-like ids,
      // while its UI path sometimes launched the label instead of `data`.
      // Only an author can choose the Pane-era prompt bytes honestly.
      reasons.push(`action-${index}-prompt-semantics-ambiguous`);
      continue;
    }
    if (action.type !== 'inline-prompt') {
      reasons.push(`action-${index}-requires-host-intent`);
      continue;
    }
    const explicitAgent = action.agent
      ? legacyAgentRef(input.pluginId, action.agent)
      : undefined;
    if (action.agent && !explicitAgent) {
      reasons.push(`action-${index}-agent-invalid`);
      continue;
    }
    if (explicitAgent && !availableAgentKeys.has(refKey(explicitAgent))) {
      reasons.push(`action-${index}-agent-not-available`);
      continue;
    }
    if (!explicitAgent && !defaultAgent) {
      reasons.push(`action-${index}-has-no-agent`);
      continue;
    }
    actions.push({
      id: migratedActionId('action', action),
      label: action.label,
      ...(action.icon ? { icon: action.icon } : {}),
      presentation: 'action',
      intent: {
        kind: 'prompt',
        prompt: action.data,
        ...(explicitAgent ? { agent: explicitAgent } : {}),
      },
    });
  }
  for (const [index, skill] of (input.layout.globalSkills ?? []).entries()) {
    const explicitAgent = skill.agent
      ? legacyAgentRef(input.pluginId, skill.agent)
      : undefined;
    if (skill.agent && !explicitAgent) {
      reasons.push(`skill-${index}-agent-invalid`);
      continue;
    }
    if (explicitAgent && !availableAgentKeys.has(refKey(explicitAgent))) {
      reasons.push(`skill-${index}-agent-not-available`);
      continue;
    }
    if (!explicitAgent && !defaultAgent) {
      reasons.push(`skill-${index}-has-no-agent`);
      continue;
    }
    actions.push({
      id: migratedActionId('skill-prompt', skill),
      label: skill.label,
      presentation: 'skill-prompt',
      intent: {
        kind: 'prompt',
        prompt: skill.prompt,
        ...(explicitAgent ? { agent: explicitAgent } : {}),
      },
    });
  }
  if (reasons.length) return { state: 'manual-review', reasons };
  const contribution = parseWorkspacePaneHostContribution({
    version: WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION,
    actions,
    agentSelection: {
      availableAgents,
      ...(defaultAgent ? { defaultAgent } : {}),
    },
  });
  return contribution
    ? { state: 'migrated', contribution }
    : { state: 'manual-review', reasons: ['migration-result-invalid'] };
}

export interface WorkspacePaneHostAgentResolver {
  resolveOwnPluginAgent(input: {
    owner: WorkspacePaneHostContributionOwner;
    projectId: string;
    agentId: AgentId;
  }): Promise<WorkspacePaneHostAgentResolution>;
  resolveStationAgent(input: {
    projectId: string;
    agentId: AgentId;
  }): Promise<WorkspacePaneHostAgentResolution>;
}

export interface WorkspacePaneHostContributionAuthority {
  current(
    owner: WorkspacePaneHostContributionOwner,
  ):
    | { state: 'current' | 'retired' | 'unavailable' }
    | Promise<{ state: 'current' | 'retired' | 'unavailable' }>;
}

export interface WorkspacePaneHostPromptLauncher {
  launch(input: {
    owner: WorkspacePaneHostContributionOwner;
    projectId: string;
    actionKey: string;
    label: string;
    prompt: string;
    agent: WorkspacePaneHostBoundAgent;
  }): Promise<
    { state: 'launched'; sessionId: string } | { state: 'unavailable' }
  >;
}

function actionKey(
  owner: WorkspacePaneHostContributionOwner,
  projectId: string,
  id: string,
) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION,
        owner.pluginId,
        owner.installationGeneration,
        projectId,
        id,
      ]),
    )
    .digest('hex');
  return `plugin-host-action:${digest}`;
}

export function createWorkspacePaneHostContribution(input: {
  declaration: WorkspacePaneHostContributionV1;
  owner: WorkspacePaneHostContributionOwner;
  projectId: string;
  authority: WorkspacePaneHostContributionAuthority;
  agents: WorkspacePaneHostAgentResolver;
  launcher: WorkspacePaneHostPromptLauncher;
}) {
  const declaration = parseWorkspacePaneHostContribution(input.declaration);
  if (
    !declaration ||
    !isCanonicalPluginId(input.owner.pluginId) ||
    !input.owner.installationGeneration ||
    input.owner.installationGeneration.length > 256 ||
    [...input.owner.installationGeneration].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    }) ||
    !text(input.projectId, 256)
  ) {
    throw new Error('Invalid Workspace Pane host contribution composition');
  }
  const owner = Object.freeze({
    pluginId: input.owner.pluginId,
    installationGeneration: input.owner.installationGeneration,
  });
  const projectId = input.projectId;
  const resolveOwnPluginAgent = input.agents.resolveOwnPluginAgent.bind(
    input.agents,
  );
  const resolveStationAgent = input.agents.resolveStationAgent.bind(
    input.agents,
  );
  const currentOwner = input.authority.current.bind(input.authority);
  const launch = input.launcher.launch.bind(input.launcher);
  const resolveAgent = async (
    ref: WorkspacePaneHostAgentRef,
  ): Promise<WorkspacePaneHostAgentResolution> => {
    try {
      const result =
        ref.kind === 'own-plugin-agent'
          ? await resolveOwnPluginAgent({
              owner,
              projectId,
              agentId: ref.agentId,
            })
          : await resolveStationAgent({
              projectId,
              agentId: ref.agentId,
            });
      if (result.state === 'restricted') return { state: 'restricted' };
      if (result.state !== 'available') return { state: 'unavailable' };
      const exact =
        ref.kind === 'own-plugin-agent'
          ? result.agent.kind === 'plugin-agent' &&
            result.agent.pluginId === owner.pluginId &&
            result.agent.installationGeneration ===
              owner.installationGeneration &&
            result.agent.agentId === ref.agentId
          : result.agent.kind === 'station-agent' &&
            result.agent.agentId === ref.agentId;
      if (!exact) return { state: 'unavailable' };
      return {
        state: 'available',
        agent:
          result.agent.kind === 'plugin-agent'
            ? {
                kind: 'plugin-agent',
                pluginId: result.agent.pluginId,
                installationGeneration: result.agent.installationGeneration,
                agentId: result.agent.agentId,
              }
            : { kind: 'station-agent', agentId: result.agent.agentId },
      };
    } catch {
      return { state: 'unavailable' };
    }
  };
  const ownerState = async (): Promise<
    'current' | 'retired' | 'unavailable'
  > => {
    try {
      const result = await currentOwner(owner);
      return result.state === 'current' ||
        result.state === 'retired' ||
        result.state === 'unavailable'
        ? result.state
        : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
  const defaultRef = declaration.agentSelection.defaultAgent;

  return Object.freeze({
    async project(): Promise<WorkspacePaneHostCompositionOutcome> {
      const before = await ownerState();
      if (before !== 'current') {
        return {
          state: before === 'retired' ? 'owner-retired' : 'unavailable',
        };
      }
      const availableAgents = await Promise.all(
        declaration.agentSelection.availableAgents.map(resolveAgent),
      );
      const defaultIndex = defaultRef
        ? declaration.agentSelection.availableAgents.findIndex(
            (candidate) => refKey(candidate) === refKey(defaultRef),
          )
        : -1;
      const defaultAgent = defaultRef
        ? {
            declaration: defaultRef,
            resolution: availableAgents[defaultIndex]!,
          }
        : ({ state: 'not-declared' } as const);
      const actions = declaration.actions.map((action) => {
        const target = action.intent.agent ?? defaultRef;
        const index = target
          ? declaration.agentSelection.availableAgents.findIndex(
              (candidate) => refKey(candidate) === refKey(target),
            )
          : -1;
        return {
          key: actionKey(owner, projectId, action.id),
          id: action.id,
          label: action.label,
          ...(action.icon ? { icon: action.icon } : {}),
          presentation: action.presentation,
          ...(action.intent.agent ? { agent: action.intent.agent } : {}),
          availability:
            index >= 0
              ? availableAgents[index]!.state
              : ('unavailable' as const),
        };
      });
      const after = await ownerState();
      if (after !== 'current') {
        return { state: after === 'retired' ? 'owner-retired' : 'unavailable' };
      }
      const projection: WorkspacePaneHostCompositionProjection = {
        version: WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION,
        owner,
        projectId,
        actions,
        agentSelection: {
          availableAgents: declaration.agentSelection.availableAgents.map(
            (agent, index) => ({
              declaration: agent,
              resolution: availableAgents[index]!,
            }),
          ),
          defaultAgent,
        },
      };
      return { state: 'available', projection: structuredClone(projection) };
    },

    async dispatch(
      actionId: string,
    ): Promise<WorkspacePaneHostActionDispatchResult> {
      const action = declaration.actions.find(
        (candidate) => actionKey(owner, projectId, candidate.id) === actionId,
      );
      if (!action) return { state: 'refused', reason: 'action-not-found' };
      // This projection-only compatibility dispatcher has no installed-body
      // authority. Registered prompts require the owned invocation capability.
      if (action.intent.kind !== 'prompt') return { state: 'unavailable' };
      const before = await ownerState();
      if (before !== 'current') {
        return before === 'retired'
          ? { state: 'refused', reason: 'owner-retired' }
          : { state: 'unavailable' };
      }
      const target = action.intent.agent ?? defaultRef;
      if (!target) return { state: 'refused', reason: 'no-default-agent' };
      const resolution = await resolveAgent(target);
      const after = await ownerState();
      if (after !== 'current') {
        return after === 'retired'
          ? { state: 'refused', reason: 'owner-retired' }
          : { state: 'unavailable' };
      }
      if (resolution.state !== 'available') {
        return {
          state: 'refused',
          reason:
            resolution.state === 'restricted'
              ? 'agent-restricted'
              : 'agent-unavailable',
        };
      }
      try {
        const launched = await launch({
          owner,
          projectId,
          actionKey: actionId,
          label: action.label,
          prompt: action.intent.prompt,
          agent: resolution.agent,
        });
        return launched.state === 'launched' && text(launched.sessionId, 256)
          ? { state: 'launched', sessionId: launched.sessionId }
          : { state: 'unavailable' };
      } catch {
        return { state: 'unavailable' };
      }
    },
  });
}
