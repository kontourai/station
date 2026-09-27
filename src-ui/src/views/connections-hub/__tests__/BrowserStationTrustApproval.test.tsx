/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  approve: vi.fn(),
  revoke: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@kontourai/station-connect/connection-trust', () => ({
  openDeviceConnectionTrustStore: async () => ({
    read: mocks.read,
    approve: mocks.approve,
    revoke: mocks.revoke,
    close: mocks.close,
  }),
  stationRelayRouteTrustStatus: (
    record: { trust: { enrollmentId: string } } | null,
    candidate: { enrollmentId: string },
  ) =>
    !record
      ? 'untrusted'
      : record.trust.enrollmentId === candidate.enrollmentId
        ? 'approved'
        : 'mismatch',
}));

vi.mock('@kontourai/station-shared/connection-proof', () => ({
  copyStationConnectionTrust: (value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('invalid');
    return value;
  },
  stationConnectionSigningKeyId: async (trust: { signingKey: { x: string } }) =>
    trust.signingKey.x,
  stationConnectionKeyConfirmationCode: async () => '0123456789ABCDEF',
  formatStationConnectionKeyConfirmationCode: (code: string) =>
    `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`,
}));

import { BrowserStationTrustApproval } from '../BrowserStationTrustApproval';

const STATION_ID = '11111111-1111-4111-8111-111111111111';
const ENROLLMENT_ID = '22222222-2222-4222-8222-222222222222';
const KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function trust(generation = 1, enrollmentId = ENROLLMENT_ID, keyId = KEY_ID) {
  return {
    stationId: STATION_ID,
    enrollmentId,
    generation,
    signingKey: { kty: 'EC', crv: 'P-256', x: keyId, y: 'Y'.repeat(43) },
  };
}

function report(
  generation = 1,
  enrollmentId = ENROLLMENT_ID,
  publicKeyId = KEY_ID,
  claimedKeyId = publicKeyId,
) {
  const descriptor = trust(generation, enrollmentId, publicKeyId);
  return JSON.stringify({
    schema: 'station.connection-key/v1',
    operation: 'inspect',
    status: 'present',
    trust: descriptor,
    keyId: claimedKeyId,
  });
}

function enterReport(value: string) {
  fireEvent.change(screen.getByLabelText('Operator Station key report'), {
    target: { value },
  });
}

function confirmComparison() {
  fireEvent.click(
    screen.getByLabelText(
      /I compared the confirmation code and full key ID with the Station operator/,
    ),
  );
}

describe('browser Station signing-key approval', () => {
  beforeEach(() => {
    mocks.current = null;
    mocks.read.mockReset().mockImplementation(async () => mocks.current);
    mocks.approve
      .mockReset()
      .mockImplementation(async (candidate, revision) => {
        mocks.current = {
          schemaVersion: 1,
          revision: (revision ?? 0) + 1,
          status: 'approved',
          trust: candidate,
        };
        return mocks.current;
      });
    mocks.revoke.mockReset().mockImplementation(async () => {
      mocks.current = { ...mocks.current, revision: 2, status: 'revoked' };
      return mocks.current;
    });
    mocks.close.mockReset();
  });

  it('requires explicit separate-channel confirmation and stores only the supplied public trust', async () => {
    render(<BrowserStationTrustApproval />);
    enterReport(report());

    expect(await screen.findByText(KEY_ID)).toBeTruthy();
    expect(await screen.findByText('0123-4567-89AB-CDEF')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve Station key' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.approve).not.toHaveBeenCalled();

    confirmComparison();
    fireEvent.click(approve);
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledOnce());
    expect(mocks.approve).toHaveBeenCalledWith(trust(), null, KEY_ID);
    expect(await screen.findByText(/approved on this browser/)).toBeTruthy();
  });

  it('rejects a report whose claimed thumbprint differs from its public key', async () => {
    render(<BrowserStationTrustApproval />);
    enterReport(
      report(
        1,
        ENROLLMENT_ID,
        KEY_ID,
        'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      ),
    );

    expect(
      await screen.findByText(
        'The Station key ID does not match its public key.',
      ),
    ).toBeTruthy();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it('requires higher generation and the current revision for key rotation', async () => {
    mocks.current = {
      schemaVersion: 1,
      revision: 7,
      status: 'approved',
      trust: trust(
        1,
        ENROLLMENT_ID,
        'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      ),
    };
    render(<BrowserStationTrustApproval />);
    enterReport(report(2));
    expect(
      await screen.findByText('A newer Station key needs approval'),
    ).toBeTruthy();
    confirmComparison();
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve Station key' }),
    );

    await waitFor(() => expect(mocks.approve).toHaveBeenCalledOnce());
    expect(mocks.approve).toHaveBeenCalledWith(trust(2), 7, KEY_ID);
  });

  it('refuses approval if another tab revoked the key after the user reviewed it', async () => {
    mocks.current = {
      schemaVersion: 1,
      revision: 7,
      status: 'approved',
      trust: trust(
        1,
        ENROLLMENT_ID,
        'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      ),
    };
    render(<BrowserStationTrustApproval />);
    enterReport(report(2));
    expect(
      await screen.findByText('A newer Station key needs approval'),
    ).toBeTruthy();
    confirmComparison();
    mocks.current = { ...mocks.current, revision: 8, status: 'revoked' };
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve Station key' }),
    );
    expect(
      await screen.findByText(
        /Station trust changed while you were reviewing it/,
      ),
    ).toBeTruthy();
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(
      (
        screen.getByLabelText(
          /I compared the confirmation code and full key ID with the Station operator/,
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it('does not restore revoked trust with the same generation and revokes with the observed revision', async () => {
    mocks.current = {
      schemaVersion: 1,
      revision: 4,
      status: 'revoked',
      trust: trust(),
    };
    const view = render(<BrowserStationTrustApproval />);
    enterReport(report());
    expect(
      await screen.findByText(
        /cannot be restored at the same or an older generation/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Approve Station key' }),
    ).toBeNull();
    expect(mocks.approve).not.toHaveBeenCalled();

    view.unmount();
    mocks.current = {
      schemaVersion: 1,
      revision: 4,
      status: 'revoked',
      trust: trust(
        1,
        ENROLLMENT_ID,
        'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      ),
    };
    const restored = render(<BrowserStationTrustApproval />);
    enterReport(report(2));
    expect(await screen.findByText(/newer key can restore trust/)).toBeTruthy();
    confirmComparison();
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve Station key' }),
    );
    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith(trust(2), 4, KEY_ID),
    );

    restored.unmount();
    mocks.current = {
      schemaVersion: 1,
      revision: 4,
      status: 'approved',
      trust: trust(),
    };
    render(<BrowserStationTrustApproval />);
    enterReport(report());
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Revoke stored Station trust',
      }),
    );
    await waitFor(() =>
      expect(mocks.revoke).toHaveBeenCalledWith(STATION_ID, 4),
    );
  });

  it('refuses a changed enrollment rather than resetting existing Station trust', async () => {
    mocks.current = {
      schemaVersion: 1,
      revision: 3,
      status: 'approved',
      trust: trust(1, '33333333-3333-4333-8333-333333333333'),
    };
    render(<BrowserStationTrustApproval />);
    enterReport(report());

    expect(await screen.findByText('Station enrollment mismatch')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Approve Station key' }),
    ).toBeNull();
    expect(mocks.approve).not.toHaveBeenCalled();
  });
});
