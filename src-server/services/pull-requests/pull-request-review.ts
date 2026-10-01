import type {
  PullRequest,
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestChecksObservation,
  PullRequestRepositoryContext,
  PullRequestReviewComment,
  PullRequestReviewCommentsObservation,
  PullRequestReviewInput,
  PullRequestReviewOutcome,
  PullRequestReviewSnapshot,
  PullRequestWriteAdmission,
} from '@kontourai/station-contracts/pull-request-provider';

type Forge = 'github' | 'gitlab';
type Json = Record<string, unknown>;
type Run = (args: string[]) => Promise<{ stdout: string }>;
const record = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The provider returned an incomplete review observation.');
  return value as Json;
};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const sha = (value: unknown) => {
  const text = string(value);
  if (!/^[a-f0-9]{40,64}$/i.test(text))
    throw new Error('The provider did not report an exact revision.');
  return text;
};
function paths(
  forge: Forge,
  context: PullRequestRepositoryContext,
  ref: string,
) {
  if (!/^[1-9]\d*$/.test(ref))
    throw new Error('Choose an exact pull request number.');
  const { owner, name } = context.repository;
  const repo =
    forge === 'github'
      ? `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      : `projects/${encodeURIComponent(`${owner}/${name}`)}`;
  return {
    repo,
    detail: `${repo}/${forge === 'github' ? 'pulls' : 'merge_requests'}/${ref}`,
  };
}
function revisions(forge: Forge, value: Json) {
  return forge === 'github'
    ? { head: sha(value.headRefOid), base: sha(value.baseRefOid) }
    : {
        head: sha(record(value.diff_refs).head_sha),
        base: sha(record(value.diff_refs).base_sha),
      };
}
async function detail(
  forge: Forge,
  host: string,
  context: PullRequestRepositoryContext,
  ref: string,
  run: Run,
  withChecks = false,
) {
  const repository = `${host}/${context.repository.owner}/${context.repository.name}`;
  return record(
    JSON.parse(
      (
        await run(
          forge === 'github'
            ? [
                'pr',
                'view',
                ref,
                '--repo',
                repository,
                '--json',
                `number,url,title,body,state,author,headRefName,baseRefName,headRefOid,baseRefOid,commits,reviews,comments,mergeable${withChecks ? ',statusCheckRollup' : ''}`,
              ]
            : [
                'mr',
                'view',
                ref,
                '--repo',
                `https://${repository}`,
                '--output',
                'json',
              ],
        )
      ).stdout,
    ),
  );
}
/**
 * The most check contexts one review carries to the client. `gh pr view
 * --json statusCheckRollup` pages the rollup itself (gh 2.97.0 returned 162
 * contexts for one upstream pull request), so everything it returns is kept
 * up to this payload bound, and only a rollup beyond it is partial. 1000 is
 * well past the largest CI matrices seen on a single head while keeping the
 * snapshot a bounded message.
 */
const GITHUB_CHECK_ROLLUP_CAP = 1000;
/** One page of inline comments; a full page may have more behind it. */
const PULL_REQUEST_REVIEW_MAX_INLINE_COMMENTS = 100;
const INLINE_COMMENT_BODY_MAX = 8192;
const INLINE_COMMENT_TOTAL_MAX = 65_536;

const httpsUrl = (value: unknown) => {
  const text = string(value);
  try {
    return new URL(text).protocol === 'https:' ? text : undefined;
  } catch {
    return undefined;
  }
};

const GITHUB_CONCLUSION: Record<string, PullRequestCheckState> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  TIMED_OUT: 'failure',
  STARTUP_FAILURE: 'failure',
  ACTION_REQUIRED: 'failure',
  NEUTRAL: 'neutral',
  STALE: 'neutral',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
};
const GITHUB_STATUS_STATE: Record<string, PullRequestCheckState> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending',
};
const GITLAB_PIPELINE_STATE: Record<string, PullRequestCheckState> = {
  success: 'success',
  failed: 'failure',
  canceled: 'cancelled',
  canceling: 'cancelled',
  skipped: 'skipped',
  manual: 'neutral',
  created: 'pending',
  waiting_for_resource: 'pending',
  preparing: 'pending',
  pending: 'pending',
  running: 'pending',
  scheduled: 'pending',
};

