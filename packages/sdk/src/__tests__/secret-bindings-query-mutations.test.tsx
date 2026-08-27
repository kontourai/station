/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getApiBase: vi.fn().mockResolvedValue('https://station.example.test'),
  create: vi.fn().mockResolvedValue({}),
  replace: vi.fn().mockResolvedValue({}),
  revoke: vi.fn().mockResolvedValue({}),
  bind: vi.fn().mockResolvedValue({}),
  unbind: vi.fn().mockResolvedValue({}),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  _getApiBase: mocks.getApiBase,
}));

vi.mock('../client/secret-bindings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/secret-bindings')>()),
  createSecretBinding: mocks.create,
  replaceSecretBinding: mocks.replace,
  revokeSecretBinding: mocks.revoke,
  bindSecretBinding: mocks.bind,
  unbindSecretBinding: mocks.unbind,
}));

import {
  useBindSecretBindingMutation,
  useCreateSecretBindingMutation,
  useReplaceSecretBindingMutation,
  useRevokeSecretBindingMutation,
  useUnbindSecretBindingMutation,
} from '../query-domains/secret-bindings';

const API_BASE = 'https://station.example.test';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.getApiBase.mockResolvedValue(API_BASE);
  mocks.create.mockResolvedValue({});
  mocks.replace.mockResolvedValue({});
  mocks.revoke.mockResolvedValue({});
  mocks.bind.mockResolvedValue({});
  mocks.unbind.mockResolvedValue({});
});

describe('secret-binding mutation API-base seam (station#4065)', () => {
  test('resolves the API base once per mutation and forwards it with every wrapper input', async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { result } = renderHook(
      () => ({
        create: useCreateSecretBindingMutation(),
        replace: useReplaceSecretBindingMutation(),
        revoke: useRevokeSecretBindingMutation(),
        bind: useBindSecretBindingMutation(),
        unbind: useUnbindSecretBindingMutation(),
      }),
      { wrapper: wrapperFor(client) },
    );

    const create = {
      id: 'github-token',
      name: 'GitHub token',
      authRef: { provider: 'github' },
    };
    const replace = {
      id: 'github-token',
      name: 'Renamed token',
      authRef: { provider: 'github' },
      expectedRevision: 2,
    };
    const revoke = { id: 'github-token', expectedRevision: 3 };
    const bind = {
      id: 'github-token',
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 4,
    };
    const unbind = {
      id: 'github-token',
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 5,
    };

    await act(async () => {
      await result.current.create.mutateAsync(create);
      await result.current.replace.mutateAsync(replace);
      await result.current.revoke.mutateAsync(revoke);
      await result.current.bind.mutateAsync(bind);
      await result.current.unbind.mutateAsync(unbind);
    });

    expect(mocks.getApiBase).toHaveBeenCalledTimes(5);
    expect(mocks.create).toHaveBeenCalledWith(API_BASE, create);
    expect(mocks.replace).toHaveBeenCalledWith(API_BASE, 'github-token', {
      name: 'Renamed token',
      authRef: { provider: 'github' },
      expectedRevision: 2,
    });
    expect(mocks.revoke).toHaveBeenCalledWith(API_BASE, 'github-token', 3);
    expect(mocks.bind).toHaveBeenCalledWith(API_BASE, 'github-token', {
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 4,
    });
    expect(mocks.unbind).toHaveBeenCalledWith(API_BASE, 'github-token', {
      integrationId: 'github',
      envName: 'TOKEN',
      expectedRevision: 5,
    });
  });
});
