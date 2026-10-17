import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import type {
  PullRequestReviewGuide,
  PullRequestReviewGuideResult,
} from '@kontourai/station-contracts/pull-request-review-guide';
import { JsonFileStore } from '../infra/json-store.js';
import { assertPullRequestLinkIdentity } from './conversation-pull-request-link-store.js';
import { ReviewGuideError } from './pull-request-review-guide-errors.js';
import { guideOutputSchema } from './pull-request-review-guide-normalize.js';

/** Versioned, per-repository/PR/head documents. No migration of pre-existing user data is needed. */
export class PullRequestReviewGuideStore {
  constructor(private readonly home: string) {}
  key(identity: PullRequestLinkIdentity) {
    assertPullRequestLinkIdentity(identity);
    return createHash('sha256')
      .update(
        JSON.stringify([
          identity.provider,
          identity.host.toLowerCase(),
          identity.repository.owner.toLowerCase(),
          identity.repository.name.toLowerCase(),
          identity.ref,
        ]),
      )
      .digest('hex');
  }
  private document(key: string, head: string) {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{40,64}$/i.test(head))
      throw Error('Invalid guide identity.');
    const directory = join(this.home, 'pull-request-guides', key);
    return {
      directory,
      store: new JsonFileStore<{
        version: 1;
        guide: PullRequestReviewGuide;
      } | null>(join(directory, `${head}.json`), null, {
        durableAtomicWrite: true,
        onCorruption: 'throw',
        maxReadBytes: 256 * 1024,
      }),
    };
  }
  read(
    identity: PullRequestLinkIdentity,
    head: string,
  ): PullRequestReviewGuide | null {
    const value = this.document(this.key(identity), head).store.read();
    if (!value) return null;
    if (
      value.version !== 1 ||
      value.guide.headSha !== head ||
      !Number.isFinite(Date.parse(value.guide.generatedAt)) ||
      typeof value.guide.modelSelection !== 'string'
    )
      throw Error('Stored guide is invalid.');
    // Normalization may add one final coverage stop beyond the model's eight.
    for (const stop of value.guide.stops)
      guideOutputSchema.parse({ stops: [stop] });
    if (value.guide.stops.length > 9) throw Error('Stored guide is invalid.');
    return value.guide;
  }
  latest(identity: PullRequestLinkIdentity): PullRequestReviewGuide | null {
    const pointer = new JsonFileStore<{ head: string } | null>(
      join(this.home, 'pull-request-guides', this.key(identity), 'latest.json'),
      null,
      { onCorruption: 'throw', maxReadBytes: 1024 },
    ).read();
    return pointer ? this.read(identity, pointer.head) : null;
  }
  write(identity: PullRequestLinkIdentity, guide: PullRequestReviewGuide) {
    const { directory, store } = this.document(
      this.key(identity),
      guide.headSha,
    );
    const document = { version: 1 as const, guide };
    if (
      Buffer.byteLength(JSON.stringify(document, null, 2), 'utf8') >
      256 * 1024
    )
      throw new ReviewGuideError('stored-too-large');
    mkdirSync(directory, { recursive: true });
    store.write(document);
    new JsonFileStore(
      join(directory, 'latest.json'),
      { head: guide.headSha },
      { durableAtomicWrite: true, onCorruption: 'throw', maxReadBytes: 1024 },
    ).write({ head: guide.headSha });
  }
}

export function guideResult(
  guide: PullRequestReviewGuide | null,
  currentHeadSha: string | null,
  run: PullRequestReviewGuideResult['run'] = null,
): PullRequestReviewGuideResult {
  // Never return obsolete line anchors, even to non-UI consumers.
  return {
    guide:
      guide && guide.headSha !== currentHeadSha
        ? {
            ...guide,
            stops: guide.stops.map((stop) => ({
              ...stop,
              excerpts: [],
              notes: [],
            })),
          }
        : guide,
    currentHeadSha,
    excerptContents: [],
    run,
  };
}
