/**
 * Cycling phrases for full-screen loading and error states.
 *
 * Edit these arrays to change what users see while waiting.
 * Phrases are shuffled on each mount so order doesn't matter.
 */

/** Fun phrases shown as the primary loading message. */
export const loadingPhrases = [
  'Warming up the engines...',
  'Reticulating splines...',
  'Consulting the oracle...',
  'Aligning the flux capacitors...',
  'Counting backwards from infinity...',
  'Convincing electrons to cooperate...',
  'Calibrating the vibes...',
  'Herding photons...',
  'Negotiating with the cloud...',
  'Polishing the pixels...',
  'Waking up the hamsters...',
  'Charging the lasers...',
  'Shuffling the deck...',
  'Teaching AI to be patient...',
  'Untangling the internet...',
  'Asking the servers nicely...',
  'Spinning up the turbo encabulator...',
  'Compiling the good vibes...',
];

/** Tips and fun facts shown below the primary message. */
export const loadingTips = [
  'tip: you can use / commands in chat for quick actions',
  'tip: layouts can have multiple tabs with different tools',
  'tip: agents can be customized per layout',
  'tip: keyboard shortcuts make everything faster',
  'tip: plugins extend your layout with new capabilities',
  'tip: chat sessions persist across page reloads',
  'tip: you can connect multiple AI backends at once',
  'fun fact: the first AI program was written in 1951',
  'fun fact: "debugging" came from an actual moth in a computer',
  "fun fact: the cloud is just someone else's computer",
];

/**
 * Friendly quips shown on error screens. Keep these mood-only: an error
 * screen cannot know whether data is intact, so no entry may make a factual
 * claim about the user's data or the failure (#1571).
 */
export const errorQuips = [
  'even the best connections need a second chance',
  'the bits got lost, but we know the way back',
  'a brief intermission in our regularly scheduled program',
  'plot twist: the server took a coffee break',
  'sometimes the internet needs a moment',
];
