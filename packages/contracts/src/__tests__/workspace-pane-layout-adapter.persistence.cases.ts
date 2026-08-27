import { describe, expect, test } from 'vitest';

import type { LayoutTab } from '../layout';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '../workspace-pane';
import {
  layoutTabFromWorkspacePaneAdaptation,
  parseWorkspacePaneLayoutTabAdaptation,
  type WorkspacePaneLayoutTabAdaptation,
} from '../workspace-pane-layout-adapter';
import {
  adapt,
  builtinTab,
  mcpTab,
} from './workspace-pane-layout-adapter.test-fixtures';

function mcpTabAtDepth(depth: number) {
  let initialArguments: Record<string, unknown> = { value: 'leaf' };
  for (let index = 0; index < depth; index += 1) {
    initialArguments = { nested: initialArguments };
  }
  const component = mcpTab().component as Extract<
    LayoutTab['component'],
    { kind: 'mcp-tool-ui' }
  >;
  return {
    ...mcpTab(),
    component: {
      ...component,
      initialArguments,
    },
  };
}

describe('adaptation records read back as untrusted input', () => {
  function record(): WorkspacePaneLayoutTabAdaptation {
    return adapt(mcpTab());
  }

  test('accepts a record this module produced, unchanged', () => {
    const parsed = parseWorkspacePaneLayoutTabAdaptation(record());
    expect(parsed).toEqual(record());
    expect(
      layoutTabFromWorkspacePaneAdaptation(
        parsed as WorkspacePaneLayoutTabAdaptation,
      ),
    ).toEqual(mcpTab());
  });

  test('survives a JSON persistence round trip', () => {
    const persisted = JSON.parse(JSON.stringify(record()));
    expect(parseWorkspacePaneLayoutTabAdaptation(persisted)).toEqual(record());
  });

  test('rejects a restored plugin MCP record whose contribution attribution disagrees with its descriptor', () => {
    const contribution = {
      id: 'plugin:synthetic-plugin:review',
      version: '1.2.3',
      sourceIdentity: {
        id: 'synthetic-plugin',
        kind: 'local' as const,
        source: 'plugins/synthetic-plugin',
      },
      provenance: {
        origin: 'plugin' as const,
        pluginId: 'synthetic-plugin',
      },
    };
    const persisted = adapt(mcpTab(), {
      layoutSlug: 'review',
      pluginId: 'synthetic-plugin',
      contribution,
    });
    const tampered = JSON.parse(JSON.stringify(persisted));
    tampered.instance.boundContext.contribution.provenance = {
      origin: 'mcp',
      mcpServerId: 'synthetic-server',
    };

    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();
  });

  test('rejects the removed retained-tab key', () => {
    const persisted = record() as unknown as Record<string, unknown>;
    persisted.legacyTab = persisted.retainedLayoutTab;

    expect(parseWorkspacePaneLayoutTabAdaptation(persisted)).toBeNull();
  });

  test('round-trips depth-32 MCP initialArguments unchanged and rejects depth 33', () => {
    const acceptedTab = mcpTabAtDepth(32);
    const accepted = adapt(acceptedTab);

    expect(layoutTabFromWorkspacePaneAdaptation(accepted)).toEqual(acceptedTab);
    expect(
      parseWorkspacePaneLayoutTabAdaptation(
        JSON.parse(JSON.stringify(accepted)),
      ),
    ).toEqual(accepted);

    expect(() => adapt(mcpTabAtDepth(33))).toThrow();
  });

  test('rejects a retained tab rewritten to name a different component', () => {
    const tampered = record();
    tampered.retainedLayoutTab.component = {
      kind: 'mcp-tool-ui',
      ref: 'other-server/create_issue',
    };

    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();
  });

  test('rejects forged alternative renderer identity or attribution', () => {
    const recordWithAlternative = adapt({
      ...mcpTab(),
      alternativeRenderer: {
        rendererId: 'renderer:synthetic:read-only',
        component: { kind: 'plugin-component', name: 'read-only' },
        provenance: { origin: 'plugin', pluginId: 'synthetic-plugin' },
      },
    });

    const forgedIdentity = structuredClone(recordWithAlternative);
    forgedIdentity.descriptor.alternativeRenderer!.rendererId =
      'renderer:forged' as WorkspacePaneDescriptor['rendererId'];
    expect(parseWorkspacePaneLayoutTabAdaptation(forgedIdentity)).toBeNull();

    const forgedProvenance = structuredClone(recordWithAlternative);
    forgedProvenance.descriptor.alternativeRenderer!.provenance = {
      origin: 'plugin',
      pluginId: 'forged-plugin',
    };
    expect(parseWorkspacePaneLayoutTabAdaptation(forgedProvenance)).toBeNull();
  });

  test('rejects a descriptor swapped for a different security class', () => {
    const tampered = record();
    tampered.descriptor = {
      ...tampered.descriptor,
      renderer: { kind: 'builtin-component', name: 'create_issue' },
      provenance: { origin: 'builtin' },
    };

    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();
  });

  test('rejects a record whose identities were rewritten', () => {
    const tamperedRenderer = record();
    tamperedRenderer.descriptor = {
      ...tamperedRenderer.descriptor,
      rendererId:
        'renderer:mcp-tool-ui:other-server%2Fcreate_issue' as WorkspacePaneDescriptor['rendererId'],
    };
    expect(parseWorkspacePaneLayoutTabAdaptation(tamperedRenderer)).toBeNull();

    const tamperedInstance = record();
    tamperedInstance.instance = {
      ...tamperedInstance.instance,
      instanceId:
        'instance:window-a:pane:other-layout:issue-ui' as WorkspacePaneInstance['instanceId'],
    };
    expect(parseWorkspacePaneLayoutTabAdaptation(tamperedInstance)).toBeNull();
  });

  test('rejects a descriptor id forged to a syntactically plausible but non-canonical value', () => {
    const tampered = record();
    const forgedId = 'pane:builtin:forged' as WorkspacePaneDescriptor['id'];
    tampered.descriptor = { ...tampered.descriptor, id: forgedId };
    tampered.instance = {
      ...tampered.instance,
      descriptorId:
        forgedId as unknown as WorkspacePaneInstance['descriptorId'],
      instanceId:
        `instance:synthetic-layout:${forgedId}` as WorkspacePaneInstance['instanceId'],
      stateKey:
        `state:synthetic-layout:${forgedId}` as WorkspacePaneInstance['stateKey'],
    };

    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();
  });

  test('rejects a descriptor id carrying an extra segment after the tab segment', () => {
    const tampered = record();
    const forgedId =
      `${tampered.descriptor.id}:extra` as WorkspacePaneDescriptor['id'];
    tampered.descriptor = { ...tampered.descriptor, id: forgedId };
    tampered.instance = {
      ...tampered.instance,
      descriptorId:
        forgedId as unknown as WorkspacePaneInstance['descriptorId'],
      instanceId:
        `instance:synthetic-layout:${forgedId}` as WorkspacePaneInstance['instanceId'],
      stateKey:
        `state:synthetic-layout:${forgedId}` as WorkspacePaneInstance['stateKey'],
    };

    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();
  });

  test('rejects a descriptor id whose layout segment is not canonically encoded', () => {
    const tampered = record();
    // `%2` is not a valid percent-escape, so decodeURIComponent throws.
    const forgedId =
      'pane:mcp%3Asynthetic-server:synthetic-layout%2:issue-ui' as WorkspacePaneDescriptor['id'];
    tampered.descriptor = { ...tampered.descriptor, id: forgedId };
    tampered.instance = {
      ...tampered.instance,
      descriptorId:
        forgedId as unknown as WorkspacePaneInstance['descriptorId'],
      instanceId:
        `instance:synthetic-layout:${forgedId}` as WorkspacePaneInstance['instanceId'],
      stateKey:
        `state:synthetic-layout:${forgedId}` as WorkspacePaneInstance['stateKey'],
    };

    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();
  });

  test('rejects a record whose instance and state key were minted under different scopes', () => {
    const tampered = record();
    tampered.instance = {
      ...tampered.instance,
      stateKey:
        `state:mismatched-scope:${tampered.descriptor.id}` as WorkspacePaneInstance['stateKey'],
    };

    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();
  });

  test('rejects a record whose scope segment is not well-formed', () => {
    const tampered = record();
    tampered.instance = {
      ...tampered.instance,
      stateKey:
        `state:%zz:${tampered.descriptor.id}` as WorkspacePaneInstance['stateKey'],
    };

    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();
  });

  test('rejects a record whose descriptor and retained tab disagree on decoration', () => {
    const tampered = record();
    tampered.retainedLayoutTab.label = 'Renamed';
    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();

    const relabelled = record();
    relabelled.retainedLayoutTab.icon = '🚨';
    expect(parseWorkspacePaneLayoutTabAdaptation(relabelled)).toBeNull();
  });

  test('rejects an instance that belongs to another descriptor', () => {
    const tampered = record();
    tampered.instance = adapt(builtinTab()).instance;
    expect(parseWorkspacePaneLayoutTabAdaptation(tampered)).toBeNull();
  });

  test('rejects malformed records outright', () => {
    for (const value of [null, 'record', 42, {}, { descriptor: {} }]) {
      expect(parseWorkspacePaneLayoutTabAdaptation(value)).toBeNull();
    }
  });
});

