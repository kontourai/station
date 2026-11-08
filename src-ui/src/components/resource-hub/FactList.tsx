import type { ReactNode } from 'react';
import './resource-hub.css';

export interface Fact {
  label: string;
  /** `undefined` reads "Not reported": absent is not the same as empty. */
  value: ReactNode | undefined;
}

/**
 * Read-only facts as a definition list. Values never render as inputs; a
 * fact the reader can change belongs on a form instead. Entries that are
 * `null` or `false` are left out, so a caller can list conditional facts
 * inline.
 */
export function FactList({
  facts,
  label,
  className,
}: {
  facts: ReadonlyArray<Fact | null | false | undefined>;
  /** Names the list for assistive technology when a heading does not. */
  label?: string;
  className?: string;
}) {
  const shown = facts.filter((fact): fact is Fact => !!fact);
  if (shown.length === 0) return null;
  return (
    <dl
      className={className ? `fact-list ${className}` : 'fact-list'}
      {...(label ? { 'aria-label': label } : {})}
    >
      {shown.map((fact) => (
        <div key={fact.label} className="fact-list__row">
          <dt>{fact.label}</dt>
          <dd>{fact.value ?? 'Not reported'}</dd>
        </div>
      ))}
    </dl>
  );
}
