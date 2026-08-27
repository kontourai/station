/**
 * The Computers row model — the claim each row makes, one phase at a time.
 *
 * Registered in `scripts/claim-fixture-ratchet.mjs`: every member of the two
 * phase switches must be exercised here, because the defect class this guards
 * (station#1166) was a capability sentence rendered for phases that could not
 * support it — "can run delegated tasks here" printed beside "not connected".
 */

import type {
  SshEnvironmentState,
  SshEnvironmentView,
} from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import {
  buildComputerRows,
  computerKind,
  isSshBusy,
  knownEnvironmentRelationship,
  knownEnvironmentState,
  sshComputerState,
  sshRelationship,
} from '../views/connections-hub/computer-rows';

const PHASES: SshEnvironmentState[] = [
  { phase: 'idle' },
  { phase: 'starting', attempt: 2 },
  { phase: 'verifying' },
  { phase: 'launching' },
  { phase: 'prompt', prompt: 'passphrase' },
  { phase: 'host-key', reason: 'confirmation-required' },
  { phase: 'host-key', reason: 'changed' },
  { phase: 'agent', reason: 'unavailable' },
  { phase: 'agent', reason: 'rejected' },
  { phase: 'error', reason: 'station-unavailable', action: 'Do the thing.' },
  { phase: 'disconnected', reason: 'stopped' },
  { phase: 'disconnected', reason: 'transport-error' },
  {
    phase: 'connected',
    localUrl: 'http://127.0.0.1:41200',
    instanceId: 'i',
    sha: 's',
    bootId: 'b',
    connectedAt: '2026-01-01T00:05:00.000Z',
  },
];

describe('sshComputerState', () => {
  test.each(PHASES)(
    '$phase has a label and never a bare state word',
    (state) => {
      const view = sshComputerState(state);
      expect(view.label.length).toBeGreaterThan(0);
      expect(['ready', 'warn', 'error', 'disabled']).toContain(view.tone);
    },
  );

  test('only a connected computer reads ready', () => {
    for (const state of PHASES) {
      expect(sshComputerState(state).tone === 'ready').toBe(
        state.phase === 'connected',
      );
    }
  });

  test("the error phase carries the server's own action string", () => {
    expect(
      sshComputerState({
        phase: 'error',
        reason: 'station-unavailable',
        action: 'Connection refused on port 22 — is sshd running on box-b?',
      }).detail,
    ).toBe('Connection refused on port 22 — is sshd running on box-b?');
  });

  test('a changed host key is not described the same way as an unconfirmed one', () => {
    expect(
      sshComputerState({ phase: 'host-key', reason: 'changed' }).detail,
    ).toContain('changed');
    expect(
      sshComputerState({ phase: 'host-key', reason: 'confirmation-required' })
        .detail,
    ).toContain('Confirm this host');
  });

  test('an unavailable agent and a rejected key get different next steps', () => {
    expect(
      sshComputerState({ phase: 'agent', reason: 'unavailable' }).detail,
    ).toContain('Start your SSH agent');
    expect(
      sshComputerState({ phase: 'agent', reason: 'rejected' }).detail,
    ).toContain('rejected this key');
  });

  test('a stopped computer is not described as an interrupted one', () => {
    expect(
      sshComputerState({ phase: 'disconnected', reason: 'stopped' }).label,
    ).toBe('Stopped');
    expect(
      sshComputerState({ phase: 'disconnected', reason: 'transport-error' })
        .detail,
    ).toContain('interrupted');
  });
});

describe('sshRelationship', () => {
  test.each(PHASES)(
    '$phase claims present-tense delegation only when connected',
    (state) => {
      const line = sshRelationship(state, 'Box B');
      expect(line).toContain('Box B');
      expect(line.includes('This Station can run delegated tasks here')).toBe(
        state.phase === 'connected',
      );
    },
  );

  test('a prompt/host-key/agent phase points at the detail rather than claiming capability', () => {
    for (const state of PHASES.filter((candidate) =>
      ['prompt', 'host-key', 'agent'].includes(candidate.phase),
    )) {
      expect(sshRelationship(state, 'Box B')).toContain('Needs attention');
    }
  });

  test('the in-flight phases say the capability is not there yet', () => {
    for (const state of PHASES.filter((candidate) =>
      ['starting', 'verifying', 'launching'].includes(candidate.phase),
    )) {
      expect(sshRelationship(state, 'Box B')).toContain('Connecting');
    }
  });

  test('an idle computer is configured, not connected', () => {
    expect(sshRelationship({ phase: 'idle' }, 'Box B')).toContain(
      'Configured for delegation',
    );
  });

  test('an errored or disconnected computer says so first', () => {
    expect(
      sshRelationship(
        { phase: 'error', reason: 'station-unavailable', action: 'x' },
        'Box B',
      ),
    ).toContain('Not connected');
    expect(
      sshRelationship({ phase: 'disconnected', reason: 'stopped' }, 'Box B'),
    ).toContain('Not connected');
  });
});

describe('isSshBusy', () => {
  test('only the in-flight phases are busy', () => {
    for (const state of PHASES) {
      expect(isSshBusy(state)).toBe(
        ['starting', 'verifying', 'launching'].includes(state.phase),
      );
    }
  });
});

