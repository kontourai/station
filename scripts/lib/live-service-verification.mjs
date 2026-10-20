import { readFileSync } from 'node:fs';

export class LiveServiceVerificationError extends Error {}

export function assertVerificationHost(command) {
  if (process.platform !== 'linux') return;
  let membership;
  try {
    membership = readFileSync('/proc/self/cgroup', 'utf8');
  } catch (error) {
    throw new LiveServiceVerificationError(
      `${command} cannot verify Linux cgroup membership: ${error.message}`,
      { cause: error },
    );
  }
  const unit = membership.match(
    /\/(station-[a-zA-Z0-9_.@-]+\.service)(?:\/|$)/mu,
  )?.[1];
  if (!unit) return;
  throw new LiveServiceVerificationError(
    `${command} cannot run inside live Station service ${unit}: memory-heavy verification shares its OOM failure domain. Run this command from an external shell or use hosted CI. Focused tests and individual typecheck lanes remain available in Station.`,
  );
}
