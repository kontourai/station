export const STATION_SERVER_EXTERNALS = [
  'fsevents',
  'esbuild',
  'node-pty',
  // Native OS-keyring binding used by the published CLI. It cannot be inlined
  // because npm selects a platform-specific binary package at install time.
  '@napi-rs/keyring',
  '@anthropic-ai/claude-agent-sdk',
  // Flow resolves its Hachure schemas through require.resolve() from the
  // installed package. Bundling moves that lookup to Station's output and
  // bypasses Flow's package-local dependency tree.
  '@kontourai/flow',
  // @kontourai/flow-agents' public entry re-exports loadJson/writeJson from
  // its cli/workflow-sidecar.js module, which runs its CLI main() guarded
  // by an import.meta.url === process.argv[1] real-path check. When this
  // module is inlined by esbuild's bundler, import.meta.url for the merged
  // module resolves to the single bundle output file — the same path as
  // process.argv[1] when running `node dist-server/command-station.js` — so the
  // guard misfires and the CLI's main() runs at server boot, printing
  // 'workflow-sidecar command is required' and exiting the process before
  // the HTTP server ever binds. Keeping the package external (loaded via
  // normal node_modules resolution instead of inlined) preserves the
  // guard's real per-file import.meta.url, restoring the intended
  // library-vs-CLI-entry distinction.
  '@kontourai/flow-agents',
  // Review-lens routing consumes the public Veritas engine. Veritas loads its
  // shipped schemas by package-relative paths; bundling relocates that lookup
  // into dist-server, where those data files do not exist. Keep the package
  // external so the staged runtime carries its declared package closure.
  '@kontourai/veritas',
  // @kontourai/console-server's single entry point (`.` — no per-function
  // subpath exports) pulls in its whole dependency graph on import,
  // including flow-bridge.js's `require('@kontourai/surface')`. npm
  // resolves that to console-server's OWN pinned `@kontourai/surface@^1.0.1`
  // nested under its own node_modules (station's top-level dependency is
  // `@kontourai/surface@^2.12.0` — a different major version), and that
  // nested copy's package.json `exports` only declares `types`/`import`
  // conditions for `.`, which esbuild's node-platform bundling (`default`/
  // `module`/`node`/`require` active conditions) cannot resolve — a build-
  // time failure, not a runtime one (`require('@kontourai/console-server')`
  // resolves fine via normal node_modules resolution, proven by
  // `operating-state-service.ts`'s own tests). Keeping the package external
  // avoids esbuild ever walking into its nested dependency tree at all,
  // mirroring the `@kontourai/flow`/`@kontourai/flow-agents` precedent above.
  '@kontourai/console-server',
  // VoltAgent's workflow state manager (WorkflowStateManager) holds state in a
  // private field (#state). Bundling inlines that class into dist-server, but
  // plugins and other runtime-resolved modules load @voltagent/core fresh from
  // node_modules — two class identities for the same logical class. When an
  // object built by one identity crosses into code from the other, V8's
  // private-field brand check throws
  // "Cannot read private member #state from an object whose class did not
  // declare it." Keeping the package external (single node_modules copy shared
  // by the server and every plugin) preserves one class identity, mirroring
  // the @kontourai/flow / flow-agents precedent above.
  '@voltagent/core',
  '@voltagent/logger',
  '@voltagent/server-core',
  '@voltagent/server-hono',
];