/**
 * The checks the forge reports for the observed head. GitHub's
 * `statusCheckRollup` mixes check runs and commit statuses; GitLab reports
 * the head pipeline. An entry this reader does not understand makes the
 * observation partial rather than being guessed at.
 */
function readChecks(
  forge: Forge,
  value: Json,
  head: string,
): PullRequestChecksObservation {
  if (forge === 'gitlab') {
    const pipeline = value.head_pipeline;
    if (pipeline === null || pipeline === undefined)
      return { state: 'available', checks: [], partial: false };
    try {
      const p = record(pipeline);
      if (string(p.sha) !== head)
        return {
          state: 'unavailable',
          // A merged-results pipeline runs on a merge commit the MR payload
          // never names, so it cannot be tied to the observed head here.
          reason: /^refs\/merge-requests\/\d+\/merge$/.test(string(p.ref))
            ? 'The latest pipeline is a merged-results pipeline; it ran on a merge commit, not on the observed head. Open the forge to see it.'
            : 'The latest pipeline ran on a different revision.',
        };
      const state = GITLAB_PIPELINE_STATE[string(p.status)];
      if (!state)
        return {
          state: 'unavailable',
          reason:
            'The provider reported a pipeline state Station does not know.',
        };
      const url = httpsUrl(p.web_url);
      return {
        state: 'available',
        partial: false,
        checks: [
          {
            name: `Pipeline ${String(p.id ?? '')}`.trim(),
            state,
            ...(url ? { url } : {}),
          },
        ],
      };
    } catch {
      return {
        state: 'unavailable',
        reason: 'The provider returned an incomplete pipeline.',
      };
    }
  }
  const rollup = value.statusCheckRollup;
  if (!Array.isArray(rollup))
    return {
      state: 'unavailable',
      reason: 'The provider did not report checks.',
    };
  const checks: PullRequestCheck[] = [];
  let partial = rollup.length > GITHUB_CHECK_ROLLUP_CAP;
  for (const entry of rollup.slice(0, GITHUB_CHECK_ROLLUP_CAP)) {
    try {
      const item = record(entry);
      if (item.__typename === 'CheckRun') {
        const name = string(item.name);
        const state =
          item.status === 'COMPLETED'
            ? GITHUB_CONCLUSION[string(item.conclusion)]
            : 'pending';
        if (!name || !state) throw Error('Unknown check run');
        const url = httpsUrl(item.detailsUrl);
        const group = string(item.workflowName);
        checks.push({
          name,
          state,
          ...(group ? { group } : {}),
          ...(url ? { url } : {}),
        });
      } else if (item.__typename === 'StatusContext') {
        const name = string(item.context);
        const state = GITHUB_STATUS_STATE[string(item.state)];
        if (!name || !state) throw Error('Unknown status');
        const url = httpsUrl(item.targetUrl);
        checks.push({ name, state, ...(url ? { url } : {}) });
      } else throw Error('Unknown check kind');
    } catch {
      partial = true;
    }
  }
  return { state: 'available', checks, partial };
}

/**
 * Inline review comments, one page from the forge. GitHub maps each
 * comment onto the current diff itself (`line` null once outdated); a
 * GitLab note is placed only when it was made on the observed head.
 */
