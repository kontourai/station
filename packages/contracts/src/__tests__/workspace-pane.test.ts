import { describe, expect, test } from 'vitest';
import type { LayoutMetadata } from '../layout';
import {
  mcpAppHostAvailableDisplayModes,
  mediateMcpAppDisplayMode,
} from '../mcp-app-display-mode';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneDescriptorId,
  WorkspacePaneInstanceId,
  WorkspacePaneRendererId,
} from '../workspace-pane';
import {
  isBoundedWorkspacePanePreviewImage,
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  toWorkspacePaneDescriptorId,
  toWorkspacePaneInstanceId,
  toWorkspacePaneRendererId,
  toWorkspacePaneStateKey,
  WORKSPACE_PANE_CONTRACT_VERSION,
  withWorkspacePaneInstanceLayoutBinding,
  workspacePaneModesSatisfiableBy,
} from '../workspace-pane';
import { selectWorkspacePaneRenderer } from '../workspace-pane-renderer-selection';

function builtinDescriptorInput(): Record<string, unknown> {
  return {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    id: 'coding-pane',
    name: 'Coding',
    rendererId: 'builtin-coding-pane',
    renderer: { kind: 'builtin-component', name: 'coding-pane' },
    placement: { supportedRegions: ['primary'] },
    modes: [{ id: 'default' }],
    provenance: { origin: 'builtin' },
    lifecycle: { stage: 'stable' },
  };
}

function pluginDescriptorInput(): Record<string, unknown> {
  return {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    id: 'review-queue',
    name: 'Review Queue',
    description: 'Plugin-contributed review queue',
    rendererId: 'review-queue-plugin.review-queue',
    renderer: { kind: 'plugin-component', name: 'review-queue' },
    placement: {
      supportedRegions: ['secondary'],
      preferredRegion: 'secondary',
      order: 2,
    },
    modes: [
      {
        id: 'default',
        contextRequirement: { project: true, requiredProviders: ['github'] },
      },
    ],
    actions: [
      { type: 'prompt', label: 'Summarize', data: 'summarize the queue' },
    ],
    provenance: { origin: 'plugin', pluginId: 'review-queue-plugin' },
    lifecycle: { stage: 'preview', since: '2026-08-01' },
  };
}

function mcpDescriptorInput(): Record<string, unknown> {
  return {
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    id: 'github-issue-ui',
    name: 'GitHub Issue',
    rendererId: 'github.create_issue',
    renderer: {
      kind: 'mcp-tool-ui',
      ref: 'github/create_issue',
      displayMode: 'inline',
    },
    placement: { supportedRegions: ['standalone'] },
    modes: [{ id: 'default' }],
    provenance: { origin: 'mcp', mcpServerId: 'github' },
    lifecycle: { stage: 'stable' },
    alternativeRenderer: {
      renderer: { kind: 'builtin-component', name: 'unavailable-pane' },
      reason: 'MCP server unreachable',
    },
  };
}

