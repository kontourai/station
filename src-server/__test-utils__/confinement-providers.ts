import { codexSandboxConfinementProvider } from '../providers/adapters/codex-confinement.js';
import type { ConfinementProvider } from '../security/confinement/confinement-provider.js';
import { createSeatbeltConfinementProvider } from '../security/confinement/seatbelt.js';

/**
 * #2494: the production Seatbelt provider, reporting itself available on
 * any host. Orchestration suites that drive recording engines use it so a
 * workspace Claude start at full access resolves the same plan on Linux CI
 * as on macOS; the real profile's kernel behaviour is proven by
 * `seatbelt.process.test.ts`, and its availability rules by
 * `seatbelt.test.ts`.
 */
function availableSeatbeltProvider(): ConfinementProvider {
  return createSeatbeltConfinementProvider({
    platform: () => 'darwin',
    // Any executable stands in for `sandbox-exec`; nothing is spawned.
    sandboxExec: process.execPath,
    probe: () => ({ ok: true, reason: 'test stand-in' }),
  }) as ConfinementProvider;
}

/** Station's default providers, with Seatbelt available on any host. */
export function confinementProvidersForTests(): readonly ConfinementProvider[] {
  return [codexSandboxConfinementProvider, availableSeatbeltProvider()];
}
