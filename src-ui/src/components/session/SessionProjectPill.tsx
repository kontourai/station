import './SessionProjectPill.css';

/**
 * The project a session row belongs to, as a pill on the row instead of the
 * heading above it (archive#3027 — the owner asked for it "more pill shaped
 * or popping out a little more.. and maybe even ability to filter on it so
 * you get the best of both worlds").
 *
 * Two shapes, and which one you get is a fact about the session, not a style
 * choice:
 * - `filterKey` set → a real `<button>`: one click filters the list to that
 *   project, another clears it. `aria-pressed` carries the active state.
 * - `filterKey` null → an inert `<span>`. That is the AMBIGUOUS session
 *   (`sessionProjectFilterKey`): the label names two candidate projects and a
 *   click cannot say which was meant. It still appears under either
 *   candidate's filter — see `matchesProjectFilter`.
 *
 * `label` is whatever `sessionProjectLabel` says, verbatim, including its
 * `(unverified name match)` / `ambiguous (a, b, and 2 more)` caveats — the
 * caveat is the point of that helper and this surface does not get to drop
 * it. Long labels are visually truncated with the full text on `title`, never
 * rewritten.
 */
export function SessionProjectPill({
  label,
  filterKey,
  active,
  onToggle,
}: {
  label: string | null;
  filterKey: string | null;
  active: boolean;
  onToggle: (filterKey: string) => void;
}) {
  if (!label) return null;
  if (!filterKey) {
    return (
      <span
        className="session-project-pill session-project-pill--static"
        title={label}
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`session-project-pill${active ? ' session-project-pill--active' : ''}`}
      data-project={filterKey}
      aria-pressed={active}
      title={
        active
          ? `Show sessions from every project (currently filtered to ${filterKey})`
          : `Show only ${filterKey} sessions`
      }
      onClick={() => onToggle(filterKey)}
    >
      {label}
    </button>
  );
}
