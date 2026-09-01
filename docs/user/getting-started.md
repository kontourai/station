# Getting Started

Station is a local-first workspace for agent work. This guide covers a signed
macOS/Linux install when its release ring is published, first launch, Provider
setup, and routine lifecycle.

## Before You Install

You need:

- Node.js 24.x
- npm 10 or newer
- git, curl, and tar
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login`

Authentication is used for GitHub release metadata and attestation checks.
There is no unsigned fallback.

Optional, Linux only: a C++ toolchain (`g++`, `make`, `python3`) to compile
the `node-pty` native module that powers interactive terminal panes. macOS
and Windows use shipped prebuilds. Without a toolchain on Linux, Station
still installs and runs, but terminal panes are unavailable and `station
doctor` reports the degraded terminal capability with the remediation
(`npm rebuild node-pty` after installing the toolchain, then restart).
Agent execution does not use `node-pty` and works either way.

## Install Or Upgrade

```bash
sh -c 'set -eu; file=$(mktemp "${TMPDIR:-/tmp}/station-install.XXXXXX"); trap '\''rm -f "$file"'\'' EXIT HUP INT TERM; curl -fsSL https://raw.githubusercontent.com/kontourai/station/main/install.sh >"$file"; chmod 600 "$file"; GH_TOKEN=$(gh auth token) sh "$file"'
```

For an available signed release, the installer verifies its GitHub OIDC attestation and SHA-256
receipt before it builds and starts Station. The stable channel installs under
`~/.station/installs/stable`, writes runtime data to
`~/.station/instances/stable`, and owns the
`station` launcher in `~/.local/bin`. Open `http://localhost:18000` after the
command completes.

When a signed beta ring is available, export `STATION_CHANNEL=beta` before running the same
installer command. Preview is a release provenance name; the local runtime is
the **beta** channel. It uses a separate `~/.station/installs/beta` install root,
`~/.station/instances/beta` runtime,
`station-beta` launcher, and `http://localhost:28000` UI. Do not use the
retired `STATION_CHANNEL=preview`; the installer refuses it. The exact channel
identity, launcher, and port mapping are verified by the release installer.

## Choose A Provider

A Provider is anything that can power an agent: a local or hosted model service,
or an external engine that runs its own agent loop.

1. Open **Connections**.
2. Choose a detected Provider or select **Add Provider**.
3. Follow its setup action until it reports **Ready**.

