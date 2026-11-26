import { type ReactNode, type Ref, useRef } from 'react';
import { useContextMenuGesture } from '../../hooks/useContextMenuGesture';
import {
  ActionOverflowMenu,
  type OverflowAction,
  type OverflowMenuHandle,
} from '../ActionOverflowMenu';
import {
  PullRequestClosedGlyph,
  PullRequestDraftGlyph,
  PullRequestGlyph,
  PullRequestMergedGlyph,
} from '../icons/Glyph';
import {
  PullRequestChip,
  type PullRequestChipValue,
  pullRequestStateChip,
} from './pull-request-chips';
import './PullRequestRow.css';

/**
 * One quiet pull request row: the title is the row's ONE action (it opens
 * the review), under it a meta line of reference, chips and facts, and
 * everything else behind a `⋯`. Shared by the pull requests pane and a
 * session's Details so a pull request looks the same wherever it is listed.
 */
export function PullRequestRow({
  title,
  reference,
  chips = [],
  meta = [],
  trailing,
  compactState,
  stats,
  onOpen,
  openRef,
  openLabel,
  overflow = [],
  overflowLabel,
  current = false,
  note,
  detail,
}: {
  title: string;
  /** "#42" or "lantern/lantern #42" — where the title lives. */
  reference: string;
  chips?: readonly PullRequestChipValue[];
  /** Short facts after the chips: author, branches, a provenance word. */
  meta?: readonly string[];
  /** The time, at the end of the meta line. */
  trailing?: ReactNode;
  compactState?: string;
  stats?: ReactNode;
  /** Opens the review. Without it the title is text, not a button. */
  onOpen?: () => void;
  /** The open button, for a list that returns focus to it. */
  openRef?: Ref<HTMLButtonElement>;
  /** The open action's accessible name; defaults to the title. */
  openLabel?: string;
  overflow?: readonly OverflowAction[];
  /** Names the `⋯` ("More actions for #42"). */
  overflowLabel: string;
  /** This row is the checked-out branch's pull request. */
  current?: boolean;
  /** One line below, for a row that cannot be opened (its reason). */
  note?: string;
  /** One quiet line below the row: what Station last did for it. */
  detail?: ReactNode;
}) {
  const menu = useRef<OverflowMenuHandle>(null);
  // A right-click or hold anywhere on the row opens its `⋯`: the same rows,
  // anchored to the same control.
  const gesture = useContextMenuGesture({
    enabled: overflow.length > 0,
    onOpen: () => menu.current?.open() ?? false,
  });
  const state = compactState ? pullRequestStateChip(compactState) : undefined;
  const StateGlyph =
    state?.label === 'Merged'
      ? PullRequestMergedGlyph
      : state?.label === 'Draft'
        ? PullRequestDraftGlyph
        : state?.label === 'Closed'
          ? PullRequestClosedGlyph
          : PullRequestGlyph;
  const titleText = <span className="pull-request-row__title">{title}</span>;
  const badges = chips.map((chip) => (
    <PullRequestChip key={chip.label} {...chip} />
  ));
  const body = (
    <>
      {state ? (
        <span className="pull-request-row__heading">
          <span
            className="pull-request-row__state"
            data-state={state.label}
            role="img"
            aria-label={state.label}
            title={state.label}
          >
            <StateGlyph />
          </span>
          {reference !== title && (
            <span className="pull-request-row__reference">{reference}</span>
          )}
          {titleText}
        </span>
      ) : (
        titleText
      )}
      <span className="pull-request-row__meta">
        {!state && reference !== title && (
          <span className="pull-request-row__reference">{reference}</span>
        )}
        {!state && badges}
        {current && (
          <span className="pull-request-row__current">current branch</span>
        )}
        {meta.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
        {trailing}
      </span>
      {state && (
        <span className="pull-request-row__facts">
          {badges}
          {stats}
        </span>
      )}
    </>
  );
  return (
    <li
      className="pull-request-row"
      data-compact={state ? true : undefined}
      data-current={current ? 'true' : undefined}
      {...gesture}
    >
      {onOpen ? (
        <button
          ref={openRef}
          type="button"
          className="pull-request-row__open"
          aria-label={openLabel ?? (state ? `${title}, ${state.label}` : title)}
          onClick={onOpen}
        >
          {body}
        </button>
      ) : (
        <div className="pull-request-row__open pull-request-row__open--inert">
          {body}
        </div>
      )}
      {overflow.length > 0 && (
        <ActionOverflowMenu
          actions={overflow}
          handleRef={menu}
          label={overflowLabel}
          triggerClassName="pull-request-row__more"
        />
      )}
      {note && <p className="pull-request-row__note">{note}</p>}
      {detail && <p className="pull-request-row__detail">{detail}</p>}
    </li>
  );
}
