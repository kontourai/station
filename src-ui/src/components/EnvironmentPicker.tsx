import {
  type EnvironmentRef,
  environmentId,
} from '@kontourai/station-contracts/execution-target';
import { useSshEnvironmentsQuery } from '@kontourai/station-sdk';

export const MISSING_ENVIRONMENT_NOTICE =
  'This project names a saved environment that no longer exists. Execution will fall back to This Station until you choose another environment.';
export const ENVIRONMENTS_UNAVAILABLE_NOTICE =
  'Saved environments are unavailable right now. The configured environment is preserved until the inventory can be loaded.';

export function EnvironmentPicker({
  id,
  label = 'Default environment',
  value,
  onChange,
}: {
  id: string;
  label?: string;
  value: EnvironmentRef;
  onChange: (value: EnvironmentRef) => void;
}) {
  const { data: environments, isSuccess, isError } = useSshEnvironmentsQuery();
  const savedId = value.kind === 'saved' ? value.id : null;
  const dangling = Boolean(
    isSuccess &&
      savedId &&
      !environments?.some((item) => item.profile.environmentId === savedId),
  );

  return (
    <div className="editor-field environment-picker">
      <label className="editor-label" htmlFor={id}>
        {label}
      </label>
      {/* #765 F5: `editor-select`, the design system's styled select (custom
          chevron, no native appearance) — `editor-input` left this control
          native-looking beside otherwise styled fields. */}
      <select
        id={id}
        className="editor-select"
        value={savedId ?? 'current'}
        onChange={(event) =>
          onChange(
            event.target.value === 'current'
              ? { kind: 'current' }
              : { kind: 'saved', id: environmentId(event.target.value) },
          )
        }
      >
        <option value="current">This Station</option>
        {(dangling || isError) && savedId && (
          <option value={savedId}>
            {savedId} —{' '}
            {dangling ? 'missing saved environment' : 'saved environment'}
          </option>
        )}
        {(environments ?? [])
          .filter((item) => item.profile.environmentId)
          .map((item) => (
            <option key={item.profile.id} value={item.profile.environmentId!}>
              {item.profile.name}
            </option>
          ))}
      </select>
      {dangling && (
        <p
          className="editor-field-hint environment-picker__notice"
          role="status"
        >
          {MISSING_ENVIRONMENT_NOTICE}
        </p>
      )}
      {isError && savedId && (
        <p
          className="editor-field-hint environment-picker__notice"
          role="alert"
        >
          {ENVIRONMENTS_UNAVAILABLE_NOTICE}
        </p>
      )}
    </div>
  );
}
