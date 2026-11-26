/**
 * Fixture copy for the unpaired first-run sample (archive#2652 / #1772).
 *
 * This is a labeled sample so the first-run tour has something true to point
 * at when no Station host is paired. It is not a live run, and it must not
 * wear a derived verdict (verified / ready / pass) that nothing computed.
 */

export const UNPAIRED_SAMPLE_PROJECT = 'Getting started';

const UNPAIRED_SAMPLE_SURFACES = {
  notifications: {
    title: 'Sample Task',
    eyebrow: 'Waiting for a decision',
    body: 'A weekly digest is waiting for approval. Your decision is saved with the run.',
  },
  activity: {
    title: 'Sample session',
    eyebrow: 'One completed run',
    body: 'This session keeps the events behind its result.',
  },
  schedule: {
    title: 'Sample schedule',
    eyebrow: 'Every Monday at 9:00',
    body: 'Scheduled runs keep the same record as runs you start.',
  },
  customize: {
    title: 'Customize Station',
    eyebrow: 'Agents, skills, engines, and plugins',
    body: 'Choose what powers your work. Pair a Station to customize its agents and tools.',
  },
} as const;

type UnpairedSampleSurfaceId = keyof typeof UNPAIRED_SAMPLE_SURFACES;

export function sampleSurfaceForAnchor(anchor: string) {
  if (Object.hasOwn(UNPAIRED_SAMPLE_SURFACES, anchor)) {
    return UNPAIRED_SAMPLE_SURFACES[anchor as UnpairedSampleSurfaceId];
  }
  return null;
}
