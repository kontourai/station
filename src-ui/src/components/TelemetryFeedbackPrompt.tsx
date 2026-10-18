import {
  TELEMETRY_FEEDBACK_REASONS,
  type TelemetryFeedbackReason,
} from '@kontourai/station-contracts/product-telemetry';
import { useId } from 'react';
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
  deferred = false,
}: {
  publisher: string;
  onChoose: (reason: TelemetryFeedbackReason) => void;
  deferred?: boolean;
}) {
  const id = useId();
  return (
    <section className="telemetry-feedback" aria-labelledby={id}>
      <h3 id={id} tabIndex={-1} ref={(element) => element?.focus()}>
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
      </div>
    </section>
  );
}
