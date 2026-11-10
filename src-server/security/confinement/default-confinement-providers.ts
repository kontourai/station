import { codexSandboxConfinementProvider } from '../../providers/adapters/codex-confinement.js';
import type { ConfinementProvider } from './confinement-provider.js';
import { seatbeltConfinementProvider } from './seatbelt.js';

/**
 * #2494: the providers a start resolves its confinement from, in order,
 * unless a test injects its own. The confinement preflight (#4774) reads the
 * same list, so it reports the providers a start would consult.
 */
export const DEFAULT_CONFINEMENT_PROVIDERS: readonly ConfinementProvider[] = [
  codexSandboxConfinementProvider,
  seatbeltConfinementProvider,
];
