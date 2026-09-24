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
   * `activatable` region is already the single keyboard/AT stop for this
   * control (archive#1915) — the switch stays reachable via its accessible
   * name, it just isn't a second tab stop.
   */
  tabIndex?: number;
  /**
   * Also say the state in a word ("On"/"Off") beside the track (#2425/#2441).
   * The word is `aria-hidden` — assistive tech reads `aria-checked` — so it is
   * purely visual reinforcement. Off by default: the track already differs by
   * fill and thumb position, and most consumers sit in dense rows whose
   * width was laid out around the bare 36px/28px track.
   */
  showStateLabel?: boolean;
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
  showStateLabel = false,
}: ToggleProps) {
  const control = (
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
  if (!showStateLabel) return control;
  return (
    <span className="station-toggle-field">
      {control}
      <span className="station-toggle__state" aria-hidden="true">
        {checked ? 'On' : 'Off'}
      </span>
    </span>
  );
}
