/**
 * The one switch shape every device feature row in Settings uses.
 *
 * Extracted from `VoiceFeaturesSection.tsx` by #2182, when Pairing became its
 * own section: two sections now draw the same row, and a second copy of the
 * `aria-describedby` wiring below would be a second place for it to go wrong.
 *
 * Each setting must be ONE native button carrying `role="switch"`. An earlier
 * implementation nested that button inside an activatable outer row, which axe
 * correctly reports as nested interactive controls.
 */
import type { ReactNode } from 'react';
import '../../components/Toggle.css';
import type { BooleanFeatureSetting } from '../../hooks/useFeatureSettings';

export function SettingsToggle({
  checked,
  className,
  describedBy,
  disabled,
  label,
  onChange,
  children,
}: {
  checked: boolean;
  className: string;
  describedBy?: string;
  disabled?: boolean;
  label: string;
  onChange: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span
        className={`station-toggle station-toggle--sm${checked ? ' station-toggle--on' : ''}`}
        aria-hidden="true"
      >
        <span className="station-toggle__thumb" />
      </span>
      {children}
    </button>
  );
}

export function FeatureToggle({
  featureKey,
  label,
  description,
  privacyNote,
  checked,
  onToggle,
}: {
  featureKey: BooleanFeatureSetting;
  label: string;
  description: string;
  privacyNote?: string;
  checked: boolean;
  onToggle: (key: BooleanFeatureSetting) => void;
}) {
  const descId = `feature-desc-${featureKey}`;
  const privacyId = `feature-privacy-${featureKey}`;
  return (
    <SettingsToggle
      className="settings__feature-toggle"
      checked={checked}
      onChange={() => onToggle(featureKey)}
      // The privacy note is a consequence of flipping this switch, not
      // decoration beside it. Left out of the description, a screen-reader
      // user hears the toggle described without the one sentence that says
      // what turning it on makes this device do.
      describedBy={privacyNote ? `${descId} ${privacyId}` : descId}
      label={label}
    >
      <div>
        <div className="settings__toggle-name">{label}</div>
        <div className="settings__toggle-detail" id={descId}>
          {description}
        </div>
        {privacyNote && (
          <div className="settings__toggle-privacy" id={privacyId}>
            {privacyNote}
          </div>
        )}
      </div>
    </SettingsToggle>
  );
}