const environment = (
  overrides: Partial<{
    id: string;
    label: string;
    source: 'paired' | 'manual' | 'discovered' | 'ssh';
    endpoints: Array<{
      id: string;
      httpBaseUrl: string;
      kind: string;
      preferred: boolean;
      addedAt: number;
    }>;
    environmentId: string;
  }> = {},
): any => ({
  schemaVersion: 1,
  id: 'paired:conn-1',
  label: 'Box B',
  source: 'paired',
  endpoints: [],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe('computerKind', () => {
  test('names the mechanism, from the id or the source', () => {
    expect(computerKind(environment())).toBe('Paired device');
    expect(
      computerKind(environment({ source: 'manual', id: 'manual-1' })),
    ).toBe('Station');
    expect(
      computerKind(environment({ source: 'discovered', id: 'discovered-1' })),
    ).toBe('Station');
    expect(
      computerKind(environment({ source: 'ssh', id: 'ssh-environment:a' })),
    ).toBe('SSH');
  });
});

describe('knownEnvironmentState / knownEnvironmentRelationship', () => {
  test('a paired device is authorized or not, and never evidenced-live', () => {
    expect(knownEnvironmentState(environment(), true)).toEqual({
      label: 'Authorized',
      tone: 'disabled',
    });
    expect(knownEnvironmentState(environment(), false)).toEqual({
      label: 'Not authorized',
      tone: 'warn',
    });
  });

  test('an unauthorized paired device is never claimed as controllable', () => {
    expect(knownEnvironmentRelationship(environment(), false)).toContain(
      'authorize it',
    );
    expect(knownEnvironmentRelationship(environment(), true)).toContain(
      'you can control it directly',
    );
  });

  test('a manual entry claims nothing until it has been reached', () => {
    const manual = environment({ source: 'manual', id: 'manual-1' });
    expect(knownEnvironmentState(manual, false).label).toBe('Not verified');
    expect(knownEnvironmentRelationship(manual, false)).toContain(
      'no confirmed way to reach it yet',
    );
  });
});

describe('buildComputerRows', () => {
  const sshEnvironments: SshEnvironmentView[] = [
    {
      profile: {
        schemaVersion: 1,
        id: 'ssh-1',
        name: 'Media Server',
        hostAlias: 'media-server',
        remoteProjectPath: '/home/dev/project',
        remotePort: 3141,
        launchMode: 'attach',
        environmentId: null,
        hostIdentity: null,
        remoteHome: null,
        verifiedProjectPath: null,
        workerProtocolVersion: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastConnectedAt: null,
      },
      state: { phase: 'idle' },
    } as SshEnvironmentView,
  ];

  test('an SSH row carries the server phase, the host and the folder', () => {
    const [row] = buildComputerRows({
      environments: [
        environment({ source: 'ssh', id: 'ssh-environment:ssh-1' }),
      ],
      sshEnvironments,
      isPairedAuthorized: () => false,
      isManualEntry: () => false,
    });
    expect(row.kind).toBe('SSH');
    expect(row.name).toBe('Media Server');
    expect(row.detail).toBe('media-server · /home/dev/project');
    expect(row.state.label).toBe('Not connected');
    expect(row.sshEnvironmentId).toBe('ssh-1');
  });

  test('an endpoint this device cannot open is not offered', () => {
    const [row] = buildComputerRows({
      environments: [
        environment({
          endpoints: [
            {
              id: 'e1',
              httpBaseUrl: 'http://127.0.0.1:41200',
              kind: 'ssh-forward',
              preferred: true,
              addedAt: 0,
            },
          ],
        }),
      ],
      sshEnvironments: [],
      isPairedAuthorized: () => true,
      isManualEntry: () => false,
      hideEndpoint: (_url, kind) => kind === 'ssh-forward',
    });
    expect(row.detail).toBe('No live endpoint right now');
  });

  test('only a locally-registered manual entry is removable from this list', () => {
    const rows = buildComputerRows({
      environments: [
        environment(),
        environment({ source: 'manual', id: 'manual-1' }),
      ],
      sshEnvironments: [],
      isPairedAuthorized: () => true,
      isManualEntry: (candidate) => candidate.id === 'manual-1',
    });
    expect(rows[0].removableManualEntryId).toBeUndefined();
    expect(rows[1].removableManualEntryId).toBe('manual-1');
  });

  test('the same address folded twice is listed once', () => {
    const [row] = buildComputerRows({
      environments: [
        environment({
          endpoints: [
            {
              id: 'e1',
              httpBaseUrl: 'http://localhost:5681',
              kind: 'direct',
              preferred: false,
              addedAt: 0,
            },
            {
              id: 'e2',
              httpBaseUrl: 'http://localhost:5681',
              kind: 'direct',
              preferred: true,
              addedAt: 0,
            },
          ],
        }),
      ],
      sshEnvironments: [],
      isPairedAuthorized: () => true,
      isManualEntry: () => false,
    });
    expect(row.detail).toBe('http://localhost:5681');
  });
});
