# Copy a Git workspace between hosts

Station can create an encrypted copy of a paused Git checkout and restore it
into a fresh directory. The same commands apply to a company's own cloud host,
a development machine, or an operator-managed environment. They require no cloud
provider adapter or Station server connection.

This is a workspace copy, not a complete Station setup migration. It does not
register a Project, install dependencies, enroll credentials, or resume agents.
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
code. Add the checkout to Station through the existing Project workflow and
pair/sign in using the target's normal enrollment flow. The commands themselves
never execute repository scripts or transfer Station execution authority.

For rollback, continue using the unchanged source. A failed import cleans up its
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
`packWorkspace`, `inspectWorkspacePackage`, and `unpackWorkspace`. Receipt types
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
