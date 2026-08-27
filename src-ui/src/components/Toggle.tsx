/**
 * Toggle — CSS-only switch for on/off settings.
 */
import './Toggle.css';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  describedBy?: string;
  label?: string;
  /**
   * Forwarded to the underlying `role="switch"` button. Defaults to the
   * native button's own tab stop (unset). Pass `-1` when an enclosing
   * `activatable()` region is already the single keyboard/AT stop for this
   * control (station#1915) — the switch stays reachable via its accessible
   * name, it just isn't a second tab stop.
   */
  tabIndex?: number;
}

export function Toggle({
  checked,
  onChange,
  id,
  disabled,
  size = 'md',
  describedBy,
  label,
  tabIndex,
}: ToggleProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      aria-label={label}
      disabled={disabled}
      tabIndex={tabIndex}
      className={`station-toggle station-toggle--${size}${checked ? ' station-toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="station-toggle__thumb" />
    </button>
  );
}
