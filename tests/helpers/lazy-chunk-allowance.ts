/**
 * How long a browser journey may wait for a code-split surface whose only
 * remaining dependency is a lazy `import()`.
 *
 * THIS NUMBER IS NOT DERIVED, and the module exists so that fact is written
 * down once instead of being re-guessed at each call site. A lazy chunk is
 * served from the Station UI proxy's own static handler, so none of the bounds
 * the repo can legitimately cite applies to it:
 *
 * - `PROXY_UPSTREAM_TIMEOUT_MS` (30 s, `packages/cli/src/commands/lifecycle.ts`)
 *   bounds a request the proxy forwards to the backend. A chunk is answered by
 *   the proxy itself and never makes that hop.
 * - There is no retry to budget for: React caches a `lazy` rejection for the
 *   life of the module, which is why `LazyBoundary` has to construct a fresh
 *   one to retry at all (`src-ui/src/components/LazyBoundary.tsx`).
 * - Under host contention the cost is chunk transfer plus parse and execute,
 *   and nothing in this repository has ever measured that.
 *
 * So this is the LARGEST of the budgets the three sites using it already
 * carried before #1642 — 20 s at the Switch task dialog, 15 s at the Chat
 * actions menu, and the file-wide 15 s action timeout at the Connections add
 * action. It is retained rather than raised, deliberately: it lowers no
 * existing bound, and it is not evidence. What #1642 changes at those sites is
 * structural — the waits now observe the boundary's own failure state, so a
 * chunk that REJECTS is reported immediately by name instead of spending this
 * allowance and then blaming the surface it was going to render.
 *
 * To turn this into a derivation, measure it: #1693 proposes recording
 * `performance.getEntriesByType('resource')` for these chunk URLs during the
 * live run, which makes the next occurrence the measurement rather than
 * another sample.
 */
export const LAZY_CHUNK_ALLOWANCE_MS = 20_000;
