/** @vitest-environment jsdom */
import type { EnsembleInspection } from '@kontourai/station-contracts/ensemble';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { EnsembleRecordedGroupInspection } from '../EnsembleRecordedGroupInspection';

const hash = `sha256:${'a'.repeat(64)}`;
const base: EnsembleInspection = {
  version: 'station.ensemble.inspection/v1',
  source: {
    sha256: hash,
    presetId: 'team',
    name: 'Team',
    stationmaster: 'lead',
  },
  environmentId: 'local',
  observedAt: '2026-11-05T12:00:00Z',
  resolutions: [],
  facts: [],
  groupInspection: { state: 'available' },
  limits:
    'Authentication, entitlement, execution limits and live group bindings are unverified.',
};
const bound: EnsembleInspection = {
  ...base,
  groupInspection: { state: 'bound', groupId: 'cli-bound', revision: 7 },
  limits:
    'Recorded group references only; output availability, acceptance, native/shared memory, authentication, entitlement and execution limits are unverified.',
  facts: [
    {
      id: 'outputs:lead',
      memberId: 'lead',
      category: 'output destinations',
      label: 'Recorded Session and output references',
      value: 'Own Session output location',
      origin: 'runtime-derived',
      state: 'configured',
      owner: {
        label: 'Recorded Session group snapshot',
        receipt: 'group:cli-bound:7',
      },
    },
  ],
};
const bodies: Record<string, unknown>[] = [];
let current = true;
let support: EnsembleInspection = base;
let reply: EnsembleInspection = bound;
const scope = {
  apiBase: 'https://station.test',
  authorityKey: 'operator-a',
  isCurrent: () => current,
};

beforeEach(() => {
  current = true;
  support = base;
  reply = bound;
  bodies.length = 0;
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    credential: 'owned-fixture-credential',
    requestAuthority: scope,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return new Response(
        JSON.stringify({ success: true, data: body.groupId ? reply : support }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function mount(sourceHash = hash) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (selectedHash: string) => (
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <section className="ensemble-inspection">
          <EnsembleRecordedGroupInspection
            scope={scope}
            path="/private/team.json"
            hash={selectedHash}
          />
        </section>
      </NavigationProvider>
    </QueryClientProvider>
  );
  const view = render(tree(sourceHash));
  return {
    ...view,
    rerenderSource: (nextHash: string) => view.rerender(tree(nextHash)),
    rerenderCurrent: () => view.rerender(tree(sourceHash)),
  };
}

async function inspectGroup() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect a recorded group' }),
  );
  const input = await screen.findByLabelText('Recorded group ID');
  fireEvent.change(input, { target: { value: 'cli-bound' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect recorded bindings' }),
  );
}

test('the declared offer precedes an explicit bound read without creating or running a group', async () => {
  mount();
  expect(fetch).not.toHaveBeenCalled();
  await inspectGroup();
  expect(await screen.findByText('Own Session output location')).toBeTruthy();
  expect(bodies).toEqual([
    { path: '/private/team.json', expectedPresetHash: hash, bindings: {} },
    {
      path: '/private/team.json',
      expectedPresetHash: hash,
      bindings: {},
      groupId: 'cli-bound',
    },
  ]);
  expect(screen.getByText('cli-bound')).toBeTruthy();
  expect(screen.getByText('Revision 7')).toBeTruthy();
});

test.each(['older', 'unavailable'] as const)(
  'a %s host offers no bound request',
  async (kind) => {
    support =
      kind === 'older'
        ? { ...base, groupInspection: undefined }
        : {
            ...base,
            groupInspection: {
              state: 'unavailable',
              detail: 'Recorded groups are unavailable here.',
            },
          };
    mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect a recorded group' }),
    );
    expect(
      await screen.findByText(
        kind === 'older'
          ? 'This host does not offer recorded group inspection.'
          : 'Recorded groups are unavailable here.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Recorded group ID')).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].groupId).toBeUndefined();
  },
);

test('a cross-group response is rejected without displaying its references', async () => {
  reply = {
    ...bound,
    groupInspection: { state: 'bound', groupId: 'cli-foreign', revision: 7 },
  };
  mount();
  await inspectGroup();
  expect(
    await screen.findByText(
      'Recorded bindings are unavailable for this preset and Station authority.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText('Own Session output location')).toBeNull();
});

test('source replacement and lost authority hide prior recorded references', async () => {
  const view = mount();
  await inspectGroup();
  expect(await screen.findByText('Own Session output location')).toBeTruthy();
  current = false;
  view.rerenderCurrent();
  await waitFor(() =>
    expect(screen.queryByText('Own Session output location')).toBeNull(),
  );
  current = true;
  view.rerenderSource(`sha256:${'b'.repeat(64)}`);
  expect(screen.queryByLabelText('Recorded group ID')).toBeNull();
  expect(screen.queryByText('Own Session output location')).toBeNull();
  expect(bodies).toHaveLength(2);
});
