import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type RenderOptions,
  render as renderTestingLibrary,
} from '@testing-library/react';
import type { PropsWithChildren, ReactElement } from 'react';

/** The app's remote-data prerequisites, isolated per test render. */
function createQueryTestBoundary(
  CallerWrapper?: RenderOptions['wrapper'],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const values = new Map<string, string>();
  const store = new ConnectionStore({
    storage: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    },
  });
  return function QueryBoundary({ children }: PropsWithChildren) {
    return (
      <ConnectionsProvider store={store}>
        <QueryClientProvider client={client}>
          {CallerWrapper ? <CallerWrapper>{children}</CallerWrapper> : children}
        </QueryClientProvider>
      </ConnectionsProvider>
    );
  };
}
export function render(ui: ReactElement, options?: RenderOptions) {
  const { wrapper, ...rest } = options ?? {};
  return renderTestingLibrary(ui, {
    ...rest,
    wrapper: createQueryTestBoundary(wrapper),
  });
}
