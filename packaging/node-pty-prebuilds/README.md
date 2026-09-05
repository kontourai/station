# node-pty Linux prebuilds

Attested, digest-pinned Linux builds of the exact `node-pty` version pinned in
`pnpm-lock.yaml`, staged into `node_modules/node-pty/prebuilds/<target>/`
by the dependency lifecycle (#1245) so a Linux install does not need a C++
toolchain. Upstream node-pty ships prebuilds for darwin and win32 only; its
own loader and install hook already understand this `prebuilds/` layout, so
staging slots into upstream with no fork and no vendored package.

## Contents

- `manifest.json` — which targets have a pinned artifact, with each file's
  sha256 and its measured glibc/libstdc++ symbol-version floor. An empty
  `artifacts` map means no prebuild ships yet and every Linux install
  compiles from source exactly as before.
- `<target>/pty.node` — the binary for `linux-x64` / `linux-arm64` (glibc),
  present only for targets listed in `manifest.json`.

## Trust chain

1. Artifacts are built by `.github/workflows/node-pty-prebuilds.yml`: the
   approved dependency lifecycle compiles node-pty from the integrity-pinned
   lockfile tarball, `scripts/verify-node-pty-prebuild.mjs` re-proves the
   artifact standalone (upstream `scripts/prebuild.js` exits 0, the module
   loads from `prebuilds/` with no `build/` directory and no node-gyp, and it
   passes Station's real-PTY handshake), and
   `actions/attest-build-provenance` binds the file to the workflow run.
2. A reviewed PR commits the artifact and records its sha256 here. The same
   PR must flip the node-pty entry's linux artifact arrays in
   `config/dependency-lifecycle-allowlist.json` to
   `prebuilds/<target>/pty.node` — `scripts/__tests__/dependency-lifecycle.test.ts`
   fails when the manifest and the allowlist disagree.
3. At install time, `scripts/lib/dependency-lifecycle-policy.mjs`
   (`stageNodePtyPrebuild`) refuses to stage a file whose sha256 does not
   match the manifest, and `dependencies:verify` still runs the full
   node-pty-smoke handshake against whatever was staged.

## Scope decisions

- **glibc baseline:** artifacts are built on `ubuntu-22.04` runners; the
  authoritative floor is the measured `GLIBC_*`/`GLIBCXX_*` values recorded
  per artifact in `manifest.json`. A host below the floor falls back to
  compiling from source (`node scripts/prebuild.js || node-gyp rebuild`).
- **musl (Alpine) is out**, deliberately: no musl artifact is built or
  staged. musl hosts keep the compile path, with #1244's loud terminal
  degradation as the toolchain-less floor.
- **spawn-helper** is a darwin-only executable; Linux prebuilds are
  `pty.node` alone, so npm's executable-bit stripping does not apply here.
- `npm_config_build_from_source=true` skips staging entirely and compiles
  from source, matching upstream's own opt-out.

## Refreshing

Rebuild only when `pnpm-lock.yaml` moves node-pty to a new version (the
consistency test fails until the manifest follows), or on a node-pty
security advisory. node-pty is an N-API addon: artifacts are ABI-stable
across Node majors and do not need rebuilding for a Node upgrade.
