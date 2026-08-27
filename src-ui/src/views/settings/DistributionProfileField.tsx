/**
 * station#settings-revamp slice 3: custom composite editor for
 * `distributionProfile`. Renders a 2-option select when the value is the
 * string 'standard'/'minimal' (or absent -> default 'standard'); a
 * read-only note when it's a custom `DistributionProfile` object (composite
 * kinds never get a generic editor — see `registry-row.tsx`).
 */
import type { DistributionProfileSelection } from '@kontourai/station-contracts/distribution';
import { PageRow } from '../../components/PageRow';
import { ProvenanceBadge } from '../../components/ProvenanceBadge';
import type { RegistryRowComponentProps } from './registry-row-types';

export function DistributionProfileField({
  definition,
  value,
  provenance,
  onChange,
}: RegistryRowComponentProps) {
  const selection = value as DistributionProfileSelection | undefined;
  const badge = <ProvenanceBadge provenance={provenance} />;

  if (selection !== undefined && typeof selection === 'object') {
    return (
      <PageRow
        label={definition.label}
        description={definition.description}
        status={badge}
      >
        <span className="settings__field-hint">
          Custom layout sources are configured in app.json. Changes take effect
          after the next Station restart. Declared remote sources are not
          fetched or executed.
        </span>
      </PageRow>
    );
  }

  const current = selection === 'minimal' ? 'minimal' : 'standard';
  return (
    <PageRow
      label={definition.label}
      description={definition.description}
      status={badge}
      control={
        <select
          className="editor-select"
          aria-label={definition.label}
          value={current}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="standard">
            Standard — built-in and installed plugin layouts
          </option>
          <option value="minimal">Minimal — no layout sources</option>
        </select>
      }
    >
      <span className="settings__field-hint">
        Changes take effect after the next Station restart. This is
        project-layout configuration: it does not build or distribute Station,
        set the Registry URL, or fetch or execute declared remote sources.
      </span>
    </PageRow>
  );
}
