import type { EnsembleInspection } from '@kontourai/station-contracts/ensemble';
import { useId } from 'react';
import { useNavigationActions } from '../contexts/NavigationContext';
import { layoutEnsembleInspection } from './ensemble-inspection-layout';
import './EnsembleInspectionView.css';

export function EnsembleInspectionResult({
  result,
}: {
  result: EnsembleInspection;
}) {
  const { navigate } = useNavigationActions();
  const identity = useId();
  const geometry = layoutEnsembleInspection(result.facts);
  return (
    <>
      <h2>{result.source.name}</h2>
      <p>
        Source <code>{result.source.sha256}</code> · Environment{' '}
        {result.environmentId} · Observed {result.observedAt}
      </p>
      <p>{result.limits}</p>
      <section
        className="ensemble-inspection__table"
        aria-label="Scrollable Ensemble configuration and provenance"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users scroll this wide table.
        tabIndex={0}
      >
        <table>
          <caption>Ensemble configuration and provenance</caption>
          <thead>
            <tr>
              {[
                'Category',
                'Member / setting',
                'Value',
                'Origin',
                'State',
                'Owner / receipt',
              ].map((heading) => (
                <th scope="col" key={heading}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.facts.map((fact) => (
              <tr key={fact.id} id={`${identity}-fact-${fact.id}`}>
                <td>{fact.category}</td>
                <th scope="row">
                  {fact.memberId && `${fact.memberId}: `}
                  {fact.label}
                </th>
                <td>{fact.value}</td>
                <td>{fact.origin}</td>
                <td>{fact.state}</td>
                <td>
                  {fact.owner.href ? (
                    <a
                      href={fact.owner.href}
                      onClick={(event) => {
                        const target = fact.owner.href;
                        if (
                          target &&
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.shiftKey &&
                          event.button === 0
                        ) {
                          event.preventDefault();
                          navigate(target);
                        }
                      }}
                    >
                      {fact.owner.label}
                    </a>
                  ) : (
                    fact.owner.label
                  )}
                  {fact.owner.receipt?.startsWith('resolution:') ? (
                    <a href={`#${identity}-resolution-${fact.memberId}`}>
                      Resolution receipt
                    </a>
                  ) : (
                    fact.owner.receipt && <code>{fact.owner.receipt}</code>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {result.resolutions.map(({ memberId, receipt }) => (
        <details key={memberId} id={`${identity}-resolution-${memberId}`}>
          <summary>Resolution receipt for {memberId}</summary>
          <pre>{JSON.stringify(receipt, null, 2)}</pre>
        </details>
      ))}
      {geometry && (
        <figure>
          <figcaption>
            Configuration diagram. Lines connect members to inspected settings;
            they are not routing or runtime edges. The table contains every
            value and owner link.
          </figcaption>
          <div className="ensemble-inspection__diagram">
            <svg
              width={geometry.width}
              height={geometry.height}
              role="img"
              aria-label="Member configuration relationships; full details in the configuration table"
            >
              {geometry.edges.map((edge) => (
                <path
                  key={`${edge.from.fact.id}:${edge.to.fact.id}`}
                  d={`M${edge.from.x + 110},${edge.from.y + 40} L${edge.to.x + 110},${edge.to.y + 40}`}
                />
              ))}
              {geometry.nodes.map(({ fact, x, y }) => (
                <g key={fact.id} transform={`translate(${x},${y})`}>
                  <rect width="220" height="80" rx="4" />
                  <text x="8" y="20">
                    {fact.label.slice(0, 26)}
                  </text>
                  <text x="8" y="40">
                    {fact.state} · {fact.origin}
                  </text>
                  <text x="8" y="60">
                    {fact.memberId ?? fact.category}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        </figure>
      )}
    </>
  );
}
