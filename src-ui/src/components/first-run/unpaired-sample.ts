/**
 * Fixture copy for the unpaired first-run sample (archive#2652 / #1772).
 *
 * This is a labeled sample so the receipts tour has something true to point
 * at when no Station host is paired. It is not a live run, and it must not
 * wear a derived verdict (verified / ready / pass) that nothing computed.
 */

export const UNPAIRED_SAMPLE_PROJECT = 'Getting started';

export const UNPAIRED_SAMPLE_SURFACES = {
  'review-queue': {
    title: 'Sample Task',
    eyebrow: 'Waiting for a decision',
    body: 'A weekly digest stopped here because someone still has to approve it. The decision, when it happens, stays with the run that asked for it.',
  },
  activity: {
    title: 'Sample session',
    eyebrow: 'One completed run',
    body: 'This session holds the events that produced its result, so an answer can be traced back to the work behind it.',
  },
  schedule: {
    title: 'Sample schedule',
    eyebrow: 'Every Monday at 9:00',
    body: 'A scheduled job produces the same kind of evidence as work you start yourself. Nobody is watching it — which is when a receipt matters.',
  },
  'command-palette': {
    title: 'Command palette',
    eyebrow: 'One keystroke',
    body: 'Everything in Station is reachable from here, including this tour. Pair a Station to use it on your own work.',
  },
} as const;

export type UnpairedSampleSurfaceId = keyof typeof UNPAIRED_SAMPLE_SURFACES;

export function sampleSurfaceForAnchor(anchor: string) {
  if (Object.hasOwn(UNPAIRED_SAMPLE_SURFACES, anchor)) {
    return UNPAIRED_SAMPLE_SURFACES[anchor as UnpairedSampleSurfaceId];
  }
  return null;
}
