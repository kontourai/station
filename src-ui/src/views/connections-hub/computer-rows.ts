/**
 * The Computers section's row model — one derivation, shared by every kind of
* computer the section lists (lane design §4).
 *
 * Before this, three differently-shaped lists sat within 300px of each other:
 * paired saved connections and manual Station entries as `connections-page__card`
 * articles, SSH environments as their own cards with a different status
 * grammar, and outbound peer credentials as a third empty-state style. A user
 * had no way to tell what a "computer", a "Station" and a "Remote work"
 * machine were, because the shapes implied three different kinds of thing.
 *
 * Everything here is pure so the mapping — especially "which state word does
 * this row get" — is testable without a DOM, and so the section can never
 * quietly grow a second copy of it.
 */

import { mergeKnownEnvironments } from '@kontourai/station-connect/known-environment';
import type { KnownEnvironment } from '@kontourai/station-contracts';
import type {
  SshEnvironmentState,
  SshEnvironmentView,
} from '@kontourai/station-sdk';

/** What kind of relationship this Station has with the computer in the row. */
export type ComputerKind = 'Paired device' | 'Station' | 'SSH';

export type ComputerStateTone = 'ready' | 'warn' | 'error' | 'disabled';

export interface ComputerState {
  label: string;
  tone: ComputerStateTone;
  detail?: string;
}

export interface ComputerRowModel {
  id: string;
  name: string;
  kind: ComputerKind;
/** Where it is: an endpoint, or the SSH host and the folder work runs in. */
  detail: string;
  state: ComputerState;
/** What this relationship does (or what is missing before it can). */
  relationship: string;
/** The SSH profile id, when this row is an SSH computer. */
  sshEnvironmentId?: string;
/** Locally-registered manual entries are the only removable rows here. */
  removableManualEntryId?: string;
}

export const SSH_ENVIRONMENT_ID_PREFIX = 'ssh-environment:';
const PAIRED_ID_PREFIX = 'paired:';

/**
 * Folds every source list together, manual entries first so a manual
 * label/id wins an identity merge. This is what makes the list one row per
 * COMPUTER rather than one row per record — and, since,
 * the only place that answers how many computers there are.
 */
export function foldKnownEnvironments(
  lists: readonly KnownEnvironment[][],
): KnownEnvironment[] {
  let result: KnownEnvironment[] = [];
  for (const list of lists) {
    for (const environment of list) {
      result = mergeKnownEnvironments(result, environment);
    }
  }
  return result;
}

/** Locally-registered entries: the only rows this client owns and can remove. */
export function isManualEntry(environment: KnownEnvironment): boolean {
  return (
    !environment.id.startsWith(PAIRED_ID_PREFIX) &&
    !environment.id.startsWith(SSH_ENVIRONMENT_ID_PREFIX)
  );
}

export function computerKind(environment: KnownEnvironment): ComputerKind {
  if (
    environment.source === 'ssh' ||
    environment.id.startsWith(SSH_ENVIRONMENT_ID_PREFIX)
  ) {
    return 'SSH';
  }
  return environment.source === 'paired' ? 'Paired device' : 'Station';
}

/**
 * The SSH connection phases, each with the state word the SERVER's phase
 * supports and the sentence that says what to do about it. Moved verbatim
 * from `SshEnvironmentsSection` so the merged list keeps the phase-specific
* copy archive#1116's review put there — is about the `error` phase
 * being the one that says nothing, which the section now supplements with
 * the server's own action string.
 */
export function sshComputerState(state: SshEnvironmentState): ComputerState {
  switch (state.phase) {
    case 'connected':
      return {
        label: 'Ready',
        tone: 'ready',
        detail: 'Verified and ready for delegated work.',
      };
    case 'starting':
      return {
        label: 'Connecting…',
        tone: 'warn',
        detail: `Starting SSH connection (attempt ${state.attempt}).`,
      };
    case 'verifying':
      return {
        label: 'Verifying…',
        tone: 'warn',
        detail: 'Checking Station, Node.js, and the project folder.',
      };
    case 'launching':
      return {
        label: 'Starting Station…',
        tone: 'warn',
        detail: 'Starting Station on the remote computer.',
      };
    case 'prompt':
      return {
        label: 'Needs attention',
        tone: 'warn',
        detail: `Complete the SSH ${state.prompt} prompt from an interactive terminal.`,
      };
    case 'host-key':
      return {
        label: 'Host key',
        tone: 'error',
        detail:
          state.reason === 'changed'
            ? 'The host key changed. Review it in a terminal before reconnecting.'
            : 'Confirm this host once from an interactive SSH terminal, then reconnect.',
      };
    case 'agent':
      return {
        label: 'SSH agent',
        tone: 'error',
        detail:
          state.reason === 'unavailable'
            ? 'Start your SSH agent and load the host key, then reconnect.'
            : 'The SSH agent rejected this key. Check the host configuration and retry.',
      };
    case 'error':
      return { label: 'Action needed', tone: 'error', detail: state.action };
    case 'disconnected':
      return {
        label: state.reason === 'stopped' ? 'Stopped' : 'Disconnected',
        tone: 'disabled',
        detail:
          state.reason === 'transport-error'
            ? 'The SSH connection was interrupted. Reconnect when the host is available.'
            : undefined,
      };
    case 'idle':
      return { label: 'Not connected', tone: 'disabled' };
  }
}

