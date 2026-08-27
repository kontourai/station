/**
 * The ONE map of host-naming copy (station#3843 §2).
 *
 * A paired device is a remote control for the host, not a second host.
 * Every affordance that executes on the host's machine therefore says two
 * different things depending on who is reading it — and before this, each
 * surface would have grown its own `deviceClass === 'paired' ? … : …`
 * ternary, which is how four screens end up describing the same machine
 * four ways.
 *
 * So the strings live here, both branches side by side, and every surface
 * calls {@link hostActionCopy}. Nothing composes a sentence about the host
 * anywhere else; `src-ui/src/components/host-action/__tests__` asserts that
 * the surfaces render exactly what this map produces, which is what makes
 * "single-sourced" a checkable claim rather than a convention.
 *
 * WHAT `reach` IS. Not decoration: it is the fact that decides which of
 * {@link HostAction}'s three branches a paired device gets.
 *  - `remote-safe` — the host performs it, the device only asks. The
 *    affordance renders unchanged and the host is named beside it.
 *  - `host-hands` — it needs a shell run there, a file placed there, a
 *    binary installed there. The affordance is replaced by the instruction,
 *    with the host named and (where there is one) the exact command to copy.
 *    Never a disabled button, never silently hidden.
 */

import type { DevicePresentation } from '@kontourai/station-contracts/system-status';

export type HostActionReach = 'remote-safe' | 'host-hands';

export type HostActionId =
  /** #3843 T1 — the SSH creator's trust command (#3733's creator). */
  | 'ssh-trust-command'
  /** #3843 T2 — the first-run engines chapter's scan lede. */
  | 'engine-scan'
  /** #3843 T2 — the first-run engines chapter's still-scanning line. */
  | 'engine-scan-pending'
  /** #3843 T2 — an engine the scan did not find. */
  | 'engine-missing'
  /** #3843 T2 — the Agents row's one fixing verb, accessibly named. */
  | 'agent-engine-setup'
  /** #3843 T3 — the Developer surface's redacted log read. */
  | 'developer-logs';

export interface HostActionCopyEntry {
  reach: HostActionReach;
  /** What the person sitting at the host machine reads. */
  host: string;
  /** What a paired device reads. `hostName` is the host machine's own name. */
  paired: (hostName: string) => string;
}

export const HOST_ACTION_COPY: Record<HostActionId, HostActionCopyEntry> = {
  'ssh-trust-command': {
    // It appends a line to a known_hosts file on the machine `ssh` will run
    // from. Nothing a browser can do reaches that file.
    reach: 'host-hands',
    host: 'Copy command',
    paired: (hostName) =>
      `Run this on ${hostName}. It records the key in that computer's known_hosts file, so it only takes effect there.`,
  },
  'engine-scan': {
    reach: 'host-hands',
    host: 'Station found these on this machine. Pick the ones you use and Station sets up an agent for each — you can change them later.',
    paired: (hostName) =>
      `Station found these on ${hostName}, the computer it runs on. Pick the ones you use and Station sets up an agent for each — you can change them later.`,
  },
  'engine-scan-pending': {
    reach: 'host-hands',
    host: 'Looking for agent CLIs on this machine…',
    paired: (hostName) => `Looking for agent CLIs on ${hostName}…`,
  },
  'engine-missing': {
    // Deliberately still claims nothing about installation — `notReadyNote`'s
    // restraint (`reason` is orthogonal to `detected`) survives the rewrite.
    // Naming where it would have to be installed is an instruction, not an
    // observation.
    reach: 'host-hands',
    host: 'Not found on this machine.',
    paired: (hostName) =>
      `Not found on ${hostName}. Agent CLIs run on that computer, so it has to be installed there.`,
  },
  'agent-engine-setup': {
    // Setting up an engine sends you to Connections, which a paired device
    // can browse perfectly well — so the verb stays, and stays the ONLY verb
    // on the row (`tests/agents-readiness-board.spec.ts`'s one-verb
    // contract). All that changes is which machine the row's accessible name
    // says the engine would be set up on. A TRAILING CLAUSE rather than a
    // whole label, because the label is composed from the server's verb and
    // the agent's own name; the host is the third thing, not a replacement
    // for either.
    reach: 'remote-safe',
    host: '',
    paired: (hostName) => `on ${hostName}`,
  },
  'developer-logs': {
    // The read itself works from anywhere; D6 redacts it for a principal
    // that did not prove home possession. Saying so is the whole point —
    // a silently degraded page reads as a broken one.
    reach: 'remote-safe',
    host: '',
    paired: (hostName) =>
      `Full logs are available on ${hostName}. This device is shown the redacted read.`,
  },
};

/**
 * The copy for `id` as the CURRENT device should read it.
 *
 * `presentation` is `undefined` while the server has not answered. That is
 * not a device class and must not be guessed at: the host branch is
 * returned, because it is the wording that makes no claim about a second
 * machine.
 */
export function hostActionCopy(
  id: HostActionId,
  presentation: DevicePresentation | undefined,
): string {
  const entry = HOST_ACTION_COPY[id];
  return presentation?.deviceClass === 'paired'
    ? entry.paired(presentation.hostName)
    : entry.host;
}

/** Whether this affordance needs hands on the host's machine. */
export function hostActionReach(id: HostActionId): HostActionReach {
  return HOST_ACTION_COPY[id].reach;
}
