# Deferred dependency upgrades

> **Historical snapshot:** The versions and GitHub Actions state below were
> captured in July 2026 and are not current dependency status. Use
> `package-lock.json`, `src-desktop/Cargo.lock`, the live package registries,
> Dependabot, and current Actions runs for present state. The table is retained
> only for its migration rationale and revisit triggers; never copy its version
> numbers or operational status into a current claim without re-verifying them.

Dependabot recreates these PRs as new versions land. At the time of this
snapshot they had been assessed and intentionally deferred. Each entry records
the then-current rationale and revisit trigger.

> **Last verified: 2026-07-25.** Every "installed" version below was read from
> `node_modules`, and every "latest" from the registry, on that date. When you
> touch this file, re-verify rather than editing around the edges: the previous
> revision had drifted far enough to be actively misleading — it claimed Strands
> was on `1.0.0-rc.3` (it was 1.9.0), that a Zod 3→4 migration was the blocker
> (the repo was already on Zod 4), and that `@kontourai/flow` was on `0.1.x`
> (it was 1.3.0).

*Constraint in effect: GitHub Actions is still refusing this repository's runs — workflows are queued and rejected within ~2 seconds with zero steps executed (verified on run `30162340497`, 2026-07-25). Everything is validated locally and merges don't get CI, which makes workflow-only changes un-validatable — see the GitHub Actions entry.*

## Deferred

| Dependency | Installed → latest | Deferred because | Revisit when |
|-----------|--------------------|------------------|--------------|
| `ai` + the `@ai-sdk/*` provider family | `ai` 6.0.235 → **7.0.37**; `@ai-sdk/amazon-bedrock` 4.0.141 → **5.0.31**; `anthropic` 3.0.102 → **4.0.20**; `google` 3.0.101 → **4.0.24**; `openai-compatible` 2.0.62 → **3.0.14**; `provider-utils` 4.0.40 → **5.0.12** | These move as one set — mixing majors creates a multi-way `@ai-sdk/provider` split and a `LanguageModel` interface shift on the **default** LLM path. The 6.x line already moved `LanguageModelUsage` from `promptTokens`/`completionTokens` to `inputTokens`/`outputTokens`; reading the wrong field typechecks as `undefined` and silently zeroes token accounting, so the v7 surface needs field-by-field review, not a bump. Bedrock invocation can't be exercised without credentials. | Doing it as one dedicated migration across every provider adapter at once: dedupe `@ai-sdk/provider`, re-verify the usage field mapping (`src-server/runtime/frameworks/voltagent-adapter.ts` and its hook tests), and run a live turn against each provider. |
| `@kontourai/flow` | 1.3.0 → **3.10.0** | Per the roadmap standing decision log (2026-06-14), the Kontour 1.0 line fixed none of Station's flagged issues. That rationale has not been re-tested against the 2.x/3.x lines — this entry is a *deferral of the investigation*, not a verified rejection of 3.x. | Someone re-reads the 2.x and 3.x changelogs against Station's flagged issues. Two majors of drift is past the point where "no" should be inherited without checking. |
| `@kontourai/console` | 0.3.0 → **2.8.0** | Dev-only dependency, two majors behind. Same as above: the gap is large enough that it needs its own read of what changed, not a drive-by bump. | Taken as its own task alongside the `@kontourai/flow` review — they are the same question about sibling-package drift. |
| frontend tooling: `typescript`, `vite`, `vitest`, `@vitejs/plugin-react`, `@vitest/coverage-v8` | TS 5.9.3 → **7.0.2**; Vite 7.3.6 → **8.1.5**; Vitest + coverage 3.2.6 → **4.1.10**; plugin-react 5.2.0 → **6.0.4** | The compatible security floor is already met at Vite 7.3.6 with aligned Vitest/coverage 3.2.6. The remaining proposals are major build/test-infrastructure migrations with no immediate runtime product value, and each needs dedicated config and compatibility work. TypeScript is now **two** majors behind (5 → 7), so this is growing. | Taken as its own focused migration, one tool at a time (TS 6 then 7, then Vite 8, then Vitest 4), each fully test- and build-verified. |
| `fast-uri` (override) | 3.1.4 → **4.1.1** | Pinned as a transitive `overrides` entry to hold the advisory floor for Ajv's URI parsing. Moving the override to a new major changes resolution for every consumer that expects 3.x. | The packages that depend on it (Ajv and the Kontour packages) declare 4.x support themselves. |
| GitHub Actions (`actions/upload-artifact` v4→v7, `actions/download-artifact` v4→v8, `actions/setup-node` v4→v6, `softprops/action-gh-release` v2→v3, `swatinem/rust-cache`) | various majors | Workflow-only — runnable **only** in CI, which is still rejecting this repository's runs. The artifact/release-action majors touch the publish pipeline (`publish-npm.yml`); merging un-validated risks breaking releases. | GitHub Actions accepts runs again — then take them as one batch and confirm a green release dry-run. |

## Resolved since the previous revision

These were deferred and are no longer blocked. Kept briefly so a returning reader can see the blocker actually cleared rather than wondering where the entry went.

