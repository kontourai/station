import type { HumanController } from '../live-surface/control-lease.js';
import {
  claimHumanControl,
  type LiveSurfaceEntry,
} from '../live-surface/registry.js';
import { BrowserSessionError } from './browser-session-registry.js';

/** Claim and fence a human chrome action on the same surface as page input. */
export async function withBrowserHumanControl<T>(
  options: {
    entry: LiveSurfaceEntry;
    human: HumanController;
    request: Request;
    current: () => boolean;
  },
  operation: (guard: () => void) => Promise<T>,
): Promise<T> {
  const { entry, human, request, current } = options;
  for (const action of ['input', 'control'] as const) {
    const decision = await entry.decide(human.principal, action, { request });
    if (decision === 'busy')
      throw new BrowserSessionError(
        'surface-busy',
        'The browser surface is busy.',
      );
    if (decision !== 'allow')
      throw new BrowserSessionError(
        'control-refused',
        'Browser control is unavailable.',
      );
  }
  if (!current())
    throw new BrowserSessionError(
      'control-interrupted',
      'Browser access changed.',
    );
  const claim = claimHumanControl(entry, human);
  if (!claim.ok)
    throw new BrowserSessionError(
      'control-refused',
      'Browser control is unavailable.',
    );
  const guard = () => {
    if (!current() || !entry.lease.isCurrent(claim.lease.fence, human).ok)
      throw new BrowserSessionError(
        'control-interrupted',
        'Browser control changed.',
      );
  };
  guard();
  const result = await operation(guard);
  guard();
  return result;
}
