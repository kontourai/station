import type { SessionIconAgent } from '../../utils/sessionDisplay';
import type { HomeLaneItem } from '../../views/home/home-lane-model';
import { InboxRow } from '../chat-dock/ChatDockInboxRows';

interface HomeWorkRowProps {
  task: HomeLaneItem;
  isWoken: boolean;
  /**
   * The agent catalog, used only to resolve this row's icon. An agent this
   * Station does not have renders no icon (`inboxRowIconAgent`).
   */
  agents: readonly SessionIconAgent[];
  onOpen: (task: HomeLaneItem) => void;
  onSnooze?: (task: HomeLaneItem, trigger: HTMLButtonElement) => void;
  /**
   * #2312: offer "Discard draft" (a server delete) when the row is a Draft
   * the server can name. Set by the Drafts section only.
   */
  discardDraft?: boolean;
  /** `slim` for the settled tail; every other lane renders the full card. */
  size?: 'card' | 'slim';
}

/** The discard itself is the button's own server command; Home has no tab
 *  bookkeeping or focus move to add after it. */
const afterDraftDiscarded = () => {};

/**
 * Home's work row is the shared inbox row (#3043), in the always-visible
 * `touch` chrome: Home is used on phones, where there is no hover to reveal
 * a snooze control with. It mounts no hover card; Home has no session
 * records to resolve one's git section from.
 */
export function renderHomeWorkRow({
  task,
  isWoken,
  agents,
  onOpen,
  onSnooze,
  discardDraft = false,
  size = 'card',
}: HomeWorkRowProps) {
  return (
    <li key={task.stableId}>
      <InboxRow
        item={task}
        rowKey={task.stableId}
        isCurrent={false}
        isSnoozed={false}
        isOpenChat={false}
        now={Date.now()}
        size={size}
        chrome="touch"
        hoverCard={false}
        agents={agents}
        isWoken={isWoken}
        onActivate={() => onOpen(task)}
        onSnoozeMenu={
          onSnooze ? (_item, trigger) => onSnooze(task, trigger) : undefined
        }
        onDraftDiscarded={discardDraft ? afterDraftDiscarded : undefined}
      />
    </li>
  );
}
