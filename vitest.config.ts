import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // First-party example packages are also discovered by the root test lane.
    // Their source-linked SDK components and local renderers must share one
    // React dispatcher here, just as they do in each package-local config.
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        // The root aggregate must also load its renderer entry point from the
        // root dependency tree. Aliasing React alone cannot rewrite CommonJS
        // requires made after a package-local renderer has been selected.
        find: /^@testing-library\/react$/,
        replacement: path.resolve(
          __dirname,
          './node_modules/@testing-library/react/dist/index.js',
        ),
      },
      {
        // React Query is a context provider as well as a data dependency, so
        // package-local copies must use the same dispatcher in this lane.
        find: /^@tanstack\/react-query$/,
        replacement: path.resolve(
          __dirname,
          './node_modules/@tanstack/react-query/build/modern/index.js',
        ),
      },
      {
        // Mirror the app's `@` → src-ui/src alias (vite.config.ts) so unit tests
        // can import modules that use it (e.g. ConfigContext → @/utils/logger).
        find: /^@\/(.+)$/,
        replacement: path.resolve(__dirname, './src-ui/src/$1'),
      },
      {
        // Mirror the app's `@shared` alias for UI modules that consume shared
        // browser/server contracts directly.
        find: /^@shared\/(.+)$/,
        replacement: path.resolve(__dirname, './src-shared/$1'),
      },
      {
        find: /^@kontourai\/station-contracts\/(.+)$/,
        replacement: path.resolve(__dirname, './packages/contracts/src/$1.ts'),
      },
      {
        find: '@kontourai/station-contracts',
        replacement: path.resolve(
          __dirname,
          './packages/contracts/src/index.ts',
        ),
      },
      {
        // `packages/connect`'s package.json "." entry points at an unbuilt
        // `dist/` (this repo's dev/test loop never runs its `build` script) —
        // mirrors the same alias `vite.config.ts` already carries for the
        // app build. Exact-match only (RegExp `$` anchor): subpath imports
        // like `@kontourai/station-connect/known-environment` already
        // resolve correctly through the package's own `exports` map (those
        // subpaths point directly at source, not `dist/`) and must not be
        // redirected here.
        find: /^@kontourai\/station-connect$/,
        replacement: path.resolve(__dirname, './packages/connect/src/index.ts'),
      },
    ],
  },
  test: {
    // 30s, not vitest's 5s default.
    //
    // The 5s was inherited, not chosen, and it acts as a uniform latency
    // assertion nobody wrote. Six suites reddened under corpus load on
    // branches that touched none of them — a benchmark run, a signing and
    // install round-trip, redaction over an attachment set, a filesystem
    // walk, a bounded-readiness wait, a multi-step RTL flow. One was
    // measured at 5005ms: five milliseconds over. The last one found takes
    // 1.2s in isolation and still blew the deadline, because it spawns
    // child processes and spawning is what contends.
    //
    // Enumerating them did not converge: each corpus run verifying the
    // previous batch surfaced another, at ~20 minutes per round, and each
    // red lands on whoever is gating rather than whoever caused it.
    //
    // Finite on purpose. A genuine hang still fails, just not in the time it
    // takes a busy machine to do real work. A test whose SUBJECT is latency
    // should assert that itself — the performance suite already does, with
    // thresholds it chose (station#3162).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 4,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    globals: true,
    exclude: [
      'tests/**',
      '**/node_modules/**',
      'vendor/**',
      '.claude/**',
      '.station/**',
      // Local sibling worktrees are separate repositories, not test sources.
      '**/station-worktrees/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      include: ['src-server/**/*.ts'],
      exclude: ['**/__tests__/**', '**/__test-utils__/**', '**/*.d.ts'],
      thresholds: {
        statements: 30,
        branches: 65,
        functions: 50,
        lines: 30,
      },
    },
  },
});
