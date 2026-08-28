/**
 * @vitest-environment jsdom
 *
 * D7 — the SSH computer creator (audit CI-R1 BLOCKER: nothing in the UI could
 * create an SSH environment, and CI-R14: a failure that named no cause and no
 * next step).
 */

import type { SshReachabilityEvidence } from '@kontourai/station-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  create: vi.fn(),
  devicePresentation: vi.fn(),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ apiBase: 'http://127.0.0.1:3141' }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useDevicePresentation: () => mocks.devicePresentation(),
  useOpenSshHostsQuery: () => ({
    data: {
      hosts: [
        {
          alias: 'media-server',
          hostname: 'media-server.local',
          user: 'dev',
          port: 22,
          identityAgent: 'default',
          proxyJump: null,
          strictHostKeyChecking: 'ask',
        },
      ],
      unavailableAliases: [],
    },
  }),
  useProbeSshEnvironmentMutation: () => ({
    isPending: false,
    mutateAsync: mocks.probe,
  }),
  useCreateSshEnvironmentMutation: () => ({
    isPending: false,
    mutateAsync: mocks.create,
  }),
}));

function reached(
  overrides: Partial<SshReachabilityEvidence> = {},
): SshReachabilityEvidence {
  return {
    evidenceVersion: 1,
    level: 'smoke-passed',
    freshness: 'fresh',
    observedAt: '2026-08-22T00:00:00.000Z',
    reachable: true,
    summary:
      'Signed in to dev@media-server.local on port 22 and ran a command there · Node v24.19.0.',
    resolved: {
      hostname: 'media-server.local',
      user: 'dev',
      port: 22,
      identityAgent: 'default',
    },
    ...overrides,
  };
}

/**
 * What the server composes for an unknown host: it appends the EXACT key line
 * whose fingerprint the dialog displays, and re-scans nothing.
 * The dialog must hand this over verbatim.
 */
const TRUST_COMMAND = `printf '%s\\n' '192.168.1.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=' >> "$HOME/.ssh/known_hosts"`;

import { SshComputerCreatorDialog } from '../views/connections-hub/SshComputerCreatorDialog';