export function isSshBusy(state: SshEnvironmentState): boolean {
  return (
    state.phase === 'starting' ||
    state.phase === 'verifying' ||
    state.phase === 'launching'
  );
}

/** Phase-aware "what this unlocks" line (archive#1116 1). */
export function sshRelationship(
  state: SshEnvironmentState,
  machineName: string,
): string {
  switch (state.phase) {
    case 'connected':
      return `This Station can run delegated tasks here — work runs on ${machineName}, with its own agents and workspace.`;
    case 'starting':
    case 'verifying':
    case 'launching':
      return `Connecting — delegated tasks will run on ${machineName} once this is connected.`;
    case 'prompt':
    case 'host-key':
    case 'agent':
      return `Needs attention before delegated tasks can run on ${machineName} — see below.`;
    case 'error':
      return `Not connected — fix the issue below before delegating tasks to ${machineName}.`;
    case 'disconnected':
      return `Not connected — reconnect to run delegated tasks on ${machineName}.`;
    case 'idle':
      return `Configured for delegation — connect to start running tasks on ${machineName}.`;
  }
}

/**
 * State for a row this client only has a REACHABILITY record for. None of
 * these carry liveness evidence — a paired connection can be offline and a
 * manual entry may never have been reached — so none of them may read
 * `ready`, which on this page means "evidenced, currently reachable".
 */
export function knownEnvironmentState(
  environment: KnownEnvironment,
  pairedAuthorized: boolean,
): ComputerState {
  if (computerKind(environment) === 'Paired device') {
    return pairedAuthorized
      ? { label: 'Authorized', tone: 'disabled' }
      : { label: 'Not authorized', tone: 'warn' };
  }
  return { label: 'Not verified', tone: 'warn' };
}

export function knownEnvironmentRelationship(
  environment: KnownEnvironment,
  pairedAuthorized: boolean,
): string {
  if (computerKind(environment) === 'Paired device') {
    return pairedAuthorized
      ? 'You reach it from this device — you can control it directly.'
      : 'Saved on this device — authorize it to control it directly.';
  }
  return 'Not yet verified — no confirmed way to reach it yet.';
}

function endpointDetail(
  environment: KnownEnvironment,
  hideTunnelEndpoints: (endpointUrl: string, kind: string) => boolean,
): string {
  const visible = environment.endpoints.filter(
    (endpoint) => !hideTunnelEndpoints(endpoint.httpBaseUrl, endpoint.kind),
  );
  if (visible.length === 0) return 'No live endpoint right now';
// One line per ADDRESS, not per endpoint record: the fold can carry the
// same URL twice (a saved connection's own url and its preferred endpoint),
// and printing it twice reads as two computers to reach.
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const endpoint of visible) {
    if (seen.has(endpoint.httpBaseUrl)) continue;
    seen.add(endpoint.httpBaseUrl);
    addresses.push(
      `${endpoint.httpBaseUrl}${endpoint.preferred ? ' (preferred)' : ''}`,
    );
  }
  return addresses.join(' · ');
}

export interface ComputerRowInput {
/** Folded known environments (paired + manual + ssh-adapted). */
  environments: readonly KnownEnvironment[];
/** The server's SSH environments, keyed for the rows folded from them. */
  sshEnvironments: readonly SshEnvironmentView[];
  isPairedAuthorized: (environment: KnownEnvironment) => boolean;
/** True for an endpoint this device cannot actually open (SSH forwards on mobile). */
  hideEndpoint?: (endpointUrl: string, kind: string) => boolean;
/** Ids the local manual registry owns, and can therefore remove. */
  isManualEntry: (environment: KnownEnvironment) => boolean;
}

/**
 * One row per computer, whatever the mechanism. An SSH-backed row keeps the
 * server's phase state and its action; a paired/manual row states what this
 * client knows and claims nothing more.
 */
export function buildComputerRows(input: ComputerRowInput): ComputerRowModel[] {
  const hide = input.hideEndpoint ?? (() => false);
  const sshById = new Map(
    input.sshEnvironments.map((view) => [view.profile.id, view]),
  );
  return input.environments.map((environment) => {
    const kind = computerKind(environment);
    const sshId = environment.id.startsWith(SSH_ENVIRONMENT_ID_PREFIX)
      ? environment.id.slice(SSH_ENVIRONMENT_ID_PREFIX.length)
      : undefined;
    const ssh = sshId ? sshById.get(sshId) : undefined;
    if (ssh) {
      return {
        id: environment.id,
        name: ssh.profile.name,
        kind: 'SSH' as const,
        detail: `${ssh.profile.hostAlias} · ${ssh.profile.remoteProjectPath}`,
        state: sshComputerState(ssh.state),
        relationship: sshRelationship(ssh.state, ssh.profile.name),
        sshEnvironmentId: ssh.profile.id,
      };
    }
    const pairedAuthorized =
      kind === 'Paired device' ? input.isPairedAuthorized(environment) : false;
    return {
      id: environment.id,
      name: environment.label,
      kind,
      detail: endpointDetail(environment, hide),
      state: knownEnvironmentState(environment, pairedAuthorized),
      relationship: knownEnvironmentRelationship(environment, pairedAuthorized),
      ...(input.isManualEntry(environment)
        ? { removableManualEntryId: environment.id }
        : {}),
    };
  });
}

export function pairedConnectionIdFor(
  environment: KnownEnvironment,
): string | null {
  return environment.id.startsWith(PAIRED_ID_PREFIX)
    ? environment.id.slice(PAIRED_ID_PREFIX.length)
    : null;
}
