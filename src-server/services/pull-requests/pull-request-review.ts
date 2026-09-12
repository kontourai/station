import type {
  PullRequest,
  PullRequestRepositoryContext,
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
                'number,url,title,body,state,author,headRefName,baseRefName,headRefOid,baseRefOid,commits,reviews,comments,mergeable',
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
  const last = await detail(forge, host, context, ref, run);
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
  };
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
