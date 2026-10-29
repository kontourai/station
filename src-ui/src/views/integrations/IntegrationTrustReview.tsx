import type { IntegrationTrustReviewField } from '@kontourai/station-contracts/tool';
import {
  type IntegrationViewModel,
  useDecideIntegrationTrustReviewMutation,
} from '@kontourai/station-sdk';
import { StatusBadge } from '@kontourai/ui/react';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/state';
import { userFacingErrorMessage } from '../../utils/errorText';

const FIELD_LABEL: Record<IntegrationTrustReviewField['field'], string> = {
  contentTrust: 'Content classification',
  permissions: 'Permissions after untrusted content',
  trustReadOnlyHints: 'Trust read-only hints',
};

function fieldValue(field: IntegrationTrustReviewField): string {
  if (field.field === 'trustReadOnlyHints')
    return field.value === true ? 'Trusted' : 'Not trusted';
  if (field.field === 'contentTrust') return String(field.value);
  const value = field.value as
    | { default?: string; tools?: Record<string, string> }
    | undefined;
  return [
    ...(value?.default ? [`default ${value.default}`] : []),
    ...Object.entries(value?.tools ?? {}).map(
      ([name, permission]) => `${name} ${permission}`,
    ),
  ].join(', ');
}

/**
 * #3483: stored trust settings that would allow more and whose owner Station
 * cannot confirm. The integration stays off until a person decides.
 */
export function IntegrationTrustReview({
  form,
}: {
  form: IntegrationViewModel;
}) {
  const decide = useDecideIntegrationTrustReviewMutation();
  const fields = form.trustReview?.fields ?? [];
  if (fields.length === 0) return null;
  return (
    <section
      className="agent-editor__section"
      aria-labelledby="integration-trust-review-heading"
    >
      <div className="agent-editor__section-header">
        <h3
          id="integration-trust-review-heading"
          className="agent-editor__section-title"
        >
          Trust settings
        </h3>
        <StatusBadge tone="caution" status="Needs your review" />
      </div>
      <p className="agent-editor__section-desc">
        These saved settings allow more than Station&rsquo;s defaults. They stay
        off until you keep or reset them.
      </p>
      <dl className="integration-trust-review">
        {fields.map((field) => (
          <div key={field.field}>
            <dt>{FIELD_LABEL[field.field]}</dt>
            <dd>{fieldValue(field)}</dd>
          </div>
        ))}
      </dl>
      <div className="integration-trust-review__actions">
        <Button
          variant="primary"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ id: form.id, decision: 'keep' })}
        >
          Keep these settings
        </Button>
        <Button
          disabled={decide.isPending}
          onClick={() => decide.mutate({ id: form.id, decision: 'reset' })}
        >
          Use Station defaults
        </Button>
      </div>
      {decide.error && (
        <ErrorState
          variant="compact"
          title="Review was not saved"
          description={userFacingErrorMessage(decide.error)}
        />
      )}
    </section>
  );
}
