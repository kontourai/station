# Copy a Git workspace between hosts

Station can create an encrypted copy of a paused Git checkout and restore it
into a fresh directory. The same commands apply to a company's own cloud host,
a development machine, or an operator-managed environment. Package-only commands require no cloud
provider adapter or Station server connection; Project registration uses an
already authenticated target.

This is a workspace copy, not a complete Station setup migration. The unpack command does not
register a Project; the optional combined command below does. Neither installs
dependencies, enrolls credentials, or resumes agents.
The [cloud move design](../design/cloud-move.md) tracks those separate steps.

## Prepare the source

Use a Station CLI build containing `cloud pack-workspace`, Node 24, and Git with
bundle version 2 support (version 3 and SHA-256 support for SHA-256 repositories).
Use matching CLI versions on both hosts; the initial format is
`station.workspace-package/v1`. Stop agents, editors that save automatically,
and other writers to the checkout and its Git metadata before capture. Keep
those writers stopped until the command finishes. `--source-paused` records your
acknowledgement; it does not stop processes or fence execution. Source rechecks
detect many changes but do not create an atomic snapshot.

Use a trusted local checkout with an existing commit and complete HEAD history.
Choose existing private parent directories outside the checkout and its backing
Git directory for both the package and key. This includes linked worktrees.

```bash
station cloud keygen --output=/private/keys/workspace.key
station cloud pack-workspace --workspace=/work/acme-project \
  --key-file=/private/keys/workspace.key \
  --output=/private/exports/acme.workspace.enc --source-paused --json
station cloud inspect-workspace --archive=/private/exports/acme.workspace.enc \
  --key-file=/private/keys/workspace.key --json
```

The package uses AES-256-GCM with a random nonce and a 32-byte key. Outputs are
created exclusively: existing key, package, and destination paths are refused.
POSIX keys must have private permissions. On Windows, place keys and packages in
a directory whose ACL grants access only to the operator; POSIX mode bits do not
establish that Windows ACL. Keep the key separate from the package, and transfer
it through an authenticated private channel. Possession of both allows reading
and replacing the package. Encryption does not establish a sender's identity.

Project files and committed history can contain secrets, including deleted
secrets in old commits. This tool does not scan or redact them. Review the
checkout before export; metadata inspection cannot establish that history is
secret-free. Inspection prints file paths, hashes, and sizes, so treat its output
as private project metadata too.

## Restore on the target

Copy the encrypted package to your selected host using your organization's
transfer mechanism, such as authenticated SSH. Provision the key separately.
The destination must not exist; its parent must already exist.

```bash
station cloud inspect-workspace --archive=/private/import/acme.workspace.enc \
  --key-file=/private/keys/workspace.key --json
station cloud unpack-workspace --archive=/private/import/acme.workspace.enc \
  --key-file=/private/keys/workspace.key --destination=/work/acme-import --json
git -C /work/acme-import/workspace status --short
```

The checkout is `/work/acme-import/workspace`; its adjacent
`workspace-package-receipt.json` records the HEAD, branch, counts, and transfer
limitations. Inspection authenticates the envelope and checks content/path and
Git expansion budgets. Import additionally runs Git's object validation. A
successful inspection alone does not prove that Git will accept the package.

Compare the target HEAD, staged diff, unstaged diff, and expected untracked files
with the source before using it. Configure target remotes and credentials
explicitly. Review project scripts before installing dependencies or running
code. Use the target's normal pairing/sign-in flow before registration. The package
commands themselves never execute repository scripts or transfer Station
execution authority.

## Verify the restored checkout

Pause writers to the restored checkout, then compare it with the original
package before accepting the copy:

```bash
station cloud verify-workspace --archive=/private/import/acme.workspace.enc \
  --key-file=/private/keys/workspace.key --workspace=/work/acme-import/workspace \
  --workspace-paused --json
```

Verification checks HEAD, branch, staged index entries, Git content policy, and
supported working-file bytes. It reuses the bounded capture/import codecs and
validates the target-derived Git objects in an isolated temporary import. It
rechecks target metadata after that import and around the final file read.
Unexpected nonignored files, missing files, modified bytes, changed staged state,
or changed branch/policy fail verification. It never repairs or rewrites the
selected checkout.

