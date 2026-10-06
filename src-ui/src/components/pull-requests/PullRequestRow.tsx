import type { ReactNode, Ref } from 'react';
import { ActionOverflowMenu, type OverflowAction } from '../ActionOverflowMenu';
import {
  PullRequestChip,
  type PullRequestChipValue,
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
  onOpen,
  openRef,
  openLabel,
  overflow = [],
  overflowLabel,
  current = false,
  note,
}: {
  title: string;
  /** "#42" or "lantern/lantern #42" — where the title lives. */
  reference: string;
  chips?: readonly PullRequestChipValue[];
  /** Short facts after the chips: author, branches, a provenance word. */
  meta?: readonly string[];
  /** The time, at the end of the meta line. */
  trailing?: ReactNode;
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
}) {
  const body = (
    <>
      <span className="pull-request-row__title">{title}</span>
      <span className="pull-request-row__meta">
        {reference !== title && (
          <span className="pull-request-row__reference">{reference}</span>
        )}
        {chips.map((chip) => (
          <PullRequestChip key={chip.label} {...chip} />
        ))}
        {current && (
          <span className="pull-request-row__current">current branch</span>
        )}
        {meta.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
        {trailing}
      </span>
    </>
  );
  return (
    <li
      className="pull-request-row"
      data-current={current ? 'true' : undefined}
    >
      {onOpen ? (
        <button
          ref={openRef}
          type="button"
          className="pull-request-row__open"
          aria-label={openLabel ?? title}
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
          label={overflowLabel}
          triggerClassName="pull-request-row__more"
        />
      )}
      {note && <p className="pull-request-row__note">{note}</p>}
    </li>
  );
}
