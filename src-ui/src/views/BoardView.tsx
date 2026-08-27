import type {
  BoardReference,
  BoardWidget,
} from '@kontourai/station-contracts/board';
import { useBoardQuery } from '@kontourai/station-sdk';
import { UIBlockRenderer } from '../components/chat/UIBlockRenderer';
import { Empty, ErrorState, SkeletonBlock } from '../components/state';
import './BoardView.css';

export interface BoardViewProps {
  reference: BoardReference;
}

function widgetsByTab(widgets: readonly BoardWidget[]) {
  const byTab = new Map<string, BoardWidget[]>();
  for (const widget of widgets) {
    const list = byTab.get(widget.tabId) ?? [];
    list.push(widget);
    byTab.set(widget.tabId, list);
  }
  for (const list of byTab.values()) {
    list.sort((a, b) => a.position - b.position);
  }
  return byTab;
}

/**
 * station#4079 slice 1 — the board face: pinned provenance-bound UI blocks
 * (station#1399) laid out in an ordinal grid per tab, reusing `UIBlockRenderer`
 * verbatim (it already renders attestation badges from #1399 — see the
 * design comment: "no third render authority"). Reached by URL only this
 * slice (no sidebar item — `page-frame-registry.ts` frames it `null`, a
 * workspace-shaped surface that owns its own identity header, same family
 * as `ProjectPage`/`TaskWorkspaceView`).
 */
export function BoardView({ reference }: BoardViewProps) {
  const { data: board, isLoading, error, refetch } = useBoardQuery(reference);

  const title =
    reference.kind === 'session'
      ? `Board · Session ${reference.id}`
      : `Board · Task ${reference.id}`;

  return (
    <div className="board-view">
      <div className="board-view__header">
        <span className="board-view__title">{title}</span>
      </div>
      {isLoading && <SkeletonBlock />}
      {!isLoading && error && (
        <ErrorState
          title="The board could not be read."
          action={
            <button type="button" onClick={() => refetch()}>
              Retry
            </button>
          }
        />
      )}
      {!isLoading && !error && board && board.widgets.length === 0 && (
        <Empty
          variant="prominent"
          label="Nothing pinned yet"
          description="Pinned widgets from this session or Task will appear here."
        />
      )}
      {!isLoading &&
        !error &&
        board &&
        board.widgets.length > 0 &&
        Array.from(widgetsByTab(board.widgets).entries()).map(
          ([tabId, widgets]) => {
            const tab = board.tabs.find((t) => t.id === tabId);
            return (
              <section className="board-view__tab" key={tabId}>
                {tab && <h3 className="board-view__tab-title">{tab.title}</h3>}
                <div className="board-view__grid">
                  {widgets.map((widget) => (
                    <div
                      key={widget.id}
                      className={`board-view__cell board-view__cell--${widget.size}`}
                    >
                      <UIBlockRenderer block={widget.block} />
                    </div>
                  ))}
                </div>
              </section>
            );
          },
        )}
    </div>
  );
}
