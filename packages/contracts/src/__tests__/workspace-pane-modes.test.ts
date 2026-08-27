import { describe, expect, test } from 'vitest';
import { WORKSPACE_ACTIVITY_PANE_DESCRIPTOR } from '../workspace-activity-pane.js';
import { WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR } from '../workspace-browser-preview.js';
import { WORKSPACE_CHAT_PANE_DESCRIPTOR } from '../workspace-chat-pane.js';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '../workspace-coding-panels.js';
import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
} from '../workspace-evidence-panels.js';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '../workspace-file-preview.js';
import { WORKSPACE_HOME_PANE_DESCRIPTOR } from '../workspace-home-pane.js';
import { workspacePaneModesSatisfiableBy } from '../workspace-pane.js';
import { workspacePaneHostSuppliableContexts } from '../workspace-pane-host.js';
import { WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR } from '../workspace-spatial-board.js';
import {
  WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
  WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR,
} from '../workspace-task-room.js';

const BUILTIN_DESCRIPTORS = [
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
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
] as const;

describe('built-in Workspace Pane ambient satisfiability', () => {
  test('derives the behavior-identical ambient dockable set', () => {
    // Epic station#4142 M3: {chat, home} became {chat, home, activity} — the
    // first DELIBERATE expansion of the dockable set. Activity declaring a
    // requirement-free default mode makes it ambient-satisfiable, and this
    // pin changing is the system working: the set is a derivation over the
    // declarations, and every membership change must arrive as a reviewed
    // edit here naming the pane it admits.
    expect(
      BUILTIN_DESCRIPTORS.filter(
        (descriptor) =>
          workspacePaneModesSatisfiableBy(
            descriptor,
            workspacePaneHostSuppliableContexts({ kind: 'ambient' }),
          ).length > 0,
      ).map((descriptor) => descriptor.id),
    ).toEqual([
      WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.id,
      WORKSPACE_CHAT_PANE_DESCRIPTOR.id,
      WORKSPACE_HOME_PANE_DESCRIPTOR.id,
    ]);
  });
});
