import type { GitReadLocation } from '@kontourai/station-sdk';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
import type { HomeLaneItem } from '../../views/home/home-lane-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import { InboxRow } from '../chat-dock/ChatDockInboxRows';
import { rowProjectMarks } from '../inbox-row/row-project-marks';

interface HomeWorkRowProps {
  task: HomeLaneItem;
  isWoken: boolean;
  /**
   * The agent catalog, used only to resolve this row's icon. An agent this
   * Station does not have renders no icon (`inboxRowIconAgent`).
   */
  agents: readonly SessionIconAgent[];
  onOpen: (task: HomeLaneItem) => void;
  /** Present on the live lanes: the row's snooze control, which opens the
   *  shared duration choice and reports the chosen wake time. */
  onSnooze?: (task: HomeLaneItem, wakeAt: number) => void;
  /**
   * #2312: offer "Discard draft" (a server delete) when the row is a Draft
   * the server can name. Set by the Drafts section only.
   */
  discardDraft?: boolean;
  /** `slim` for the settled tail; every other lane renders the full card. */
  size?: 'card' | 'slim';
  /** The lanes' own clock and the status facts derived beside the items. */
  context: HomeRowContext;
}

export interface HomeRowContext {
  now: number;
  workFacts?: WorkFactsById;
  /** The item whose Details sheet is open; owned by the section so a row
   *  that changes lane keeps its sheet. */
  detailsFor: string | null;
  setDetailsFor: (id: string | null) => void;
  /**
   * Which chrome the rows render (B5, C8): `hover` on a fine pointer, where
   * the hover card and the snooze control appear over the time slot on
   * hover or focus, exactly as in the dock; `touch` on a coarse pointer,
   * where the row keeps its always-visible 44px Details and one action.
   * Decided once by the section from `useCoarsePointer`.
   */
  chrome: 'hover' | 'touch';
  /**
   * The rows' hover-card git sections, by thread id — the dock's own
   * derivation (`useGitLocationByThreadId`), so a row names the same branch
   * on Home as in the inbox.
   */
  gitLocationByThreadId?: ReadonlyMap<string, GitReadLocation>;
  /** The sidebar's project colours (`useProjectAccents`), by slug. */
  projectAccentBySlug?: ReadonlyMap<string, string>;
  /** The projects' icons (`useProjectIcons`), by slug. */
  projectIconBySlug?: ReadonlyMap<string, string>;
}

/** The discard itself is the button's own server command; Home has no tab
 *  bookkeeping or focus move to add after it. */
const afterDraftDiscarded = () => {};

/**
 * Home's work row is the shared inbox row (#3043), in the chrome its
 * pointer calls for. A Home row used to show the (i) and clock on every row
 * on every pointer — twenty icons on a ten-row page.
 */
export function renderHomeWorkRow({
  task,
  isWoken,
  agents,
  onOpen,
  onSnooze,
  discardDraft = false,
  size = 'card',
  context,
}: HomeWorkRowProps) {
  return (
    <li key={task.stableId}>
      <InboxRow
        item={task}
        rowKey={task.stableId}
        isCurrent={false}
        isSnoozed={false}
        isOpenChat={false}
        now={context.now}
        facts={context.workFacts?.get(task.id)}
        detailsOpen={context.detailsFor === task.id}
        onDetailsOpenChange={(open) =>
          context.setDetailsFor(open ? task.id : null)
        }
        size={size}
        chrome={context.chrome}
        agents={agents}
        isWoken={isWoken}
        // Resolved exactly as `InboxGroupList` resolves the dock's rows.
        gitLocation={context.gitLocationByThreadId?.get(
          task.orchestrationThreadId ?? task.chatSessionId ?? '',
        )}
        {...rowProjectMarks(
          task,
          context.projectAccentBySlug,
          context.projectIconBySlug,
        )}
        onActivate={() => onOpen(task)}
        onSnoozeWake={
          onSnooze
            ? (_item, wakeAt) => {
                // Home's live lanes hold nothing snoozed, so `null` (unsnooze)
                // never arrives here; the shelf below wakes rows.
                if (wakeAt !== null) onSnooze(task, wakeAt);
              }
            : undefined
        }
        onDraftDiscarded={discardDraft ? afterDraftDiscarded : undefined}
      />
    </li>
  );
}
