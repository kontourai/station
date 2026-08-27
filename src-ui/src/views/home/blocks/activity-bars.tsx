/**
 * Activity per project over a fixed window, as bars on a shared baseline.
 *
 * A BLOCK: it survived station#3122's variant experiment and belongs to the
 * one Home now. Kept in `blocks/` rather than folded into `HomeSurface.tsx`
 * because its grid derivation is the block's claim and is pinned by
 * `__tests__/activity-bars.test.ts` without rendering a page.
 */
import { useIsMobile } from '../../../hooks/useIsMobile';
import type { HomeWorkItem } from '../home-view-model';
import './activity-bars.css';

const HOUR_MS = 60 * 60 * 1000;
const BUCKET_COUNT = 12;
const BUCKET_MS = 4 * HOUR_MS;
/** Derived from the window the buckets actually cover, not written twice. */
const WINDOW_LABEL = `${(BUCKET_COUNT * BUCKET_MS) / (24 * HOUR_MS)} days ago`;

export interface HeatCell {
  count: number;
  latest: HomeWorkItem | null;
}

export interface HeatRow {
  project: string;
  /**
   * The project slug EVERY item folded into this row is bound to, or `null`.
   *
   * `project` above is `projectLabel` — a display string that also covers
   * `'No project'`, `'Project unavailable'`, and the ambiguous/unverified
   * variants `sessionProjectLabel` produces. Turning that string back into a
   * project would be a guess, so the slug is carried from the items instead
   * and only when they agree: one distinct slug, present on all of them.
   * A row whose items disagree, or where any item carries no slug at all,
   * reports `null` — the caller then has nothing to navigate to and must
   * render the label as text rather than invent a destination for it.
   */
  projectSlug: string | null;
  cells: HeatCell[];
  total: number;
}

/**
 * Buckets items into project rows × fixed time columns, newest column last.
 * Exported for test: the grid is the claim, so it is derived and pinned.
 */
export function buildHeatRows(items: HomeWorkItem[], now: number): HeatRow[] {
  const byProject = new Map<string, HeatRow>();
  /** Per row: every distinct slug seen, and whether any item carried none. */
  const slugAgreement = new Map<
    string,
    { slugs: Set<string>; anyMissing: boolean }
  >();
  for (const item of items) {
    // Clock skew between a client and the station server makes the NEWEST
    // items future-dated — exactly what this block exists to show.
    //
    // This clamp is load-bearing, not tidiness: a negative age yields
    // `bucket = BUCKET_COUNT`, `row.cells[BUCKET_COUNT]` is undefined, and the
    // `cell.count` read below throws — taking the whole Home route down to
    // its error boundary for one skewed timestamp. Verified by injection.
    //
    // It also keeps this agreeing with `bucketByRecency`, the sibling time
    // function Home renders below it, which files a future item under Today.
    const age = Math.max(0, now - item.updatedAt);
    const bucket = BUCKET_COUNT - 1 - Math.floor(age / BUCKET_MS);
    if (bucket < 0) continue;
    let row = byProject.get(item.projectLabel);
    if (!row) {
      row = {
        project: item.projectLabel,
        projectSlug: null,
        cells: Array.from({ length: BUCKET_COUNT }, () => ({
          count: 0,
          latest: null,
        })),
        total: 0,
      };
      byProject.set(item.projectLabel, row);
      slugAgreement.set(item.projectLabel, {
        slugs: new Set(),
        anyMissing: false,
      });
    }
    const agreement = slugAgreement.get(item.projectLabel)!;
    if (item.projectSlug) agreement.slugs.add(item.projectSlug);
    else agreement.anyMissing = true;
    const cell = row.cells[bucket];
    cell.count += 1;
    if (!cell.latest || item.updatedAt > cell.latest.updatedAt) {
      cell.latest = item;
    }
    row.total += 1;
  }
  for (const row of byProject.values()) {
    const agreement = slugAgreement.get(row.project);
    row.projectSlug =
      agreement && !agreement.anyMissing && agreement.slugs.size === 1
        ? [...agreement.slugs][0]
        : null;
  }
  return [...byProject.values()].sort((a, b) => b.total - a.total);
}

/**
 * Activity per project over the window, as bars on a shared baseline.
 *
 * This replaced a 12x5 grid of filled squares. The grid encoded count as
 * colour, which needed a legend to read at all, and drew a dashed box for
 * every empty bucket — so a sparse two days (the normal case) rendered as
 * mostly furniture. Bar height needs no legend, an empty bucket can be a
 * baseline tick instead of a box, and the whole block gets about a third of
 * the vertical space back.
 *
 */