async function readReviewComments(
  forge: Forge,
  host: string,
  detailPath: string,
  head: string,
  run: Run,
): Promise<PullRequestReviewCommentsObservation> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      (
        await run([
          'api',
          forge === 'github'
            ? `${detailPath}/comments?per_page=${PULL_REQUEST_REVIEW_MAX_INLINE_COMMENTS}`
            : `${detailPath}/discussions?per_page=${PULL_REQUEST_REVIEW_MAX_INLINE_COMMENTS}`,
          '--hostname',
          host,
        ])
      ).stdout,
    );
    if (!Array.isArray(raw)) throw Error('Not a list');
  } catch {
    return {
      state: 'unavailable',
      reason: 'The provider could not supply inline review comments.',
    };
  }
  let partial = raw.length >= PULL_REQUEST_REVIEW_MAX_INLINE_COMMENTS;
  let remaining = INLINE_COMMENT_TOTAL_MAX;
  const comments: PullRequestReviewComment[] = [];
  const push = (comment: PullRequestReviewComment) => {
    const body = comment.body.slice(
      0,
      Math.min(INLINE_COMMENT_BODY_MAX, remaining),
    );
    if (body.length < comment.body.length) partial = true;
    if (!remaining) {
      partial = true;
      return;
    }
    remaining -= body.length;
    comments.push({ ...comment, body });
  };
  for (const entry of raw) {
    try {
      if (forge === 'github') {
        const c = record(entry);
        const id = String(c.id ?? '');
        const path = string(c.path);
        if (!id || !path) throw Error('Missing comment identity');
        const url = httpsUrl(c.html_url);
        push({
          id,
          author: string(record(c.user).login),
          body: string(c.body),
          createdAt: string(c.created_at),
          path,
          side: c.side === 'LEFT' ? 'deletions' : 'additions',
          subject: c.subject_type === 'file' ? 'file' : 'line',
          line:
            c.subject_type !== 'file' && Number.isInteger(c.line)
              ? (c.line as number)
              : null,
          ...(c.in_reply_to_id != null
            ? { inReplyTo: String(c.in_reply_to_id) }
            : {}),
          ...(url ? { url } : {}),
        });
        continue;
      }
      const discussion = record(entry);
      const notes = Array.isArray(discussion.notes) ? discussion.notes : [];
      let first: string | undefined;
      for (const value of notes) {
        const note = record(value);
        if (note.type !== 'DiffNote' || !note.position) continue;
        const position = record(note.position);
        const id = String(note.id ?? '');
        const path = string(position.new_path) || string(position.old_path);
        if (!id || !path) throw Error('Missing note identity');
        const newLine = position.new_line;
        const oldLine = position.old_line;
        const side = Number.isInteger(newLine) ? 'additions' : 'deletions';
        const line = Number.isInteger(newLine)
          ? (newLine as number)
          : Number.isInteger(oldLine)
            ? (oldLine as number)
            : null;
        push({
          id,
          author: string(record(note.author).username),
          body: string(note.body),
          createdAt: string(note.created_at),
          path,
          side,
          subject: 'line',
          line: string(position.head_sha) === head ? line : null,
          ...(first ? { inReplyTo: first } : {}),
        });
        first ??= id;
      }
    } catch {
      partial = true;
    }
  }
  return {
    state: 'available',
    comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    partial,
  };
}

