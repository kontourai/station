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
  const prerequisiteEdges = geometry.edges.filter(
    (edge) => edge.kind === 'prerequisite',
  );
  return (
    <>
      <h2>{result.source.name}</h2>
      {result.groupInspection?.state === 'bound' && (
        <p>
          Recorded group <code>{result.groupInspection.groupId}</code> ·{' '}
          <span>Revision {result.groupInspection.revision}</span>
        </p>
      )}
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
            Configuration relationships and declared prerequisites; execution
            and acceptance remain unassessed.
          </figcaption>
          <details>
            <summary>Diagram meaning</summary>
            <p>
              Lines link inspected settings; arrows show declared prerequisites.
            </p>
            <p>
              These relationships establish neither live routing nor readiness.
              Values and owner links are in the table.
            </p>
          </details>
          <div className="ensemble-inspection__diagram">
            {/* biome-ignore lint/a11y/useSemanticElements: Interactive SVG has no HTML group equivalent. */}
            <svg
              width={geometry.width}
              height={geometry.height}
              role="group"
              aria-label="Member configuration relationships; full details in the configuration table"
            >
              <defs>
                <marker
                  id={`${identity}-prerequisite-arrow`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              {geometry.edges.map((edge, index) => (
                <path
                  key={`${edge.kind}:${edge.factId}:${edge.from.fact.id}:${index}`}
                  className={`ensemble-inspection__edge--${edge.kind}`}
                  markerEnd={
                    edge.kind === 'prerequisite'
                      ? `url(#${identity}-prerequisite-arrow)`
                      : undefined
                  }
                  d={
                    edge.kind === 'prerequisite'
                      ? `M ${edge.from.x + 220} ${edge.from.y + 40} H ${edge.from.x + 230} V ${edge.from.y + 90} H ${edge.to.x - 5} V ${edge.to.y + 40} H ${edge.to.x}`
                      : `M${edge.from.x + 110},${edge.from.y + 40} L${edge.to.x + 110},${edge.to.y + 40}`
                  }
                >
                  <title>
                    {edge.kind === 'prerequisite'
                      ? `Declared prerequisite ${edge.from.fact.memberId} → ${edge.to.fact.memberId}`
                      : `${edge.from.fact.label}: ${edge.to.fact.label}`}
                  </title>
                </path>
              ))}
              {geometry.nodes.map(({ fact, x, y }) => (
                <g key={fact.id} transform={`translate(${x},${y})`}>
                  <a
                    href={`#${identity}-fact-${fact.id}`}
                    aria-label={`Inspect ${fact.memberId ?? fact.category}: ${fact.label}`}
                  >
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
                  </a>
                </g>
              ))}
            </svg>
          </div>
          {prerequisiteEdges.length > 0 && (
            <ul
              aria-label="Declared prerequisite references"
              className="ensemble-inspection__edge-links"
            >
              {prerequisiteEdges.map((edge, index) => (
                <li key={`${edge.factId}:${edge.from.fact.id}:${index}`}>
                  <a href={`#${identity}-fact-${edge.factId}`}>
                    Inspect declared prerequisite {edge.from.fact.memberId} →{' '}
                    {edge.to.fact.memberId}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </figure>
      )}
    </>
  );
}
