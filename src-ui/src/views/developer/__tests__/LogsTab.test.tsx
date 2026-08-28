/**
 * @vitest-environment jsdom
 *
 * archive#3843 — the Developer log read on a paired principal.
 *
 * redacts this read for anyone who did not prove home possession, and it
 * is right to. What was missing is the sentence: a page that quietly serves
 * `[REDACTED]` reads as a broken page rather than as a correct boundary. The
 * read itself is remote-safe — the host performs it, this device only asks —
 * so the list stays exactly as it is and the host is named beside it.
 */

import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const logsState: {
  data: { entries: Array<Record<string, unknown>>; truncated?: boolean };
  error: unknown;
  isLoading: boolean;
} = { data: { entries: [] }, error: null, isLoading: false };
let devicePresentation: DevicePresentation | undefined;

vi.mock('@kontourai/station-sdk/developer-runtime', () => ({
  useServerLogsQuery: () => ({ ...logsState, refetch: vi.fn() }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://127.0.0.1:3141' }),
}));
vi.mock('../../../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => devicePresentation,
}));

import LogsTab from '../LogsTab';

const REDACTED_SENTENCE =
  'Full logs are available on workshop. This device is shown the redacted read.';

beforeEach(() => {
  logsState.data = {
    entries: [
      { timestamp: '2026-08-23T00:00:00.000Z', level: 'info', msg: 'booted' },
    ],
  };
  logsState.error = null;
  logsState.isLoading = false;
  devicePresentation = undefined;
});

describe('LogsTab', () => {
  test('on a paired device it says where the full logs are, beside the read it still renders', () => {
    devicePresentation = { deviceClass: 'paired', hostName: 'workshop' };
    render(<LogsTab />);
// Not a degraded page: the entries the device IS entitled to still render.
    expect(screen.getByLabelText('Server logs')).toBeTruthy();
    expect(screen.getByText(/booted/)).toBeTruthy();
    expect(screen.getByText(REDACTED_SENTENCE)).toBeTruthy();
  });

  test('the empty read still says where the full logs are', () => {
// "No matching logs" from a paired device is exactly the state that reads
// as broken without the sentence.
    logsState.data = { entries: [] };
    devicePresentation = { deviceClass: 'paired', hostName: 'workshop' };
    render(<LogsTab />);
    expect(screen.getByText('No matching logs available.')).toBeTruthy();
    expect(screen.getByText(REDACTED_SENTENCE)).toBeTruthy();
  });

  test('on the host it claims nothing about a second machine', () => {
    devicePresentation = { deviceClass: 'host', hostName: 'workshop' };
    render(<LogsTab />);
    expect(screen.getByLabelText('Server logs')).toBeTruthy();
    expect(screen.queryByText(/workshop/)).toBeNull();
  });

  test('the search field no longer claims the read is redacted regardless of who is asking', () => {
// A local operator receives UNREDACTED bytes; "Search redacted logs" was
// a state word nothing on this page derived.
    devicePresentation = { deviceClass: 'host', hostName: 'workshop' };
    render(<LogsTab />);
    expect(screen.getByPlaceholderText('Search logs')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Search redacted logs')).toBeNull();
  });
});
