import type { WorkspacePaneAvailabilityAction } from '@kontourai/station-contracts/workspace-pane-availability';
import { type CSSProperties, useId, useState } from 'react';
import {
  presentWorkspacePaneAvailability,
  type WorkspacePaneAvailabilityCatalogEntry,
} from './workspacePaneAvailabilityPresentation';
import { builtinWorkspacePaneGlyph } from './workspacePaneGlyphs';
import './WorkspacePaneAvailabilityList.css';

export interface WorkspacePaneAvailabilityListProps {
  /** Every known catalog entry, including entries which cannot currently open. */
  entries: readonly WorkspacePaneAvailabilityCatalogEntry[];
  /** Opens an available pane; unavailable cards instead expose their explanation. */
  onSelect: (entry: WorkspacePaneAvailabilityCatalogEntry) => void;
  /** Receives only actions this surface can actually execute. */
  onAction?: (
    entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ) => string;
  /** Non-executable resolver actions remain explanatory guidance, not buttons. */
  canExecuteAction?: (
    entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ) => boolean;
  /** In-flight is the sole state in which a card or its actions are disabled. */
  isPending?: (entry: WorkspacePaneAvailabilityCatalogEntry) => boolean;
  /** A host can report that one exact catalog occurrence is already open. */
  isOpen?: (entry: WorkspacePaneAvailabilityCatalogEntry) => boolean;
  onReviewInRegistry?: () => void;
  'aria-label'?: string;
}

/**
 * The preview placeholder's accent is derived from the descriptor id alone —
 * the same hash-into-token-palette shape as `projectAccent` — so a pane keeps
 * its color regardless of catalog order or availability churn.
 */
const PANE_PREVIEW_ACCENTS = [
  'var(--event-agent-start)',
  'var(--event-agent-complete)',
  'var(--event-tool-call)',
  'var(--event-tool-result)',
  'var(--event-agent-health)',
  'var(--event-reasoning)',
] as const;

export function panePreviewAccent(descriptorId: string): string {
  let hash = 0;
  for (let index = 0; index < descriptorId.length; index += 1) {
    hash = (hash * 31 + descriptorId.charCodeAt(index)) | 0;
  }
  return PANE_PREVIEW_ACCENTS[(hash >>> 0) % PANE_PREVIEW_ACCENTS.length];
}

