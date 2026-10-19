/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

interface Prerequisite {
  id: string;
  name: string;
  description: string;
  status: 'installed' | 'missing' | 'error';
  category: 'required' | 'optional';
  source?: string;
}
const fixtures = vi.hoisted(() => ({
  status: null as {
    prerequisites: Prerequisite[];
    recommendation?: { code: string };
  } | null,
  loading: false,
  queried: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useSystemStatusForApiBaseQuery: () => {
    fixtures.queried();
    return {
      data: fixtures.status,
      isLoading: fixtures.loading,
      isError: false,
    };
  },
}));

import { EnvironmentStatus } from '../views/settings/EnvironmentStatus';

beforeEach(() => {
  fixtures.status = null;
  fixtures.loading = false;
  fixtures.queried.mockClear();
});

async function openDiagnostics() {
  fireEvent.click(
    screen.getByText('Host diagnostics', { selector: 'summary' }),
  );
  await waitFor(() => expect(fixtures.queried).toHaveBeenCalled());
}

test('keeps editable host settings available while requested diagnostics load', async () => {
  fixtures.loading = true;
  render(
    <EnvironmentStatus apiBase="http://host">
      <input aria-label="Terminal shell" defaultValue="zsh" />
    </EnvironmentStatus>,
  );
  expect(screen.getByRole('textbox', { name: 'Terminal shell' })).toBeTruthy();
  await openDiagnostics();
  expect(
    screen.getByRole('status', { name: 'Checking the Station host' }),
  ).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Terminal shell' })).toBeTruthy();
});

test('does not claim an unavailable discovery is healthy or a required repair', async () => {
  render(<EnvironmentStatus apiBase="http://host" />);
  await openDiagnostics();
  expect(screen.getByRole('status').textContent).toContain(
    'Host diagnostics are unavailable',
  );
  expect(screen.queryByRole('alert')).toBeNull();
});

test('keeps a required discovery failure collapsed and shows it once when requested', async () => {
  fixtures.status = {
    prerequisites: [
      {
        id: 'discovery',
        name: 'Discovery timed out',
        description: 'No result',
        status: 'error',
        category: 'required',
      },
    ],
  };
  render(<EnvironmentStatus apiBase="http://host" />);
  expect(screen.queryByText('Discovery timed out')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await openDiagnostics();
  expect(screen.getAllByText('Discovery timed out')).toHaveLength(1);
  expect(screen.queryByText(/required item.*resolve/i)).toBeNull();
});

test('retains runtime-only filtering of implicit Bedrock prerequisites', async () => {
  fixtures.status = {
    recommendation: { code: 'runtime-only' },
    prerequisites: [
      {
        id: 'bedrock-credentials',
        name: 'AWS credentials',
        description: 'Bedrock access',
        status: 'missing',
        category: 'required',
      },
      {
        id: 'codex',
        name: 'Codex',
        description: 'Agent app',
        status: 'installed',
        category: 'optional',
      },
    ],
  };
  render(<EnvironmentStatus apiBase="http://host" />);
  await openDiagnostics();
  expect(screen.queryByText('AWS credentials')).toBeNull();
  expect(screen.getByText('Codex')).toBeTruthy();
});
