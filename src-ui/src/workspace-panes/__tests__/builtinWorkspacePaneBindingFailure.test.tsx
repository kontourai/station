/** @vitest-environment jsdom */

import { WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-browser-preview';
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
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { FILE_PREVIEW_PANE_DESCRIPTOR } from '../filePreviewPaneInstance';

const mocks = vi.hoisted(() => ({
  identity: {} as
    | { state: 'missing-project-binding' }
    | { state: 'project-unresolvable'; reason: 'missing' },
}));

vi.mock('../useWorkspacePaneBoundIdentity', () => ({
  useWorkspacePaneBoundIdentity: () => mocks.identity,
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useFlowDefinitionsQuery: () => ({ data: undefined }),
  useProjectLayoutQuery: () => ({ data: undefined }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    activeChat: null,
    openFilePreviewIntent: null,
    setLayout: vi.fn(),
  }),
}));
vi.mock('../../hooks/useDerivedSessions', () => ({
  useDerivedSessions: () => [],
}));
vi.mock('../WorkspacePaneHostOpenContext', () => ({
  useWorkspacePaneHostOpenAction: () => null,
}));

import { getBuiltinWorkspacePaneRenderer } from '../builtinWorkspacePaneRegistry';

const coding = paneAdaptationFromLayoutTab(
  {
    id: 'coding',
    label: 'Coding',
    component: { kind: 'builtin-component', name: 'coding' },
  },
  {
    layoutSlug: 'coding',
    instanceScope: 'project:project-id:source:builtin:coding',
    modeContextRequirement: { project: true, source: true },
    boundContext: { projectId: 'project-id', sourceId: 'builtin:coding' },
  },
)!;

const cases: readonly [string, WorkspacePaneDescriptor][] = [
  [
    'Flow Run Console',
    {
      ...WORKSPACE_PLAN_PANE_DESCRIPTOR,
      id: 'pane:builtin:flow',
      rendererId: 'renderer:builtin:flow',
      renderer: { kind: 'builtin-component', name: 'flow-run-console' },
    } as unknown as WorkspacePaneDescriptor,
  ],
  ['Chat', WORKSPACE_CHAT_PANE_DESCRIPTOR],
  ['Coding', coding.descriptor],
  ['Files', WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR],
  ['Diff', WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR],
  ['Terminal', WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR],
  ['Plan', WORKSPACE_PLAN_PANE_DESCRIPTOR],
  ['Readiness', WORKSPACE_READINESS_PANE_DESCRIPTOR],
  ['Trust', WORKSPACE_TRUST_PANE_DESCRIPTOR],
  ['Browser Preview', WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR],
  ['File Preview', FILE_PREVIEW_PANE_DESCRIPTOR],
];

function instanceFor(
  descriptor: WorkspacePaneDescriptor,
  boundContext: WorkspacePaneInstance['boundContext'],
) {
  return {
    version: '1.0',
    descriptorId: descriptor.id,
    instanceId: `instance:${descriptor.name}`,
    stateKey: `state:${descriptor.name}`,
    boundContext,
  } as WorkspacePaneInstance;
}

afterEach(() => {
  mocks.identity = { state: 'missing-project-binding' };
});

test.each(cases)(
  '%s renders visible unavailable content for missing and unresolvable bindings',
  (name, descriptor) => {
    for (const [label, identity, boundContext] of [
      ['missing', { state: 'missing-project-binding' as const }, undefined],
      [
        'unresolvable',
        { state: 'project-unresolvable' as const, reason: 'missing' as const },
        { projectId: 'gone-project' },
      ],
    ] as const) {
      mocks.identity = identity;
      const Pane = getBuiltinWorkspacePaneRenderer(descriptor)!;
      const { unmount } = render(
        <Pane
          descriptor={descriptor}
          instance={instanceFor(descriptor, boundContext)}
        />,
      );
      expect(
        screen.getByText(
          label === 'missing'
            ? 'This pane isn’t linked to a Project'
            : 'That Project is gone',
        ),
        `${name} ${label}`,
      ).toBeTruthy();
      unmount();
    }
  },
);
