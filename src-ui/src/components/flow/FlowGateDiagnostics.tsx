import type { FlowGateDiagnosticDetails } from '@kontourai/station-contracts/runtime-events';

export function FlowGateDiagnostics({
  details,
}: {
  details?: FlowGateDiagnosticDetails;
}) {
  if (!details) return null;
  return (
    <div className="flow-gate-card__meta">
      <ul className="flow-gate-card__missing">
        {details.claims.map((claim, index) => (
          <li key={index}>
            {[claim.expectationId, claim.reason, claim.specificReason]
              .filter(Boolean)
              .join(' · ')}
            {claim.surfaceGaps && (
              <ul>
                {claim.surfaceGaps.map((gap, gapIndex) => (
                  <li key={gapIndex}>
                    {[gap.type, gap.message].filter(Boolean).join(' · ')}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {details.truncated && <p>Additional gate details omitted.</p>}
    </div>
  );
}
