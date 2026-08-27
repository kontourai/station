/**
 * Refuse a push whose branch does not contain the current `main`.
 *
 * A pre-push check verifies the branch you are pushing. It does not verify the
 * tree that will actually land: once `main` moves, a squash-merge produces a
 * combination nobody ran the gate against. On 2026-07-25 that put `main` into a
 * failing state four separate times — a lint error, an unorganized-imports
 * error, three accessibility-ratchet violations, and a typecheck failure from a
 * usage-field mapping that has now been reverted three times. Every one of those
 * branches was green when pushed.
 *
 * GitHub would normally close this with "require branches to be up to date
 * before merging", and required status checks would catch it too. Neither is
 * available here: branch protection returns 403 on a private repository without
 * a paid plan, and Actions is billing-blocked. A local pre-push hook is the only
 * enforcement point left, so the freshness check lives there.
 *
 * Escape hatches, in order of preference:
 *   STATION_ALLOW_STALE_BASE=1   — deliberate, one push
 *   git push --no-verify         — skips every hook, not just this
 *
 * Runs only when an `origin/main` ref is present, so a fresh clone, a detached
 * CI checkout, or a repo without that remote is unaffected rather than blocked.
 */

import { execFileSync } from 'node:child_process';

const BASE_REF = process.env.STATION_BASE_REF ?? 'origin/main';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** `null` when the ref does not exist here. */
export function resolveRef(ref, run = git) {
  try {
    return run(['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

/** Does `head` already contain `base`? */
export function containsBase(head, base, run = git) {
  try {
    run(['merge-base', '--is-ancestor', base, head]);
    return true;
  } catch {
    return false;
  }
}

/** How far behind is `head`? Used only to make the message concrete. */
export function commitsBehind(head, base, run = git) {
  try {
    return Number.parseInt(
      run(['rev-list', '--count', `${head}..${base}`]),
      10,
    );
  } catch {
    return 0;
  }
}

export function evaluate({ headSha, baseSha, behind, allowStale }) {
  if (!baseSha) {
    return { ok: true, reason: 'no base ref present; nothing to compare' };
  }
  if (headSha === baseSha) return { ok: true, reason: 'branch is the base' };
  if (allowStale) {
    return { ok: true, reason: 'STATION_ALLOW_STALE_BASE=1' };
  }
  return { ok: false, behind };
}

function main() {
  const headSha = resolveRef('HEAD');
  const baseSha = resolveRef(BASE_REF);
  const contains = baseSha ? containsBase('HEAD', BASE_REF) : true;

  if (baseSha && contains) {
    console.log(`Merge base: branch contains ${BASE_REF}.`);
    return;
  }

  const result = evaluate({
    headSha,
    baseSha,
    behind: baseSha ? commitsBehind('HEAD', BASE_REF) : 0,
    allowStale: process.env.STATION_ALLOW_STALE_BASE === '1',
  });

  if (result.ok) {
    console.log(`Merge base: skipped — ${result.reason}.`);
    return;
  }

  console.error(
    `\nFAIL: this branch is ${result.behind} commit(s) behind ${BASE_REF}.\n\n` +
      'The gate you just passed ran against your branch, not against the tree\n' +
      'that will land. Merging a stale branch produces a combination nobody has\n' +
      'verified — which is how main was broken four times on 2026-07-25.\n\n' +
      `Fix:\n  git fetch origin && git merge ${BASE_REF}\n  npm run ci:fast\n\n` +
      'Deliberate exception: STATION_ALLOW_STALE_BASE=1 git push ...\n',
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
