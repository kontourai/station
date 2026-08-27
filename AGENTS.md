# Station agent instructions

## Start here

- GitHub issues and pull requests own live work state. Before trusting a checkout, inspect `git status -sb` and its relationship to `origin/main`.
- Work only in a sibling worktree (`../station-worktrees/<lane>`), never the primary checkout or a nested worktree. Preserve intentional changes: never use `git stash`; after review begins, integrate upstream with `git merge origin/main`, not rebase.
- Use an isolated Station home, instance name, and non-default ports. Ports 3141 and 3000 belong to the user.
- Run `npm run dependencies:ci` to arm hooks. Before editing, use `npm run gate:for -- <paths...>`; it routes to focused evidence. Run selected tests with `npm run test:focused -- <file...>`, not ad-hoc `npx vitest`.
- `npm run test:changed -- --base=origin/main --explain` selects a diagnostic lane; exit 3 is provisional/deferred, not completion. The only completion evidence command is `npm run full:regression`; join or reuse an in-flight same-digest request rather than rerunning green work. Submission freezes a worktree and is not completion evidence.
- Builder `tests-evidence` requires the canonical completion receipt; focused test evidence remains diagnostic.
- Diagnose the failure rather than rerun-to-green: a red lane is a signal to diagnose, not a request to rerun until green. For a redundant same-digest run, join or reuse the existing lease.
- After focused proof, freeze the worktree before `npm run full:regression:submit`. Never use shell background or relaunch loops, and do not edit or remove a worktree with a live handoff.

## Read only the route you need

Codex loads this root file when launched here; it does not automatically load nested instructions after touching files. Read the routed scope explicitly. Claude loads nested `CLAUDE.md` when it reads that directory; each nested file imports its paired `AGENTS.md`.

| Touched path | Read |
| --- | --- |
| `src-server/**` | [src-server/AGENTS.md](src-server/AGENTS.md) |
| `src-ui/**` | [src-ui/AGENTS.md](src-ui/AGENTS.md) |
| `scripts/**`, `.github/**`, root configuration, package scripts | [scripts/AGENTS.md](scripts/AGENTS.md) |
| `src-desktop/**` | [src-desktop/AGENTS.md](src-desktop/AGENTS.md) |
| `packages/contracts/**` | [packages/contracts/AGENTS.md](packages/contracts/AGENTS.md) |
| `packages/sdk/**` | [packages/sdk/AGENTS.md](packages/sdk/AGENTS.md) |
| `tests/**` | [tests/AGENTS.md](tests/AGENTS.md) |

Read [docs/glossary.md](docs/glossary.md), the affected canonical guide, and [docs/architecture/module-map.md](docs/architecture/module-map.md) only when their topic is in scope. Station consumes sibling Kontour products through published contracts, never their internals. `docs/strategy/roadmap.md` is historical, not live authority.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
