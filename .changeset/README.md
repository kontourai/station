# Workspace release notes

Use `npm run changeset` to select packages from the current pnpm workspace.
The private root application, `@kontourai/station-core`, is not a member of
that release set. Do not add it to `pnpm-workspace.yaml` to satisfy a changeset.

For a root-application-only change, keep its release explanation in the PR and
use `npm run changeset -- --empty` if an acknowledgement file is needed. An
empty changeset has no package entries between its two `---` lines. If a
workspace package also changes, name only the affected workspace package(s).

Run `npm run changesets:check` before submitting. It uses the installed
Changesets CLI's own workspace discovery, configuration and release planner
to validate every retained changeset, including references and release types.
It does not publish, version files or require a local Git base branch.
`ci:fast` runs the same check before package builds and type checks.