describe('contributor identity stays data, not switch logic', () => {
  /**
   * Replaces every mention of one contributor's identifiers with a placeholder,
   * so two adaptations that differ only in *who* contributed them collapse to
   * the same shape. If the adapter branched on a contributor id anywhere —
   * a special-cased plugin, server, component name, or layout slug — the two
   * shapes would diverge.
   */
  function contributorAgnosticShape(
    value: unknown,
    identifiers: readonly string[],
  ): string {
    return identifiers.reduce(
      (json, identifier) => json.split(identifier).join('<contributor>'),
      JSON.stringify(value),
    );
  }

  test('treats two different trusted plugins identically', () => {
    const alpha = adapt(
      {
        id: 'panel',
        label: 'Panel',
        component: { kind: 'plugin-component', name: 'alpha-panel' },
      },
      { layoutSlug: 'alpha-layout', pluginId: 'alpha-plugin' },
    );
    const omega = adapt(
      {
        id: 'panel',
        label: 'Panel',
        component: { kind: 'plugin-component', name: 'omega-panel' },
      },
      { layoutSlug: 'omega-layout', pluginId: 'omega-plugin' },
    );

    expect(
      contributorAgnosticShape(alpha, [
        'alpha-plugin',
        'alpha-panel',
        'alpha-layout',
      ]),
    ).toBe(
      contributorAgnosticShape(omega, [
        'omega-plugin',
        'omega-panel',
        'omega-layout',
      ]),
    );
  });

  test('treats two different MCP servers identically', () => {
    const alpha = adapt({
      id: 'app',
      label: 'App',
      component: { kind: 'mcp-tool-ui', ref: 'alpha-server/render' },
    });
    const omega = adapt({
      id: 'app',
      label: 'App',
      component: { kind: 'mcp-tool-ui', ref: 'omega-server/render' },
    });

    expect(contributorAgnosticShape(alpha, ['alpha-server'])).toBe(
      contributorAgnosticShape(omega, ['omega-server']),
    );
  });

  test('names no shipped contributor in its own source', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const implementationFiles = [
      'workspace-pane-layout-adapter.ts',
      'workspace-pane-layout-adapter-adaptation.ts',
      'workspace-pane-layout-adapter-catalog.ts',
      'workspace-pane-layout-adapter-helpers.ts',
      'workspace-pane-layout-adapter-types.ts',
    ];
    const source = implementationFiles
      .map((file) =>
        fs.readFileSync(path.resolve(__dirname, `../${file}`), 'utf8'),
      )
      .join('\n');

    // Real contributor identities from this repo's own bundled layouts and
    // built-ins. Station core adapts them generically; none may appear as a
    // literal here.
    for (const contributor of [
      'builder-delivery-viewer',
      'survey-review-workbench',
      'flow-run-console',
      'coding-workspace',
      'knowledge-library',
      'station-control',
    ]) {
      expect(
        source.includes(contributor),
        `workspace pane adapter implementation must not name the contributor '${contributor}'`,
      ).toBe(false);
    }
  });
});