The result includes the exact encrypted package's SHA-256 and an observation
timestamp. They identify what was checked; they are not a lease, freshness
promise, or permission to execute. Paused-writer acknowledgement does not fence
processes or provide an atomic live snapshot. Ignored untracked files, other Git
refs, external configuration and credentials remain outside the comparison.
On POSIX, physical executable intent is checked even when Git ignores mode
changes. Windows reports that physical executable-bit verification is unavailable;
its staged Git mode intent is still compared.

Verification uses private temporary storage, including a temporary plaintext
checkout for Git validation, and removes it on ordinary success/failure. A crash
can leave that scratch directory under the system temporary directory; inspect
ownership before cleanup. The same package limits apply, and sufficient scratch
space is required. This validates selected captured state, not every unreferenced
object or configuration file in `.git`.

## Import and register in one command

For a new import, `import-project` composes unpacking with the same Project API
used below. Select an already enrolled Station, an unused slug, a fresh local
destination, and the path that the target server will see after import:

```bash
station cloud import-project --archive=/private/import/acme.workspace.enc \
  --key-file=/private/keys/workspace.key --destination=/work/acme-import \
  --target-workspace=/work/acme-import/workspace \
  --name="Acme imported workspace" --slug=acme-imported --station=cloud-dev
```

An explicit `--api-base` may replace `--station` for an already authenticated
operator CLI; use its existing credential environment/store. Credentials are
never command output or package content. The first cloud release uses normal
owner-approved Station pairing; company SSO is a later integration. Cloud IAM
access never implicitly enrolls a Station browser.

This command requires the package to be present on the machine running the CLI.
It does not upload to the cloud or discover a Docker mount mapping. Set
`--target-workspace` to that explicit mapping, as described below. It selects
`shared` workspace mode so later use of the checkout can see imported working
bytes. It does not start any agent.

Before import, the CLI checks the exact slug on the selected target. Auth,
transport and existing-slug failures leave no import. After unpacking it verifies the local checkout against the package. A local
verification failure retains the checkout and attempts no Project creation. On
success it writes `workspace-project-request.json` beside the checkout, then sends one create
request and reads the resulting Project back. Only matching ID/slug/path
responses produce `workspace-project-registration.json` and a registered receipt.
The registration receipt carries the nested local verification result, including
its package digest and platform limits. Target filesystem verification still
requires normal workspace reads; matching
Project metadata alone does not prove a correct mount or usable provider.

If registration fails, races with another creator, or loses its reply, the
command preserves the imported files and reports registration as unconfirmed.
It never silently retries, overwrites a Project, or deletes imported work. Use
`projects get` on the **same enrolled target** and compare with the saved request
before taking another action. A missing success receipt does not prove the
server rejected the request. If no Project exists and you choose to retry, use
the existing `projects create` command with the `project` object from the saved
request; do not rerun import over an existing destination. A crash can leave a
partial import and must be inspected separately. The receipt is an operator
record, not a signed authority transfer or idempotency key.

## Register the restored checkout as a target Project

Use the existing Project API through `station projects create`. There is no
second cloud-specific Project registry. Select an already enrolled target
Station explicitly with `--station`; do not rely on whichever local server
happens to be the current default. The JSON file below is a reviewed request to
create a **new** target Project, not a portable identity or authority manifest.

Save this as `target-project.json`, adjusting its name, unused slug, and path:

```json
{
  "name": "Acme imported workspace",
  "slug": "acme-imported",
  "workingDirectory": "/work/acme-import/workspace",
  "defaultWorkspaceIsolation": "shared"
}
```

```bash
station projects create --station=cloud-dev --file=target-project.json
station projects get acme-imported --station=cloud-dev
```

`workingDirectory` is the path visible to the **target Station process**. With
Docker, map the host directory through a persistent bind mount or named volume,
then use its container path in the request. For example, a host import mounted
at `/workspace/imported` uses `/workspace/imported/workspace`. A path on the
operator's laptop is not automatically available to a remote server. Make sure
the target process UID can read and write it; package import creates private
files owned by the importing user.

The returned Project ID is newly allocated by the target. Do not copy source
Project IDs, room references, authority leases, agents, environment selections,
or credential references into this request. A workspace copy cannot establish
continuity of those identities. Before any agent starts, review the target
Project path, available provider, credentials, and intended workspace mode.
`shared` uses this restored checkout, including its uncommitted bytes. A new
`worktree` starts from Git history and should not be assumed to include those
uncommitted bytes. Stop source work before deliberately continuing it elsewhere;
this flow does not enforce exclusive execution ownership.

