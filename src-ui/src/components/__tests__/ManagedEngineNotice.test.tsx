/** @vitest-environment jsdom */

import {
  type ManagedPolicyStatus,
  parseManagedPolicyStatus,
} from '@kontourai/station-contracts/managed-policy-status';
import { render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  managedEngineIdFor,
  managedEngineState,
  managedEnginesView,
  useManagedEngines,
} from '../../hooks/useManagedEngines';

// The shared managed-policy status query (the SDK hook) and the app's API
// base: `ManagedPolicyProvider` reads both, and `useManagedEngines` reads the
// provider and nothing else.
const statusQuery = vi.hoisted(() => ({
  calls: [] as unknown[],
  data: undefined as unknown,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useManagedPolicyStatusQuery: (apiBase: unknown) => {
    statusQuery.calls.push(apiBase);
    return { data: statusQuery.data };
  },
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://127.0.0.1:4100' }),
}));

import { ManagedPolicyProvider } from '../../contexts/ManagedPolicyContext';
import {
  ManagedEngineNotice,
  managedEngineFact,
  managedEnvironmentLocked,
} from '../ManagedEngineNotice';

/** A `GET /api/settings/managed-policy` body as the server sends it. */
const body = {
  success: true,
  data: {
    state: 'loaded',
    source: { kind: 'file', location: '/etc/station/policy.json' },
    digest: `sha256:${'a'.repeat(64)}`,
    summary: {
      organization: 'Acme',
      supportUrl: 'https://help.example.com/station',
      lockedSettings: [],
      limits: {},
      engines: {
        allowed: ['claude', 'acp'],
        acpRegistryAgents: false,
        pinned: [
          {
            engine: 'claude',
            locked: true,
            fields: ['binaryPath', 'environment'],
            environmentNames: ['ANTHROPIC_BASE_URL'],
          },
        ],
      },
    },
  },
};

/** The summary of a decoded status, as `ManagedPolicyProvider` provides it. */
const summaryOf = (status: ManagedPolicyStatus | null) =>
  status?.state === 'loaded' ? status.summary : undefined;

describe('#4520: managed engines in the UI', () => {
  // Decoded the one way every surface decodes it (#4515).
  const view = managedEnginesView(
    summaryOf(parseManagedPolicyStatus(body.data)),
  );

  afterEach(() => {
    statusQuery.calls.length = 0;
    statusQuery.data = undefined;
    vi.unstubAllGlobals();
  });

  test('reads the engine summary from the decoded status, and nothing from what the decoder refuses', () => {
    expect(view?.organization).toBe('Acme');
    expect(
      managedEnginesView(
        summaryOf(parseManagedPolicyStatus({ state: 'none' })),
      ),
    ).toBeNull();
    // A malformed engine summary refuses the whole status, so nothing shows.
    expect(
      parseManagedPolicyStatus({
        ...body.data,
        summary: { ...body.data.summary, engines: { allowed: ['x'] } },
      }),
    ).toBeNull();
    expect(managedEnginesView(null)).toBeNull();
    // A policy without `limits.engines` limits no engine.
    const { engines: _engines, ...summary } = body.data.summary;
    expect(
      managedEnginesView(
        summaryOf(parseManagedPolicyStatus({ ...body.data, summary })),
      ),
    ).toBeNull();
  });

  test('the hook reads the app policy provider, which reads the shared status query; no request of its own', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    statusQuery.data = parseManagedPolicyStatus(body.data);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ManagedPolicyProvider>{children}</ManagedPolicyProvider>
    );
    const { result } = renderHook(() => useManagedEngines(), { wrapper });
    expect(statusQuery.calls).toEqual(['http://127.0.0.1:4100']);
    expect(result.current).toEqual(view);
    expect(fetchSpy).not.toHaveBeenCalled();
    // While the status loads, nothing is marked.
    statusQuery.data = undefined;
    expect(
      renderHook(() => useManagedEngines(), { wrapper }).result.current,
    ).toBeNull();
    // Outside the provider it reads nothing and queries nothing itself.
    statusQuery.calls.length = 0;
    statusQuery.data = parseManagedPolicyStatus(body.data);
    expect(renderHook(() => useManagedEngines()).result.current).toBeNull();
    expect(statusQuery.calls).toEqual([]);
  });

  test('derives disallowed and pinned engines', () => {
    expect(managedEngineState(view, 'codex')?.disallowed).toBe(true);
    expect(managedEngineState(view, 'acp')).toBeNull();
    expect(
      managedEngineState(view, 'acp', { registryAgent: true })?.disallowed,
    ).toBe(true);
    const claude = managedEngineState(view, 'claude');
    expect(claude).toMatchObject({ disallowed: false, pin: { locked: true } });
    expect(managedEnvironmentLocked(claude)).toBe(true);
    expect(managedEngineFact(managedEngineState(view, 'codex'))).toBe(
      'Managed',
    );
    expect(managedEngineFact(claude)).toBe('Managed launch');
    expect(managedEngineFact(null)).toBeNull();
    expect(managedEngineIdFor('station', false)).toBe('station-agent');
    expect(managedEngineIdFor('opencode', true)).toBe('acp');
  });

  test('renders a disallowed engine as managed and not allowed', () => {
    render(<ManagedEngineNotice state={managedEngineState(view, 'codex')} />);
    expect(screen.getByText('Managed by Acme')).toBeTruthy();
    expect(screen.getByText('Not allowed')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Get help' }).getAttribute('href'),
    ).toBe('https://help.example.com/station');
  });

  test('renders pinned fields by name and never a value', () => {
    render(<ManagedEngineNotice state={managedEngineState(view, 'claude')} />);
    expect(screen.getByText('Launch locked')).toBeTruthy();
    const note = screen.getByTestId('managed-engine-notice').textContent ?? '';
    expect(note).toContain('program, environment (ANTHROPIC_BASE_URL)');
    expect(note).toContain(
      'Connect through and connection environment do not apply.',
    );
  });

  test('renders nothing for an engine the policy does not govern', () => {
    const { container } = render(<ManagedEngineNotice state={null} />);
    expect(container.textContent).toBe('');
  });
});
