import type { ManagedPolicyEngineLaunchField } from '@kontourai/station-contracts/managed-policy-engines';
import { Badge } from '@kontourai/ui/react';
import type { ManagedEngineState } from '../hooks/useManagedEngines';

const FIELD_LABELS: Record<ManagedPolicyEngineLaunchField, string> = {
  binaryPath: 'program',
  launchArgs: 'arguments',
  environment: 'environment',
};

/** The row subtitle prefix for an engine the managed policy governs. */
/**
 * The engine row's policy fact. A disallowed engine's badge already reads
 * "Not allowed", so its fact names only who decided.
 */
export function managedEngineFact(
  state: ManagedEngineState | null,
): string | null {
  if (!state) return null;
  return state.disallowed ? 'Managed' : 'Managed launch';
}

/** Whether the policy owns this engine's launch environment. */
export function managedEnvironmentLocked(state: ManagedEngineState | null) {
  return Boolean(
    state?.pin?.locked && state.pin.fields.includes('environment'),
  );
}

/**
 * #4520: why an engine is unavailable or launched a fixed way. Names what
 * the policy pins, never a value.
 */
export function ManagedEngineNotice({
  state,
}: {
  state: ManagedEngineState | null;
}) {
  if (!state) return null;
  const pin = state.pin;
  const fields = (pin?.fields ?? []).map((field) => FIELD_LABELS[field]);
  const names = pin?.environmentNames.length
    ? ` (${pin.environmentNames.join(', ')})`
    : '';
  return (
    <div
      className="managed-engine-notice"
      role="note"
      data-testid="managed-engine-notice"
    >
      <div className="managed-engine-notice__badges">
        <Badge value={`Managed by ${state.organization}`} tone="neutral" />
        {state.disallowed && <Badge value="Not allowed" tone="caution" />}
        {pin && !state.disallowed && (
          <Badge
            value={pin.locked ? 'Launch locked' : 'Launch defaults'}
            tone="neutral"
          />
        )}
      </div>
      {state.disallowed ? (
        <p className="editor-help">
          Not allowed on this computer. Its chats are kept but can't run.
        </p>
      ) : pin ? (
        <p className="editor-help">
          {pin.locked ? 'Policy sets its ' : 'Policy defaults for its '}
          {fields.join(', ')}
          {names}.
          {managedEnvironmentLocked(state)
            ? ' Connect through and connection environment do not apply.'
            : ''}
        </p>
      ) : null}
      {state.supportUrl ? (
        <a
          className="managed-engine-notice__help"
          href={state.supportUrl}
          target="_blank"
          rel="noreferrer"
        >
          Get help
        </a>
      ) : null}
    </div>
  );
}
