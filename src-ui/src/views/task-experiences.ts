export type TaskExperienceId = 'direct' | 'deliver' | 'learn' | 'operate';

export type TaskExperienceAvailability = 'available' | 'unavailable';

export interface TaskExperienceDefinition {
  id: TaskExperienceId;
  label: string;
  authority: string;
  description: string;
  unavailableDescription: string;
  alternativeHref?: string;
  alternativeLabel?: string;
}

export interface ResolvedTaskExperience extends TaskExperienceDefinition {
  availability: TaskExperienceAvailability;
}

export const TASK_EXPERIENCE_DEFINITIONS: readonly TaskExperienceDefinition[] =
  [
    {
      id: 'direct',
      label: 'Direct',
      authority: 'Station',
      description:
        'Inspect the exact Task workspace and recorded references. Inspection is not a verification claim.',
      unavailableDescription: '',
    },
    {
      id: 'deliver',
      label: 'Deliver',
      authority: 'Builder Kit',
      description:
        'Continue delivery through a Builder-owned Task reference. Station does not infer lifecycle completion.',
      unavailableDescription:
        'No trusted Builder Kit contract is attached. Direct work remains available, and Station does not report delivery completion.',
      alternativeHref: '/plugins',
      alternativeLabel: 'Manage plugins',
    },
    {
      id: 'learn',
      label: 'Learn',
      authority: 'Knowledge Kit',
      description:
        'Open a Knowledge-owned record with its published provenance and freshness.',
      unavailableDescription:
        'No trusted Knowledge Kit contract is attached. Station does not invent knowledge, provenance, or freshness.',
      alternativeHref:
        '/settings?view=knowledge&highlight=personal-knowledge-store',
      alternativeLabel: 'Configure knowledge',
    },
    {
      id: 'operate',
      label: 'Operate',
      authority: 'Console',
      description:
        'Open a Console-owned operational projection. Station remains a reader and deep-link boundary.',
      unavailableDescription:
        'No trusted Console deep-link contract is attached. Station does not host or write Console operational state.',
      alternativeHref: 'https://github.com/kontourai/console',
      alternativeLabel: 'Open Console project',
    },
  ] as const;

/**
 * The capability string an installed plugin declares in its manifest to say it
 * provides one of these Task experiences. Namespaced under `station.` so it is
 * a deliberate declaration against Station's own contract, not a word a plugin
 * could collide with by accident.
 */
export function taskExperienceCapabilityId(id: TaskExperienceId): string {
  return `station.task-experience.${id}`;
}

/**
 * What this Station has actually observed about the optional experiences.
 *
 * `attachedExperiences` is the set an installed, enabled plugin declares it
 * provides. It is a real observation of this host — not a hardcoded list — but
 * it is exactly and only that: the producer's own declaration that it
 * implements the contract, which is what makes the experience openable. It is
 * NOT a claim that the contract has been verified, and nothing in the rendered
 * experience may say otherwise.
 */
export interface TaskExperienceAvailabilityObservation {
  attachedExperiences?: readonly TaskExperienceId[];
}

/**
 * Generic Task external references are opaque, untrusted handles. They cannot
 * establish a first-party product identity or availability. Optional
 * experiences stay unavailable until a producer that declares the contract is
 * installed and enabled on this Station.
 *
 * `direct` is Station's own inspection view and is always available; it is the
 * one experience whose availability this process can answer for itself.
 */
export function resolveTaskExperiences(
  observation: TaskExperienceAvailabilityObservation = {},
): ResolvedTaskExperience[] {
  const attached = new Set(observation.attachedExperiences ?? []);
  // A task page must not advertise product experiences that it cannot open,
  // so an unattached optional experience is not listed at all — it is reached
  // through the single Add capabilities affordance instead.
  return TASK_EXPERIENCE_DEFINITIONS.filter(
    (definition) => definition.id === 'direct' || attached.has(definition.id),
  ).map((definition) => ({ ...definition, availability: 'available' }));
}

/**
 * The observation above, read off this Station's installed plugins. An
 * `enabled === false` plugin is not a producer this page can open, so its
 * declaration does not count.
 */
export function observeTaskExperienceAvailability(
  plugins: readonly {
    enabled?: boolean;
    manifest?: { capabilities?: string[] };
  }[],
): TaskExperienceAvailabilityObservation {
  const declared = new Set(
    plugins
      .filter((plugin) => plugin.enabled !== false)
      .flatMap((plugin) => plugin.manifest?.capabilities ?? []),
  );
  return {
    attachedExperiences: TASK_EXPERIENCE_DEFINITIONS.filter(
      (definition) =>
        definition.id !== 'direct' &&
        declared.has(taskExperienceCapabilityId(definition.id)),
    ).map((definition) => definition.id),
  };
}
