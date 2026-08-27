import type { PluginSettingField } from '@kontourai/station-sdk';
import { Toggle } from '../../components/Toggle';

export function PluginSettingFieldRow({
  field,
  value,
  onChange,
}: {
  field: PluginSettingField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <div className="plugins__setting-field">
      <span className="plugins__setting-label">
        {field.label}
        {field.required && (
          <span className="plugins__setting-required"> *</span>
        )}
      </span>
      {field.description && (
        <div className="plugins__setting-desc">{field.description}</div>
      )}
      {field.type === 'boolean' ? (
        <Toggle
          checked={!!value}
          onChange={onChange}
          size="sm"
          label={field.label}
        />
      ) : field.type === 'select' ? (
        <select
          aria-label={field.label}
          className="plugins__setting-input"
          value={
            (value as string | number | readonly string[] | undefined) ?? ''
          }
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={field.label}
          className="plugins__setting-input"
          type={
            field.secret
              ? 'password'
              : field.type === 'number'
                ? 'number'
                : 'text'
          }
          value={(value as string | number | undefined) ?? ''}
          onChange={(event) =>
            onChange(
              field.type === 'number'
                ? Number(event.target.value)
                : event.target.value,
            )
          }
        />
      )}
    </div>
  );
}
