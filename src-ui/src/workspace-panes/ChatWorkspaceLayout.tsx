import { ChatWorkspacePane } from '../components/chat-dock/ChatDock';

/** The full-screen layout placement of Station's one Chat pane renderer. */
export function ChatWorkspaceLayout({
  projectSlug,
  layoutSlug,
}: {
  projectSlug: string;
  layoutSlug: string;
  config: Record<string, unknown>;
}) {
  return (
    <ChatWorkspacePane
      placement="fullscreen"
      projectSlug={projectSlug}
      layoutSlug={layoutSlug}
    />
  );
}
