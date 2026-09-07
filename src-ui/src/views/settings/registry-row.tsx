/**
 * archive#settings-revamp (docs/design/settings-architecture.md §4:
 * "the Settings UI rows for scalar settings (form-from-schema; composite
 * editors like the guardian config opt out with a custom component)").
 *
 * `renderSettingRow` switches on a registry definition's `descriptor.kind`
 * to render a generic `PageRow`-wrapped control (string -> text input,
 * boolean -> Toggle, number -> number input, enum -> select), unless the
 * key has a custom row component registered in `composite-editors.tsx`
 * (`CUSTOM_ROW_RENDERERS`) — every composite-kind field always does (see
 * that module's completeness contract).
 */
import type { SettingDefinition } from '@kontourai/station-contracts/settings-registry';
import type { ReactNode } from 'react';
import { PageRow } from '../../components/PageRow';
import { ProvenanceBadge } from '../../components/ProvenanceBadge';
import { Toggle } from '../../components/Toggle';
import {
  CUSTOM_ROW_RENDERERS,
  DEFERRED_COMPOSITE_KEYS,
} from './composite-editors';
import type { RegistryRowComponentProps } from './registry-row-types';
import {
  settingsCatalogEntryForConfigKey,
  settingsRow,
} from './settings-catalog';

/**
 * archive#1840: a control must show the EFFECTIVE value, never the raw stored
 * one. An un-overridden setting has `value === undefined` while the runtime
 * applies `definition.defaultValue` — rendering the raw value made two
 * default-on toggles read "off" beside copy describing an active feature. The
 * default-vs-overridden distinction is the `DEFAULT` provenance chip's job.
 *
 * Toggles and selects have no placeholder affordance, so they render the
 * effective value directly. Text/number inputs stay empty when un-overridden
 * (an empty input honestly reads "no override recorded") and surface the
 * effective default via the placeholder instead.
 */
function effectiveDefaultPlaceholder(
  definition: SettingDefinition,
  runtimeDefault?: string,
): string | undefined {
  if (definition.placeholder !== undefined) return definition.placeholder;
  // #1582 D9: a value this HOST reports is what the runtime would actually
  // apply, where `defaultValue` is only what it would apply everywhere, so it
  // is preferred over that. An explicit `placeholder` still wins above: it is
  // authored copy for the field ("no cap", "leave empty to inherit"), not a
  // claim about a value, and a host-reported string must not overwrite it.
  // Most fields have no runtime default and fall through unchanged.
  if (runtimeDefault) return runtimeDefault;
  if (definition.defaultValue === undefined || definition.defaultValue === null)
    return undefined;
  return String(definition.defaultValue);
}

export function renderSettingRow({
  definition,
  value,
  provenance,
  onChange,
  runtimeDefault,
}: RegistryRowComponentProps): ReactNode {
  if (definition.userFacing === false) return null;

  const key = definition.key as string;
  const catalogEntry = settingsCatalogEntryForConfigKey(key);
  const row = catalogEntry ? settingsRow(catalogEntry.id) : undefined;
  const Custom = CUSTOM_ROW_RENDERERS[key];
  if (Custom) {
    return (
      <div key={key} {...row} tabIndex={row ? -1 : undefined}>
        <Custom
          definition={
            catalogEntry
              ? { ...definition, label: catalogEntry.title }
              : definition
          }
          value={value}
          provenance={provenance}
          onChange={onChange}
        />
      </div>
    );
  }

  const descriptor = definition.descriptor;
  const badge = <ProvenanceBadge provenance={provenance} />;

  switch (descriptor.kind) {
    case 'string':
      return (
        <PageRow
          key={key}
          {...row}
          label={catalogEntry?.title ?? definition.label}
          description={definition.description}
          status={badge}
          control={
            <input
              type="text"
              className="editor-input"
              aria-label={definition.label}
              value={(value as string) ?? ''}
              placeholder={effectiveDefaultPlaceholder(
                definition,
                runtimeDefault,
              )}
              maxLength={descriptor.maxLength}
              onChange={(event) => {
                onChange(event.target.value || null);
              }}
            />
          }
        />
      );

    case 'boolean':
      return (
        <PageRow
          key={key}
          {...row}
          label={catalogEntry?.title ?? definition.label}
          description={definition.description}
          status={badge}
          control={
            <Toggle
              checked={(value ?? definition.defaultValue) === true}
              onChange={(checked) => {
                onChange(checked);
              }}
              label={definition.label}
            />
          }
        />
      );

    case 'number':
      return (
        <PageRow
          key={key}
          {...row}
          label={catalogEntry?.title ?? definition.label}
          description={definition.description}
          status={badge}
          control={
            <input
              type="number"
              className="editor-input"
              aria-label={definition.label}
              value={value === undefined || value === null ? '' : String(value)}
              placeholder={effectiveDefaultPlaceholder(definition)}
              min={descriptor.min}
              max={descriptor.max}
              step={descriptor.integer ? 1 : undefined}
              onChange={(event) => {
                const raw = event.target.value;
                onChange(raw === '' ? null : Number(raw));
              }}
            />
          }
        />
      );

    case 'enum':
      return (
        <PageRow
          key={key}
          {...row}
          label={catalogEntry?.title ?? definition.label}
          description={definition.description}
          status={badge}
          control={
            <select
              className="editor-select"
              aria-label={definition.label}
              value={String(value ?? definition.defaultValue ?? '')}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            >
              {descriptor.values.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          }
        />
      );

    case 'composite':
      // Never a generic editor (see module doc comment) — a key reaching
      // here is either explicitly deferred (render nothing) or an
      // unclassified drift that `registry-row.test.tsx`'s completeness
      // test catches before merge; render nothing defensively either way.
      if (!DEFERRED_COMPOSITE_KEYS.includes(key)) {
        console.warn(
          `renderSettingRow: composite key "${key}" is not in COMPOSITE_EDITORS or DEFERRED_COMPOSITE_KEYS`,
        );
      }
      return null;

    default: {
      const exhaustive: never = descriptor;
      return exhaustive;
    }
  }
}

/** Every AppConfig/DeviceSettings definition's own type shares this base — re-exported here for callers building the list of definitions to render. */
export type { SettingDefinition };
