import { describe, expect, test } from 'vitest';
import {
  createWorkspaceChatPaneInstance,
  isCanonicalWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
  WORKSPACE_CHAT_PANE_INSTANCE_ID,
} from '../workspace-chat-pane';

describe('Chat Workspace Pane contract', () => {
  test('declares the docked capability plus primary and standalone placements, with no Project requirement', () => {
    // `docked` is a capability claim: chat is a registered shell surface
    // (`REGION_SURFACE_REGISTRY`) and an ambient-dock occupant, and
    // docked-capability-derivation.test.ts pins the claim to both tables.
    expect(WORKSPACE_CHAT_PANE_DESCRIPTOR).toMatchObject({
      id: 'pane:builtin:chat',
      renderer: { kind: 'builtin-component', name: 'workspace-chat' },
      placement: {
        supportedRegions: ['primary', 'standalone', 'docked'],
        preferredRegion: 'primary',
      },
    });
    // station#3970: a chat MAY be projectless, so the descriptor cannot demand
    // a Project of every host that places it.
    expect(WORKSPACE_CHAT_PANE_DESCRIPTOR.modes).toEqual([{ id: 'default' }]);
  });

  test('issues a projectless occurrence for the shell dock', () => {
    const instance = createWorkspaceChatPaneInstance();

    expect(instance).toEqual(
      expect.objectContaining({
        instanceId: WORKSPACE_CHAT_PANE_INSTANCE_ID,
        boundContext: { sourceId: 'builtin:workspace-chat' },
      }),
    );
    expect(isCanonicalWorkspaceChatPaneInstance(instance!)).toBe(true);
  });

  test('issues a Project-bound occurrence for a Project layout, and it is equally canonical', () => {
    // The dock getting a projectless occurrence must not cost Project layouts
    // theirs: `builtinWorkspacePaneRegistry` renders the fullscreen Project
    // chat pane ONLY for a canonical instance, so a bound occurrence that
    // stopped being canonical would render Unavailable in every layout.
    const instance = createWorkspaceChatPaneInstance('project-a');

    expect(instance).toEqual(
      expect.objectContaining({
        instanceId: WORKSPACE_CHAT_PANE_INSTANCE_ID,
        boundContext: {
          projectId: 'project-a',
          sourceId: 'builtin:workspace-chat',
        },
      }),
    );
    expect(isCanonicalWorkspaceChatPaneInstance(instance!)).toBe(true);
  });

  test('rejects a blank or untrimmed Project identity rather than binding to it', () => {
    expect(createWorkspaceChatPaneInstance(' project-a ')).toBeNull();
    expect(createWorkspaceChatPaneInstance('')).toBeNull();

    const bound = createWorkspaceChatPaneInstance('project-a')!;
    expect(
      isCanonicalWorkspaceChatPaneInstance({
        ...bound,
        boundContext: { ...bound.boundContext, projectId: ' project-a ' },
      }),
    ).toBe(false);
  });

  test('rejects a mismatched occurrence and any context member beyond the Project', () => {
    const instance = createWorkspaceChatPaneInstance()!;
    expect(
      isCanonicalWorkspaceChatPaneInstance({
        ...instance,
        stateKey: 'other' as typeof instance.stateKey,
      }),
    ).toBe(false);
    expect(
      isCanonicalWorkspaceChatPaneInstance({
        ...instance,
        boundContext: { ...instance.boundContext, taskId: 'task-a' },
      }),
    ).toBe(false);
    expect(
      isCanonicalWorkspaceChatPaneInstance({
        ...instance,
        boundContext: { ...instance.boundContext, layoutId: 'layout-a' },
      }),
    ).toBe(false);
  });
});