describe('WorkspacePane contract', () => {
  test('derives satisfiable modes from host-supplied context', () => {
    const projectBound = parseWorkspacePaneDescriptor({
      ...builtinDescriptorInput(),
      modes: [{ id: 'project', contextRequirement: { project: true } }],
    });
    expect(projectBound).not.toBeNull();
    expect(workspacePaneModesSatisfiableBy(projectBound!, new Set())).toEqual(
      [],
    );
    expect(
      workspacePaneModesSatisfiableBy(projectBound!, new Set(['project'])),
    ).toEqual([{ id: 'project', contextRequirement: { project: true } }]);
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        dockability: { enabled: true },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        contextRequirement: { project: true },
      }),
    ).toBeNull();
  });

  test('public parsers reject accessor-bearing plain data without evaluating getters', () => {
    let descriptorGetterReads = 0;
    const descriptorWithGetter = Object.defineProperty(
      builtinDescriptorInput(),
      'name',
      {
        enumerable: true,
        get: () => {
          descriptorGetterReads += 1;
          throw new Error('descriptor getter must not run');
        },
      },
    );
    expect(() =>
      parseWorkspacePaneDescriptor(descriptorWithGetter),
    ).not.toThrow();
    expect(parseWorkspacePaneDescriptor(descriptorWithGetter)).toBeNull();
    expect(descriptorGetterReads).toBe(0);
  });

  test('parses a representative built-in descriptor', () => {
    const descriptor = parseWorkspacePaneDescriptor(builtinDescriptorInput());
    expect(descriptor).toEqual({
      version: '1.0',
      id: 'coding-pane',
      name: 'Coding',
      rendererId: 'builtin-coding-pane',
      renderer: { kind: 'builtin-component', name: 'coding-pane' },
      placement: { supportedRegions: ['primary'] },
      modes: [{ id: 'default' }],
      provenance: { origin: 'builtin' },
      lifecycle: { stage: 'stable' },
    });
  });

  test('parses the optional previewImage and rejects a blank one (station#3318)', () => {
    const withPreview = parseWorkspacePaneDescriptor({
      ...builtinDescriptorInput(),
      previewImage: '/assets/panes/coding-preview.png',
    });
    expect(withPreview?.previewImage).toBe('/assets/panes/coding-preview.png');
    expect(
      parseWorkspacePaneDescriptor(builtinDescriptorInput())?.previewImage,
    ).toBeUndefined();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        previewImage: '   ',
      }),
    ).toBeNull();
  });

  // A descriptor is plugin-controlled and its preview lands in `img src` on
  // every catalog render, so an absolute URL is an unconsented beacon (viewer
  // IP, user agent, and when they opened the picker). The Tauri CSP admits
  // http:/https:/data: and the browser-served UI has none, so the bound is
  // here, at the parse boundary — no producer sets the field yet, which is
  // exactly why now is when it costs nothing.
  test('bounds previewImage to same-origin assets and small inline images (station#3318)', () => {
    const parsePreview = (previewImage: unknown) =>
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        previewImage,
      });

    for (const accepted of [
      '/assets/panes/coding-preview.png',
      'assets/panes/coding-preview.png',
      './preview.webp',
      `data:image/png;base64,${'A'.repeat(64)}==`,
      // Exactly ON each cap, so the boundary cases below prove a bound rather
      // than an off-by-one: 22 + 95_978 = 96_000, and 1 + 2_047 = 2_048.
      `data:image/png;base64,${'A'.repeat(95_978)}`,
      `/${'a'.repeat(2_047)}`,
    ]) {
      expect(parsePreview(accepted)?.previewImage).toBe(accepted);
      expect(isBoundedWorkspacePanePreviewImage(accepted)).toBe(true);
    }

    for (const rejected of [
      'https://evil.example/x.png',
      'http://evil.example/x.png',
      '//evil.example/x.png',
      'HTTPS://evil.example/x.png',
      'javascript:alert(1)',
      '\\\\evil.example\\x.png',
      '/assets/../../../etc/passwd',
      '/assets/pane preview.png',
      '/assets/%2e%2e/secret.png',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/svg+xml;base64,PHN2Zz4=',
      // Oversized inline payload: a picture this big is a payload.
      `data:image/png;base64,${'A'.repeat(96_000)}`,
      // Exactly one character past each cap — the bound is a bound, not a
      // vibe. `data:image/png;base64,` is 22 chars, so 95_979 payload chars
      // lands the whole string on 96_001.
      `data:image/png;base64,${'A'.repeat(95_979)}`,
      `/${'a'.repeat(2_048)}`,
      '   ',
      '',
      42,
    ]) {
      expect(isBoundedWorkspacePanePreviewImage(rejected)).toBe(false);
      expect(parsePreview(rejected)).toBeNull();
    }
  });

  test('parses a representative trusted-plugin descriptor', () => {
    const descriptor = parseWorkspacePaneDescriptor(pluginDescriptorInput());
    expect(descriptor).toEqual({
      version: '1.0',
      id: 'review-queue',
      name: 'Review Queue',
      description: 'Plugin-contributed review queue',
      rendererId: 'review-queue-plugin.review-queue',
      renderer: { kind: 'plugin-component', name: 'review-queue' },
      placement: {
        supportedRegions: ['secondary'],
        preferredRegion: 'secondary',
        order: 2,
      },
      modes: [
        {
          id: 'default',
          contextRequirement: { project: true, requiredProviders: ['github'] },
        },
      ],
      actions: [
        { type: 'prompt', label: 'Summarize', data: 'summarize the queue' },
      ],
      provenance: { origin: 'plugin', pluginId: 'review-queue-plugin' },
      lifecycle: { stage: 'preview', since: '2026-08-01' },
    });
  });

  test('parses a representative sandboxed MCP App descriptor', () => {
    const descriptor = parseWorkspacePaneDescriptor(mcpDescriptorInput());
    expect(descriptor).toEqual({
      version: '1.0',
      id: 'github-issue-ui',
      name: 'GitHub Issue',
      rendererId: 'github.create_issue',
      renderer: {
        kind: 'mcp-tool-ui',
        ref: 'github/create_issue',
        displayMode: 'inline',
      },
      placement: { supportedRegions: ['standalone'] },
      modes: [{ id: 'default' }],
      provenance: { origin: 'mcp', mcpServerId: 'github' },
      lifecycle: { stage: 'stable' },
      alternativeRenderer: {
        renderer: { kind: 'builtin-component', name: 'unavailable-pane' },
        reason: 'MCP server unreachable',
      },
    });
  });

  test('retains a plugin contributor alongside MCP renderer attribution', () => {
    const descriptor = parseWorkspacePaneDescriptor({
      ...mcpDescriptorInput(),
      id: 'plugin-github-issue-ui',
      rendererId: 'plugin-github-issue-ui-renderer',
      provenance: {
        origin: 'plugin',
        pluginId: 'review-plugin',
        mcpServerId: 'github',
      },
    });

    expect(descriptor?.renderer.kind).toBe('mcp-tool-ui');
    expect(descriptor?.provenance).toEqual({
      origin: 'plugin',
      pluginId: 'review-plugin',
      mcpServerId: 'github',
    });
  });

  test('supports independently attributed alternative renderers', () => {
    const descriptor = parseWorkspacePaneDescriptor({
      ...mcpDescriptorInput(),
      alternativeRenderer: {
        rendererId: 'builtin-unavailable-pane',
        renderer: { kind: 'builtin-component', name: 'unavailable-pane' },
        provenance: { origin: 'builtin' },
        reason: 'MCP server unreachable',
      },
    });

    expect(descriptor?.alternativeRenderer).toEqual({
      rendererId: 'builtin-unavailable-pane',
      renderer: { kind: 'builtin-component', name: 'unavailable-pane' },
      provenance: { origin: 'builtin' },
      reason: 'MCP server unreachable',
    });
  });

  test('validates declared renderer capabilities without accepting unknown values', () => {
    const descriptor = parseWorkspacePaneDescriptor({
      ...mcpDescriptorInput(),
      requiredRendererCapabilities: ['sandboxed-mcp-app'],
      alternativeRenderer: {
        renderer: { kind: 'plugin-component', name: 'issue-summary' },
        requiredCapabilities: ['trusted-plugin-react'],
        reason: 'Use the read-only summary when MCP Apps are unavailable.',
      },
    });
    expect(descriptor?.requiredRendererCapabilities).toEqual([
      'sandboxed-mcp-app',
    ]);
    expect(descriptor?.alternativeRenderer?.requiredCapabilities).toEqual([
      'trusted-plugin-react',
    ]);
    expect(
      parseWorkspacePaneDescriptor({
        ...mcpDescriptorInput(),
        requiredRendererCapabilities: ['unknown-capability'],
      }),
    ).toBeNull();
  });

  test('selects a declared alternative only when its capability and renderer are both present', () => {
    const descriptor = parseWorkspacePaneDescriptor({
      ...mcpDescriptorInput(),
      provenance: {
        origin: 'plugin',
        pluginId: 'third-party-review',
        mcpServerId: 'github',
      },
      requiredRendererCapabilities: ['sandboxed-mcp-app'],
      alternativeRenderer: {
        rendererId: 'third-party-review-read-only',
        renderer: { kind: 'plugin-component', name: 'review-read-only' },
        requiredCapabilities: ['trusted-plugin-react'],
        reason: 'Use the read-only contribution when MCP Apps are unavailable.',
      },
    })!;

    const selected = selectWorkspacePaneRenderer(descriptor, {
      capabilities: ['trusted-plugin-react'],
      isRendererPresent: (candidate) =>
        candidate.renderer.kind === 'plugin-component' &&
        candidate.renderer.name === 'review-read-only',
    });
    expect(selected).toEqual({
      state: 'selected',
      candidate: expect.objectContaining({
        source: 'alternative',
        rendererId: 'third-party-review-read-only',
        renderer: { kind: 'plugin-component', name: 'review-read-only' },
        contributorProvenance: {
          origin: 'plugin',
          pluginId: 'third-party-review',
          mcpServerId: 'github',
        },
      }),
    });
    expect(
      selectWorkspacePaneRenderer(descriptor, {
        capabilities: [],
        isRendererPresent: () => true,
      }),
    ).toEqual({ state: 'unavailable' });
  });

  test('rejects the removed descriptor renderer key', () => {
    const input = {
      ...builtinDescriptorInput(),
      fallback: {
        renderer: { kind: 'builtin-component', name: 'unavailable-pane' },
      },
    };

    expect(parseWorkspacePaneDescriptor(input)).toBeNull();
  });

  test('ignores additive unknown fields, including on nested objects', () => {
    const input = {
      ...builtinDescriptorInput(),
      futureTopLevelField: 'ignored',
      placement: { region: 'primary', futureNestedField: 'ignored' },
      provenance: { origin: 'builtin', futureField: 'ignored' },
      lifecycle: { stage: 'stable', futureField: 'ignored' },
    };

    const descriptor = parseWorkspacePaneDescriptor(
      input,
    ) as WorkspacePaneDescriptor;
    expect(descriptor).not.toHaveProperty('futureTopLevelField');
    expect(descriptor.placement).not.toHaveProperty('futureNestedField');
    expect(descriptor.provenance).not.toHaveProperty('futureField');
    expect(descriptor.lifecycle).not.toHaveProperty('futureField');
  });

  test('keeps plural placement capability and exact bound context separate', () => {
    const descriptor = parseWorkspacePaneDescriptor({
      ...pluginDescriptorInput(),
      placement: {
        supportedRegions: ['primary', 'secondary', 'standalone'],
        preferredRegion: 'secondary',
      },
      modes: [
        {
          id: 'default',
          contextRequirement: {
            project: true,
            task: true,
            session: true,
            run: true,
            workspace: true,
            source: true,
          },
        },
      ],
    })!;
    const instance = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: descriptor.id,
      instanceId: 'review-queue-project-a',
      stateKey: 'review-queue-state-project-a',
      boundContext: {
        projectId: 'project-a',
        taskId: 'task-a',
        sessionId: 'session-a',
        runId: 'run-a',
        workspaceId: 'workspace-a',
        sourceId: 'plugin:review-queue-plugin',
        contribution: {
          id: 'plugin:review-queue-plugin:review',
          version: '1.2.3',
          sourceIdentity: {
            id: 'review-queue-plugin',
            kind: 'local',
            source: 'plugins/review-queue-plugin',
          },
          provenance: {
            origin: 'plugin',
            pluginId: 'review-queue-plugin',
          },
        },
        futureBinding: 'ignored',
      },
    })!;

    expect(descriptor.placement).toEqual({
      supportedRegions: ['primary', 'secondary', 'standalone'],
      preferredRegion: 'secondary',
    });
    expect(descriptor.modes).toEqual([
      {
        id: 'default',
        contextRequirement: {
          project: true,
          task: true,
          session: true,
          run: true,
          workspace: true,
          source: true,
        },
      },
    ]);
    expect(instance.boundContext).toEqual({
      projectId: 'project-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      runId: 'run-a',
      workspaceId: 'workspace-a',
      sourceId: 'plugin:review-queue-plugin',
      contribution: {
        id: 'plugin:review-queue-plugin:review',
        version: '1.2.3',
        sourceIdentity: {
          id: 'review-queue-plugin',
          kind: 'local',
          source: 'plugins/review-queue-plugin',
        },
        provenance: {
          origin: 'plugin',
          pluginId: 'review-queue-plugin',
        },
      },
    });
  });

  test('binds a stable layout on a parsed instance copy without mutating the catalog instance', () => {
    const catalogInstance = parseWorkspacePaneInstance({
      version: WORKSPACE_PANE_CONTRACT_VERSION,
      descriptorId: 'coding-pane',
      instanceId: 'coding-pane#project-a',
      stateKey: 'coding-pane#project-a#state',
      boundContext: { projectId: 'project-a', sourceId: 'builtin:coding' },
    })!;

    const layout: LayoutMetadata = {
      id: 'layout-uuid',
      slug: 'coding',
      projectSlug: 'project-a',
      type: 'builtin',
      name: 'Coding',
    };
    const bound = withWorkspacePaneInstanceLayoutBinding(
      catalogInstance,
      layout,
    );

    expect(bound).toEqual({
      ...catalogInstance,
      boundContext: {
        projectId: 'project-a',
        layoutId: 'layout-uuid',
        sourceId: 'builtin:coding',
      },
    });
    expect(bound).not.toBe(catalogInstance);
    expect(bound?.boundContext).not.toBe(catalogInstance.boundContext);
    expect(catalogInstance.boundContext).toEqual({
      projectId: 'project-a',
      sourceId: 'builtin:coding',
    });
    expect(
      withWorkspacePaneInstanceLayoutBinding(
        catalogInstance,
        'coding' as unknown as LayoutMetadata,
      ),
    ).toBeNull();
  });

  test('rejects malformed known placement and bound-context fields while reading legacy region data', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        placement: { supportedRegions: ['primary', 'primary'] },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        placement: {
          supportedRegions: ['primary'],
          preferredRegion: 'secondary',
        },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneInstance({
        version: '1.0',
        descriptorId: 'coding-pane',
        instanceId: 'coding-instance',
        stateKey: 'coding-state',
        boundContext: { taskId: '  task-a' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneInstance({
        version: '1.0',
        descriptorId: 'pane:review-queue',
        instanceId: 'review-queue-project-a',
        stateKey: 'review-queue-state-project-a',
        boundContext: {
          contribution: {
            id: 'plugin:review-queue-plugin:review',
            version: '',
            sourceIdentity: { id: 'review-queue-plugin', kind: 'local' },
            provenance: { origin: 'plugin', pluginId: 'review-queue-plugin' },
          },
        },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor(builtinDescriptorInput())?.placement,
    ).toEqual({
      supportedRegions: ['primary'],
    });
  });

  test('keeps application-host details out of the serialized contract', () => {
    const descriptor = parseWorkspacePaneDescriptor({
      ...builtinDescriptorInput(),
      host: 'tauri',
      webviewHandle: 42,
      nativeGeometry: { x: 10, y: 20, width: 800, height: 600 },
      placement: {
        region: 'primary',
        electronWebContentsId: 7,
      },
    }) as WorkspacePaneDescriptor;

    expect(descriptor).not.toHaveProperty('host');
    expect(descriptor).not.toHaveProperty('webviewHandle');
    expect(descriptor).not.toHaveProperty('nativeGeometry');
    expect(descriptor.placement).toEqual({
      supportedRegions: ['primary'],
      preferredRegion: 'primary',
    });
    expect(JSON.stringify(descriptor)).not.toMatch(
      /tauri|electron|webview|nativeGeometry/i,
    );
  });

  test('drops additive unknown fields on the primary and alternative renderer', () => {
    const input = {
      ...mcpDescriptorInput(),
      renderer: {
        ...(mcpDescriptorInput().renderer as Record<string, unknown>),
        futureRendererField: 'ignored',
      },
      alternativeRenderer: {
        renderer: {
          kind: 'builtin-component',
          name: 'unavailable-pane',
          futureAlternativeRendererField: 'ignored',
        },
        reason: 'MCP server unreachable',
      },
    };

    const descriptor = parseWorkspacePaneDescriptor(
      input,
    ) as WorkspacePaneDescriptor;
    expect(descriptor).not.toBeNull();
    expect(descriptor.renderer).not.toHaveProperty('futureRendererField');
    expect(descriptor.alternativeRenderer?.renderer).not.toHaveProperty(
      'futureAlternativeRendererField',
    );
    expect(descriptor.alternativeRenderer?.renderer).toEqual({
      kind: 'builtin-component',
      name: 'unavailable-pane',
    });
  });

  test('fails closed on malformed optional MCP renderer fields', () => {
    const base = mcpDescriptorInput();
    const baseRenderer = base.renderer as Record<string, unknown>;

    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, displayMode: 'not-a-real-mode' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, approvalPolicy: 'not-a-real-policy' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, resourceUri: '  padded  ' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, fallbackComponent: '' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, initialArguments: 'not-an-object' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        alternativeRenderer: {
          renderer: {
            kind: 'mcp-tool-ui',
            ref: 'github/create_issue',
            displayMode: 'not-a-real-mode',
          },
        },
      }),
    ).toBeNull();
  });

  test('rejects initialArguments containing a nested Date instance', () => {
    const base = mcpDescriptorInput();
    const baseRenderer = base.renderer as Record<string, unknown>;
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: {
          ...baseRenderer,
          initialArguments: { nested: { createdAt: new Date() } },
        },
      }),
    ).toBeNull();
  });

  test('rejects initialArguments containing dangerous keys', () => {
    const base = mcpDescriptorInput();
    const baseRenderer = base.renderer as Record<string, unknown>;
    for (const dangerousKey of ['__proto__', 'prototype', 'constructor']) {
      const initialArguments = JSON.parse(
        `{"nested": {"${dangerousKey}": "evil"}}`,
      ) as Record<string, unknown>;
      expect(
        parseWorkspacePaneDescriptor({
          ...base,
          renderer: { ...baseRenderer, initialArguments },
        }),
      ).toBeNull();
    }
  });

  test('rejects initialArguments containing a cyclic reference', () => {
    const base = mcpDescriptorInput();
    const baseRenderer = base.renderer as Record<string, unknown>;
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, initialArguments: { nested: cyclic } },
      }),
    ).toBeNull();
  });

  test('rejects initialArguments containing an array with an undefined member', () => {
    const base = mcpDescriptorInput();
    const baseRenderer = base.renderer as Record<string, unknown>;
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: {
          ...baseRenderer,
          initialArguments: { list: [1, undefined, 3] },
        },
      }),
    ).toBeNull();
  });

  test('rejects initialArguments nested at depth 33', () => {
    const base = mcpDescriptorInput();
    const baseRenderer = base.renderer as Record<string, unknown>;
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 33; i += 1) {
      deep = { nested: deep };
    }
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, initialArguments: deep },
      }),
    ).toBeNull();
  });

  test('accepts initialArguments nested at the maximum allowed depth', () => {
    const base = mcpDescriptorInput();
    const baseRenderer = base.renderer as Record<string, unknown>;
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 32; i += 1) {
      deep = { nested: deep };
    }
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, initialArguments: deep },
      }),
    ).not.toBeNull();
  });

  test('rejects initialArguments containing non-finite numbers', () => {
    const base = mcpDescriptorInput();
    const baseRenderer = base.renderer as Record<string, unknown>;
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, initialArguments: { value: NaN } },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...base,
        renderer: { ...baseRenderer, initialArguments: { value: Infinity } },
      }),
    ).toBeNull();
  });

  test('clones initialArguments so mutating the source or the result does not alias the other', () => {
    const base = mcpDescriptorInput();
    const baseRenderer = base.renderer as Record<string, unknown>;
    const source: Record<string, unknown> = {
      nested: { list: [1, 2, 3] },
    };
    const descriptor = parseWorkspacePaneDescriptor({
      ...base,
      renderer: { ...baseRenderer, initialArguments: source },
    }) as WorkspacePaneDescriptor;

    expect(descriptor).not.toBeNull();
    const initialArguments = descriptor.renderer as {
      initialArguments?: Record<string, unknown>;
    };
    expect(initialArguments.initialArguments).toEqual({
      nested: { list: [1, 2, 3] },
    });

    (source.nested as Record<string, unknown>).list = [9, 9, 9];
    expect(initialArguments.initialArguments).toEqual({
      nested: { list: [1, 2, 3] },
    });

    const clonedNested = (
      initialArguments.initialArguments as Record<string, unknown>
    ).nested as Record<string, unknown>;
    (clonedNested.list as unknown[]).push(4);
    const secondParse = parseWorkspacePaneDescriptor({
      ...base,
      renderer: { ...baseRenderer, initialArguments: source },
    }) as WorkspacePaneDescriptor;
    const secondInitialArguments = (
      secondParse.renderer as { initialArguments?: Record<string, unknown> }
    ).initialArguments as Record<string, unknown>;
    expect(
      (secondInitialArguments.nested as Record<string, unknown>).list,
    ).toEqual([9, 9, 9]);
  });

  test('requires a non-empty trimmed name for builtin and plugin renderers', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        renderer: { kind: 'builtin-component', name: '  padded  ' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...pluginDescriptorInput(),
        renderer: { kind: 'plugin-component', name: '' },
      }),
    ).toBeNull();
  });

  test('rejects an unsupported contract version', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        version: '2.0',
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        version: undefined,
      }),
    ).toBeNull();
  });

  test('rejects a malformed renderer field', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        renderer: { kind: 'unknown-kind', name: 'x' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        renderer: { kind: 'mcp-tool-ui', ref: 'not a valid ref' },
      }),
    ).toBeNull();
  });

  test('rejects a malformed rendererId field', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        rendererId: '',
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        rendererId: '  padded  ',
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        rendererId: undefined,
      }),
    ).toBeNull();
    expect(() => toWorkspacePaneRendererId('')).toThrow(TypeError);
    expect(() => toWorkspacePaneRendererId(' padded ')).toThrow(TypeError);
  });

  test('rejects malformed mode requirements', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...pluginDescriptorInput(),
        modes: [
          { id: 'default', contextRequirement: { requiresProject: 'yes' } },
        ],
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...pluginDescriptorInput(),
        modes: [
          {
            id: 'default',
            contextRequirement: { requiredProviders: ['github', ''] },
          },
        ],
      }),
    ).toBeNull();
  });

  test('keeps contributor provenance independent from the renderer security class', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        provenance: { origin: 'plugin', pluginId: 'x' },
      }),
    ).toMatchObject({
      renderer: { kind: 'builtin-component', name: 'coding-pane' },
      provenance: { origin: 'plugin', pluginId: 'x' },
    });
    expect(
      parseWorkspacePaneDescriptor({
        ...mcpDescriptorInput(),
        provenance: { origin: 'builtin' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        provenance: { origin: 'not-a-real-origin' },
      }),
    ).toBeNull();
  });

  test('rejects provenance attribution fields that disagree with origin', () => {
    // builtin accepts neither pluginId nor mcpServerId
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        provenance: { origin: 'builtin', pluginId: 'x' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        provenance: { origin: 'builtin', mcpServerId: 'x' },
      }),
    ).toBeNull();

    // plugin requires pluginId and rejects mcpServerId
    expect(
      parseWorkspacePaneDescriptor({
        ...pluginDescriptorInput(),
        provenance: { origin: 'plugin' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...pluginDescriptorInput(),
        provenance: {
          origin: 'plugin',
          pluginId: 'review-queue-plugin',
          mcpServerId: 'github',
        },
      }),
    ).toBeNull();

    // mcp requires mcpServerId and rejects pluginId
    expect(
      parseWorkspacePaneDescriptor({
        ...mcpDescriptorInput(),
        provenance: { origin: 'mcp' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...mcpDescriptorInput(),
        provenance: { origin: 'mcp', mcpServerId: 'github', pluginId: 'x' },
      }),
    ).toBeNull();
  });

  test('rejects mcp provenance whose mcpServerId is spoofed relative to the renderer ref', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...mcpDescriptorInput(),
        renderer: {
          kind: 'mcp-tool-ui',
          ref: 'github/create_issue',
        },
        provenance: { origin: 'mcp', mcpServerId: 'not-github' },
      }),
    ).toBeNull();
  });

  test('rejects a malformed lifecycle field', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        lifecycle: { stage: 'not-a-real-stage' },
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        lifecycle: {
          stage: 'stable',
          deprecationNotice: 'only valid when deprecated',
        },
      }),
    ).toBeNull();
  });

  test('rejects malformed identity fields', () => {
    expect(
      parseWorkspacePaneDescriptor({ ...builtinDescriptorInput(), id: '' }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        id: '  padded  ',
      }),
    ).toBeNull();
    expect(() => toWorkspacePaneDescriptorId('')).toThrow(TypeError);
    expect(() => toWorkspacePaneInstanceId(' padded ')).toThrow(TypeError);
    expect(() => toWorkspacePaneStateKey('')).toThrow(TypeError);
  });

  test('rejects a missing or malformed renderer identity', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        rendererId: '',
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneDescriptor({
        ...builtinDescriptorInput(),
        rendererId: 123,
      }),
    ).toBeNull();
    const { rendererId: _omitted, ...withoutRendererId } =
      builtinDescriptorInput();
    expect(parseWorkspacePaneDescriptor(withoutRendererId)).toBeNull();
  });

  test('gives two instances of one descriptor independent instance and state-key identity', () => {
    const first = parseWorkspacePaneInstance({
      version: WORKSPACE_PANE_CONTRACT_VERSION,
      descriptorId: 'coding-pane',
      instanceId: 'coding-pane#project-a',
      stateKey: 'coding-pane#project-a#state',
    });
    const second = parseWorkspacePaneInstance({
      version: WORKSPACE_PANE_CONTRACT_VERSION,
      descriptorId: 'coding-pane',
      instanceId: 'coding-pane#project-b',
      stateKey: 'coding-pane#project-b#state',
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).toEqual({
      version: '1.0',
      descriptorId: 'coding-pane',
      instanceId: 'coding-pane#project-a',
      stateKey: 'coding-pane#project-a#state',
    });
    expect(first?.descriptorId).toBe(second?.descriptorId);
    expect(first?.instanceId).not.toBe(second?.instanceId);
    expect(first?.stateKey).not.toBe(second?.stateKey);
  });

  test('rejects a WorkspacePane instance missing any identity field', () => {
    expect(
      parseWorkspacePaneInstance({
        version: WORKSPACE_PANE_CONTRACT_VERSION,
        descriptorId: 'coding-pane',
        instanceId: 'coding-pane#project-a',
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneInstance({
        version: WORKSPACE_PANE_CONTRACT_VERSION,
        descriptorId: '',
        instanceId: 'x',
        stateKey: 'y',
      }),
    ).toBeNull();
  });

  test('rejects a WorkspacePane instance with an unsupported or missing version', () => {
    expect(
      parseWorkspacePaneInstance({
        version: '2.0',
        descriptorId: 'coding-pane',
        instanceId: 'coding-pane#project-a',
        stateKey: 'coding-pane#project-a#state',
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneInstance({
        descriptorId: 'coding-pane',
        instanceId: 'coding-pane#project-a',
        stateKey: 'coding-pane#project-a#state',
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneInstance({
        version: undefined,
        descriptorId: 'coding-pane',
        instanceId: 'coding-pane#project-a',
        stateKey: 'coding-pane#project-a#state',
      }),
    ).toBeNull();
  });

  test('keeps descriptor, instance, and state-key identities as distinct branded types', () => {
    const descriptorId: WorkspacePaneDescriptorId =
      toWorkspacePaneDescriptorId('coding-pane');
    // @ts-expect-error a descriptor id is not assignable to an instance id
    const notAnInstanceId: WorkspacePaneInstanceId = descriptorId;
    expect(notAnInstanceId).toBe(descriptorId);
  });

  test('keeps renderer identity distinct from descriptor/instance/state-key identities', () => {
    const rendererId: WorkspacePaneRendererId = toWorkspacePaneRendererId(
      'builtin-coding-pane',
    );
    // @ts-expect-error a renderer id is not assignable to a descriptor id
    const notADescriptorId: WorkspacePaneDescriptorId = rendererId;
    expect(notADescriptorId).toBe(rendererId);

    const descriptorId = toWorkspacePaneDescriptorId('coding-pane');
    // @ts-expect-error a descriptor id is not assignable to a renderer id
    const notARendererId: WorkspacePaneRendererId = descriptorId;
    expect(notARendererId).toBe(descriptorId);
  });

  test('parses two descriptors sharing a renderer ref shape as independent renderer identities', () => {
    const first = parseWorkspacePaneDescriptor({
      ...builtinDescriptorInput(),
      rendererId: 'builtin-coding-pane-v1',
    }) as WorkspacePaneDescriptor;
    const second = parseWorkspacePaneDescriptor({
      ...builtinDescriptorInput(),
      rendererId: 'builtin-coding-pane-v2',
    }) as WorkspacePaneDescriptor;

    expect(first.renderer).toEqual(second.renderer);
    expect(first.rendererId).not.toBe(second.rendererId);
  });
});

describe('MCP App display-mode mediation', () => {
  const paneIdentity = {
    descriptorId: toWorkspacePaneDescriptorId('mcp-review'),
    instanceId: toWorkspacePaneInstanceId('mcp-review-instance'),
    stateKey: toWorkspacePaneStateKey('mcp-review-state'),
  };
  const intent = {
    requestedMode: 'fullscreen' as const,
    currentMode: 'inline' as const,
    appAvailableModes: ['inline', 'fullscreen'] as const,
    hostAvailableModes: mcpAppHostAvailableDisplayModes(paneIdentity),
    lifecycle: 'active' as const,
    paneIdentity,
  };

  test('maps allowed fullscreen to maximize while preserving exact Pane identity', () => {
    expect(mediateMcpAppDisplayMode(intent)).toEqual({
      outcome: 'accepted',
      requestedMode: 'fullscreen',
      actualMode: 'fullscreen',
      panePresentation: 'maximized',
      paneIdentity,
      popout: false,
    });
    expect(
      mediateMcpAppDisplayMode({
        ...intent,
        requestedMode: 'inline',
        currentMode: 'fullscreen',
      }),
    ).toMatchObject({
      outcome: 'accepted',
      actualMode: 'inline',
      panePresentation: 'inline',
      paneIdentity,
      popout: false,
    });
  });

  test.each([
    [
      { lifecycle: 'initializing' as const },
      'declined',
      'lifecycle-not-active',
    ],
    [{ paneIdentity: undefined }, 'declined', 'pane-identity-unavailable'],
    [
      { appAvailableModes: ['inline'] as const },
      'declined',
      'app-mode-undeclared',
    ],
    [
      { hostAvailableModes: ['inline'] as const },
      'declined',
      'host-mode-unavailable',
    ],
    [{ requestedMode: 'pip' as const }, 'unsupported', 'pip-unsupported'],
  ])(
    'declines unsupported/hostile intent %# truthfully',
    (override, outcome, reason) => {
      expect(
        mediateMcpAppDisplayMode({ ...intent, ...override }),
      ).toMatchObject({
        outcome,
        actualMode: 'inline',
        panePresentation: 'inline',
        popout: false,
        reason,
      });
    },
  );
});
