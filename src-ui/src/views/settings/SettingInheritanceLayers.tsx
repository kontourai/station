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

/**
 * A project-override change this page holds but has not saved.
 *
 * The provenance entry predates the draft, so with one in hand the list is
 * describing the SAVED state while the row beside it already shows the
 * drafted one. `'reset'` is a pending drop of the override, `'edit'` a
 * pending new value; both mean the same thing here — do not claim any layer
 * is in effect, because the page cannot know what the server will resolve
 * until the write lands.
 */
export type PendingOverrideChange = 'reset' | 'edit';

export interface SettingInheritanceLayersProps {
  definition: SettingDefinition;
  provenance?: SettingProvenanceEntry;
  /** An unsaved project-override change, if the page holds one. */
  pending?: PendingOverrideChange;
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
/**
 * Does this Station carry a decision for the key at all?
 *
 * `''` and absent are the SAME answer — that is `isStoredValue`'s rule on the
 * server (`src-server/domain/settings-registry-server.ts`), and the layer
 * list must not invent a second one: a blank string is not a value the
 * resolver reads, so rendering it as "none" while an absent field renders
 * "uses the built-in default" would make one state look like a decision and
 * the other like an absence when they resolve identically.
 */
function isUnstored(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim().length === 0;
}

/**
 * How a Station that has stored nothing for a key reads.
 *
 * NOT always "uses the built-in default": of the three project-overridable
 * settings only `defaultWorkspaceIsolation` declares a `defaultValue`.
 * `defaultLLMProvider` has none and nothing fills it in, so that sentence
 * would sit directly above "Built-in default: none" and promise a fallback
 * the chain does not have. A `required` setting is the same case by
 * declaration — see the built-in layer below, which applies the same test.
 */
function unstoredStationValue(definition: SettingDefinition): string {
  return definition.required || definition.defaultValue === undefined
    ? 'nothing stored'
    : 'uses the built-in default';
}

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
    // The layer the override sits on top of. Two different facts, and the
    // list must not spell them the same way:
    //
    // - a value in hand -> show it. What the provenance cannot add is whether
    //   that value is STORED or is the default the server already resolved,
    //   because the scoped read replaced this key's entry with the project's;
    //   the note below says exactly that.
    // - nothing stored -> `unstoredStationValue` decides, because whether
    //   there is a default to fall back to is a property of the DEFINITION,
    //   not of the absence. There is nothing unknown to note in this case
    //   either, so the source note below is withheld for it.
    layers.push({
      id: 'station',
      label: 'This Station',
      value: isUnstored(stationValue)
        ? unstoredStationValue(definition)
        : describeValue(stationValue),
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
  // Only where there is something the page genuinely cannot report: a Station
  // that carries no value for the key falls back to the default, full stop.
  const stationSourceUnreported =
    overriddenByProject && !isUnstored(props.stationValue);
  const pending = props.pending !== undefined;

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
              layer.inEffect && !pending
                ? ' setting-inheritance__layer--in-effect'
                : ''
            }`}
          >
            <span className="setting-inheritance__layer-label">
              {layer.label}
            </span>
            <span className="setting-inheritance__layer-value">
              {layer.value}
            </span>
            {layer.inEffect && !pending && (
              <span className="setting-inheritance__layer-effect">
                in effect
              </span>
            )}
          </li>
        ))}
      </ul>
      {pending && (
        // The provenance was computed before this draft existed, so every
        // "in effect" mark above would describe a resolution the row beside
        // it no longer shows. Say which state the list describes rather than
        // guessing at the one that has not been saved.
        <p className="setting-inheritance__note">
          Unsaved change: the layers above describe what is saved.
        </p>
      )}
      {stationSourceUnreported && (
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
