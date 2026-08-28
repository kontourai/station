/**
 * The four counts. A BLOCK — see `activity-bars.tsx` for why these do not
 * live inside the page that renders them.
 */
import type { useHomeWorkLanes } from '../useHomeWorkLanes';

export interface PulseStat {
  label: string;
  value: number;
  /**
   * What activating this count does, or `undefined` when this count has
   * nowhere to go and therefore renders as text.
   *
   * Presence is DERIVED, never assumed: the host supplies a handler only for
   * a count whose population is actually on screen (see `pulseStatTargets`).
   * A count that links to a list it does not filter promises a filter that
   * was never applied, which is worse than a count that does not link.
   */
  onActivate?: () => void;
  /**
   * Where activating goes, in the user's words — becomes the tail of the
   * control's accessible name ("Active now, 3, show the Active now lane").
   * Required alongside `onActivate` so a control can never be labelled with
   * only a number.
   */
  destination?: string;
}

/**
 * The four counts, without the page that frames them.
 */
export function PulseStats({ stats }: { stats: PulseStat[] }) {
  return (
    <div className="home-pulse__stats">
      {stats.map((stat) =>
        stat.onActivate && stat.destination ? (
          <button
            key={stat.label}
            type="button"
            className="home-pulse__stat home-pulse__stat--link"
            aria-label={`${stat.label}, ${stat.value}, ${stat.destination}`}
            onClick={stat.onActivate}
          >
            <span className="home-pulse__value">{stat.value}</span>
            <span className="home-pulse__label">{stat.label}</span>
          </button>
        ) : (
          <div key={stat.label} className="home-pulse__stat">
            <span className="home-pulse__value">{stat.value}</span>
            <span className="home-pulse__label">{stat.label}</span>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * What each count can be activated to reveal, keyed by label.
 *
 * Separated from `pulseStats` so the numbers stay a pure derivation of the
 * lanes while the destinations stay a fact about what the HOST rendered.
 */
export interface PulseStatTarget {
  onActivate?: () => void;
  destination?: string;
}

/**
 * The counts every surface that shows them agrees on.
 *
 * `projectRowCount` (archive#3227 A7): the number of per-project rows the
 * HOST page actually renders beside these stats. It used to be
 * `model.projects.length` (CONFIGURED projects), a different population from
 * the rows under the number: the rows fold `projectLabel`, a display string
 * that includes `'No project'`, `'Project unavailable'`, and the ambiguous/
 * unverified-match variants, and omits configured projects with no recent
 * work — so "Projects 3" sat above five rows. The count must describe what
 * the user can see, not a second derivation of something else.
 *
 * `targets` is looked up by label for the same reason: a count and the thing
 * it can reveal must be the same population, and the host is what knows
 * whether that population is currently on screen.
 */
export function pulseStats(
  lanes: ReturnType<typeof useHomeWorkLanes>,
  projectRowCount: number,
  targets: Record<string, PulseStatTarget> = {},
): PulseStat[] {
  return [
    { label: 'Active now', value: lanes.active.length },
    { label: 'Just finished', value: lanes.recentlyFinished.length },
    { label: 'Snoozed', value: lanes.snoozed.length },
    { label: 'Projects', value: projectRowCount },
  ].map((stat) => ({ ...stat, ...(targets[stat.label] ?? {}) }));
}
