/**
 * Checkbox — styled checkbox for multi-select scenarios.
 */
import './Checkbox.css';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}

function CheckboxBox({ checked }: { checked: boolean }) {
  return (
    <span className="cb__box" aria-hidden="true">
      {checked && (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 12 12"
          className="cb__check"
        >
          <path
            d="M2.5 6l2.5 2.5 4.5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

/**
 * The tick box ALONE — no `<label>`, no `<input>`, nothing focusable.
 *
 * For a row that is itself the control. `Checkbox` below is a `<label>` around
 * a real input, and a `<label>` nested inside a `<button>` is invalid
 * interactive nesting: the label click activates the input, which synthesises a
 * second click that also bubbles to the button, so the row's toggle fires twice
 * and nets to zero — clicking the tick box did nothing at all, and only the
 * row's text worked (CAT-R06, reproduced both directions). A row that owns the
 * click must draw the state, not embed a second control that also claims it.
 * Give the enclosing button `aria-pressed` so the state is announced.
 */
export function CheckboxGlyph({
  checked,
  disabled,
}: {
  checked: boolean;
  disabled?: boolean;
}) {
  return (
    <span
      className={`cb cb--static${checked ? ' cb--checked' : ''}${disabled ? ' cb--disabled' : ''}`}
    >
      <CheckboxBox checked={checked} />
    </span>
  );
}

export function Checkbox({
  checked,
  onChange,
  id,
  disabled,
  children,
}: CheckboxProps) {
  return (
    <label className={`cb${disabled ? ' cb--disabled' : ''}`}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="cb__input"
      />
      <CheckboxBox checked={checked} />
      {children && <span className="cb__label">{children}</span>}
    </label>
  );
}
