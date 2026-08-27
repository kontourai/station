import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { fetchSurveyFlowReviews } from '../query-domains/flowRuns';

function respond(data: unknown): void {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data }),
  } as Response);
}

/**
 * #3322: the aggregate is total over the project inventory, so the Review
 * Queue must be able to tell "no flow reviews" from "one project's sessions
 * file could not be read" — and must never read a loaded source as empty.
 */
describe('fetchSurveyFlowReviews (#3322 aggregate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('carries the unavailable projects beside the served items', async () => {
    respond({
      items: [{ reviewSessionRef: 'review:example:1' }],
      unavailableProjects: [
        { projectSlug: 'broken', reason: 'sessions-unreadable' },
      ],
    });

    await expect(fetchSurveyFlowReviews()).resolves.toEqual({
      items: [{ reviewSessionRef: 'review:example:1' }],
      unavailableProjects: [
        { projectSlug: 'broken', reason: 'sessions-unreadable' },
      ],
    });
  });

  it('adapts the bare item array from a pre-#3322 server instead of reading it as an empty queue', async () => {
    respond([{ reviewSessionRef: 'review:example:1' }]);

    await expect(fetchSurveyFlowReviews()).resolves.toEqual({
      items: [{ reviewSessionRef: 'review:example:1' }],
      unavailableProjects: [],
    });
  });

  it('throws on a response that is neither shape rather than shrinking to zero items', async () => {
    respond({ items: [{ reviewSessionRef: 'review:example:1' }] });

    await expect(fetchSurveyFlowReviews()).rejects.toThrow(
      'Survey Flow reviews response is invalid',
    );
  });

  it('accepts every reason the server can derive', async () => {
    respond({
      items: [],
      unavailableProjects: [
        { projectSlug: 'no-path', reason: 'workspace-unreadable' },
        { projectSlug: 'bad-file', reason: 'sessions-unreadable' },
        { projectSlug: 'defective', reason: 'projection-failed' },
      ],
    });

    const aggregate = await fetchSurveyFlowReviews();

    expect(aggregate.unavailableProjects.map((p) => p.reason)).toEqual([
      'workspace-unreadable',
      'sessions-unreadable',
      'projection-failed',
    ]);
  });

  it('throws on an unavailability reason outside the known vocabulary', async () => {
    respond({
      items: [],
      unavailableProjects: [{ projectSlug: 'broken', reason: 'who-knows' }],
    });

    await expect(fetchSurveyFlowReviews()).rejects.toThrow(
      'Survey Flow reviews unavailability reason is invalid',
    );
  });
});
