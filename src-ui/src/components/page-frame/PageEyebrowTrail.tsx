import React from 'react';
import { activatable } from '../../utils/activatable';

export interface EyebrowSegment {
  label: string;
  /** Present when this segment navigates; absent segments are plain text. */
  onClick?: () => void;
}

/**
 * The page header's eyebrow when the route sits under something — a project,
 * a section. Renders inside `.page__label`, so it is the same mono uppercase
 * teal line every framed route shows; only the linking is per route.
 *
 * Memoise the element at the call site (`useMemo` on the segment inputs)
 * before handing it to `usePageHeader` — see that hook's identity contract.
 */
export function PageEyebrowTrail({ segments }: { segments: EyebrowSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        <React.Fragment key={segment.label}>
          {index > 0 && <span className="page__label-sep"> / </span>}
          {segment.onClick ? (
            <span
              className="page__label-link"
              {...activatable(segment.onClick, { role: 'link' })}
            >
              {segment.label}
            </span>
          ) : (
            <span>{segment.label}</span>
          )}
        </React.Fragment>
      ))}
    </>
  );
}
