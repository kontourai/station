import { expect } from 'vitest';

import { agentId } from '../agent-identity';
import type { LayoutTab } from '../layout';
import type {
  WorkspacePaneLayoutAdapterContext,
  WorkspacePaneLayoutTabAdaptation,
} from '../workspace-pane-layout-adapter';
import { paneAdaptationFromLayoutTab } from '../workspace-pane-layout-adapter';

/** Synthetic generic contributor data shared by adapter responsibility tests. */
export function builtinTab(): LayoutTab {
  return {
    id: 'files',
    label: 'Files',
    component: { kind: 'builtin-component', name: 'file-tree' },
    icon: '📁',
    description: 'Working directory file tree',
  };
}

export function pluginTab(): LayoutTab {
  return {
    id: 'review-queue',
    label: 'Review Queue',
    component: { kind: 'plugin-component', name: 'review-queue-panel' },
    actions: [
      { type: 'prompt', label: 'Summarize', data: 'summarize the queue' },
      {
        type: 'inline-prompt',
        label: 'Triage',
        data: 'triage the queue',
        icon: '⚖️',
        agent: agentId('reviewer'),
      },
    ],
    skills: [{ type: 'prompt', label: 'Explain', data: 'explain this queue' }],
  };
}

export function mcpTab(): LayoutTab {
  return {
    id: 'issue-ui',
    label: 'Issue',
    component: {
      kind: 'mcp-tool-ui',
      ref: 'synthetic-server/create_issue',
      resourceUri: 'ui://synthetic-server/create_issue',
      displayMode: 'fullscreen',
      fallbackComponent: 'unavailable-pane',
      initialArguments: { repo: 'synthetic/repo', labels: ['bug', 'ui'] },
      approvalPolicy: 'require',
    },
    icon: '🧩',
  };
}

export function baselineStringTab(): LayoutTab {
  return {
    id: 'terminal',
    label: 'Terminal',
    component: 'terminal-panel',
    description: 'Baseline bare-string component spelling',
  };
}

export function context(
  overrides: Partial<WorkspacePaneLayoutAdapterContext> = {},
): WorkspacePaneLayoutAdapterContext {
  return { layoutSlug: 'synthetic-layout', ...overrides };
}

export function adapt(
  tab: LayoutTab,
  overrides: Partial<WorkspacePaneLayoutAdapterContext> = {},
): WorkspacePaneLayoutTabAdaptation {
  const adaptation = paneAdaptationFromLayoutTab(tab, context(overrides));
  expect(adaptation).not.toBeNull();
  return adaptation as WorkspacePaneLayoutTabAdaptation;
}
