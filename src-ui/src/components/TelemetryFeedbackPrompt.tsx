import {
  TELEMETRY_FEEDBACK_REASONS,
  type TelemetryFeedbackReason,
} from '@kontourai/station-contracts/product-telemetry';
import { useEffect, useId, useRef } from 'react';
import { Button } from './Button';
import './TelemetryPrivacy.css';

const LABELS: Record<TelemetryFeedbackReason, string> = {
  privacy: 'Privacy',
  'too-much-data': 'Too much data',
  performance: 'Performance',
  'not-useful': 'Not useful',
  unexpected: 'Unexpected',
  other: 'Other',
  skip: 'Skip',
};

/** Inline so disclosure dialogs keep their single focus trap and escape route. */
export function TelemetryFeedbackPrompt({
  publisher,
  onChoose,
  onCancel,
  deferred = false,
}: {
  publisher: string;
  onChoose: (reason: TelemetryFeedbackReason) => void;
  deferred?: boolean;
  onCancel?: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section
      className="telemetry-feedback"
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onCancel) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <h3 id={id} tabIndex={-1} ref={heading}>
        Why lower {publisher} telemetry? (optional)
      </h3>
      <p>
        Share one identifier-free reason with this publisher only.
        {deferred
          ? ' It is included when you save Settings.'
          : ' Choosing a reason saves your lower tier.'}{' '}
        Skip saves without sending feedback.
      </p>
      <div className="telemetry-feedback__reasons">
        {TELEMETRY_FEEDBACK_REASONS.map((reason) => (
          <Button
            key={reason}
            variant="secondary"
            onClick={() => onChoose(reason)}
          >
            {LABELS[reason]}
          </Button>
        ))}
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}
