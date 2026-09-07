import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      // files with @vitest-environment jsdom at top use jsdom
      ['src/__tests__/useConnections.test.tsx', 'jsdom'],
      ['src/__tests__/useConnectionStatus.test.tsx', 'jsdom'],
      ['src/__tests__/ConnectionsContext.insecureContext.test.tsx', 'jsdom'],
    ],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});
