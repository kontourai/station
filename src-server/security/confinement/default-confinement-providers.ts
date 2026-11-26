import { codexSandboxConfinementProvider } from '../../providers/adapters/codex-confinement.js';
import { bubblewrapConfinementProvider } from './bubblewrap.js';
import type { ConfinementProvider } from './confinement-provider.js';
import { seatbeltConfinementProvider } from './seatbelt.js';

/**
 * #2494, #4770: the providers a start on `platform` resolves its
 * confinement from, in order: Codex's own sandbox, then the one
 * Station-applied `os-profile` mechanism for Claude that can exist there
 * (bubblewrap on Linux; Seatbelt everywhere else, which reports itself
 * unavailable off macOS). One per platform, so the confinement preflight
 * (#4774) never reports a mechanism that cannot exist on the host beside the
 * one a start would use, and a refusal names the mechanism that host lacks.
 */
export function defaultConfinementProviders(
  platform: NodeJS.Platform,
): readonly ConfinementProvider[] {
  return [
    codexSandboxConfinementProvider,
    platform === 'linux'
      ? bubblewrapConfinementProvider
      : seatbeltConfinementProvider,
  ];
}

/**
 * The providers a start resolves its confinement from, unless a test
 * injects its own. The confinement preflight (#4774) reads the same list,
 * so it reports the providers a start would consult.
 */
export const DEFAULT_CONFINEMENT_PROVIDERS: readonly ConfinementProvider[] =
  defaultConfinementProviders(process.platform);
