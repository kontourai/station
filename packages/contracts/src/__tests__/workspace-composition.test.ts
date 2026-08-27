import { describe, expect, test } from 'vitest';
import {
  instantiateWorkspaceComposition as instantiateWorkspaceCompositionRaw,
  parseWorkspaceCompositionSpec,
  WORKSPACE_COMPOSITION_SPEC_VERSION,
} from '../workspace-composition';
import { WORKSPACE_PANE_CONTRACT_VERSION } from '../workspace-pane';

const instantiateWorkspaceComposition = (input: Record<string, unknown>) =>
  instantiateWorkspaceCompositionRaw({
    ...input,
    admittedInstances:
      input.admittedInstances ??
      (
        (input.spec as { panes?: { instance: unknown }[] } | undefined)
          ?.panes ?? []
      ).map((entry) => entry.instance),
  });

const descriptor = (
  id: string,
  name = id,
  contextRequirement?: Record<string, true>,
) => ({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id,
  name,
  rendererId: `renderer.${id}`,
  renderer: { kind: 'builtin-component', name: id },
  placement: { supportedRegions: ['primary', 'secondary'] },
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'stable' },
  modes: [
    {
      id: 'default',
      ...(contextRequirement ? { contextRequirement } : {}),
    },
  ],
});

const pane = (
  descriptorId: string,
  role: 'navigation' | 'content' | 'auxiliary' | 'inspector',
  order: number,
  optionalCapabilities: string[] = [],
) => ({
  role,
  instance: {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId,
    instanceId: `${descriptorId}.instance`,
    stateKey: `${descriptorId}.state`,
    boundContext: { projectId: 'project-1' },
  },
  requiredCapabilities: [],
  optionalCapabilities,
  placement: {
    region: role === 'content' ? 'primary' : 'secondary',
    order,
    splitOrientation: 'horizontal',
  },
});

const requirement = (id: string) => ({
  id,
  context: 'project',
  grant: 'required',
});

const spec = () => ({
  version: WORKSPACE_COMPOSITION_SPEC_VERSION,
  id: 'coding-rich',
  name: 'Coding workspace composition',
  requiredCapabilities: [requirement('project.read')],
  optionalCapabilities: [requirement('review.read')],
  panes: [pane('files', 'navigation', 0), pane('chat', 'content', 1)],
});