describe('SshComputerCreatorDialog', () => {
  beforeEach(() => {
    mocks.probe.mockReset();
    mocks.create.mockReset().mockResolvedValue(undefined);
    // The default is the machine Station runs on; the paired cases below say
    // so explicitly.
    mocks.devicePresentation
      .mockReset()
      .mockReturnValue({ deviceClass: 'host', hostName: 'workshop' });
  });

  function unknownHostProbe() {
    return reached({
      level: 'discovered',
      reachable: false,
      summary: '192.168.1.20 has not been confirmed from this computer yet.',
      action: `Station does not accept new host keys. Verify this fingerprint with the computer's owner, then run: ${TRUST_COMMAND}, and test again.`,
      unknownHost: {
        fingerprint: 'SHA256:6dPBcHKtaMBrKUJvC/6DcGGVXCEQvSlPO9lVCJ6L1DE',
        keyType: 'ssh-ed25519',
        knownHostsLine:
          '192.168.1.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=',
        trustCommand: TRUST_COMMAND,
      },
      failure: {
        code: 'host-key',
        detail: 'Host key verification failed.',
      },
    });
  }

  test('cannot be saved before a connection test has reached the computer', () => {
    render(<SshComputerCreatorDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: 'media-server' },
    });
    const save = screen.getByRole('button', { name: 'Save computer' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        /Test the connection before saving — Station only saves a computer it has reached\./,
      ),
    ).toBeTruthy();
  });

  test('a successful probe reports what the server observed, including the user and port it signed in as', async () => {
    mocks.probe.mockResolvedValue(reached());
    render(<SshComputerCreatorDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: 'media-server' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(screen.getByText('Reached')).toBeTruthy());
    expect(mocks.probe).toHaveBeenCalledWith('media-server');
    expect(
      screen.getByText(
        'Signed in to dev@media-server.local on port 22 and ran a command there · Node v24.19.0.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Signing in as dev on port 22 · key from your SSH agent',
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'Save computer',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test('a failed probe names the cause and the next step, as an alert (CI-R14)', async () => {
    mocks.probe.mockResolvedValue(
      reached({
        level: 'discovered',
        reachable: false,
        summary:
          'Connection refused on port 22 — is sshd running on 127.0.0.2?',
        action:
          'Start the SSH server on 127.0.0.2 (macOS: System Settings → General → Sharing → Remote Login; Linux: `sudo systemctl start sshd`), then test again.',
        failure: { code: 'connection-refused', detail: 'ssh: connect to host' },
      }),
    );
    render(<SshComputerCreatorDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: '127.0.0.2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Connection refused on port 22 — is sshd running on 127.0.0.2?',
    );
    expect(alert.textContent).toContain('Start the SSH server on 127.0.0.2');
    expect(
      (
        screen.getByRole('button', {
          name: 'Save computer',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('saving sends the host, folder and optional port, and closes', async () => {
    mocks.probe.mockResolvedValue(reached());
    const onClose = vi.fn();
    render(<SshComputerCreatorDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: 'media-server' },
    });
    fireEvent.change(screen.getByLabelText(/Project folder/), {
      target: { value: '/home/dev/project' },
    });
    fireEvent.change(screen.getByLabelText(/Station port/), {
      target: { value: '3141' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText('Reached')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save computer' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        hostAlias: 'media-server',
        remoteProjectPath: '/home/dev/project',
        remotePort: 3141,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("an unknown host shows the scanned fingerprint and copies the server's own trust command, and Save stays disabled", async () => {
    const clipboard = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText: clipboard } });
    mocks.probe.mockResolvedValue(
      reached({
        level: 'discovered',
        reachable: false,
        summary: '192.168.1.20 has not been confirmed from this computer yet.',
        action: `Station does not accept new host keys. Verify this fingerprint with the computer's owner, then run: ${TRUST_COMMAND}, and test again.`,
        unknownHost: {
          fingerprint: 'SHA256:6dPBcHKtaMBrKUJvC/6DcGGVXCEQvSlPO9lVCJ6L1DE',
          keyType: 'ssh-ed25519',
          knownHostsLine:
            '192.168.1.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZha2U=',
          trustCommand: TRUST_COMMAND,
        },
        failure: {
          code: 'host-key',
          detail: 'Host key verification failed.',
        },
      }),
    );
    render(<SshComputerCreatorDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: '192.168.1.20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Station does not accept new host keys.',
    );
    expect(
      screen.getByText(
        'ssh-ed25519 SHA256:6dPBcHKtaMBrKUJvC/6DcGGVXCEQvSlPO9lVCJ6L1DE',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(TRUST_COMMAND));

    expect(
      (
        screen.getByRole('button', {
          name: 'Save computer',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  /**
   * archive#3843 — the trust command is host-hands: it appends a line to a
   * known_hosts file on the machine `ssh` will run from, so a paired device
   * cannot execute it and must not present it as though it could. The
   * fingerprint is the opposite — verifying it is a conversation with the
   * computer's owner, which works from anywhere — so it stays visible in both.
   */
  test('on a paired device the trust command becomes guidance naming the host, with the fingerprint still visible', async () => {
    mocks.devicePresentation.mockReturnValue({
      deviceClass: 'paired',
      hostName: 'workshop',
    });
    mocks.probe.mockResolvedValue(unknownHostProbe());
    render(<SshComputerCreatorDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: '192.168.1.20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await screen.findByRole('alert');
    expect(
      screen.getByText(
        "Run this on workshop. It records the key in that computer's known_hosts file, so it only takes effect there.",
      ),
    ).toBeTruthy();
    // The exact bytes, readable and copyable rather than buried in prose.
    expect(screen.getByText(TRUST_COMMAND)).toBeTruthy();
    // Never a disabled button, never silently hidden.
    const copy = screen.getByRole('button', {
      name: 'Copy command',
    }) as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    // The fingerprint is the part a person can verify from anywhere.
    expect(
      screen.getByText(
        'ssh-ed25519 SHA256:6dPBcHKtaMBrKUJvC/6DcGGVXCEQvSlPO9lVCJ6L1DE',
      ),
    ).toBeTruthy();
  });

  test('on the host the trust command keeps its plain Copy affordance and names no second machine', async () => {
    mocks.probe.mockResolvedValue(unknownHostProbe());
    render(<SshComputerCreatorDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: '192.168.1.20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
    expect(screen.queryByText(/Run this on workshop/)).toBeNull();
    expect(document.querySelector('.host-action')).toBeNull();
  });

  // The client-side rejection of an unprobed save IS the native `disabled`
  // attribute (React blocks the handler on a disabled button's fiber props,
  // so there is no second in-handler path a test could drive — a guard there
  // would be a rejection branch that never executes). This pins it in every
  // not-reached state, so no state can quietly re-enable Save. There is no
  // server-side probe requirement on `POST /api/environments/ssh`: it stores
  // a profile, and reaching the host is gated by the host key, not by this.
  test.each([
    ['never probed', null],
    ['a failed probe', { reachable: false as const }],
  ])('Save is disabled after %s', async (_label, probeResult) => {
    if (probeResult)
      mocks.probe.mockResolvedValue(
        reached({
          ...probeResult,
          level: 'discovered',
          summary: 'Station could not reach box-b over SSH.',
        }),
      );
    render(<SshComputerCreatorDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: 'box-b' },
    });
    if (probeResult) {
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => expect(screen.getByText('Not reached')).toBeTruthy());
    }

    expect(
      (
        screen.getByRole('button', {
          name: 'Save computer',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  test('editing the host retires the previous probe, so Save cannot ride another computer receipt', async () => {
    mocks.probe.mockResolvedValue(reached());
    render(<SshComputerCreatorDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: 'media-server' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText('Reached')).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/Computer/), {
      target: { value: 'other-box' },
    });
    expect(
      (
        screen.getByRole('button', {
          name: 'Save computer',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByText('Reached')).toBeNull();
  });
});
