# Bounded agent work

Station can reduce repeated context and tool-schema loading while keeping the
source, authority and result of each operation visible. These capabilities are
[Feature previews](../user/settings.md#feature-previews), off by default. They
are independent choices; turning one on grants no additional tool permission.

## Review a Project's working configuration

In **Project settings → Sources → Where Agent work starts**, discover the
repository guidance, then review the proposed rules, validation commands,
completion criteria, checkpoints and evidence pointers before applying them.
Only the operator in person can discover or change this host-filesystem
configuration. Applying it saves defaults; it runs no setup, installation,
validation command or model.

Discovery follows bounded files inside the selected execution root and reports
incomplete reads. It pins the Project incarnation, root identity and source
content digest. Rediscovery preserves authored choices. A changed source or
Project refuses a stale apply or mandatory Task context read; review the new
snapshot instead of silently proceeding without guidance.

The [Task brief owner](../../src-server/services/projects/task-brief-source.ts)
serves both dispatch and `get_task_brief`. It shares one 16K-character bound
across Task state, reviewed Project rules, guidance and source pointers. Scoped
repository rules without a known relevant path stay lazy pointers. Omission
counts and exact reviewed revisions remain visible. A smaller brief alone does
not establish a smaller whole model prompt or measured savings.

## Load tools as needed

The progressive-tools preview initially lists `list_tool_families` and
`load_tool_family` for eligible runtime tokens. Loading a family exposes the
existing registrations and schemas under that token's private incarnation.
Source selection, custody filters and call-time authorization remain in force.
Another token starts with its own index; rotation and revocation invalidate the
old capability. Disabling the preview restores static discovery.

Claude keeps its existing native on-demand tool search. External leases and
engines without this runtime admission retain their static selection. Actual
engine handling of dynamic list notifications needs qualification separately
from MCP transport fixtures.

Codex built-in Control and Knowledge credentials travel in private thread
JSON-RPC configuration as HTTP headers. They stay outside spawn argv and retain
**delegated-custody** assurance. Only Station's in-process credential supplies
bound assurance; private delivery does not itself authorize browser or device
control.

## Review and use a learning

In **Project settings → Sources → Learning review**, choose an exact standing
record from a done Task, or a rated response whose canonical turn belongs to
this Project. Edit the candidate's wording and expected effect, inspect its
supporting and conflicting evidence, then submit an evaluation and decision.
Knowledge Kit owns the revisioned lifecycle through its published API. Station
stores no parallel candidate index or activation state.

Approval and activation are separate owner intents. Activation registers a
revision for Project context consumers; it does not install a Skill, deploy a
rule, establish consumption or prove a successful effect. A Task brief quotes
only currently active, readable revisions, with their owner references and a
bounded omission disclosure. Trusted first-turn composition receipts retain
the included learning revisions. Review shows up to 100 recent Task turns, not a
complete historical consumption census; opening one still requires current
conversation access. Withdrawal and retirement remove future contribution.
Feedback edits retain exact bounded raw revisions; explicit deletion withdraws
every revision. A changed standing Task source needs review again. Retained
receipts preserve prior history.

No effect observations means no effect was observed. Source timestamps that the
owner did not capture remain unknown. A replaced Project slug or revoked source
cannot expose a cached candidate's identity or body. A refused index, detail,
evidence or prepared-source read clears the protected query namespace and closes
an open inspector or copied proposal. A fresh authoritative read is required to
reopen it. An initial unsupported-host read retains update guidance. This preview uses the
owner's private POSIX file adapter; hosted and Windows hosts do not offer it.

## Compact without rewriting history

The context-compaction preview offers a manual action and `/compact` only when
Station owns that operation. Declared native and ACP commands take precedence.
Engine-owned compaction stays attributed to its engine.

For a Task-bound conversation, **Refresh Task context** reads the current bounded
Task brief without calling a summary model. It also works before the first turn
when the canonical boundary owner confirms there is no active or uncertain
effect. Interactive conversations use the semantic-summary path. Both pin their
data in the existing durable boundary. The successor cuts prior native
and canonical model history; the original transcript remains append-only and
readable. It does not carry native tool, attachment or approval state forward.
Summary generation is a separate model effect and can fail or remain unknown. Its retained
input/output token observation is separate from provider receipt totals; missing
account, price and quota data stay unknown.
A boundary with uncertain execution is not retried under a new identity.

Automatic compaction requires an explicitly enabled, persisted per-conversation
policy and a confirmed current-session model-generation observation. Its
threshold is limited to 5–90 percent. Model identity, input accounting and fresh
capacity must match the actual connection; configured capacity or cumulative
billing totals cannot supply that evidence. Unsupported or unknown combinations
stay unavailable. Safe-turn admission, coalescing and retained backoff prevent
repeated summary attempts on the turn's critical path.

## Retain supervision and question delivery

Opted-in Task supervision retains the Task incarnation, coordinator identity,
checkpoint and known wait state. Reconciliation reads canonical Task and Session
facts; an idle Session does not prove unfinished work. Approval, capacity, quota
and indeterminate delivery remain waits, not invitations to launch duplicates.
The existing durable inbox places eligible work under the original request key.

Task-question versions are also a durable wake outbox. A restart between the
question commit and inbox submission can recover the original version and key.
Each attempt rechecks the lead and its current source access. Failed versions
remain pending with bounded deferral; they are not acknowledged as delivered.

## Compare usage and outcomes honestly

Usage views separate engine-reported cost, immutable estimates and optional
published-rate retail value from account charges, subscription allocation and
quota. Missing billing or quota remains unknown, including when an engine reports
zero cost. A current Task status is an owner fact, not an independent quality
score or proof that a learning saved money.

Retail capture uses reviewed Bearing catalog bytes and route/model-revision
bindings. Source artifact, URL, review time, effective/freshness bounds and cache
and reasoning semantics travel with the frozen snapshot. Missing or conflicting
route/category evidence stays unpriced. Historical reads never fetch today's
prices. Station supplies no invented price table or automatic direct-provider
mapping; the host operator must review an applicable owner observation first.

[Automation actions](../design/automations.md) reuse the same Task dispatcher,
budgets and inbox. Observing GitHub runs alone invokes no model. Action rules
need their own preview, enabled source and matching source grant. Automatic
repair publication additionally needs a proven credential-free repair execution
boundary and a separate deterministic publisher; a prompt or scrubbed environment
cannot establish that separation on a host with ambient write credentials.

Source and fixture evidence for these mechanisms does not establish provider
compatibility, installed/native behavior, live account billing, human usability
or causal cost savings. Those remain separate acceptance observations.

[Controlled visual captures](../learn/media/agent-efficiency-captures.json) retain
390/1440 light/dark examples. The learning comparisons show access granted →
read refused in the same current component, with synthetic owner data. They do
not establish a live account, installed app or causal savings result.

## Run an isolated GitHub repair

Enable **GitHub automation observations** and **Isolated GitHub repairs**
(`isolated-github-repairs`) in Settings → Advanced → Feature previews. Both start
off. This is a personal-host operator API preview: it has no agent/MCP grant
surface or hosted-tenant execution. Running the model can spend provider credits.
Docker, Python 3 and an immutable image containing the pinned Codex CLI must be
available. The command below prepares and separately qualifies that image.

Use the authenticated operator API at `/api/isolated-repairs`. Requests use the
same current operator credential/session as other host administration; a paired
device's management scope alone cannot act as the operator in person. An older
host returns 404/not supported. The Project must name an admitted local Git
repository whose origin matches `owner/repo` exactly and whose local
`refs/remotes/origin/main` contains the selected base. Station does not fetch or
run the Project's setup commands while preparing it.

1. `POST /profiles` creates a disabled execution profile. Supply
   `{ "expectedRevision": 0, "profile": { "kind": "execution", "projectId": "…",
   "agentId": "…", "repository": "owner/repo", "repositoryId": 123,
   "image": "sha256:<immutable-image-id>", "model": "<explicit-model>",
   "reasoningEffort": "medium", "providerAuth": { "env": "REPAIR_PROVIDER_KEY" } } }`.
   Credential references may use Datum's `env`, `keychain` or `op` shapes;
   API responses omit those references and never carry the key. External secret
   tools have a ten-second deadline and bounded output.
2. Create a separate disabled `publisher` profile with repository/repositoryId,
   `appId`, `installationId` and `privateKeyAuth`. It can be configured after the
   repair without another model run. Its credential reference must differ from
   provider references. No App key is materialized while the repair worker runs.
3. Read `GET /profiles` for current revisions. Enable a profile with `POST /profiles/<id>/enable`, sending its current
   `expectedRevision` and `enabled:true`. Reconfiguration increments its revision
   and disables it; profile changes invalidate old execution/publication bindings.
4. `POST /sources` creates a disabled `github-poll` source: name, repository,
   optional existing `credentialSecretBinding`/poll interval, and grants naming
   the exact Project/Agent pair and `isolated-repair`. Also grant `publish-branch`
   if this source may later request publication. The poll credential is the
   existing integration-secret binding, separate from model and App references.
5. `POST /rules` creates a disabled rule with name, sourceId, exact matcher,
   episode policy, rateLimit, and this action:
   `{ "kind":"isolated-repair", "projectId":"…", "agentId":"…",
   "profileId":"<execution-profile-id>", "instructions":"<operator instructions>",
   "budget":{"maxProviderRequests":4,"maxWallRuntimeMs":300000} }`.
   Match the intended workflow path, same head repository, main branch,
   schedule/workflow_dispatch/push event and failure/timed_out conclusion. The
   episode needs keyFields and a green closeOn matcher. This budget limits
   requests and wall time; it is not a token or billing reservation.
6. Read `GET /configuration`, then enable the exact source and rule through
   `POST /configuration/enable` with `{kind:"source"|"rule",id,enabled:true,
   expectedFingerprint}`. Read a new fingerprint between writes. A stale one
   refuses the change. Source, rule, profile and preview checks remain separate.

A matching failure creates one canonical Task and one durable repair run. The
worker receives source files and a short-lived, model-bound provider capability;
it receives no host home, App key or GitHub publishing token. The selected base,
failing run attempt, Task incarnation, policy/profile and source digest are bound
before execution. A regular-file census after verified worker removal produces
the patch and published blobs from the same bytes. Changes are limited to forty
paths with UTF-8 text content changes, 128 KiB per changed old/new file and 1 MiB of new content. Symlinks,
submodules, unsafe/colliding paths and protected controls refuse the proposal.

Use `GET /` to find the run by Task id, then `GET /<run>/artifact` to inspect its
source manifest, patch, worker evidence and digests. A candidate Task enters
Review. `POST /<run>/review` takes bindingDigest, resultDigest, verdict
(`approve`/`reject`) and rationale. Approval completes the Task. Read the artifact again to obtain `review.id`. It still cannot
publish: `POST /<run>/grant` separately pins bindingDigest, resultDigest, reviewId
and publisherId for fifteen minutes. `POST /<run>/publish` consumes that grantId
once. The trusted publisher opens a draft PR; ordinary checks, human review and
the normal landing policy still apply. Main moving requires new reviewable
source; publication never silently rebases or overwrites a different branch.

`revoke` and `cancel` accept an empty JSON object. Cancellation cannot undo an
unknown remote effect. A crash or ambiguous result stays **indeterminate** and
cannot replay or consume its grant again. `POST /<run>/followup` records a
rationale. Once the exact worker is stopped and the owning operation is settled,
`POST /<run>/resolve` requires `acknowledgeUnknownEffects:true` and rationale to
release global admission while retaining indeterminate evidence and its episode
fence. A failed durable release is retryable and cannot be archived as released.
`POST /<run>/archive` retains terminal records; an indeterminate record additionally
requires explicit resolution. Sixteen unarchived run records and 128 archived records
bound retention; export retained state through normal operator home-management
procedures before exceeding the archive ceiling. Repair-run history is not automatically
pruned to make room.

Preview/source revocation stops future execution and publication. Current
operators can still inspect retained evidence and disable, revoke, cancel,
resolve or archive it. Every route is private/no-store. Windows execution,
desktop host UID mapping, live model/account billing and causal savings need
separate qualification. The fixture suite and container command do not establish
those claims or authorize enabling a source on the operator's behalf.

## Qualify the container boundary

With Docker running, build the public generic worker using an explicit Codex CLI
version, then supply the immutable local image ID it prints:

```sh
npm run qualify:isolated-repair:prepare -- --codex-version 0.156.0
npm run qualify:isolated-repair -- --image sha256:<image-id>
```

The [qualification command](../../scripts/qualify-isolated-repair.mjs) uses an
isolated fixture workspace and synthetic provider credentials. A local Responses
fixture directs the real CLI to change one file. It also exercises the public
worker's credential-root mount refusal before provider dispatch, verifies absent
host paths and credential channels, checks read-only root/source mounts, and
requires container cleanup. It removes only its own temporary workspace and
network. It does not call a live model or publish anything.

The generated private receipt and patch are under
`.kontourai/repair-worker-qualification/<invocation>/`; `--output-root` selects
another parent. A clean source snapshot is required for a `PASS` receipt. A dirty
snapshot is labelled `DIAGNOSTIC_ONLY` and exits 3. The source revision, Git status and script
digest are checked again before writing the result. A completed worker invocation
retains its captured stdout, stderr and public receipt; admission failures can
leave no receipt. Missing completion or failed cleanup cannot produce a `PASS`.

The named bridge is pinned by its observed Docker network ID. It permits outbound
network access; this is credential-mount qualification, not an egress firewall.
Desktop UID mapping remains unverified. The authenticated repair API above is
a separate consumer with its own Task/source/review/grant checks. This command
does not configure that consumer, enable sources or change the CI selector.
