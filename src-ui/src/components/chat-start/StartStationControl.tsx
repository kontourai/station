import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import {
  effectiveExecutionStationId,
  useExecutionStations,
} from '../../hooks/useExecutionStationCatalog';
import { ArrowDownGlyph, MonitorGlyph } from '../icons/Glyph';

/**
 * Names the Station this start runs on ("Runs on brian-media"). When the
 * server reports another Station this caller may run on, it is a picker
 * trigger: `onOpen` opens the start menus' Station list, which only chooses
 * the destination — Start still does the starting. With nothing else to
 * choose (or before the caller's Station reads have answered), it is plain
 * text: no button, no caret, nothing to tap.
 */
export function StartStationControl({
  environmentId,
  defaultEnvironment,
  canChoose,
  projectSelected = false,
  disabled,
  onOpen,
}: {
  /** The start's explicit Station choice, if any. */
  environmentId?: string;
  /** The Project's saved default, used when nothing is chosen. */
  defaultEnvironment?: EnvironmentRef;
  /** False when there is no Agent whose Station choice could change. */
  canChoose: boolean;
  /** A Project is selected, so SSH Stations are not offered. */
  projectSelected?: boolean;
  disabled?: boolean;
  onOpen: (trigger: HTMLElement) => void;
}) {
  const { stations, nameFor, settled } = useExecutionStations({
    projectSelected,
  });
  const selectedId = effectiveExecutionStationId(
    environmentId,
    defaultEnvironment,
  );
  const selected = stations.find((station) => station.id === selectedId);
  // A remembered choice keeps its real name even when it is no longer
  // offered (or the lists that offer it could not be read).
  const name =
    nameFor(selectedId) ??
    (environmentId ? 'the selected Station' : 'the Project default');
  const label = `Runs on ${name}`;
  // An unlisted current choice stays changeable, so a Station this caller
  // lost access to can always be replaced by one it still has.
  const choosable =
    canChoose &&
    settled &&
    (stations.length > 1 || !selected || selectedId !== 'current');
  if (!choosable)
    return (
      <span className="choice-trigger start-composer__station start-composer__station--fixed">
        <MonitorGlyph className="start-composer__station-mark" />
        <span>{label}</span>
      </span>
    );
  return (
    <button
      type="button"
      className="choice-trigger start-composer__station"
      aria-haspopup="dialog"
      aria-label={`${label}. Choose where this work runs`}
      disabled={disabled}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <MonitorGlyph className="start-composer__station-mark" />
      <span>{label}</span>
      <ArrowDownGlyph className="choice-caret" />
    </button>
  );
}
