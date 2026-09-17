import { useRef, useState } from 'react';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { useMenuTriggerToggle } from '../../hooks/useMenuTriggerToggle';
import { Dialog } from '../Dialog';
import { LazyBoundary } from '../LazyBoundary';
import type { ForkTurnSource } from './fork-turn-source';
import type { TurnProvenanceStatedInRow } from './TurnProvenanceCard';
import { TurnProvenanceCard } from './TurnProvenanceCard';
import './TurnActionsMenu.css';

const loadConnectedAttachAnswerToTaskButton = () =>
  import('./AttachAnswerToTaskButton').then((module) => ({
    default: module.ConnectedAttachAnswerToTaskButton,
  }));

export interface TurnActionsMenuProps {
  taskTarget?: { sessionId: string; turnId: string; projectId?: string };
  forkSource?: ForkTurnSource | null;
  onForkFromTurn?: (source: ForkTurnSource) => void;
  /**
   * #2211: the per-turn record surfaces. The transcript stays focused on the
   * answer; provenance and reasoning open as dialogs from this menu instead
   * of occupying disclosure rows inside the bubble.
   */
  provenance?: {
    /** The envelope exactly as the row received it; the card decides readability. */
    envelope: unknown;
    /** What the row's own chips already state, so the card can stand down. */
    statedInRow: TurnProvenanceStatedInRow;
    accountableHuman?: string | null;
    /** Share affordance, composed by the row and mounted only in the dialog. */
    shareContent?: React.ReactNode;
    /** Basis affordance, composed by the row and mounted only in the dialog. */
    basisContent?: React.ReactNode;
  };
  reasoning?: { content: string };
}

/**
 * Word count for the reasoning menu item, mirroring ReasoningSection's
 * Intl.Segmenter count with the same regex fallback.
 */
function countReasoningWords(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale?: string,
        options?: { granularity?: string },
      ) => { segment(input: string): Iterable<{ isWordLike?: boolean }> };
    }
  ).Segmenter;
  if (Segmenter) {
    let count = 0;
    for (const segment of new Segmenter(undefined, {
      granularity: 'word',
    }).segment(trimmed)) {
      if (segment.isWordLike) count += 1;
    }
    return count;
  }
  return trimmed.match(/\S+/gu)?.length ?? 0;
}

/** Lazy per-turn overflow, using the same focus primitive as app header menus. */
export default function TurnActionsMenu({
  taskTarget,
  forkSource,
  onForkFromTurn,
  provenance,
  reasoning,
}: TurnActionsMenuProps) {
  const [view, setView] = useState<
    'closed' | 'menu' | 'picker' | 'provenance' | 'reasoning'
  >('closed');
  const open = view === 'menu';
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () =>
    setView((current) => (current === 'menu' ? 'closed' : current));
  const closeDialog = () => setView('closed');
  const menuRef = useMenuFocus<HTMLDivElement>(open, close);
  /**
   * #2081. The trigger is a SIBLING of the menu container, not a child, so
   * pressing it moves focus out of the container and `useMenuFocus` dismisses
   * the menu before the press becomes a click — after which `setView(open ?
   * …)` read the flushed `closed` and re-opened it. The menu could not be shut
   * from the control that opened it. The hook decides from the state at press
   * time; nothing about this depends on the menu being portalled, which the
   * issue took for the condition and which this menu is not.
   */
  const triggerProps = useMenuTriggerToggle(open, () => setView('menu'), close);

  const reasoningWordCount =
    reasoning && view !== 'closed' ? countReasoningWords(reasoning.content) : 0;

  return (
    <span className="turn-footer__actions-menu">
      <button
        ref={triggerRef}
        type="button"
        className="message__copy-btn turn-footer__overflow-trigger"
        aria-label="More answer actions"
        aria-haspopup="menu"
        aria-expanded={open}
        {...triggerProps}
      >
        …
      </button>
      {/* The picker and the #2211 dialogs portal their surfaces. Keep the
          owner mounted after the menu closes on focus transfer, until the
          surface itself settles. */}
      {view !== 'closed' && (
        <>
          <div
            hidden={!open}
            ref={menuRef}
            className="turn-footer__overflow-menu"
            role="menu"
            aria-label="Answer actions"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
          >
            {provenance && (
              <button
                type="button"
                role="menuitem"
                onClick={() => setView('provenance')}
              >
                Turn provenance
              </button>
            )}
            {reasoning && reasoningWordCount > 0 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => setView('reasoning')}
              >
                Reasoning ({reasoningWordCount.toLocaleString()}{' '}
                {reasoningWordCount === 1 ? 'word' : 'words'})
              </button>
            )}
            {taskTarget && (
              <LazyBoundary
                load={loadConnectedAttachAnswerToTaskButton}
                componentProps={{
                  ...taskTarget,
                  menuItem: true,
                  onOpen: () => setView('picker'),
                  onClose: () => setView('closed'),
                  returnFocusTarget: triggerRef.current,
                }}
                pending={null}
                unavailable={() => (
                  <span className="turn-footer__unavailable-note">
                    Add to Task is unavailable.
                  </span>
                )}
              />
            )}
            {forkSource && onForkFromTurn && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  onForkFromTurn(forkSource);
                }}
              >
                Fork from here…
              </button>
            )}
          </div>
          {view === 'provenance' && provenance && (
            <Dialog
              eyebrow="This turn"
              title="Provenance"
              subtitle="What Station observed about how this answer was produced."
              closeLabel="Close provenance"
              onClose={closeDialog}
              size="md"
              returnFocusTarget={triggerRef.current ?? undefined}
            >
              <TurnProvenanceCard
                provenance={provenance.envelope}
                statedInRow={provenance.statedInRow}
                accountableHuman={provenance.accountableHuman}
                shareContent={provenance.shareContent}
                basisContent={provenance.basisContent}
                defaultOpen
              />
            </Dialog>
          )}
          {view === 'reasoning' && reasoning && (
            <Dialog
              eyebrow="This turn"
              title="Reasoning"
              subtitle={`${reasoningWordCount.toLocaleString()} ${reasoningWordCount === 1 ? 'word' : 'words'} recorded for this turn.`}
              closeLabel="Close reasoning"
              onClose={closeDialog}
              size="md"
              returnFocusTarget={triggerRef.current ?? undefined}
            >
              <div
                className="turn-reasoning-dialog__body"
                style={{
                  color: 'var(--text-secondary)',
                  fontStyle: 'italic',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {reasoning.content}
              </div>
            </Dialog>
          )}
        </>
      )}
    </span>
  );
}
