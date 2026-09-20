import type { CSSProperties } from 'react';

/** Immediate, accessible acknowledgement while a phone sheet chunk loads. */
export function MobileSheetPending({
  label,
  style,
}: {
  label: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className="mobile-task-switcher__overlay responsive-surface-overlay"
      style={style}
    >
      <section
        className="mobile-task-switcher__panel responsive-surface-panel"
        role="dialog"
        aria-label={label}
        aria-busy="true"
      >
        <header className="mobile-task-switcher__header">
          <div>
            <p>Loading</p>
            <h2>{label}</h2>
          </div>
        </header>
        <p role="status" className="mobile-task-switcher__list">
          Loading {label.toLowerCase()}…
        </p>
      </section>
    </div>
  );
}
