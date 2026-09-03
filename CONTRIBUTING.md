# Contributing to Station

Station is the agent workspace where work ships with receipts. Start with the
path that matches the change instead of treating every request as a pull
request.

## Choose a path

| Path | Use it for | Start here |
| --- | --- | --- |
| Issue-first | Bugs, regressions, feature requests, and changes whose user outcome or scope needs agreement. | Use the public issue chooser and complete the relevant form. Search for the nearest prior issue first. |
| Safe-direct | Small, uncontroversial corrections that do not change behavior, contracts, security, privacy, release, or workflow policy. | Make a focused change and explain the outcome and evidence in the pull request. |
| Discuss-first | Product direction, architecture, broad refactors, new integrations, or any change with unclear ownership. | Use the [issue chooser](https://github.com/kontourai/station/issues/new/choose). For a discussion/architecture proposal, use the feature form and state the decision needed before implementation. |
| Support | Setup, usage, account, or troubleshooting questions. | Use [Kontour support](https://kontourai.io/support/); do not use a defect form for general help. |
| Security | Suspected vulnerabilities, exposed secrets, or unsafe behavior. | Use the private [Security Advisory](https://github.com/kontourai/station/security/advisories/new) route. Do not open a public issue. |

Do not include secrets, access tokens, private URLs, customer data, or
unredacted diagnostics in public issues, support requests, commits, or pull
requests.

## Make a change

Work from a branch or isolated worktree based on current `main`. Do not use
`git stash`: its ref is shared by every worktree. Source-setup prerequisites
(including the Linux-only C++ toolchain for `node-pty`) are listed in the
[Developer guide](docs/guides/development.md#source-prerequisites).

Use the repository's current contributor and testing guidance rather than
copying commands from an issue or pull request:

- [Contributor command reference](docs/reference/contributor-commands.md)
- [Agent and repository instructions](AGENTS.md)
- [Developer guide](docs/guides/development.md)
- [Testing guide](docs/guides/testing.md)
- [Code-quality guide](docs/guides/code-quality.md)
- [Module map](docs/architecture/module-map.md)

The pull-request template is the handoff contract: state the user outcome,
issue and closure condition, exact commands and receipts, manual inspection,
risk and rollback, and every `NOT_VERIFIED` claim with its owner and reason.
Local evidence does not prove hosted CI, release publication, or Pages
deployment.

## Optional `just` contributor Interface

[`just`](https://just.systems/) is an optional convenience interface over the
existing repository commands. Version **1.44.0 or later** is required because
the Windows recipes use Just's `[script]` attribute. Install it with Homebrew
on macOS (`brew install just`), your Linux distribution's package manager (or
`cargo install just --locked`), or Windows Package Manager (`winget install --id Casey.Just --exact`). Confirm the installed version with `just --version`
before relying on the recipes.

Run `just` from the repository root. On macOS and Linux, quote a forwarded
argument with shell quotes when it contains special characters. In Windows
Command Prompt, use double quotes. For example:

```sh
just doctor --migrate-playbooks --dry-run
just test 'scripts/__tests__/product-laws.test.ts'
```

```bat
just doctor --migrate-playbooks --dry-run
just test "scripts/__tests__/product-laws.test.ts"
```

The [generated contributor command reference](docs/reference/contributor-commands.md)
lists all nine recipes and their platform-specific delegation. `just full` is
only a convenience spelling of `npm run full:regression`; that npm command and
its verification coordinator remain the sole completion authority. The same
distinction applies to every `just` recipe: it does not create a new command
contract or receipt protocol.

Keep these surfaces `NOT_VERIFIED` unless they have their own evidence: GitHub
form rendering, required CODEOWNERS ruleset enforcement, an external-fork
drill, and hosted Pages deployment.

## AI-assisted work and personal responsibility

You remain responsible for every submitted change, including text or code
created with an AI tool. In the pull request, disclose the tool or tools used,
the material areas affected, and the personal inspection you performed. Do not
include prompts, private context, secrets, or customer data in that disclosure.

## External forks

The external-fork contribution path is **NOT_VERIFIED**. Do not claim that a
fork workflow, its checks, or its hosted execution is available or safe until
the repository's trust boundary is independently proven. Use the issue,
discussion, support, and security routes above instead.

## Public documentation

The task-oriented public guide is [Contributing to Station](docs/user/contributing.md).
It explains the public routes without duplicating repository commands or live
delivery state. Public Pages admission is explicit through
`docs/pages/public-docs.json`.
