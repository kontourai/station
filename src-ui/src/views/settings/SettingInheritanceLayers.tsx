/**
 * Epic #2144 slice 3 — "where does this value come from?", as a layer list
 * for ONE setting (docs/design/settings-architecture.md §5).
 *
 * Loaded on demand (`SettingRowStatus` mounts it through `LazyBoundary`): a
 * settings page renders dozens of rows and nobody opens more than one of
 * these, so the body has no business in the entry bundle.
 *
 * **Exactly one layer is in effect, and the provenance entry is what says
 * which.** The layers' VALUES are read from the drafts the page already
 * holds, but the "in effect" mark is never re-derived from them: a surface
 * that decided which layer won by comparing raw values would be a second,
 * looser implementation of the resolver the server already ran, and the two
 * disagree the moment "absent" means something different on either side
 * (archive#1557, and `isStoredValue`'s docblock in
 * `src-server/domain/settings-registry-server.ts`).
 *
 * Shape mirrors T3 Code's compact layer list
 * (`apps/web/src/components/settings/SettingInheritance.tsx:79-113`) — a
 * top-down list, innermost first, one row marked as the winner. Nothing but
 * the shape is borrowed; the sources are Station's own.
 */

import './SettingInheritanceLayers.css';
import type {
  SettingDefinition,
  SettingProvenanceEntry,
} from '@kontourai/station-contracts/settings-registry';

export interface SettingInheritanceLayersProps {
  definition: SettingDefinition;
  provenance?: SettingProvenanceEntry;
  /** The selected project's display name, for the project layer's label. */
  projectName?: string;
  /** The project's override value, when it has one. */
  projectValue?: unknown;
  /** This Station's stored value for the key. */
  stationValue?: unknown;
}

interface Layer {
  id: 'project' | 'station' | 'env' | 'default';
  label: string;
  value: string;
  inEffect: boolean;
}

/**
 * How a layer's value reads. Deliberately plain: this list explains where a
 * value came from, and a clever renderer for each descriptor kind would be a
 * second control masquerading as an explanation.
 */
function describeValue(value: unknown): string {
  if (value === undefined || value === null) return 'none';
  if (typeof value === 'string') return value.trim() === '' ? 'none' : value;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value))
    return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  if (typeof value === 'object') return 'a configured value';
  return String(value);
}

/**
 * The four provenance shapes this surface can be handed, and the layer each
 * one puts in effect:
 *
 * - `{ source: 'file', scope: 'project' }` -> the project override
 * - `{ source: 'file' }` / `{ source: 'file', scope: 'station' }` -> this Station
 * - `{ source: 'env' }` -> the environment (`envVar` names it)
 * - `{ source: 'default' }`, or no entry at all -> the built-in default
 *
 * No entry is the same answer as `default` on purpose: `GET /config/app`
 * emits provenance for every registered key, so a missing entry means the key
 * is absent from the config the server loaded — which is what a registry
 * default is.
 */
export function inheritanceLayers({
  definition,
  provenance,
  projectName,
  projectValue,
  stationValue,
}: SettingInheritanceLayersProps): readonly Layer[] {
  const source = provenance?.source ?? 'default';
  const fromProject = source === 'file' && provenance?.scope === 'project';
  const fromStation = source === 'file' && !fromProject;
  const fromEnv = source === 'env';

  const layers: Layer[] = [];
  if (fromProject) {
    layers.push({
      id: 'project',
      label: projectName ? `Project: ${projectName}` : 'Project override',
      value: describeValue(projectValue),
      inEffect: true,
    });
  }
  if (fromStation) {
    layers.push({
      id: 'station',
      label: 'Stored on this Station',
      value: describeValue(stationValue),
      inEffect: true,
    });
  } else if (fromProject) {
    // The Station's value IS known — the page holds it — so show it as the
    // layer the override sits on top of. What the provenance cannot say is
    // whether that value is stored or is the registry default, because the
    // scoped read replaced this key's entry with the project's; the note
    // below says exactly that and nothing more.
    layers.push({
      id: 'station',
      label: 'This Station',
      value: describeValue(stationValue),
      inEffect: false,
    });
  }
  if (fromEnv) {
    layers.push({
      id: 'env',
      label: provenance?.envVar
        ? `Environment: ${provenance.envVar}`
        : 'Environment',
      value: describeValue(stationValue),
      inEffect: true,
    });
  }
  layers.push({
    id: 'default',
    label: 'Built-in default',
    // A required setting has no default to fall back to — the value has to
    // come from somewhere closer, and printing `undefined` as a default would
    // claim a fallback that does not exist.
    value: definition.required
      ? 'none'
      : describeValue(definition.defaultValue),
    inEffect: source === 'default',
  });
  return layers;
}

export function SettingInheritanceLayers(props: SettingInheritanceLayersProps) {
  const layers = inheritanceLayers(props);
  const overriddenByProject =
    props.provenance?.source === 'file' && props.provenance.scope === 'project';

  return (
    <div className="setting-inheritance">
      {props.definition.help && (
        <p className="setting-inheritance__help">{props.definition.help}</p>
      )}
      <ul className="setting-inheritance__layers">
        {layers.map((layer) => (
          <li
            key={layer.id}
            className={`setting-inheritance__layer${
              layer.inEffect ? ' setting-inheritance__layer--in-effect' : ''
            }`}
          >
            <span className="setting-inheritance__layer-label">
              {layer.label}
            </span>
            <span className="setting-inheritance__layer-value">
              {layer.value}
            </span>
            {layer.inEffect && (
              <span className="setting-inheritance__layer-effect">
                in effect
              </span>
            )}
          </li>
        ))}
      </ul>
      {overriddenByProject && (
        // Narrowed to what is actually unknown: the page HAS the Station's
        // value (rendered as the layer above), and `GET /config/app?project=
        // <slug>` replaces this key's entry with the project's, so what the
        // page cannot say is which SOURCE that value came from. Claiming the
        // value itself was unavailable was false, and dropping a layer the
        // caller had already supplied made the list less true, not safer.
        <p className="setting-inheritance__note">
          Whether this Station stores that value or falls back to the default is
          not reported while an override is in effect.
        </p>
      )}
    </div>
  );
}
