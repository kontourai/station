import { useCallback, useMemo } from 'react';
import { getPathForView } from '../../app-shell/routing';
import { useNavigationActions } from '../../contexts/NavigationContext';
import { openChatsStore } from '../../contexts/open-chats-store';
import type { NavigationView } from '../../types';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import { useHomeViewModel } from '../../views/home/useHomeViewModel';
import { MessageGlyph } from '../icons/Glyph';

/** How many conversations the drawer lists before "See all". */
export const RECENT_CHAT_LIMIT = 5;

/**
 * The latest conversations, newest first, each once (#4386): a chat that is
 * both an open tab and an inventory row arrives as one item per id, but a
 * repeated conversation id across kinds still renders a single row.
 */
export function selectRecentChats(
  items: readonly HomeWorkItem[],
  limit = RECENT_CHAT_LIMIT,
): HomeWorkItem[] {
  const seen = new Set<string>();
  const recent: HomeWorkItem[] = [];
  for (const item of [...items].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (item.kind !== 'chat' && item.kind !== 'orchestration') continue;
    if (item.lifecycleLabel === 'Draft') continue;
    const key = item.conversationId ?? item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(item);
    if (recent.length === limit) break;
  }
  return recent;
}

interface ProjectSidebarRecentChatsProps {
  onAfterNavigate: () => void;
}

/**
 * #4397: the phone drawer's way back to a previous chat. Rows open through
 * Home's own Continue action, so a phone opens them full screen (#4391);
 * "See all" opens the dock's Inbox, the full list.
 */
export function ProjectSidebarRecentChats({
  onAfterNavigate,
}: ProjectSidebarRecentChatsProps) {
  const { navigate, setLayout } = useNavigationActions();
  const onNavigate = useCallback(
    (view: NavigationView) => {
      if (view.type === 'layout') {
        setLayout(view.projectSlug, view.layoutSlug);
        return;
      }
      const path = getPathForView(view);
      if (path) navigate(path);
    },
    [navigate, setLayout],
  );
  const { workItems, continueWork } = useHomeViewModel(onNavigate);
  const recent = useMemo(() => selectRecentChats(workItems), [workItems]);
  if (recent.length === 0) return null;
  return (
    <section
      className="sidebar__recent-chats"
      aria-labelledby="sidebar-recent-chats-label"
    >
      <div className="sidebar__section-label">
        <span
          id="sidebar-recent-chats-label"
          className="sidebar__section-label-text"
        >
          Recent chats
        </span>
        <button
          type="button"
          className="sidebar__section-link"
          onClick={() => {
            openChatsStore.openCollection();
            onAfterNavigate();
          }}
        >
          See all
        </button>
      </div>
      <ul className="sidebar__recent-chat-list">
        {recent.map((item) => (
          <li key={item.conversationId ?? item.id}>
            <button
              type="button"
              className="sidebar__project-btn sidebar__recent-chat"
              onClick={() => {
                continueWork(item);
                onAfterNavigate();
              }}
            >
              <span className="sidebar__nav-icon" aria-hidden="true">
                <MessageGlyph />
              </span>
              <span className="sidebar__project-name">
                {item.title || 'Untitled chat'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