/** All reads use the same explicit forge identity; the checkout never supplies diff bytes. */
export async function readPullRequestReview(
  forge: Forge,
  host: string,
  context: PullRequestRepositoryContext,
  ref: string,
  run: Run,
  normalize: (value: unknown, host: string) => PullRequest,
): Promise<PullRequestReviewSnapshot> {
  const address = paths(forge, context, ref);
  const first = await detail(forge, host, context, ref, run);
  const revision = revisions(forge, first);
  let diff: PullRequestReviewSnapshot['diff'];
  try {
    const patch = (
      await run(
        forge === 'github'
          ? [
              'api',
              address.detail,
              '--hostname',
              host,
              '-H',
              'Accept: application/vnd.github.diff',
            ]
          : ['api', `${address.detail}/raw_diffs`, '--hostname', host],
      )
    ).stdout;
    diff =
      Buffer.byteLength(patch, 'utf8') > 262_144
        ? {
            state: 'unavailable',
            reason:
              'This diff exceeds the in-app review size limit. Open it on the forge.',
          }
        : { state: 'available', patch, completeness: 'provider-output' };
  } catch {
    diff = {
      state: 'unavailable',
      reason:
        'The provider could not supply this diff. Refresh or open it on the forge.',
    };
  }
  let partial = false;
  let values: Array<{ value: unknown; kind: 'comment' | 'review' }> = [];
  if (forge === 'github') {
    for (const [field, kind] of [
      ['comments', 'comment'],
      ['reviews', 'review'],
    ] as const) {
      if (!Array.isArray(first[field])) {
        partial = true;
        continue;
      }
      const all = first[field] as unknown[];
      if (all.length >= 100) partial = true;
      values.push(...all.slice(-100).map((value) => ({ value, kind })));
    }
  } else {
    try {
      const notes: unknown = JSON.parse(
        (
          await run([
            'api',
            `${address.detail}/notes?per_page=100&sort=desc&order_by=created_at`,
            '--hostname',
            host,
          ])
        ).stdout,
      );
      if (!Array.isArray(notes)) throw Error('Missing notes');
      partial = notes.length >= 100;
      values = notes.slice(0, 100).map((value) => ({ value, kind: 'comment' }));
    } catch {
      partial = true;
    }
    try {
      const approvals = record(
        JSON.parse(
          (
            await run([
              'api',
              `${address.detail}/approvals`,
              '--hostname',
              host,
            ])
          ).stdout,
        ),
      );
      if (!Array.isArray(approvals.approved_by))
        throw Error('Missing approvals');
      if (approvals.approved_by.length > 100) partial = true;
      values.push(
        ...approvals.approved_by.slice(0, 100).map((entry) => {
          const approval = record(entry);
          const user = record(approval.user);
          if (!user.id) throw Error('Missing approver');
          return {
            kind: 'review' as const,
            value: {
              id: `approval:${user.id}`,
              author: user,
              body: '',
              state: 'APPROVED',
              createdAt: string(approval.approved_at),
            },
          };
        }),
      );
    } catch {
      partial = true;
    }
  }
  const discussion: PullRequestReviewSnapshot['discussion'] = [];
  let remaining = 65_536;
  for (const entry of values) {
    try {
      const v = record(entry.value);
      const author = record(v.author ?? v.user);
      const body = string(v.body);
      const text = body.slice(0, Math.min(8192, remaining));
      if (text.length < body.length) partial = true;
      if (!remaining) {
        partial = true;
        break;
      }
      remaining -= text.length;
      const id = String(v.id ?? '');
      if (!id) throw Error('Missing discussion id');
      discussion.push({
        id,
        author: string(author.login ?? author.username),
        body: text,
        createdAt: string(v.createdAt ?? v.submittedAt ?? v.created_at),
        kind: entry.kind,
        ...(typeof v.state === 'string' ? { state: v.state } : {}),
        ...(typeof v.commit_id === 'string' ? { headSha: v.commit_id } : {}),
      });
    } catch {
      partial = true;
    }
  }
  const reviewComments = await readReviewComments(
    forge,
    host,
    address.detail,
    revision.head,
    run,
  );
  // The closing read asks for checks too. When it fails, the review still
  // loads from a plain read with its checks unavailable, and only gh's own
  // refusal of the field blames gh's version. The plain read is kept even
  // after a timed-out (killed) read: it is the read that confirms the head
  // the diff was taken against, and nothing earlier can stand in for it.
  let last: Json;
  let checksRefused: string | undefined;
  try {
    last = await detail(forge, host, context, ref, run, true);
  } catch (error) {
    if (forge !== 'github') throw error;
    last = await detail(forge, host, context, ref, run);
    checksRefused = refusesStatusCheckRollup(error)
      ? 'This gh cannot report checks (it predates the statusCheckRollup field). Update gh to see them.'
      : 'The provider did not answer the checks read. Refresh to try again.';
  }
  const latest = revisions(forge, last);
  if (latest.head !== revision.head || latest.base !== revision.base)
    throw new Error(
      'The pull request changed during review loading. Refresh to inspect its current revision.',
    );
  const pullRequest = normalize(last, host);
  if (pullRequest.ref !== ref)
    throw new Error('The provider returned a different pull request.');
  return {
    pullRequest: {
      ...pullRequest,
      repository: {
        owner: context.repository.owner,
        name: context.repository.name,
      },
    },
    headSha: revision.head,
    baseSha: revision.base,
    observedAt: new Date().toISOString(),
    diff,
    discussion: discussion.sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
    discussionPartial: partial,
    // From the closing read: the same head the diff was confirmed against.
    checks: checksRefused
      ? { state: 'unavailable', reason: checksRefused }
      : readChecks(forge, last, revision.head),
    reviewComments,
  };
}

