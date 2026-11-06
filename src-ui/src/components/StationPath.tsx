import { Fragment } from 'react';
import './StationPath.css';

/** A host-owned folder; its raw path stays selectable and copyable. */
export function StationPath({
  path,
  stationName = 'This Station',
  className,
}: {
  path: string;
  stationName?: string;
  className?: string;
}) {
  return (
    <span
      className={['station-path', className].filter(Boolean).join(' ')}
      title={`${stationName}: ${path}`}
    >
      <span className="station-path__host">{stationName}</span>
      <code className="station-path__value" dir="ltr">
        <span dir="ltr">
          {path.split(/(?<=[/\\])/).map((part, index) => (
            <Fragment key={index}>
              {part}
              <wbr />
            </Fragment>
          ))}
        </span>
      </code>
    </span>
  );
}
