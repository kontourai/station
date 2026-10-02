/** @vitest-environment jsdom */
import { engineId } from '@kontourai/station-contracts/agent-identity';
import type { ExternalEngineReadinessProjection } from '@kontourai/station-contracts/system-status';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  engines: [] as ExternalEngineReadinessProjection[],
  connect: vi.fn(),
  materialize: vi.fn(),
}));
vi.mock('../../../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({
    data: { externalEngines: state.engines },
    isLoading: false,
    isFetching: false,
  }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useConnectAndMaterializeEngineMutation: () => ({
    mutateAsync: state.connect,
  }),
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: state.materialize }),
}));

import { AutomaticEnginePreparation } from '../AutomaticEnginePreparation';

afterEach(() => {
  cleanup();
  state.engines = [];
  state.connect.mockReset();
  state.materialize.mockReset();
});
test('connects an installed app using the owning API and refreshes before completion', async () => {
  state.engines = [
    {
      engineId: engineId('codex'),
      name: 'Codex',
      detected: true,
      ready: false,
      source: 'registry',
      reason: 'not_connected',
      registryEntryId: 'codex',
    },
  ];
  state.connect.mockResolvedValue({ data: {}, created: true });
  const refresh = vi.fn().mockResolvedValue(undefined);
  const done = vi.fn();
  render(
    <AutomaticEnginePreparation
      agents={[]}
      refresh={refresh}
      onComplete={done}
      onStart={vi.fn()}
      isCurrent={() => true}
    />,
  );
  await waitFor(() => expect(done).toHaveBeenCalledWith('codex'));
  expect(state.connect).toHaveBeenCalledExactlyOnceWith('codex');
  expect(refresh).toHaveBeenCalledOnce();
  expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(
    done.mock.invocationCallOrder[0]!,
  );
});
test('never enables an explicitly disabled app', async () => {
  state.engines = [
    {
      engineId: engineId('codex'),
      name: 'Codex',
      detected: true,
      ready: false,
      source: 'registry',
      reason: 'disabled',
    },
  ];
  const done = vi.fn();
  render(
    <AutomaticEnginePreparation
      agents={[]}
      refresh={vi.fn().mockResolvedValue(undefined)}
      onComplete={done}
      onStart={vi.fn()}
      isCurrent={() => true}
    />,
  );
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.materialize).not.toHaveBeenCalled();
});
