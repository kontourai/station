# node-pty Linux prebuilds

This directory defines an optional digest-pinned Linux prebuild channel for
the exact `node-pty` version in `pnpm-lock.yaml`. **The current manifest has no
artifacts**, so Linux uses the existing source-build path and still needs its
toolchain. A future reviewed artifact can be staged into
`node_modules/node-pty/prebuilds/<target>/` by the dependency lifecycle (#1245).
The pinned upstream package ships prebuilds for darwin and win32 only; its
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

[#2813](https://github.com/kontourai/station/issues/2813) tracks libc-aware
admission before Linux artifacts are added to this channel. A manifest digest
does not establish host compatibility.

1. Artifacts are built by `.github/workflows/node-pty-prebuilds.yml`: the
   approved dependency lifecycle compiles node-pty from the integrity-pinned
   lockfile tarball, `scripts/verify-node-pty-prebuild.mjs` re-proves the
   artifact standalone (node-pty's upstream `node scripts/prebuild.js` exits 0, the module
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

- **glibc baseline:** the workflow targets Ubuntu 22.04 runners and its verifier
  measures `GLIBC_*`/`GLIBCXX_*` symbol floors. The staging helper currently
  selects only by platform/architecture, version, and digest; it does not check
  the host's libc or those floors. The upstream install hook checks that the
  prebuild directory exists, not that its binary can load. Do not populate this
  channel assuming an incompatible host will automatically rebuild from source.
- **musl (Alpine):** no musl artifact or libc-specific selection exists. With
  today's empty manifest, Linux hosts keep the source-build path. A future
  glibc artifact needs an explicit musl refusal/fallback before admission.
- **spawn-helper** is a darwin-only executable; Linux prebuilds are
  `pty.node` alone, so npm's executable-bit stripping does not apply here.
- `npm_config_build_from_source=true` skips staging entirely and compiles
  from source, matching upstream's own opt-out.

## Refreshing

Rebuild only when `pnpm-lock.yaml` moves node-pty to a new version (the
consistency test fails until the manifest follows), or on a node-pty
security advisory. The pinned package uses `node-addon-api`, which avoids a
per-Node-major V8 ABI build. That does not qualify every Node or libc version:
retain the managed installation and real-PTY handshake when upgrading Node.

The [staging helper](../../scripts/lib/dependency-lifecycle-policy.mjs),
[standalone verifier](../../scripts/verify-node-pty-prebuild.mjs), and
[workflow](../../.github/workflows/node-pty-prebuilds.yml) own this channel.
This source description is not evidence that an artifact has been built,
attested, committed, or exercised on a Linux host.