An explicit slug makes retries observable: a duplicate create returns a conflict
instead of overwriting the existing Project. If the create response is lost,
run `projects get` and compare its ID, name and path before deciding whether the
request succeeded. Do not automatically switch to a new slug or update an
unrelated Project. A successful create alone does not verify filesystem access,
provider enrollment, membership, or agent readiness. Read the restored files
through the target's normal workspace UI/API and verify Git state as well.

For rollback, continue using the unchanged source. A failed unpack cleans up its
new destination when still owned by that operation. A process or machine crash
can leave a partial destination: inspect it and choose a new path for retry.
Successful output is retained if a later filesystem durability operation fails;
do not overwrite it blindly. Remove only operator-owned temporary packages,
keys, and unused imports under your organization's retention policy. This is
not a transactional backup of a running Station home.

## Preserved and unsupported content

| Content | Behavior |
| --- | --- |
| Current HEAD ancestry and branch/detached HEAD | Preserved; other branches, tags, stashes and reflogs omitted |
| Staged files, staged deletions and uncommitted blob objects | Preserved in a normalized index; index stat caches omitted |
| Working files, deletions and nonignored untracked files | Exact bytes preserved, including binary files |
| Executable files | POSIX executable intent preserved; Windows filesystem semantics differ |
| Git ignore policy | Source effective ignore rules select untracked files; ignored untracked bytes omitted |
| Git content policy | Only `core.autocrlf`, `core.eol`, and `core.filemode` carried over |
| Git config, hooks, remotes and external credentials | Omitted; configure explicitly on the target |
| Shallow history, symlinks, submodules, unresolved index entries | Refused |
| Sparse/assume-unchanged/intent-to-add index state | Refused |
| External attribute policy and custom clean/smudge filters, including LFS | Refused; require a separate adapter |
| Case/Unicode-colliding paths, reserved Windows names, Git metadata aliases | Refused for cross-filesystem portability |
| Station home, plugin state, sessions and agent credentials | Outside this format's scope |

Ignore rules outside the checkout are not installed on the target. A source's
private local/global Git configuration is never copied wholesale. Tracked files
remain included even when an ignore pattern matches them. Git's content diff is
a better cross-host comparison than cached source status after a configuration
change, since the target index is reconstructed.

## Resource budgets and integration contract

The initial implementation supports small workspaces. Limits are fixed in the
format implementation, not provider configuration: 5,000 paths per list, 8 MiB
per file, 24 MiB total working-file bytes, 64 MiB decoded JSON, and 16 MiB each
for the history bundle and staged-object pack. The two Git packs together admit at most
20,000 objects and 64 MiB of summed inflated-object/delta-result work; individual
objects, delta bases, and delta results are limited to 8 MiB. Historical and
unreferenced objects count too. Each Git subprocess has a 30-second timeout and
16 MiB output limit. These budgets are not a total process-memory guarantee.
Larger repositories require a future streaming or remote-Git adapter; raising
limits is not a deployment tuning interface.

The public Node API is
`@kontourai/station-shared/workspace-package`: `createWorkspacePackageKey`,
`packWorkspace`, `inspectWorkspacePackage`, `unpackWorkspace`, and
`verifyWorkspacePackage`. Receipt types
live in `@kontourai/station-contracts/cloud-move`. The CLI delegates to this
implementation so provider integrations can reuse the same semantics. A hosted
service must add tenant authorization, source/destination ownership, isolated
resource budgets, key handling, and authenticated transport before exposing
these operations. This synchronous local API is not a hostile-upload endpoint
or a multi-tenant sandbox.

Behavioral tests exercise real Git capture/import, linked worktrees, SHA-256,
delta history, tamper refusal, unsafe paths, unsupported source policy, and
malformed Git expansion budgets. They do not prove cloud transfer, browser
enrollment, or live agent continuation. Those require separate deployment
qualification using the [integration guide](integrating-station.md).


The container smoke journey (`scripts/container-smoke.sh` and
`tests/container-self-host.spec.ts`) creates a synthetic package, imports it into
persistent storage as the runtime user, registers it through the existing
Project route, checks unauthorized and duplicate creation refusals, reads the
restored files and Git state, and repeats reads after container recreation.
The source checkout is removed before the server starts; the synthetic key is
removed after the combined registration command finishes.
This qualifies the single-host operator path; it does not qualify multi-tenant
membership or a real agent continuation.
