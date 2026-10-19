import { Button } from '../components/Button';
import { Empty } from '../components/state';
import { usePaneRelations } from '../contexts/PaneRelationsContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { openerSession, WORKSPACE_CHAT_OPENER } from '../regions/pane-opener';
import type { PaneRelation } from '../regions/pane-relations';
import './RelatedPaneStrip.css';

/**
 * The pane's relation as a reader sees it: Up returns to the exact opener
 * (its surface, and its recorded session when it has one) — structural, not
 * a history entry — and an unkept preview says so and offers Keep open.
 * Nothing for a pane with no relation, or while relations are inactive.
 */
export function RelatedPaneStrip({ instanceId }: { instanceId: string }) {
  const relations = usePaneRelations();
  const relation = relations.relationOf(instanceId);
  if (!relation || relations.stationId !== relation.stationId) return null;
  return (
    <RelatedPaneStripBody
      relation={relation}
      onKeep={() => relations.keep(instanceId)}
    />
  );
}

/** Mounted only for a related pane, which the region model always hosts. */
function RelatedPaneStripBody({
  relation,
  onKeep,
}: {
  relation: PaneRelation;
  onKeep: () => void;
}) {
  const showSurface = useShowSurface();
  const { opener } = relation;
  const up = () => {
    const session = openerSession(opener.selection);
    // A conversation hosted outside the regions (the Coding centre) is Chat:
    // `showSurface('chat')` routes there while that centre owns Chat.
    const surface =
      opener.occurrenceId === WORKSPACE_CHAT_OPENER
        ? 'chat'
        : opener.occurrenceId;
    showSurface(surface, session ? { session } : undefined);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of two controls, not a form fieldset.
    <div
      className="related-pane-strip"
      role="group"
      aria-label={relation.kept ? 'Opened from' : 'Preview'}
    >
      <button
        type="button"
        className="related-pane-strip__up"
        onClick={up}
        title={`Up to ${opener.label}`}
        aria-label={`Up to ${opener.label}`}
      >
        <span aria-hidden="true">‹</span>
        <span className="related-pane-strip__label">{opener.label}</span>
      </button>
      {!relation.kept && (
        <>
          <span className="related-pane-strip__state">Preview</span>
          <Button size="sm" variant="ghost" onClick={onKeep}>
            Keep open
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * Whether a related pane belongs to another Station than the one this app is
 * connected to. Its stored state names that Station's file, so it is never
 * read against this one (`RelatedPaneWrongStation`).
 */
export function isWrongStationRelation(
  relation: PaneRelation | undefined,
  stationId: string | null,
): boolean {
  return (
    relation !== undefined &&
    stationId !== null &&
    relation.stationId !== stationId
  );
}

/** What a pane opened on another Station shows instead of reading here. */
export function RelatedPaneWrongStation({ label }: { label: string }) {
  return (
    <div className="dock-slot__body">
      <Empty
        variant="compact"
        label="Opened on another Station"
        description={`This pane was opened from ${label} on a different Station, so Station does not read it here. Switch back to that Station to see it, or close the tab.`}
      />
    </div>
  );
}