| Was deferred | Status |
|--------------|--------|
| `@strands-agents/sdk` rc.3 → 1.x, *"gated on a Zod 3→4 migration"* | **Done.** The repo runs Zod 4.4.3 and Strands 1.11.1 — current with the registry. The Zod migration that blocked it has already happened, so the authorization/HITL handlers the old entry wanted are available now. |
| `@voltagent/core` | **Current** at 2.9.0. |
| `@kontourai/flow-agents` | **Current** at 5.3.0 (exact pin, enforced by `npm run dependency-drift:gate`). |

## Taken in the 2026-07-26 security pass

| Dependency | Move | What verification found |
|-----------|------|--------------------------|
| `@hono/node-server` | 1.19.15 → **2.0.12** | The deferral asked for "a dedicated pass with the route suite and a boot smoke" — this was it. v2.0.0 ships exactly **two** breaking changes and neither applies: it drops Node 18 (Station's `engines` is `24.x`), and it removes the `@hono/node-server/vercel` subpath (never imported here). The type surface Station actually uses is **unchanged between 1.19.15 and 2.0.12** — `serve` is `(options, listeningListener?) => ServerType` in both, and `HttpBindings` is the same `{ incoming, outgoing }` pair — verified by diffing the published `.d.mts` files, not by trusting a green `tsc`. The package is bundled by esbuild (not in `STATION_SERVER_EXTERNALS`) and v2's ESM-first `dist/index.mjs` entry builds cleanly. **This does not clear `GHSA-frvp-7c67-39w9` from the audit:** `@modelcontextprotocol/sdk` (`^1.19.9`) and `@voltagent/server-hono` (`^1.14.0`) keep their own nested 1.19.15 copies, and forcing those with an `overrides` entry would push both outside their declared ranges for a *moderate* advisory. The advisory is in `serve-static`, and **no package in the graph imports the `@hono/node-server/serve-static` subpath at all** — verified by grep across `node_modules`, so the vulnerable code is not reachable. Revisit when the MCP SDK and VoltAgent widen to `^2`. |
| `fast-uri` (unused declared dep in `packages/shared`) | removed | `packages/shared` declared `fast-uri: ^3.1.4` but nothing under `packages/shared/src/` imports it. `shared` is a published package, so the declaration forced the dependency on every external consumer for no reason. Not a vulnerability fix — the declared `^3.1.4` sits **above** `GHSA-q3j6-qgpj-74h6`'s `>=3.0.0 <=3.1.3` range. `fast-uri` remains in the shared lock at 3.1.4 as a legitimate transitive of Ajv, and the root `overrides` pin is untouched (it still holds the floor for Ajv's URI parsing). |

## Taken in the 2026-07-25 pass

Majors that were *not* deferred, with what verification found. Each is listed because the typecheck was clean and the breakage was elsewhere — **a green `tsc` is not evidence a major landed safely.**

| Dependency | Move | What verification caught |
|-----------|------|--------------------------|
| `chokidar` | 3.6.0 → **5.0.0** | v4 removed glob support, and a glob pattern silently resolves to watching **nothing** — `getWatched()` returns `{}` and no event fires, which is indistinguishable from a quiet system. Station watched `agents/*/agent.json` and `integrations/*/integration.json`, so config hot-reload would have stopped working with no error. Migrated to directory watches plus an explicit `isWatchedConfigPath` predicate, covered by `src-server/domain/__tests__/config-loader-watch.test.ts`. |
| `js-yaml` | 4.3.0 → **5.2.2** | v5 is ESM-only and ships **no default export**, but `@types/js-yaml@4` still declared one — so `import yaml from 'js-yaml'` typechecked cleanly and broke 50 knowledge-store tests at runtime. Converted to named imports and **removed `@types/js-yaml`** entirely: js-yaml now ships its own types, and keeping the DefinitelyTyped package installed is exactly what let the broken import pass. |
| `neo4j-driver` | 5.28.3 → **6.2.0** | The API surface Station uses (`auth.basic`, `driver()`, `session().run()`) was verified unchanged against the installed v6 package before accepting. |
| `@playwright/test` | 1.58.2 → **1.62.0** | Same-major-line browser tooling. |
| `@biomejs/biome` | 2.4.6 → **2.5.5** | New formatter output plus a new `noUnsafeOptionalChaining` rule that found four real optional-chain-then-dereference bugs in tests. `biome.json`'s `$schema` pin moves with it — keep those in lockstep. |
| `@types/node` | 25.9.3 → **26.1.1** | Matches the Node 24 runtime contract. |
| `wait-on` | 8.0.5 → **9.1.0** | Test-harness only. |

Alongside these, the ~40 semver-compatible in-range updates were taken as one batch. Two latent inconsistencies surfaced and were corrected: the root package declared `@kontourai/station-shared: ^0.1.0` against a workspace package at `0.4.0` (a range its own workspace member did not satisfy), and `npm update` tried to narrow `packages/sdk`'s **peer** range from `^18.0.0 || ^19.0.0` to `^19.2.8` — reverted, because narrowing a published peer range is a semver-meaningful contract change, not a routine bump.

## What is *not* deferred

Minor/patch bumps and same-major upgrades are batched and merged after the local gate (biome + tsc + unit tests + a boot smoke where a runtime dep changed).

The current critical/high advisory floor and the exception procedure are documented in [Dependency security](../guides/dependency-security.md); `npm run audit:policy` enforces it. Vite 7.3.6 and Vitest/coverage 3.2.6 are landed security-compatible baselines, not deferred work — only their next major migrations remain deferred.
