import type {
  InstalledSkillExperienceV1,
  SkillExperienceInventoryV1,
} from '@kontourai/station-contracts/skill-experience';
import {
  sameSkillExperienceIdentity,
  skillExperiencesCanExecute,
} from '@kontourai/station-shared/skill-experience-values';
import { Button } from '../Button';
import { Empty, SkeletonList } from '../state';
import { SkillExperienceForm } from './SkillExperienceForm';

export function SkillExperiencePicker({
  query,
  selected,
  current,
  inputs,
  onSelect,
  onChange,
  onRemove,
  onBrowse,
  startHint = 'Choose an Agent below to prepare this skill in its chat composer. Attach required files there, then send explicitly.',
}: {
  query: {
    data?: SkillExperienceInventoryV1;
    isPending: boolean;
    error: unknown;
    refetch: () => Promise<unknown>;
  };
  selected: InstalledSkillExperienceV1 | null;
  current: boolean;
  inputs: Record<string, string>;
  onSelect: (entry: InstalledSkillExperienceV1) => void;
  onChange: (inputs: Record<string, string>) => void;
  onRemove: () => void;
  onBrowse: () => void;
  /** What starting does with the chosen skill, in the host's words. */
  startHint?: string;
}) {
  return (
    <section className="skill-experience-cards" aria-label="Visual skills">
      <h4>Visual skills</h4>
      {query.isPending ? (
        <SkeletonList count={2} label="Loading visual skills" />
      ) : query.error ? (
        <p role="alert">
          Visual skills could not be loaded.{' '}
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </p>
      ) : !query.data?.experiences.length ? (
        <Empty
          variant="compact"
          label="Nothing here yet"
          description="Install a visual skill through Registry to prepare it here."
        />
      ) : (
        query.data.experiences.map((entry) => (
          <button
            key={`${entry.identity.pluginId}:${entry.definition.id}`}
            type="button"
            className="skill-experience-card"
            aria-pressed={Boolean(
              selected &&
                sameSkillExperienceIdentity(selected.identity, entry.identity),
            )}
            onClick={() => onSelect(entry)}
          >
            <strong>{entry.definition.title}</strong>
            <span>{entry.definition.purpose}</span>
            <span>
              {entry.identity.pluginId} · {entry.identity.pluginVersion}
            </span>
          </button>
        ))
      )}
      {selected && (
        <>
          <p>{selected.definition.example}</p>
          <SkillExperienceForm
            definition={selected.definition}
            values={inputs}
            onChange={onChange}
          />
          {!skillExperiencesCanExecute(query.data) && (
            <p role="alert">
              This Station provides previews only. It cannot start visual
              skills.
            </p>
          )}
          {!current && (
            <p role="alert">
              The selected source changed or is unavailable. Choose it again;
              your inputs are retained.
            </p>
          )}
          <p>{startHint}</p>
          <Button onClick={onRemove}>Use ordinary chat</Button>
        </>
      )}
      <Button onClick={onBrowse}>Browse marketplaces</Button>
    </section>
  );
}
