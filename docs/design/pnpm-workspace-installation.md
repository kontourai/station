# pnpm workspace installation

> Status: implementation proposal; local evidence and hosted delivery remain
> separate. [Issue #516](https://github.com/kontourai/station/issues/516) owns the
> migration and worktree disk problem. Check its linked pull requests for live
> status. The [development guide](../guides/development.md) owns setup commands.

## Problem

Independent npm installations repeat dependency contents across Station's
worktrees. Exhaustion can leave partial installs that look like product
failures. An org-wide pnpm migration selected Station last because its native
lifecycle policy, receipt identity, standalone package audits, and release
inventory depend on the npm installation and lockfile layout.

## Installation boundary

Use one root pnpm lock with all declared workspace importers. Retain npm's
workspace metadata for existing script execution and validate the two lists
for exact parity. `npm run` and npm publication remain supported command
interfaces; package-manager choice is determined by the pinned package manager
and lock/configuration files, not the spelling of the script runner.

Preserve the managed `dependencies:*` entry points. They bootstrap the exact
pnpm pin, force an inert install, inspect all installed lifecycle packages,
validate their locked identity and complete hook set, run approved hooks, and
verify native artifacts. Native pnpm patches replace post-install patching.
Disable pnpm's automatic installation before script execution and dependency
scripts by default, so `pnpm run` cannot execute dependency hooks before this
boundary. Existing verification preflight continues to reject stale installs.

Use a hoisted layout during this migration to retain existing native and
packaging consumers. Each worktree keeps its own installation graph. Use
clone-or-copy imports to prevent native build or permission changes from
propagating through shared hardlinks. Copy-on-write filesystems can share
physical contents; platforms without cloning copy instead. Moving to the
isolated linker is a separate change that needs importer and packaging proof.

## Authority and evidence

The pnpm lock is the only workspace dependency authority. Do not retain an
independently edited npm lock as a compatibility workaround. Independent npm
plugin examples may retain their own locks; they are not workspace authorities.

Dependency receipt identity binds the new lock, workspace settings, manager
pin, lifecycle configuration, and patches. Installed-version preflight reads
each declaring importer's resolution. A malformed or missing required lock must
fail, and a receipt from the npm graph must not become reusable by renaming it.

The offline lock gate checks manifest specifiers, peer-qualified snapshots,
workspace links, override/settings parity, and patch and extension checksums.
Native frozen installation supplements these checks. Frozen installation alone
did not reject an imported unsatisfied peer in a local probe.

Advisory policy uses one registry response with separate full and production
closures for root, SDK, and Shared. It retains severity and residual policy.
Release inventories follow the locked production graph, including workspace
links, aliases, peer contexts, and platform-optional packages; npm PURLs still
identify the registry ecosystem. A tarball integrity hash is not a hash of
post-patch installed contents.

## Refresh existing worktrees

The store does not reclaim existing npm trees by itself. Refresh a worktree
through its owner: preserve intentional source changes and needed receipts,
finish active builds and dependency consumers, integrate the migration, then
run the managed frozen install and artifact verification. The guarded first
conversion retires npm or hybrid dependencies; later pnpm installs reuse the
worktree graph. Do not install a
new dependency graph under an old branch that still expects npm lock authority.

Inspect an interrupted-install guard before retrying. Neither a dead PID nor
an old timestamp proves that derived state is safe to reclaim. Remove finished
worktrees or transfer baselines only after checking ownership, in-flight use,
uncommitted work, and retained evidence; never sweep active dependencies to
make room for another task.

## Verification required for delivery

- Frozen installation and the offline gate reject manifest/lock drift.
- Unknown or altered lifecycle hooks fail before any approved hook runs.
- Script execution cannot implicitly install dependencies or run their hooks.
- Native PTY handshake and patched ESM/CJS imports execute successfully.
- Different importer versions produce distinct preflight results; old receipt
  identities cannot match the new dependency inputs.
- A second worktree reuses stored package contents while keeping independently
  writable native artifacts and patched files.
- Packed packages and relocated native runtime artifacts resolve without the
  source checkout; SBOMs validate against their declared schemas.
- Hosted platform jobs provide their own evidence; local macOS tests do not
  establish Windows, Linux, Android, or iOS success.

Rollback restores the installer, lock authority, and verification readers as
one change. It does not authorize deleting active worktrees or reusing a
partial install. Reinstall through the restored managed command before
recording new verification evidence.