function WorkspacePaneAvailabilityCard({
  entry,
  onSelect,
  onAction,
  canExecuteAction,
  pending,
  open,
  onReviewInRegistry,
}: {
  entry: WorkspacePaneAvailabilityCatalogEntry;
  onSelect: (entry: WorkspacePaneAvailabilityCatalogEntry) => void;
  onAction?: (
    entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ) => string;
  canExecuteAction?: (
    entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ) => boolean;
  pending: boolean;
  open: boolean;
  onReviewInRegistry?: () => void;
}) {
  const ids = useId();
  const [expanded, setExpanded] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const PaneGlyph = builtinWorkspacePaneGlyph(entry.descriptor.renderer);
  const presentation = presentWorkspacePaneAvailability(
    entry.availability,
    entry.rendererGate,
  );
  // A direct route has no Registry navigation callback. Keep the gate's
  // truthful explanation there, but retain the ordinary bounded action so a
  // card never advertises remediation with no reachable affordance.
  const actionPresentation =
    presentation.reviewInRegistry && !onReviewInRegistry
      ? presentWorkspacePaneAvailability(entry.availability)
      : presentation;
  const reviewActionAvailable =
    presentation.reviewInRegistry && onReviewInRegistry !== undefined;
  const isAvailable =
    presentation.state === 'available' && entry.instance !== undefined && !open;
  const stateLabel = open ? 'Open in this workspace' : presentation.stateLabel;
  const reasonLabel = open
    ? 'This pane is already open in this workspace.'
    : presentation.reasonLabel;
  const descriptionId = `${ids}-availability`;
  const nameId = `${ids}-name`;
  const stateId = `${ids}-state`;
  const explanationId = `${ids}-explanation`;
  const openLabelId = `${ids}-open-label`;
  const hasDescription = Boolean(entry.descriptor.description);

  const activateAction = () => {
    if (!actionPresentation.action || !onAction) return;
    setActionNotice(onAction(entry, actionPresentation.action));
  };

  const executableAction =
    !reviewActionAvailable &&
    actionPresentation.action !== undefined &&
    actionPresentation.actionLabel !== undefined &&
    canExecuteAction?.(entry, actionPresentation.action) === true;

  return (
    <li
      className={`workspace-pane-availability-list__card workspace-pane-availability-list__card--${presentation.state}`}
    >
      <div
        className="workspace-pane-availability-list__preview"
        aria-hidden="true"
        style={
          {
            '--pane-preview-accent': panePreviewAccent(entry.descriptor.id),
          } as CSSProperties
        }
      >
        {entry.descriptor.previewImage ? (
          <img
            className="workspace-pane-availability-list__preview-image"
            src={entry.descriptor.previewImage}
            alt=""
          />
        ) : entry.descriptor.icon ? (
          <span className="workspace-pane-availability-list__preview-glyph">
            {entry.descriptor.icon}
          </span>
        ) : PaneGlyph ? (
          // #765 F4: a built-in pane's real icon on the accent tile —
          // Coding and Chat both rendered a giant letter "C" before this.
          <PaneGlyph className="workspace-pane-availability-list__preview-icon" />
        ) : (
          <span className="workspace-pane-availability-list__preview-glyph">
            {entry.descriptor.name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className="workspace-pane-availability-list__body">
        <div className="workspace-pane-availability-list__heading">
          <span id={nameId} className="workspace-pane-availability-list__name">
            {entry.descriptor.name}
          </span>
          {/*
            station#1868. Two distinct problems lived here, and they need two
            different mechanisms — which is why this looks like belt and braces.

            1. Accessible names here are never hand-written `aria-label`
               compositions (a name ASSERTING a composition the DOM does not
               derive). Every named control uses `aria-labelledby` pointing at
               spans actually rendered, so the name cannot drift from what is
               on screen. (Name-from-content alone is not enough: the
               accessible-name algorithm joins adjacent inline elements with no
               separator, yielding "FilesAvailable".)

            2. The VISIBLE text still concatenated, because the name and state
               spans are adjacent with no text between them. That is what text
               selection, find-in-page, and any CSS-less render actually get.
               This separator is real text in the DOM to fix that, clipped from
               view by the same technique as `.background-tasks-banner__sr-status`
               because the layout already separates the two for sighted users.

            Do not "simplify" by deleting either one: without `aria-labelledby`
            the state toggle's name collapses; without the separator the
            textContent does.
          */}
          <span className="workspace-pane-availability-list__separator">
            {': '}
          </span>
          {isAvailable ? (
            <span
              id={stateId}
              className="workspace-pane-availability-list__state"
            >
              {stateLabel}
            </span>
          ) : (
            <button
              type="button"
              className="workspace-pane-availability-list__state-toggle"
              onClick={() => setExpanded((current) => !current)}
              disabled={pending}
              aria-busy={pending || undefined}
              aria-labelledby={`${nameId} ${stateId}`}
              aria-describedby={hasDescription ? descriptionId : undefined}
              aria-expanded={expanded}
              aria-controls={explanationId}
            >
              <span
                id={stateId}
                className="workspace-pane-availability-list__state"
              >
                {stateLabel}
              </span>
            </button>
          )}
        </div>
        {hasDescription && (
          <span
            id={descriptionId}
            className="workspace-pane-availability-list__summary"
          >
            {entry.descriptor.description}
          </span>
        )}
        {(isAvailable || reviewActionAvailable || executableAction) && (
          <div className="workspace-pane-availability-list__actions">
            {isAvailable && (
              <button
                type="button"
                className="workspace-pane-availability-list__open"
                onClick={() => onSelect(entry)}
                disabled={pending}
                aria-busy={pending || undefined}
                aria-labelledby={`${openLabelId} ${nameId}`}
                aria-describedby={hasDescription ? descriptionId : undefined}
              >
                <span id={openLabelId}>Open</span>
              </button>
            )}
            {!isAvailable && reviewActionAvailable && (
              <button
                type="button"
                className="workspace-pane-availability-list__remedy"
                onClick={() => onReviewInRegistry?.()}
                disabled={pending}
              >
                Review in Registry
              </button>
            )}
            {!isAvailable && executableAction && (
              <button
                type="button"
                className="workspace-pane-availability-list__remedy"
                onClick={activateAction}
                disabled={pending}
              >
                {actionPresentation.actionLabel}
              </button>
            )}
          </div>
        )}
        {!isAvailable && (
          <div
            id={explanationId}
            className="workspace-pane-availability-list__explanation"
            hidden={!expanded}
          >
            <p>{reasonLabel}</p>
            {!reviewActionAvailable &&
              actionPresentation.action &&
              actionPresentation.actionLabel &&
              !executableAction && (
                <p>
                  {actionPresentation.actionLabel} is not available from this
                  screen.
                </p>
              )}
            {actionNotice && <p role="status">{actionNotice}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * A host-neutral visual pane catalog: a card grid with a preview thumbnail per
 * pane (descriptor-supplied image, generated placeholder fallback). Available
 * cards carry an explicit Open action; unavailable cards carry their state as
 * a badge whose toggle expands the truthful explanation, plus the bounded
 * remediation action — a card never has a whole-surface click that means
 * different things per state. Native buttons preserve equivalent mouse,
 * keyboard, and touch activation; unavailable entries stay enabled so their
 * reason and bounded next action remain reachable.
 */
export function WorkspacePaneAvailabilityList({
  entries,
  onSelect,
  onAction,
  canExecuteAction,
  isPending,
  isOpen,
  onReviewInRegistry,
  'aria-label': ariaLabel = 'Workspace panes',
}: WorkspacePaneAvailabilityListProps) {
  return (
    <ul className="workspace-pane-availability-list" aria-label={ariaLabel}>
      {entries.map((entry) => (
        <WorkspacePaneAvailabilityCard
          key={entry.instance?.instanceId ?? entry.descriptor.id}
          entry={entry}
          onSelect={onSelect}
          onAction={onAction}
          canExecuteAction={canExecuteAction}
          pending={isPending?.(entry) ?? false}
          open={isOpen?.(entry) ?? false}
          onReviewInRegistry={onReviewInRegistry}
        />
      ))}
    </ul>
  );
}
