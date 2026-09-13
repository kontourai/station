# @kontourai/station-shared

## 0.8.0

### Minor Changes

- 4aca094: Add read-only cloud setup preview and AWS EC2 template preparation. Report credential enrollment, workspace review, and unavailable execution handoff explicitly; do not provision resources or transfer authority.
- 8d785cf: Add a versioned transport-only Station connection binding and maintained-JOSE
  signing/one-shot verification helpers. These proofs bind an independently
  approved signing key to one client challenge, enrollment generation, certificate
  pair and exact connection descriptions; they do not grant application access.
- 96290b2: Add the Device-local connection trust record and public-key validation helpers
  for independent approval, generation-checked rotation and retained revocation.
  These describe endpoint trust only and grant no account or Project access.
- 1344781: Record recovery-from-copy provenance atomically with an offline home restore. Show the snapshot time and explicit absence of transferred execution authority in CLI and JSON output, and expose a bounded read-only recovery-record reader.
  
  Expose a host-scoped system-status disclosure and show a persistent browser recovery notice with snapshot time and explicit authority limits.
- ce6ec59: Add encrypted, bounded Git workspace packages with shared capture, inspection, and fresh-directory import APIs and cloud CLI commands. Preserve supported staged and uncommitted work without transferring credentials or execution authority. Document self-hosted use, resource limits, and recovery.
- 0c3d60e: Verify restored Git workspace contents through the bounded package codecs and emit a package-bound verification receipt. Check fresh local imports before target Project creation, preserving failed imports for explicit recovery and reporting platform limitations.

### Patch Changes

- b8417e5: Add bounded newest-first conversation history hydration and recover complete terminal text from a retained suffix. Expose full saved Station addresses and host-owned native profile editing without forwarding credentials to a changed origin.
- e4d61c8: Wake API initialization readers directly, bound diagnostic telemetry, and separate MCP transport construction from custody while preserving the published API.
  
  Align plugin preview component and conflict kinds with the emitted layout contract and share those types with server and UI producers.
  
  Canonicalize newly allocated temporary homes before admission so read-only source observation shares the writer home identity.
- f6f9497: Add a GCP development target to the shared read-only cloud preview, retaining explicit gaps for provisioning, credentials, and execution transfer. Document the isolated operator-run Compute Engine bootstrap.
- d209461: Keep plugin builds from reinstalling a containing Station workspace. Root-managed
  plugins use the managed dependency bootstrap; standalone nested plugins install
  only into their own directory, preserving the host's lock and dependencies.
- Updated dependencies [4f19d35]
- Updated dependencies [058376c]
- Updated dependencies [e172b3d]
- Updated dependencies [4aca094]
- Updated dependencies [7ef36cc]
- Updated dependencies [e4d61c8]
- Updated dependencies [8d785cf]
- Updated dependencies [a8bbc67]
- Updated dependencies [c3bf345]
- Updated dependencies [96290b2]
- Updated dependencies [1344781]
- Updated dependencies [eb1fd17]
- Updated dependencies [2f941ba]
- Updated dependencies [4e39225]
- Updated dependencies [a777b37]
- Updated dependencies [ce6ec59]
- Updated dependencies [4d38391]
- Updated dependencies [44c019b]
- Updated dependencies [0d75052]
- Updated dependencies [9ccd6e4]
- Updated dependencies [be60151]
- Updated dependencies [0c3d60e]
  - @kontourai/station-contracts@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [1fc735a]
- Updated dependencies [5cb0aaa]
- Updated dependencies [3f6b3c2]
  - @kontourai/station-contracts@0.7.0

## 0.6.0

### Patch Changes

- 4dfc08a: Expose declared provider prompt-cache inclusivity and cache-aware total helpers, which distinguish absent cache measurements from reported zeroes and refuse unverified sums.
- 6905e5f: Publish the bounded, cache-authority-aware usage receipt rollup fold.
- Updated dependencies [6456e42]
- Updated dependencies [a04a5f1]
- Updated dependencies [4dfc08a]
- Updated dependencies [214eb24]
- Updated dependencies [8680665]
- Updated dependencies [f37bdbb]
- Updated dependencies [3be50bb]
- Updated dependencies [0704b6b]
- Updated dependencies [3af06aa]
- Updated dependencies [6905e5f]
  - @kontourai/station-contracts@0.6.0

## 0.5.0

### Patch Changes

- 0602467: Portable integration exports now explicitly distinguish ordinary legacy
  credentials, which `--include-secrets` writes as plaintext, from secret-binding
  references and binding-backed credentials, which never export.
- 737e343: `build`: load esbuild lazily, and stop assuming a `packages/` directory exists.
  
  `buildPlugin` now resolves esbuild through `await import('esbuild')` at the top
  of a layout-plugin build instead of a module-level static import, and reports a
  named, actionable error when it is absent. Nothing about the exported API
  changes — `buildPlugin` was always async — but consumers that only ever read
  config or parse manifests no longer pull esbuild's per-platform native binary
  (~9.9 MB unpacked) into their load path or their install. `@kontourai/station-cli`
  uses this to declare esbuild as an optional peer dependency.
  
  `buildAllowedInputRoots` also stops falling back to a
  `<package>/../packages/shared` path that `resolveWorkspacePackageRoot` has
  already rejected. Inside the monorepo the fallback never fired; outside it — a
  bundled CLI, where `shared` is inlined and no `packages/` directory exists — it
  fired every time and `realpathSync` threw `ENOENT`, so plugin builds were
  impossible from an installed package. A root that is not on disk allows
  nothing, so the containment set narrows rather than widens.
- Updated dependencies [fd9a422]
- Updated dependencies [051d372]
- Updated dependencies [62c5c0d]
- Updated dependencies [278bf3b]
  - @kontourai/station-contracts@0.5.0

## 0.4.0

### Minor Changes

- 2b01d6a: Align @kontourai/station-shared version with @kontourai/station-sdk and @kontourai/station-cli
