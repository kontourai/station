/**
 * Epic #2144 slice 3 — everything a settings row says ABOUT its value, in one
 * place: which scope owns it, the existing provenance chip, a way to see the
 * layers it resolved through, and a way to give a project override back
 * (docs/design/settings-architecture.md §5).
 *
 * Composed in that order into `PageRow`'s `status` slot, so the four generic
 * registry rows in `registry-row.tsx` gain all of it by passing one element
 * instead of four.
 *
 * `ProvenanceBadge` is rendered UNCHANGED and keeps its own rules — notably
 * that `source: 'file'` draws nothing (archive#1557). The scope badge beside
 * it answers a different question: provenance says what KIND of origin a
 * value has, and scope says which document may change it. A row whose value
 * is an ordinary stored Station value has no provenance chip and still has a
 * scope.
 */

import './SettingRowStatus.css';
import type {
  SettingDefinition,
  SettingProvenanceEntry,
} from '@kontourai/station-contracts/settings-registry';
import { Badge, Popover } from '@kontourai/ui/react';
import { InfoGlyph } from '../../components/icons/Glyph';
import { LazyBoundary } from '../../components/LazyBoundary';
import { ProvenanceBadge } from '../../components/ProvenanceBadge';
import { SkeletonBlock } from '../../components/state';
import type { PendingOverrideChange } from './SettingInheritanceLayers';
import type { SettingsCatalogEntry } from './settings-catalog';

/**
 * Module-level so its identity is stable across renders — `LazyBoundary`
 * memoizes on the `load` function, and an inline arrow would re-create the
 * lazy component (and re-run the import) on every keystroke in the page.
 *
 * A real `import()`, not a re-export: this body is the reason the popover is
 * code-split at all, and a static import would put the layer list in the
 * entry bundle for every row that never opens it.
 */
const loadInheritanceLayers = () =>
  import('./SettingInheritanceLayers').then((module) => ({
    default: module.SettingInheritanceLayers,
  }));

type CatalogScope = NonNullable<SettingsCatalogEntry['scope']>;

/**
 * The scope badge's text, or `undefined` for a row that has no single owner
 * to name.
 *
 * A project override wins over the catalog's answer because it is a fact
 * about THIS value (the server computed it) while the catalog scope is a fact
 * about the SETTING. `mixed`, `temporary` and `informational` deliberately
 * produce nothing: a row that is partly device and partly Station, one whose
 * value does not outlive the session, and one that is a report rather than a
 * setting would each be lied about by any of the three labels.
 */
export function scopeBadgeLabel(
  catalogScope: CatalogScope | undefined,
  provenance: SettingProvenanceEntry | undefined,
  containerScope?: 'station' | 'device',
): string | undefined {
  if (provenance?.source === 'file' && provenance.scope === 'project')
    return 'Project';
  // #2144 slice 7: a label that only restates the enclosing group's caption
  // is withheld. Every Station row inside "Saved to this Station" used to
  // carry a STATION chip — a label printed regardless of state, the epic's
  // own named defect in visual form; none of the three products compared
  // marks the common case per row. So the chip is a DIFFERENCE from the
  // caption, and a caller that names no container gets the old behaviour.
  const own =
    catalogScope === 'station' || catalogScope === 'defaults'
      ? 'station'
      : catalogScope === 'device'
        ? 'device'
        : undefined;
  if (own === undefined || own === containerScope) return undefined;
  return own === 'station' ? 'Station' : 'This device';
}

export interface SettingRowStatusProps {
  definition: SettingDefinition;
  provenance?: SettingProvenanceEntry;
  /** The owning catalog entry's scope; absent for a row with no catalog entry. */
  catalogScope?: CatalogScope;
  /** The rule the enclosing scope group's caption states; see `scopeBadgeLabel`. */
  containerScope?: 'station' | 'device';
  /** The selected project's display name, for the layer list. */
  projectName?: string;
  /** The project's override value for this key, when it has one. */
  projectValue?: unknown;
  /** This Station's stored value for this key. */
  stationValue?: unknown;
  /**
   * An unsaved project-override change for this key. Passed to the layer list
   * so it stops claiming a resolution the draft has already moved past.
   */
  pending?: PendingOverrideChange;
  /**
   * Drops the project's override for this key. Supplied only by a caller
   * that owns a project override draft; its absence is why a Station-only
   * page shows no reset affordance rather than one that does nothing.
   */
  onResetToInherited?: () => void;
}

export function SettingRowStatus({
  definition,
  provenance,
  catalogScope,
  containerScope,
  projectName,
  projectValue,
  stationValue,
  pending,
  onResetToInherited,
}: SettingRowStatusProps) {
  const scopeLabel = scopeBadgeLabel(catalogScope, provenance, containerScope);
  const overriddenByProject =
    provenance?.source === 'file' && provenance.scope === 'project';
  // `required` has no inherited value to fall back TO — dropping the override
  // would leave the chain with nothing, so the affordance is withheld rather
  // than offered and then refused.
  const canReset =
    overriddenByProject && !definition.required && onResetToInherited;

  return (
    <span className="setting-row-status">
      {/* No reserved footprint for the chip. Reserving one was tried and cost
          every row a description line (the slot squeezed the text column on
          rows that will never grow a chip); a chip shifting ONE row's control
          by its own width, on the rare row that has an override, is the
          cheaper of the two. */}
      {scopeLabel && (
        <Badge
          value={scopeLabel}
          tone="neutral"
          className="setting-row-status__scope"
        />
      )}
      <ProvenanceBadge provenance={provenance} />
      <Popover
        ariaLabel={`Where ${definition.label} comes from`}
        placement="bottom-end"
        className="setting-row-status__inheritance"
        trigger={
          <button
            type="button"
            className="setting-row-status__inheritance-trigger"
            aria-label={`Where ${definition.label} comes from`}
          >
            <InfoGlyph />
          </button>
        }
      >
        <LazyBoundary
          load={loadInheritanceLayers}
          componentProps={{
            definition,
            provenance,
            projectName,
            projectValue,
            stationValue,
            pending,
          }}
          // The shared loading vocabulary, not a new sentence: SHELL-13's
          // ratchet counts a bespoke "Loading…" string as a regression, and
          // `SkeletonBlock`'s `label` is where the wait gets named.
          pending={
            <SkeletonBlock
              count={2}
              label="Loading where this value comes from"
            />
          }
          unavailable={(onRetry) => (
            <p className="setting-row-status__pending">
              This explanation could not be loaded.{' '}
              <button
                type="button"
                className="button button--link"
                onClick={onRetry}
              >
                Retry
              </button>
            </p>
          )}
        />
      </Popover>
      {canReset && (
        <button
          type="button"
          className="button button--link setting-row-status__reset"
          onClick={onResetToInherited}
        >
          Reset to inherited
        </button>
      )}
    </span>
  );
}