For a credential-free first path, use a supported local model service and then
return to Connections. Detection is read-only: Station does not create a
connection or read credentials merely because it finds a Provider. The
[Connections guide](https://github.com/kontourai/station/blob/main/docs/guides/connections.md)
lists current integrations and their exact setup steps.

Choose the simplest path for what you want to do:

| You want to… | Start with… |
| --- | --- |
| Keep inference on this machine | A local Model Provider and a Station agent |
| Use an existing agent engine | A supported engine Provider and its External agent |
| Use a hosted model through Station | A hosted Model Provider and a Station agent |

## Start Your First Task

When Home offers **Start your first task**, it appears only after the durable
first-run decision is completed and Station has confirmed a real Project. The
action opens that Project's ordinary Task form; it does not create a second
onboarding task type. After creation, Station validates and correlates the
exact existing Task and Project, then
requests the ordinary Task dispatcher once. If the Agent is deferred or
unavailable, Station creates no Task and shows the recoverable readiness reason;
retrying reuses the same project-scoped launch identity. After a launch starts,
a response loss or indeterminate dispatch is **NOT_VERIFIED** — Station never
retries that effect automatically. Replaying the same identity returns the
durable Task/outcome or an indeterminate fence instead of creating a second
Task. The exact Task remains reopenable, and its Session, run, and receipt
owners remain the source for progress rather than Task status. If correlation
cannot be confirmed, the Task still opens with a retry link; retrying that link
never creates another Task.

1. Open a local project.
2. Create a Task for durable work, or start a direct chat for an immediate
   conversation.
3. Choose the Station agent or External agent you want to use.
4. Keep gate state, evidence, route-backs, and receipts with the work as it
   progresses.

If the workspace is not ready, Station keeps the relevant Connections action
visible. Run `station doctor` for a local diagnosis.

## Continue an Attached Session

An attached terminal Session stays read only. The first eligible **Continue in
Station** action launches the bounded `continue-session` Starter: Station
validates the exact source Session, reuses the orchestration adoption ledger
with one stable operation identity, and opens the exact Station-owned child
returned by that owner. Retrying an uncertain response reuses that identity
rather than forking another child. Once the one-time starter is bound, later
continuations use the ordinary owner action and do not overwrite its
correlation. The adoption command receipt is inspectable, but it proves only
that continuation was admitted; useful-work completion remains `NOT_VERIFIED`
until the Session's own evidence says otherwise.
If Station cannot read the one-time correlation state, it starts no
continuation; retry after that read recovers instead of guessing an owner path.

## Arrange Work You Already Own

In a Project, use **Add Pane** and choose **Work Board** to arrange exact
references to current work. It does not replace Home or create a new route.
See [Work Board](work-board.md) for pinning, keyboard controls, recovery, and
the meaning of linked-work states.

## Inspect Approval And Review Evidence

After first run, Home also offers owner-backed inspection cards when Station
can identify a real approval notification or independent-review receipt. The
approval action opens that exact Notifications row without approving or
denying it. The review action opens the exact Project and receipt tuple in
Review at `/review-queue`. Another Project's receipt with the same ID is
never substituted.

These are one-time Starter correlations, not completion checkboxes. Response
loss reuses a deterministic operation identity, reopening a bound card keeps
the original target, and every later observation reads Approval Inbox or
ReviewEvidence again. Missing, stale, unavailable, and `NOT_VERIFIED` owner
states remain visible. A reviewed receipt is evidence input only and does not
by itself satisfy a gate.

## Run A Scheduled Readiness Check

Home can create the canonical disabled `station-starter-check` job and run it
once through the real Scheduler. The job stays disabled unless you explicitly
enable its daily schedule. Station binds the exact Scheduler run before the
Agent can be invoked, so a lost response or retry opens the same receipt and
never starts another check. If Station restarts after binding but before the
Agent begins, **Resume exact check** reuses the operation identity stored in
that binding; it does not create a replacement run. Failed or indeterminate
checks offer **Inspect receipt**, not automatic retry. A completed check proves
execution only; read
its findings and decide what to do rather than treating completion as a passed
gate.

For example, open a repository as a Project, create a Task named “Update the
documentation,” and choose a ready External agent. That work's first execution
is a Session. Reopen the Task later to see its files, evidence, and receipts
together. For a one-off question that does not need that durable history, use a
direct chat instead.

## Update, Stop, Or Uninstall

## Recovery boundaries

Use the recovery path that owns the thing you need to recover. The bundled
client's `station triage` gathers bounded, read-only artifacts; it cannot run a
local source doctor. Run `./station doctor` from a checkout (or portable
release) for host diagnostics. Installer rollback concerns a released program
candidate; `station home backup` and `station home restore` concern one inactive
runtime home and retain the replaced home. They are not interchangeable.

Run the installer again in the same channel to update safely in place. To stop
and start the stable local Station manually:

```bash
station stop
station start
```

To uninstall the stable program while preserving Projects, Providers, Tasks,
and Sessions:

```bash
STATION_CHANNEL=stable "${STATION_ROOT:-$HOME/.station}/installs/stable/current/install.sh" uninstall
```

Use
`STATION_CHANNEL=beta "${STATION_ROOT:-$HOME/.station}/installs/beta/current/install.sh" uninstall`
for beta. Add
`--purge-data` only when you also intend to delete that channel's home
(`~/.station/instances/stable` or `~/.station/instances/beta`). The installer accepts purge only
for a data root it created and marked; it preserves an unmarked pre-existing
directory for manual review.

## Next

- Read [Station concepts](concepts.md).
- Customize [keyboard shortcuts](../guides/keyboard-shortcuts.md).
- Review the [Station privacy policy](https://kontourai.io/privacy/station/).
