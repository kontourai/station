import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import { type RenderOptions, render } from '@testing-library/react';
import type { PropsWithChildren, ReactElement } from 'react';

/**
 * Mounts a component through the same connection boundary the app uses, with
 * storage isolated to this render. Tests that exercise availability-dependent
 * UI must use this rather than replacing `useConnections`.
 */
export function renderWithIsolatedConnections(
  ui: ReactElement,
  options?: RenderOptions,
) {
  const values = new Map<string, string>();
  const store = new ConnectionStore({
    storage: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    },
  });
  const { wrapper: CallerWrapper, ...renderOptions } = options ?? {};

  function IsolatedConnectionsWrapper({ children }: PropsWithChildren) {
    const connectionBoundary = (
      <ConnectionsProvider store={store}>{children}</ConnectionsProvider>
    );

    return CallerWrapper ? (
      <CallerWrapper>{connectionBoundary}</CallerWrapper>
    ) : (
      connectionBoundary
    );
  }

  return render(ui, {
    ...renderOptions,
    wrapper: IsolatedConnectionsWrapper,
  });
}
