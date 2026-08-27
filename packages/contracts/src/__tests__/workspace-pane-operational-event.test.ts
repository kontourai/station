import { describe, expect, test } from 'vitest';
import {
  createWorkspacePaneOperationalEvent,
  workspacePaneOperationalRendererClass,
} from '../workspace-pane-operational-event.js';

const base = {
  id: 'event-pane-1',
  occurredAt: '2026-08-09T12:00:00.000Z',
  producer: { id: 'station-ui', version: '1' },
  occurrenceId: 'pane-occurrence-1',
  hostScope: {
    kind: 'task' as const,
    projectId: 'project-1',
    layoutId: 'layout-1',
    taskId: 'task-1',
  },
  instance: {
    version: '1.0' as const,
    descriptorId: 'pane:plugin:review' as never,
    instanceId: 'instance:review' as never,
    stateKey: 'state:review' as never,
    boundContext: {
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: 'thread-1',
      runId: 'run-1',
    },
  },
  provenance: { origin: 'plugin' as const, pluginId: 'review-plugin' },
  source: 'primary' as const,
  name: 'ready' as const,
  capability: 'supported' as const,
};

describe('Workspace Pane operational event factory', () => {
  test.each([
    [
      { kind: 'builtin-component' as const, name: 'review' },
      { origin: 'builtin' as const },
      'built-in',
    ],
    [
      { kind: 'plugin-component' as const, name: 'review' },
      { origin: 'plugin' as const, pluginId: 'review-plugin' },
      'trusted-plugin',
    ],
    [
      { kind: 'mcp-tool-ui' as const, ref: 'mcp:review' },
      { origin: 'mcp' as const, mcpServerId: 'review' },
      'sandboxed-mcp-app',
    ],
  ] as const)(
    'preserves selected renderer class %o',
    (renderer, provenance, rendererClass) => {
      expect(workspacePaneOperationalRendererClass(renderer)).toBe(
        rendererClass,
      );
      expect(
        createWorkspacePaneOperationalEvent({
          ...base,
          renderer,
          provenance,
        })?.payload.data,
      ).toMatchObject({ rendererClass });
    },
  );

  test('emits only bounded identity/provenance facts', () => {
    const event = createWorkspacePaneOperationalEvent({
      ...base,
      renderer: { kind: 'plugin-component', name: 'review' },
    });
    expect(event).toMatchObject({
      type: 'station.workspace-pane.lifecycle/v1',
      privacy: 'private',
      delivery: 'ephemeral',
      payload: {
        data: {
          event: 'ready',
          rendererClass: 'trusted-plugin',
          rendererProvenance: 'plugin',
          capability: 'supported',
        },
      },
    });
    expect(event?.scopes).toEqual([
      { kind: 'project', projectId: 'project-1' },
      { kind: 'task', taskId: 'task-1', projectId: 'project-1' },
      {
        kind: 'pane',
        descriptorId: 'pane:plugin:review',
        instanceId: 'instance:review',
        rendererClass: 'trusted-plugin',
      },
      { kind: 'thread', threadId: 'thread-1' },
      { kind: 'run', runId: 'run-1', threadId: 'thread-1' },
    ]);
    expect(JSON.stringify(event)).not.toContain('review-plugin');
  });

  test('rejects cross-project spoofing and unbounded failure placement', () => {
    expect(
      createWorkspacePaneOperationalEvent({
        ...base,
        renderer: { kind: 'plugin-component', name: 'review' },
        instance: {
          ...base.instance,
          boundContext: { projectId: 'other-project' },
        },
      }),
    ).toBeNull();
    expect(
      createWorkspacePaneOperationalEvent({
        ...base,
        renderer: { kind: 'mcp-tool-ui', ref: 'mcp:review' },
        provenance: { origin: 'mcp', mcpServerId: 'review' },
        failureCode: 'render-failed',
      }),
    ).toBeNull();
  });

  test('requires a bounded reason for failed/closed lifecycle facts', () => {
    expect(
      createWorkspacePaneOperationalEvent({
        ...base,
        name: 'render-failed',
        renderer: { kind: 'mcp-tool-ui', ref: 'mcp:review' },
        provenance: { origin: 'mcp', mcpServerId: 'review' },
        failureCode: 'render-revoked',
      })?.payload.data,
    ).toMatchObject({ failureCode: 'render-revoked' });
    expect(
      createWorkspacePaneOperationalEvent({
        ...base,
        name: 'closed',
        renderer: { kind: 'plugin-component', name: 'review' },
      }),
    ).toBeNull();
  });

  test('rejects every renderer/provenance cross-pair', () => {
    const renderers = [
      { kind: 'builtin-component' as const, name: 'review' },
      { kind: 'plugin-component' as const, name: 'review' },
      { kind: 'mcp-tool-ui' as const, ref: 'mcp:review' },
    ];
    const provenance = [
      { origin: 'builtin' as const },
      { origin: 'plugin' as const, pluginId: 'review-plugin' },
      { origin: 'mcp' as const, mcpServerId: 'review' },
    ];
    for (const [rendererIndex, renderer] of renderers.entries())
      for (const [provenanceIndex, candidate] of provenance.entries())
        if (rendererIndex === provenanceIndex) {
          expect(
            createWorkspacePaneOperationalEvent({
              ...base,
              id: `event-cross-${rendererIndex}-${provenanceIndex}`,
              renderer,
              provenance: candidate,
            }),
          ).not.toBeNull();
        } else {
          expect(
            createWorkspacePaneOperationalEvent({
              ...base,
              id: `event-cross-${rendererIndex}-${provenanceIndex}`,
              renderer,
              provenance: candidate,
            }),
          ).toBeNull();
        }
  });

  test('carries typed availability reasons only on availability transitions', () => {
    const event = createWorkspacePaneOperationalEvent({
      ...base,
      name: 'availability-changed',
      renderer: { kind: 'plugin-component', name: 'review' },
      availabilityReason: { code: 'renderer-missing', source: 'renderer' },
    });
    expect(event?.payload.data).toMatchObject({
      availabilityReasonCode: 'renderer-missing',
      availabilityReasonSource: 'renderer',
    });
    expect(
      createWorkspacePaneOperationalEvent({
        ...base,
        name: 'availability-observed',
        renderer: { kind: 'plugin-component', name: 'review' },
      }),
    ).toBeNull();
    expect(
      createWorkspacePaneOperationalEvent({
        ...base,
        renderer: { kind: 'plugin-component', name: 'review' },
        availabilityReason: { code: 'ready', source: 'resolver' },
      }),
    ).toBeNull();
  });
});