/**
 * gh's own refusal of the `--json` field, read from stderr alone. The
 * runner's message carries the argv, and the field name is in that argv, so
 * matching the message would call a 403, an auth failure or a timeout
 * "old gh".
 */
function refusesStatusCheckRollup(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return (
    typeof stderr === 'string' &&
    stderr.includes('Unknown JSON field: "statusCheckRollup"')
  );
}

/** A lost acknowledgement is not a refusal and must not invite an automatic duplicate. */
export async function writePullRequestReview(
  forge: Forge,
  host: string,
  context: PullRequestRepositoryContext,
  ref: string,
  input: PullRequestReviewInput,
  run: Run,
  admission?: PullRequestWriteAdmission,
): Promise<PullRequestReviewOutcome> {
  let entered = false;
  try {
    const address = paths(forge, context, ref);
    const expected = sha(input.expectedHeadSha);
    if (
      (input.body?.length ?? 0) > 16_384 ||
      (input.action === 'comment' && !input.body?.trim())
    )
      return {
        status: 'refused',
        reason: 'Enter a comment of at most 16384 characters.',
      };
    const actor = record(
      JSON.parse((await run(['api', 'user', '--hostname', host])).stdout),
    );
    if (!actor.id || !string(actor.login ?? actor.username))
      throw Error('Missing actor');
    if (forge === 'gitlab' && input.action === 'approve' && input.body?.trim())
      return {
        status: 'refused',
        reason:
          'This provider does not attach a message to an approval. Post the message as a comment first.',
      };
    const current = revisions(
      forge,
      await detail(forge, host, context, ref, run),
    );
    if (current.head !== expected)
      return {
        status: 'refused',
        reason:
          'The pull request head changed. Refresh and review the new revision.',
      };
    const args =
      forge === 'github'
        ? [
            'api',
            `${address.detail}/reviews`,
            '--hostname',
            host,
            '--method',
            'POST',
            '-f',
            `commit_id=${expected}`,
            '-f',
            `event=${input.action === 'approve' ? 'APPROVE' : 'COMMENT'}`,
            ...(input.body ? ['-f', `body=${input.body}`] : []),
          ]
        : [
            'api',
            `${address.detail}/${input.action === 'approve' ? 'approve' : 'notes'}`,
            '--hostname',
            host,
            '--method',
            'POST',
            '-f',
            input.action === 'approve'
              ? `sha=${expected}`
              : `body=${input.body}`,
          ];
    if (admission?.isCurrent() === false) throw Error('Station access changed');
    entered = true;
    const observed = record(JSON.parse((await run(args)).stdout));
    if (forge === 'github') {
      const user = record(observed.user);
      if (
        observed.commit_id !== expected ||
        observed.state !==
          (input.action === 'approve' ? 'APPROVED' : 'COMMENTED') ||
        user.id !== actor.id ||
        !observed.id
      )
        throw Error('Unconfirmed review receipt');
      return {
        status: 'confirmed',
        nativeId: String(observed.id),
        actor: string(user.login),
        headSha: expected,
      };
    }
    if (input.action === 'approve') {
      if (
        !Array.isArray(observed.approved_by) ||
        !observed.approved_by.some(
          (entry) => record(record(entry).user).id === actor.id,
        ) ||
        !observed.id
      )
        throw Error('Unconfirmed approval receipt');
      return {
        status: 'confirmed',
        nativeId: String(observed.id),
        actor: string(actor.username),
        headSha: expected,
      };
    }
    if (
      !observed.id ||
      record(observed.author).id !== actor.id ||
      observed.body !== input.body
    )
      throw Error('Unconfirmed comment receipt');
    return {
      status: 'confirmed',
      nativeId: String(observed.id),
      actor: string(actor.username),
    };
  } catch {
    return entered
      ? {
          status: 'indeterminate',
          reason:
            'The provider may have accepted this review, but its acknowledgement could not be verified. Refresh and inspect the discussion before trying again.',
        }
      : {
          status: 'refused',
          reason:
            'The current provider identity and revision could not be verified. Nothing was submitted.',
        };
  }
}
