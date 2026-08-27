import type { ComponentType } from 'react';
import { SessionBoardLayout } from '../components/session/SessionBoardLayout';
import { TasksLayout } from '../components/TasksLayout';
import { ChatWorkspaceLayout } from '../workspace-panes/ChatWorkspaceLayout';

type LayoutTypeComponent = ComponentType<{
  projectSlug: string;
  layoutSlug: string;
  config: Record<string, unknown>;
}>;

export const layoutTypeRegistry: Record<string, LayoutTypeComponent> = {
  chat: ChatWorkspaceLayout,
  tasks: TasksLayout,
  'session-board': SessionBoardLayout,
};
