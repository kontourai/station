import { github } from './qualification-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/;

function identity(pr) {
  return JSON.stringify([
    pr.number,
    pr.state,
    pr.base?.ref,
    pr.base?.sha,
    pr.base?.repo?.full_name,
    pr.base?.repo?.id,
    pr.head?.ref,
    pr.head?.sha,
    pr.head?.repo?.full_name,
    pr.head?.repo?.id,
    pr.mergeable,
    pr.merge_commit_sha,
  ]);
}

/** Read the live owner and main before and after the mergeability observation. */
export async function checkPrMergeability({ number, head, repository, env }) {
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !SHA.test(head ?? '') ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')
  )
    throw new Error('invalid PR admission identity');
  const options = { env: { ...env, GITHUB_REPOSITORY: repository } };
  const firstRef = await github('git/ref/heads/main', options);
  const first = await github(`pulls/${number}`, options);
  const merge =
    first.mergeable === true && SHA.test(first.merge_commit_sha ?? '')
      ? await github(`git/commits/${first.merge_commit_sha}`, options)
      : null;
  const second = await github(`pulls/${number}`, options);
  const lastRef = await github('git/ref/heads/main', options);
  const base = firstRef?.object?.sha;
  if (
    !SHA.test(base ?? '') ||
    firstRef?.ref !== 'refs/heads/main' ||
    lastRef?.ref !== 'refs/heads/main' ||
    firstRef?.object?.type !== 'commit' ||
    lastRef?.object?.type !== 'commit' ||
    lastRef?.object?.sha !== base ||
    identity(first) !== identity(second) ||
    first.number !== number ||
    first.state !== 'open' ||
    first.base?.ref !== 'main' ||
    first.base?.sha !== base ||
    first.base?.repo?.full_name !== repository ||
    first.head?.repo?.full_name !== repository ||
    !Number.isSafeInteger(first.base?.repo?.id) ||
    first.base.repo.id < 1 ||
    first.head?.repo?.id !== first.base.repo.id ||
    first.head?.sha !== head ||
    typeof first.head?.ref !== 'string' ||
    !first.head.ref
  )
    return { eligible: false, reason: 'identity-or-base-changed' };
  if (first.mergeable === false)
    return { eligible: false, reason: 'conflict', head, base };
  if (first.mergeable !== true)
    return { eligible: false, reason: 'mergeability-unknown', head, base };
  if (
    !merge ||
    merge.sha !== first.merge_commit_sha ||
    !Array.isArray(merge.parents) ||
    merge.parents.length !== 2 ||
    merge.parents[0]?.sha !== base ||
    merge.parents[1]?.sha !== head
  )
    return { eligible: false, reason: 'merge-identity-unknown', head, base };
  return { eligible: true, reason: 'mergeable', head, base };
}
