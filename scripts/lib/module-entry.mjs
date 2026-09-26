/**
 * Is this module the process entry point?
 *
 *     if (invokedDirectly(import.meta)) main();
 *
 * The answer is Node's own: `import.meta.main` (Node 24.2+) is true only for
 * the module Node started as the entry point, whether that is the main thread
 * or a worker. It needs no filesystem access and no reading of `process.argv`,
 * and it behaves the same on every platform.
 *
 * ## Why not compare paths (history)
 *
 * Every earlier form rebuilt the answer from `process.argv[1]`, and each one
 * made some gate skip `main()` and **exit 0 having done nothing**. That is a
 * gate reporting success while governing nothing, the failure these gates
 * exist to catch:
 *
 * - URL strings built from `argv[1]` (a backtick `file://` template, or
 *   `new URL(import.meta.url).pathname`) broke on Windows drive paths and on
 *   any percent-encoded character, such as a space in the checkout path. That
 *   made `type-laundering-gate.mjs` a silent no-op in the required Windows
 *   portable-floor job.
 * - Realpath comparisons broke on symlinked invocation paths. Under
 *   `node -e … <arg>` and stdin (`node - <arg>`), `argv[1]` is a user
 *   argument or `-`, so a strict realpath crashed any workflow step that
 *   imported a gate that way.
 * - Detecting eval mode from `process.execArgv` broke in workers, which
 *   inherit the parent's `-e`.
 *
 * ## Fail closed on an unsupported Node
 *
 * On a Node without `import.meta.main`, the property is `undefined`.
 * Treating that as "not the entry point" would silently skip every gate, so
 * this throws instead. `package.json` engines and `.nvmrc` pin Node 24.
 *
 * `scripts/__tests__/module-entry-guard.scan.test.ts` rejects the old
 * textual forms, and `scripts/__tests__/module-entry.process.test.ts` runs
 * each invocation shape above as a child process.
 */
export function invokedDirectly(importMeta) {
  const main = importMeta?.main;
  if (typeof main !== 'boolean') {
    throw new Error(
      `invokedDirectly: import.meta.main is ${typeof main}, not a boolean. It needs Node 24.2 or newer (running ${process.version}); pass import.meta, not import.meta.url.`,
    );
  }
  return main;
}
