import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The SDK is source-linked in this workspace; its hooks and this example
    // must resolve one React instance during package-level tests.
    dedupe: ['react', 'react-dom'],
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