describe('WorkspaceCompositionSpec', () => {
  test('parses bounded Coding-rich and nondeveloper compositions through one contract', () => {
    expect(parseWorkspaceCompositionSpec(spec())).not.toBeNull();
    const meetingNotes = {
      ...spec(),
      id: 'meeting-notes',
      name: 'Meeting Notes',
      requiredCapabilities: [requirement('meeting.read')],
      optionalCapabilities: [requirement('transcript.read')],
      panes: [
        pane('agenda', 'navigation', 0),
        pane('notes', 'content', 1),
        pane('participants', 'inspector', 2),
      ],
    };
    const parsed = parseWorkspaceCompositionSpec(meetingNotes);
    expect(parsed?.panes.map((entry) => entry.role)).toEqual([
      'navigation',
      'content',
      'inspector',
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(
      /coding|git|terminal|developer/i,
    );
  });

  test('rejects unknown versions, duplicate identities, overlapping capabilities, and exotic input', () => {
    expect(
      parseWorkspaceCompositionSpec({ ...spec(), version: '2.0' }),
    ).toBeNull();
    expect(
      parseWorkspaceCompositionSpec({
        ...spec(),
        panes: [pane('files', 'navigation', 0), pane('files', 'content', 1)],
      }),
    ).toBeNull();
    expect(
      parseWorkspaceCompositionSpec({
        ...spec(),
        optionalCapabilities: [requirement('project.read')],
      }),
    ).toBeNull();
    expect(parseWorkspaceCompositionSpec(new Date())).toBeNull();
  });

  test('instantiates the existing Host Document deterministically when required grants exist', () => {
    const result = instantiateWorkspaceComposition({
      spec: spec(),
      scope: { kind: 'project', projectId: 'project-1', layoutId: 'default' },
      descriptors: [descriptor('files'), descriptor('chat')],
      capabilityStates: [
        {
          id: 'project.read',
          context: 'project',
          available: true,
          granted: true,
        },
        {
          id: 'review.read',
          context: 'project',
          available: false,
          granted: false,
        },
      ],
    });
    expect(result.failure).toBeUndefined();
    expect(result.document).toMatchObject({
      version: '1.1',
      id: 'coding-rich.host',
      instances: [
        { instanceId: 'files.instance', stateKey: 'files.state' },
        { instanceId: 'chat.instance', stateKey: 'chat.state' },
      ],
      root: { type: 'split' },
    });
    expect(result.degradedCapabilities).toEqual(['review.read']);
  });

  test('fails closed for absent grants/descriptors and omits only optional panes', () => {
    const denied = instantiateWorkspaceComposition({
      spec: spec(),
      scope: { kind: 'project', projectId: 'project-1', layoutId: 'default' },
      descriptors: [descriptor('files'), descriptor('chat')],
      capabilityStates: [],
    });
    expect(denied.failure).toEqual({
      code: 'required-capability-unavailable',
      capabilityId: 'project.read',
    });

    const optional = spec();
    optional.optionalCapabilities.push(requirement('chat.enrich'));
    optional.panes[1] = pane('chat', 'content', 1, ['chat.enrich']);
    const degraded = instantiateWorkspaceComposition({
      spec: optional,
      scope: { kind: 'project', projectId: 'project-1', layoutId: 'default' },
      descriptors: [descriptor('files'), descriptor('chat')],
      capabilityStates: [
        {
          id: 'project.read',
          context: 'project',
          available: true,
          granted: true,
        },
        {
          id: 'review.read',
          context: 'project',
          available: true,
          granted: true,
        },
      ],
    });
    expect(degraded.document?.instances).toHaveLength(1);
    expect(degraded.omittedInstanceIds).toEqual(['chat.instance']);
    expect(degraded.degradedCapabilities).toEqual(['chat.enrich']);
  });

  test('rejects duplicate or wrong-context capability state instead of treating declaration as authority', () => {
    const input = {
      spec: spec(),
      scope: {
        kind: 'project' as const,
        projectId: 'project-1',
        layoutId: 'default',
      },
      descriptors: [descriptor('files'), descriptor('chat')],
    };
    expect(
      instantiateWorkspaceComposition({
        ...input,
        capabilityStates: [
          {
            id: 'project.read',
            context: 'workspace',
            available: true,
            granted: true,
          },
        ],
      }).failure,
    ).toEqual({
      code: 'required-capability-unavailable',
      capabilityId: 'project.read',
    });
    expect(
      instantiateWorkspaceComposition({
        ...input,
        capabilityStates: [
          {
            id: 'project.read',
            context: 'project',
            available: true,
            granted: true,
          },
          {
            id: 'project.read',
            context: 'project',
            available: true,
            granted: true,
          },
        ],
      }).failure,
    ).toEqual({ code: 'invalid-spec' });
  });

  test('binds every included instance to exact Host scope and descriptor context requirements', () => {
    const crossProject = spec();
    crossProject.panes[0].instance.boundContext = { projectId: 'project-2' };
    expect(
      instantiateWorkspaceComposition({
        spec: crossProject,
        scope: { kind: 'project', projectId: 'project-1', layoutId: 'default' },
        descriptors: [
          descriptor('files', 'Files', { project: true }),
          descriptor('chat'),
        ],
        capabilityStates: [
          {
            id: 'project.read',
            context: 'project',
            available: true,
            granted: true,
          },
          {
            id: 'review.read',
            context: 'project',
            available: true,
            granted: true,
          },
        ],
      }).failure,
    ).toEqual({ code: 'missing-descriptor', descriptorId: 'files' });
  });

  test('omits unavailable optional panes before descriptor validation and bounds hostile work inputs', () => {
    const optional = spec();
    optional.optionalCapabilities.push(requirement('chat.enrich'));
    optional.panes[1] = pane('missing-chat', 'content', 1, ['chat.enrich']);
    const result = instantiateWorkspaceComposition({
      spec: optional,
      scope: { kind: 'project', projectId: 'project-1', layoutId: 'default' },
      descriptors: [descriptor('files')],
      capabilityStates: [
        {
          id: 'project.read',
          context: 'project',
          available: true,
          granted: true,
        },
        {
          id: 'review.read',
          context: 'project',
          available: true,
          granted: true,
        },
      ],
    });
    expect(result.failure).toBeUndefined();
    expect(result.omittedInstanceIds).toEqual(['missing-chat.instance']);
    expect(
      instantiateWorkspaceComposition({
        spec: spec(),
        scope: { kind: 'project', projectId: 'project-1', layoutId: 'default' },
        descriptors: Array.from({ length: 25 }, (_, index) =>
          descriptor(`pane-${index}`),
        ),
        capabilityStates: [],
      }).failure,
    ).toEqual({ code: 'invalid-spec' });
    expect(
      instantiateWorkspaceComposition({
        spec: spec(),
        scope: { kind: 'project', projectId: 'project-1', layoutId: 'default' },
        descriptors: [descriptor('files'), descriptor('chat')],
        capabilityStates: [null],
      }).failure,
    ).toEqual({ code: 'invalid-spec' });
  });

  test('requires exact authoritative admitted context and never throws on hostile top-level input', () => {
    const declared = spec();
    const admitted = declared.panes.map((entry) => entry.instance);
    admitted[0] = {
      ...admitted[0],
      boundContext: {
        projectId: 'project-1',
        sessionId: 'session-authoritative',
      } as { projectId: string },
    };
    expect(
      instantiateWorkspaceCompositionRaw({
        spec: declared,
        scope: { kind: 'project', projectId: 'project-1', layoutId: 'default' },
        descriptors: [descriptor('files'), descriptor('chat')],
        capabilityStates: [
          {
            id: 'project.read',
            context: 'project',
            available: true,
            granted: true,
          },
          {
            id: 'review.read',
            context: 'project',
            available: true,
            granted: true,
          },
        ],
        admittedInstances: admitted,
      }).failure,
    ).toEqual({ code: 'missing-descriptor', descriptorId: 'files' });
    expect(instantiateWorkspaceCompositionRaw(null).failure).toEqual({
      code: 'invalid-spec',
    });
    expect(
      instantiateWorkspaceCompositionRaw({
        spec: declared,
        scope: new Date(),
        descriptors: [],
        capabilityStates: [],
        admittedInstances: [],
      }).failure,
    ).toEqual({ code: 'invalid-spec' });
    expect(
      instantiateWorkspaceCompositionRaw({
        spec: declared,
        scope: { kind: 'project', projectId: 'project-1', layoutId: 'default' },
        descriptors: [descriptor('files'), descriptor('chat')],
        admittedInstances: declared.panes.map((entry) => entry.instance),
        capabilityStates: [
          {
            id: 'project.read',
            context: 'project',
            available: true,
            granted: true,
            unexpected: true,
          },
        ],
      }).failure,
    ).toEqual({ code: 'invalid-spec' });
  });
});
