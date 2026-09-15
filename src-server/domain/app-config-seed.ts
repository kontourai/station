/**
 * The values `loadAppConfigFile` WRITES INTO `config/app.json` on the
 * operator's behalf when the file does not carry them.
 *
 * This is a leaf module on purpose. Two modules need these constants and
 * neither should have to import the other: `config-loader-app.ts` writes
 * them (and brings `node:fs`, the file-mutation lock and the AJV validator
 * with it), and `settings-registry-server.ts` compares against them to
 * decide whether a loaded value is a DECISION or the seed. Importing the
 * loader from the provenance builder would work today and would be a cycle
 * the first time the loader wants provenance.
 *
 * Why the comparison exists at all: the loader's seeding is invisible to
 * every later reader. `config/app.json` after a boot with no `systemPrompt`
 * is byte-identical to one where somebody typed the default prompt in, so
 * provenance reported `source: 'file'` for a value nobody chose — the
 * Settings badge read "Set in file", and "Reset Station settings" named the
 * prompt among the values it would clear, cleared it, and then saw it
 * re-seeded and named again on the next read. A reset that can never reach
 * "nothing is stored" is the label-versus-derivation defect in miniature.
 *
 * A value that is byte-equal to the seed is therefore reported as
 * `'default'`. That is lossy in exactly one direction: an operator who types
 * the factory prompt back in character-for-character is told it is the
 * default, which is true of the value even though it understates the
 * deliberateness. The opposite error — claiming a decision that was never
 * made — is the one worth avoiding.
 */

export const APP_CONFIG_SEED = {
  systemPrompt: [
    'You are {{AGENT_NAME}}, a helpful AI assistant.',
    '',
    'Be concise and direct. When you lack information, say so rather than guessing.',
    '',
    '## Environment',
    'Date: {{date}}',
    'Time: {{time}}',
  ].join('\n'),
  templateVariables: [
    { key: 'AGENT_NAME', type: 'static' as const, value: 'Station' },
  ],
  defaultModel: '',
  invokeModel: '',
  structureModel: '',
} as const;

/**
 * Keys whose loaded value the loader may have written itself, paired with
 * the seed to compare against. Read by `buildAppConfigProvenance`.
 */
export const SEEDED_APP_CONFIG_KEYS = [
  'systemPrompt',
  'templateVariables',
  'defaultModel',
  'invokeModel',
  'structureModel',
] as const satisfies readonly (keyof typeof APP_CONFIG_SEED)[];

/**
 * Whether `value` is byte-equal to what the loader seeds for `key`.
 *
 * Structural equality via JSON for `templateVariables`: the seed is a small
 * array of flat string records written by this repo, so key order is the
 * order the loader spread them in. An operator's list that merely CONTAINS
 * the seeded `AGENT_NAME` entry alongside their own is not equal and is
 * correctly reported as a decision — the loader appends rather than
 * replaces, so "seed plus their entries" is a file they shaped.
 */
export function isSeededAppConfigValue(
  key: (typeof SEEDED_APP_CONFIG_KEYS)[number],
  value: unknown,
): boolean {
  const seed = APP_CONFIG_SEED[key];
  if (typeof seed === 'string') return value === seed;
  return JSON.stringify(value) === JSON.stringify(seed);
}
