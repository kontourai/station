/**
 * Local ambient typing for `@kontourai/console-server`'s `buildCurrentOperatingState`
 * (roadmap #586, epic #580, S6).
 *
 * This is NOT a version-gap situation like `intent-binding-mirror.ts` used
 * to be: `buildCurrentOperatingState` genuinely runs at runtime in the
 * published `@kontourai/console-server@1.0.0` package (verified against the
 * tarball: `dist/src/console-foundation/index.js`'s `module.exports` object
 * literal includes `buildCurrentOperatingState: currentOperatingState.buildCurrentOperatingState`)
 * — but the package's own generated `index.d.ts` does NOT declare it (nor
 * `createOperatingStateProjection`, `LocalConsoleHub`, `createLocalConsoleHub`,
 * and a handful of other `module.exports`-only members), even though the
 * `CurrentOperatingStateOptions`/`OperatingState` types it needs ARE
 * exported. This is exactly the "Console publish inconsistency" risk the
 * work-plane-composition design doc calls out (verify the published tarball
 * before consuming beyond console-core) — a tsc-declaration gap in
 * console-server's own build (its `Hub.currentOperatingState` method IS
 * typed; the free top-level function that method delegates to is not),
 * not a missing feature.
 *
 * Rather than widen the mirror pattern to a whole extra file duplicating
 * console-server's own fold logic (`buildCurrentOperatingState` is
 * hundreds of lines of real event-replay code — there is no small, stable
 * table to mirror here the way `workflow-process-projection-mirror.ts`
 * used to mirror flow-agents' status table before flow-agents#933 shipped
 * `./console-contract` and that table's mirror was deleted -- see that
 * file's header, "RETIREMENT"; it still mirrors a small critique-detection
 * helper pair for the same reason), this module restores ONLY the one
 * missing signature so callers get real types calling the REAL function —
 * `createRequire` + a local interface, the same "package ships more at
 * runtime than its own `.d.ts` admits" pattern already used elsewhere in
 * this repo (see `workflow-sidecar-service.ts`'s `createRequire` use for
 * `ajv/dist/2020.js`, which ships no bundled types either).
 */

import { createRequire } from 'node:module';
import type { OperatingState } from '@kontourai/console-core';
import type { ConsoleEventRecord } from '@kontourai/console-server';

const require = createRequire(import.meta.url);

export interface CurrentOperatingStateOptions {
  generatedAt?: string | null;
  /** Epoch millis or ISO string; defaults to `Date.now()` when absent. */
  now?: number | string;
}

/**
 * Return type is deliberately console-CORE's `OperatingState` (the type
 * every other caller in this codebase — `OperatingStateService`,
 * `@kontourai/console-ui`'s `BoardView` — actually consumes), not
 * console-server's OWN `OperatingState` re-declaration. The two packages'
 * types are structurally near-identical but not nominally interchangeable
 * (console-server's own `types.ts` types `processes` as a loose
 * `Record<string, unknown>[]` rather than reusing console-core's
 * `ConsoleProcess[]`, even though console-server depends on
 * console-core@0.3.0 and the RUNTIME value is a genuine `ConsoleProcess[]`
 * — a typing-looseness gap in console-server's own package, not a runtime
 * behavior difference). `loadBuildCurrentOperatingState`'s single cast
 * below is the one place that gap is bridged.
 */
type BuildCurrentOperatingStateFn = (
  events: ConsoleEventRecord[],
  options?: CurrentOperatingStateOptions,
) => OperatingState;

let cached: BuildCurrentOperatingStateFn | null = null;

/**
 * Loads (once, memoized) and returns `@kontourai/console-server`'s real
 * `buildCurrentOperatingState` function. Throws if the installed package
 * genuinely stops exporting it at runtime — a loud, immediate failure at
 * first use rather than a silent `undefined` propagating into a route
 * handler.
 */
export function loadBuildCurrentOperatingState(): BuildCurrentOperatingStateFn {
  if (cached) return cached;
  const mod = require('@kontourai/console-server') as Record<string, unknown>;
  const fn = mod.buildCurrentOperatingState;
  if (typeof fn !== 'function') {
    throw new Error(
      "@kontourai/console-server does not export 'buildCurrentOperatingState' at runtime — this ambient shim (console-server-operating-state.ts) is stale for the installed version and needs re-verification against the published tarball.",
    );
  }
  cached = fn as BuildCurrentOperatingStateFn;
  return cached;
}
