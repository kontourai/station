# Cedar policy foundation

Station's server-local [adapter](../../src-server/services/policy/cedar-evaluator.ts)
uses official `@cedar-policy/cedar-wasm` **4.13.0** (Apache-2.0).
This foundation has no live authorization callers. Existing authentication,
membership, device scope, grants, approvals, revocation, and transaction checks
remain authoritative. Shadow comparison, activation/storage and enforcement
belong to later work under #3730.

`createPolicySet({ schema, policies })` accepts a Cedar schema (text or JSON)
and an ID-to-policy-text record, validates it in strict mode, and returns either
an immutable policy set or a sanitized denial. Evaluation accepts principal,
action, resource, context and entity facts. Principal and resource entities must
be present, even for policies that do not dereference them. Cedar validates
entity attributes, action applicability and required context against the schema.
Facts are copied per evaluation; no decision or mutable-fact cache exists.
The WASM runtime and up to 64 content-addressed parsed policy sets are reused
for the process lifetime. Restart is required to reclaim that registry.

Each result includes `decision`, SHA-256 `policyRevision` (schema plus policies),
`schemaRevision`, determining policy IDs, and sanitized errors. Revisions derive
from canonical accepted content, including policy IDs; caller-supplied metadata
is ignored. IDs are 1–64 ASCII letters, digits, underscore or hyphen. Runtime
messages, source locations, request values and policy text are never returned.
Errors use closed categories: `initialization`, `input`, `limit`, `policy`,
`evaluation`. A normal policy denial has no error. **Any evaluation diagnostic
error forces deny**, even alongside a matching permit. A forbid overrides a
permit. An initialization failure remains refused for the process lifetime.

The adapter limits each policy-set input and each evaluation input to 256 KiB
of JSON, 16,384 visited values and depth 32, with 1–128 policies and 1,024
entities. Strings are counted in UTF-8. Only plain JSON objects, dense arrays,
booleans, null, strings and safe integer numbers are accepted; accessors,
cycles and lossy number representations are refused. These are admission
bounds, not a CPU deadline or permission to trust stale caller facts.

Cedar returns allow/deny. Station's ask/defer and human consent orchestration
remain outside that result. A permit cannot supply missing Station authority,
consume a grant or approve a request.

## Packaging and verification

The Node 24 ESM server build emits `dist-server/cedar-policy-probe.js` and
keeps Cedar's official CommonJS Node entry external. The shared
[externals list](../../scripts/lib/server-build-config.mjs) feeds the
[desktop/portable runtime stager](../../scripts/lib/desktop-server-runtime.mjs),
which preserves the package-relative `.wasm`. No daemon, network or AWS account
is needed. The build also includes upstream LICENSE and NOTICE under
`dist-server/third-party/cedar/`; the npm tarball omits these license files.

Run:

```sh
npm run build:server
STATION_PROBE_REVISION=$(git rev-parse HEAD) node scripts/probe-packaged-cedar.mjs
npm run test:focused -- src-server/services/policy/__tests__/cedar-evaluator.test.ts
```

The [packaged probe](../../scripts/probe-packaged-cedar.mjs) stages only Cedar's
runtime closure and the real esbuild probe into a temporary install outside the
checkout, disables network connections, evaluates 200 requests with 16 policies and 128 entities, removes WASM
as a failure control, then restores and reevaluates. It reports initialization,
warm median/p95, process memory and artifact bytes. These bounded diagnostic
measurements have no performance SLA and do not measure a live request route.
The behavioral suite owns permit, no permit, forbid, validation, malformed facts,
revision integrity and permit-plus-error semantics.

This probe does not establish a complete portable archive install, native
installer/WebView behavior, Linux/Windows execution, mobile execution, provider
interception, activation, revocation, or release qualification. Record the exact
source revision and host with each executed receipt.
