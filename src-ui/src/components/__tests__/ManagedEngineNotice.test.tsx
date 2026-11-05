/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  decodeManagedEngines,
  managedEngineIdFor,
  managedEngineState,
} from '../../hooks/useManagedEngines';
import {
  ManagedEngineNotice,
  managedEngineSubtitle,
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

describe('#4520: managed engines in the UI', () => {
  const view = decodeManagedEngines(body);

  test('decodes the engine summary and refuses what it cannot', () => {
    expect(view?.organization).toBe('Acme');
    expect(
      decodeManagedEngines({ success: true, data: { state: 'none' } }),
    ).toBeNull();
    expect(
      decodeManagedEngines({
        ...body,
        data: {
          ...body.data,
          summary: { ...body.data.summary, engines: { allowed: ['x'] } },
        },
      }),
    ).toBeNull();
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
    expect(managedEngineSubtitle(managedEngineState(view, 'codex'))).toBe(
      'Managed: not allowed · ',
    );
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
