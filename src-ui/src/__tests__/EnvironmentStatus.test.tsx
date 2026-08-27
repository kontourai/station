/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// EnvironmentStatus reflects the connected Station HOST's detected engines
// and Model connections, not the user's own device. These tests pin the IA
// reframe: a "Host runtime" section, the full detected-CLI matrix collapsed by
// default, and an inline alert only for genuinely-unmet REQUIRED items.
const fixtures = vi.hoisted(() => ({
  status: null as any,
  loading: false,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useSystemStatusForApiBaseQuery: () => ({
    data: fixtures.status,
    isLoading: fixtures.loading,
  }),
}));

import { EnvironmentStatus } from '../views/settings/EnvironmentStatus';

function setStatus(prerequisites: any[], recommendationCode?: string) {
  fixtures.loading = false;
  fixtures.status = {
    prerequisites,
    ...(recommendationCode
      ? { recommendation: { code: recommendationCode } }
      : {}),
  };
}

const installedOptional = {
  id: 'ollama',
  name: 'Ollama',
  description: 'Local model server',
  status: 'installed' as const,
  category: 'optional' as const,
  source: 'Engines',
};

const installedRequired = {
  id: 'node',
  name: 'Node.js',
  description: 'JavaScript engine',
  status: 'installed' as const,
  category: 'required' as const,
  source: 'Core',
};

const missingRequired = {
  id: 'bedrock-credentials',
  name: 'AWS credentials',
  description: 'Required for Bedrock models',
  status: 'missing' as const,
  category: 'required' as const,
  source: 'Model connections',
};

describe('EnvironmentStatus (Host runtime IA)', () => {
  beforeEach(() => {
    fixtures.status = null;
    fixtures.loading = false;
  });

  test('renders nothing while loading', () => {
    fixtures.loading = true;
    const { container } = render(<EnvironmentStatus apiBase="http://host" />);
    expect(container.firstChild).toBeNull();
  });

  test('frames detected tooling as the host runtime, not user settings', () => {
    setStatus([installedRequired, installedOptional]);
    render(<EnvironmentStatus apiBase="http://host" />);

    expect(screen.getByText('Station host')).toBeTruthy();
    // Clarifies host semantics for a remote client using glossary vocabulary.
    expect(
      screen.getByText(
        /Provider software detected on the computer running this Station/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/describes the Station host—not your device/i),
    ).toBeTruthy();
  });

  test('collapses the full detected checklist by default when all required met', () => {
    setStatus([installedRequired, installedOptional]);
    render(<EnvironmentStatus apiBase="http://host" />);

    // No actionable alert when nothing required is unmet.
    expect(screen.queryByRole('alert')).toBeNull();

    // The green wall of detected CLIs lives behind a closed disclosure.
    const disclosure = document.querySelector(
      'details.host-runtime__disclosure',
    );
    expect(disclosure).toBeTruthy();
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText('Detected provider software')).toBeTruthy();
  });

  test('surfaces an inline alert and auto-opens when a required item is unmet', () => {
    setStatus([installedRequired, missingRequired]);
    render(<EnvironmentStatus apiBase="http://host" />);

    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain(
      '1 required item to resolve on this host',
    );
    expect(alert.textContent).toContain('AWS credentials');

    const disclosure = document.querySelector(
      'details.host-runtime__disclosure',
    );
    expect((disclosure as HTMLDetailsElement).open).toBe(true);
  });

  test('honors the runtime-only recommendation by hiding implicit bedrock creds', () => {
    setStatus([installedRequired, missingRequired], 'runtime-only');
    render(<EnvironmentStatus apiBase="http://host" />);

    // bedrock-credentials filtered out → no unmet required → no alert.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('AWS credentials')).toBeNull();
  });
});
