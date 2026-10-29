# Pull request guides

A guide is an AI-written reading tour of a pull request, shared by everyone
using the same Station server. It explains the change in stops, with code
excerpts, files, questions, and occasional **Look closely** decisions.

In **Settings → Agent runs**, enable **Review guides** and choose a **Review
guide model**. An empty model uses the server's structure model. The configured
model must be available through Station's managed model connections. Generating
a guide sends the pull request's title, diff, and bounded changed-file context
to that model. **Review guide instructions** change emphasis and reading order;
they cannot remove file coverage or change excerpt validation.

Open a pull request in the Pull Requests pane, choose **Guide**, then **Write
guide**. Generation continues while you visit another tab. Return to inspect
progress or a failure, and move through the stops with **Previous** and **Next**.
Use **Rewrite guide** to try again or incorporate a new revision or preference.
Ordinary requests reuse a guide for the current head; Rewrite explicitly forces
regeneration. A request for a newer head is refused while an older head is running.
Code excerpts can receive keyboard focus; scroll horizontally to read long lines.
The Guide tab is read-only: return to **Review** to comment or approve.

A push makes the saved guide stale. On the next guide read, Station compares
its head SHA with the provider's current head and hides obsolete excerpts and
line notes. The guide's original SHA remains visible. Rewriting produces a guide
for the current revision; an old guide never counts as reviewing a new head.

Generation reads bounded Git blobs through an admitted repository snapshot,
without creating a checkout or running Git smudge filters. It gives the model
no tools and requests structured guide output. Station reads the merge-base-to-head change, so a
stacked pull request covers its own layer. Both exact commits must already be
available in the project's checkout; Station does not fetch missing commits.
Submodules follow
Station's repository-read policy and are not entered. Review conversations are
not supplied to the model, including resolved conversations.

Guides support up to 500 changed files, a bounded diff and context, eight model
stops, and an optional final stop naming files the model did not explain.
Invalid excerpt paths, ranges outside a diff hunk, or excerpts over 25 lines
fail generation. An excerpt longer than 25 inclusive lines fails the whole run
with a specific limit message; split long passages into shorter excerpts when
rewriting. Station runs at most two guides at once; additional requests
are refused so they can be retried later. Completed guides persist by forge,
repository, pull request, and head SHA across restarts. In-progress and failure
status is process-local; after a restart, choose **Rewrite guide** if needed.

Agents with bound operator authority can use `write_pull_request_guides` to
request a batch of 1–20 exact project/forge/repository/PR targets, and
`read_pull_request_guide` to inspect the result. An over-limit batch is rejected
before any request starts. Set `force: true` to rewrite an existing current-head
guide; otherwise it is reused. Capacity is checked before reading a forge
snapshot. Refused requests return an MCP error; a batch with any refusal is
marked as an error and retains every per-target result. Each admitted request
starts independently; a batch
can contain both starts and capacity refusals. These tools do not post reviews,
change source files, or approve a pull request.

Guides do not yet support project-specific instructions, generation by an
external coding engine, excerpt selection for comments, question-to-chat
actions, or a finish-review workflow. Questions are reading prompts only.

While a guide is running, the Guide tab polls process-local status every 15 seconds
without rereading the forge snapshot. It reads the full guide once the run settles.
Failures distinguish invalid model output, missing commits, oversized changes,
Git timeouts, storage limits, and changed access. Saved-guide read failures and
disabled-guide requests have separate messages from model failures. The preparation and model request
share a three-minute time budget. Guide generation disables VoltAgent's automatic model retries:
an excerpt-length failure is reported after the first attempt instead of being
replaced by a later generic error or timeout. Use **Rewrite guide** to try again,
or choose a model that follows the excerpt bounds.
