import { settingsDeepLinkUrl } from './settings/settings-deep-link';

export type TaskExperienceId = 'direct' | 'deliver' | 'learn' | 'operate';

type TaskExperienceAvailability = 'available' | 'unavailable';

interface TaskExperienceDefinition {
  id: TaskExperienceId;
  label: string;
  /** The product that owns this experience, shown as "From {owner}". */
  owner: string;
  description: string;
  unavailableDescription: string;
  alternativeHref?: string;
  alternativeLabel?: string;
}

export interface ResolvedTaskExperience extends TaskExperienceDefinition {
  availability: TaskExperienceAvailability;
}

const TASK_EXPERIENCE_DEFINITIONS: readonly TaskExperienceDefinition[] = [
  {
    id: 'direct',
    label: 'Direct',
    owner: 'Station',
    description: 'Files and references recorded for this Task.',
    unavailableDescription: '',
  },
  {
    id: 'deliver',
    label: 'Deliver',
    owner: 'Builder Kit',
    description: 'Continue delivery in Builder Kit.',
    unavailableDescription:
      "Builder Kit isn't connected yet. Direct work is still available.",
    alternativeHref: '/plugins',
    alternativeLabel: 'Manage plugins',
  },
  {
    id: 'learn',
    label: 'Learn',
    owner: 'Knowledge Kit',
    description: 'Open the Knowledge record, with its source and freshness.',
    unavailableDescription:
      "Knowledge Kit isn't connected. Configure knowledge to open records here.",
    alternativeHref: settingsDeepLinkUrl({
      view: 'knowledge',
      highlight: 'personal-knowledge-store',
    }),
    alternativeLabel: 'Configure knowledge',
  },
  {
    id: 'operate',
    label: 'Operate',
    owner: 'Console',
    description: 'Open this Task in Console.',
    unavailableDescription: "Console isn't connected yet.",
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
function taskExperienceCapabilityId(id: TaskExperienceId): string {
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
interface TaskExperienceAvailabilityObservation {
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
  // through the single Add plugins affordance instead.
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