/**
 * Which four-hour window a column covers, said in words. The grid this
 * replaced had twelve unnamed columns: a cell announced "Station, 3 items"
 * with no way to know WHEN, which is most of what the block is for.
 */
export function bucketLabel(index: number): string {
  const newestFirst = BUCKET_COUNT - 1 - index;
  if (newestFirst === 0) return 'in the last 4 hours';
  const hoursAgo = newestFirst * (BUCKET_MS / HOUR_MS);
  return `about ${hoursAgo} hours ago`;
}

export function ActivityBars({
  rows,
  onOpen,
  resolveProjectOpen,
}: {
  rows: HeatRow[];
  onOpen: (item: HomeWorkItem) => void;
  /**
   * Returns the opener for a row's project, or `null` when this row has no
   * project to open. Supplied by the host, which is the only layer that
   * knows the configured project catalog; a `null` answer renders the label
   * as plain text rather than a control that goes somewhere unrelated.
   */
  resolveProjectOpen?: (row: HeatRow) => (() => void) | null;
}) {
  /**
   * station#3768: a twelve-column chart cannot hold twelve 44px targets in a
   * phone-width row — twelve buttons at ~18px wide are not a small control,
   * they are an unhittable one, and a transparent 44px hit area would make
   * them overlap each other four deep. On a coarse pointer the chart is
   * therefore what it reads as: a picture. Every destination it offers is
   * still on this page — the row's project is on the sidebar and in the
   * project switcher, and the work itself is the Recent-work list below,
   * whose rows already carry a 64px floor.
   */
  const isTouch = useIsMobile();
  const peak = Math.max(
    1,
    ...rows.flatMap((row) => row.cells.map((cell) => cell.count)),
  );
  return (
    <div className="home-heat__chart">
      <div className="home-heat__axis" aria-hidden="true">
        <span>{WINDOW_LABEL}</span>
        <span>now</span>
      </div>
      <ul className="home-heat__rows">
        {rows.map((row) => (
          <li className="home-heat__row" key={row.project}>
            <ProjectLabel
              row={row}
              open={isTouch ? null : (resolveProjectOpen?.(row) ?? null)}
            />
            <span className="home-heat__bars">
              {row.cells.map((cell, index) => {
                const key = `${row.project}-${index}`;
                const latest = cell.latest;
                if (!latest) {
                  return (
                    <span
                      key={key}
                      className="home-heat__bar home-heat__bar--empty"
                      aria-hidden="true"
                    />
                  );
                }
                const barStyle = {
                  '--bar': barHeight(cell.count, peak),
                } as React.CSSProperties;
                if (isTouch) {
                  return (
                    <span
                      key={key}
                      className="home-heat__bar"
                      style={barStyle}
                      aria-hidden="true"
                    />
                  );
                }
                return (
                  <button
                    key={key}
                    type="button"
                    className="home-heat__bar"
                    style={barStyle}
                    aria-label={`${row.project}, ${cell.count} item${
                      cell.count === 1 ? '' : 's'
                    } ${bucketLabel(index)} — open ${latest.title}`}
                    onClick={() => onOpen(latest)}
                  />
                );
              })}
            </span>
            <span className="home-heat__total">
              {row.total}
              <span className="home-heat__total-unit"> in {WINDOW_LABEL}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The row's name, as a control only when it has somewhere to go.
 *
 * The accessible name says the destination ("Open the station project"),
 * which is also the honest limit of what the link promises: the project's own
 * page, not a project-filtered Activity list — that filter is component state
 * in `SessionsView` with no route parameter, so no caller can preset it.
 */
function ProjectLabel({
  row,
  open,
}: {
  row: HeatRow;
  open: (() => void) | null;
}) {
  if (!open) return <span className="home-heat__label">{row.project}</span>;
  return (
    <button
      type="button"
      className="home-heat__label home-heat__label--link"
      aria-label={`Open the ${row.project} project`}
      onClick={open}
    >
      {row.project}
    </button>
  );
}

/**
 * Bar height as a fraction of the tallest bucket, floored so that a bucket
 * with work never renders as an empty one.
 */
export function barHeight(count: number, peak: number): number {
  if (count <= 0) return 0;
  return Math.max(0.18, count / Math.max(1, peak));
}
