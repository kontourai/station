import { USAGE_PERIOD_OPTIONS, type UsagePeriod } from './period';

/**
 * The period control for the usage panel (archive#3093). A plain button
 * group rather than tabs: it filters figures in place, it does not switch
 * panes. The `-toolbar` class suffix opts its buttons into the inventory-wide
 * mobile wrap + 44px touch-target floor in index.css.
 */
export function UsagePeriodSelector({
  value,
  onChange,
}: {
  value: UsagePeriod;
  onChange: (period: UsagePeriod) => void;
}) {
  return (
    /*
     * A fieldset of native radios, not `aria-pressed` buttons in a
     * role="group": exactly one period is active, and independent toggle
     * buttons tell assistive tech the wrong thing about that — while native
     * radios provide the single tab stop, arrow-key roving focus, and checked
     * state for free. Same pattern and rationale as HomeVariantSwitcher
     * (archive#3191); the a11y ratchet holds this rule at zero.
     */
    <fieldset className="usage-period-toolbar">
      <legend className="usage-period-legend">Usage period</legend>
      {USAGE_PERIOD_OPTIONS.map((option) => (
        <label
          key={option.id}
          className={`usage-period-btn${value === option.id ? ' is-active' : ''}`}
        >
          <input
            type="radio"
            name="usage-period"
            className="usage-period-radio"
            value={option.id}
            checked={value === option.id}
            onChange={() => onChange(option.id)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
