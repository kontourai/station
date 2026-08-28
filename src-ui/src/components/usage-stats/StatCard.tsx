import type { ReactNode } from 'react';

/**
 * `color` is optional because most of the palette it was written against does
 * not exist (archive#1254).
 *
 * The call sites passed a categorical accent per metric family —
 * `--accent-primary` for counts of messages, `--accent-secondary` for token
 * counts, `--accent-warning` for money, `--accent-success` for averages,
 * `--accent-info` for per-turn rates. Only `--accent-primary` is a real token.
 * The other four are defined nowhere, so `var` was invalid at
 * computed-value time and `color` fell back to `inherit`: twelve of the
 * fifteen cards in this app have always rendered `--text-primary`, and the
 * scheme has never been visible.
 *
 * Those four are not converted to something that exists, because nothing that
 * exists means them. Station has no categorical accent ramp, and the two
 * status tokens that could be reached for — `--warning-text` on Total Cost,
 * `--success-text` on Avg Cost/Turn — would assert a state the number does not
 * carry. Inventing `--accent-secondary` / `--accent-info` is the "second name
 * for one concept" that archive#1168 and archive#1246 both ruled out.
 *
 * So the undefined values are dropped rather than replaced, `--accent-primary`
 * stays where it already rendered, and nothing on screen changes.
 */
export function StatCard({
  color,
  detail,
  icon,
  label,
  value,
}: {
  color?: string;
  /**
   * What the figure above is a measurement OF, when that is not "everything".
   * Rendered only when supplied — an unqualified number stays unqualified
   * rather than gaining a permanent caveat (archive#3245).
   */
  detail?: ReactNode;
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="usage-stat-card">
      <div className="usage-stat-icon">{icon}</div>
      <div className="usage-stat-label">{label}</div>
      <div className="usage-stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {detail ? <div className="usage-stat-detail">{detail}</div> : null}
    </div>
  );
}
