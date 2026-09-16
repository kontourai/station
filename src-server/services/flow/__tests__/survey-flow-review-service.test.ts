import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewItem } from '@kontourai/survey';
import { initialReviewQueueSessionState } from '@kontourai/survey/review-workbench';
import { createServerReviewSessionRecord } from '@kontourai/survey/review-workbench/server-review-session';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileStationSurveyReviewSessionStore,
  type StationSurveyReviewSession,
  SurveyFlowReviewService,
} from '../survey-flow-review-service.js';

const roots: string[] = [];

function domainNeutralReviewItem(
  name = 'public-record-status',
  candidateSetStatus?: 'escalated' | 'resolved',
): ReviewItem {
  return {
    apiVersion: 'survey.kontourai.io/v1alpha1',
    kind: 'ReviewItem',
    metadata: { name },
    spec: {
      target: 'availabilityStatus',
      ...(candidateSetStatus ? { candidateSetStatus } : {}),
      candidates: [
        {
          id: 'current',
          role: 'current',
          value: 'AVAILABLE',
          source: { sourceRef: 'https://example.test/current' },
          extraction: { extractionId: 'extract-current' },
          claimTarget: { claimType: 'public-data.field' },
        },
        {
          id: 'proposed',
          role: 'proposed',
          value: 'WAITLIST',
          source: { sourceRef: 'https://example.test/proposed' },
          extraction: { extractionId: 'extract-proposed' },
          claimTarget: { claimType: 'public-data.field' },
        },
      ],
    },
  } as ReviewItem;
}

async function fixture(
  projectSlug = 'example',
  items: readonly ReviewItem[] = [domainNeutralReviewItem()],
) {
  const root = await mkdtemp(join(tmpdir(), 'station-survey-review-'));
  roots.push(root);
  const snapshot = initialReviewQueueSessionState(items);
  const record = createServerReviewSessionRecord({
    sessionName: 'domain-neutral-review',
    snapshot,
    eventCount: 0,
    updatedAt: '2026-07-22T12:00:00.000Z',
  });
  await mkdir(join(root, '.station'), { recursive: true });
  await writeFile(
    join(root, '.station', 'survey-review-sessions.json'),
    JSON.stringify({
      sessions: [
        {
          reviewSessionRef: 'review:example:1',
          projectSlug,
          record,
          events: [],
          currentSnapshot: snapshot,
          currentEventCount: 0,
          projectionSource: 'example.harvest',
          workflowSubjectRef: 'public-record:entity-123',
        },
      ],
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('SurveyFlowReviewService', () => {
  it('projects canonical Survey state without interpreting review semantics', async () => {
    const root = await fixture();
    const store = new FileStationSurveyReviewSessionStore({
      listSlugs: () => ['example'],
      workspace: () => root,
    });
    const [item] = await new SurveyFlowReviewService(store).list('example');

    expect(item).toMatchObject({
      reviewSessionRef: 'review:example:1',
      workflowSubjectRef: 'public-record:entity-123',
      projectionSource: 'example.harvest',
      summary: { unresolved: 1 },
    });
    expect(item.items[0]?.targetLabel).toBe('Availability Status');
  });

  /**
   * #2064 review MED-2, at the derivation rather than at a fixture of it.
   *
   * Survey's `reviewSessionSummary` files an UNDECIDED item whose
   * `candidateSetStatus` is `escalated` under `escalated` and one whose status
   * is `resolved` under `accepted` — both read as `unresolved: 0` while
   * `continuePausedGate` (which passes `requiredResolvedItems: 'all'`) still
   * refuses, because neither item has a recorded decision. The whole point of
   * `pendingDecisions` is that it disagrees with `summary.unresolved` here.
   */
  it('counts escalated items as awaiting a decision, though Survey reports unresolved 0', async () => {
    const root = await fixture('example', [
      domainNeutralReviewItem('escalated-one', 'escalated'),
      domainNeutralReviewItem('escalated-two', 'escalated'),
    ]);
    const store = new FileStationSurveyReviewSessionStore({
      listSlugs: () => ['example'],
      workspace: () => root,
    });
    const [item] = await new SurveyFlowReviewService(store).list('example');

    // The exact shape the reviewer reproduced, pinned so the disagreement
    // between the two numbers is the assertion rather than a coincidence.
    expect(item.summary).toMatchObject({ escalated: 2, unresolved: 0 });
    expect(item.pendingDecisions).toBe(2);
  });

  /**
   * The other half of the same divergence: `candidateSetStatus: 'resolved'`
   * with no recorded decision is counted as `accepted` by Survey's summary,
   * yet continuation has no result for it. Asserted because the arithmetic
   * `items.length - (accepted + keptCurrent + rejected + couldNotConfirm)`
   * — the obvious replacement for `unresolved` — gets this case wrong, and
   * reading the continuation's own `unresolvedItemNames` gets it right.
   */
  it('counts a resolved-but-undecided item as awaiting a decision', async () => {
    const root = await fixture('example', [
      domainNeutralReviewItem('resolved-no-decision', 'resolved'),
    ]);
    const store = new FileStationSurveyReviewSessionStore({
      listSlugs: () => ['example'],
      workspace: () => root,
    });
    const [item] = await new SurveyFlowReviewService(store).list('example');

    expect(item.summary).toMatchObject({ accepted: 1, unresolved: 0 });
    expect(item.pendingDecisions).toBe(1);
  });

  it('fails closed when a foreign project binding is placed in a project store', async () => {
    const root = await fixture('taxes');
    const store = new FileStationSurveyReviewSessionStore({
      listSlugs: () => ['example'],
      workspace: () => root,
    });

    await expect(store.list('example')).rejects.toThrow(
      'project binding does not match',
    );
  });

  it('serves healthy projects and names the one with a corrupt sessions file (#3322)', async () => {
    const healthy = await fixture();
    const corrupt = await mkdtemp(join(tmpdir(), 'station-survey-corrupt-'));
    roots.push(corrupt);
    await mkdir(join(corrupt, '.station'), { recursive: true });
    await writeFile(
      join(corrupt, '.station', 'survey-review-sessions.json'),
      '{ not json',
    );
    const diagnostics: Array<{ projectSlug: string }> = [];
    const service = new SurveyFlowReviewService(
      new FileStationSurveyReviewSessionStore({
        listSlugs: () => ['example', 'broken', 'no-workspace'],
        workspace: (slug) =>
          slug === 'example'
            ? healthy
            : slug === 'broken'
              ? corrupt
              : undefined,
      }),
      { diagnostic: (projectSlug) => diagnostics.push({ projectSlug }) },
    );

    const aggregate = await service.listAll([
      'example',
      'broken',
      'no-workspace',
    ]);
    expect(aggregate.items.map((item) => item.reviewSessionRef)).toEqual([
      'review:example:1',
    ]);
    // The missing-workspace project stays a normal empty state, not an
    // unavailability; only the corrupt file is named.
    expect(aggregate.unavailableProjects).toEqual([
      { projectSlug: 'broken', reason: 'sessions-unreadable' },
    ]);
    expect(diagnostics).toEqual([{ projectSlug: 'broken' }]);
  });

  it('reports a workspace that cannot be traversed as workspace-unreadable, not as a bad sessions file (#3322)', async () => {
    const healthy = await fixture();
    const parent = await mkdtemp(join(tmpdir(), 'station-survey-notdir-'));
    roots.push(parent);
    // The workspace path is a regular file, so the sessions path cannot be
    // traversed at all — there is no file to go and fix.
    const notADirectory = join(parent, 'workspace-is-a-file');
    await writeFile(notADirectory, 'not a directory');
    const service = new SurveyFlowReviewService(
      new FileStationSurveyReviewSessionStore({
        listSlugs: () => ['example', 'blocked'],
        workspace: (slug) => (slug === 'example' ? healthy : notADirectory),
      }),
    );

    const aggregate = await service.listAll(['example', 'blocked']);

    expect(aggregate.items.map((item) => item.reviewSessionRef)).toEqual([
      'review:example:1',
    ]);
    expect(aggregate.unavailableProjects).toEqual([
      { projectSlug: 'blocked', reason: 'workspace-unreadable' },
    ]);
  });

  it('reports a throw while building the projection as projection-failed (#3322)', async () => {
    const service = new SurveyFlowReviewService({
      list: (projectSlug) =>
        projectSlug === 'defective'
          ? [
              // Sessions loaded fine; this one breaks the presentation build,
              // which is a Station defect and not the operator's file.
              {
                reviewSessionRef: 'review:defective:1',
                projectSlug,
              } as unknown as StationSurveyReviewSession,
            ]
          : [],
      resolve: () => {
        throw new Error('resolve is not exercised here');
      },
    });

    const aggregate = await service.listAll(['defective', 'empty']);

    expect(aggregate.items).toEqual([]);
    expect(aggregate.unavailableProjects).toEqual([
      { projectSlug: 'defective', reason: 'projection-failed' },
    ]);
  });

  it('fails closed when an opaque ref is duplicated across providers', async () => {
    const one = await fixture('one');
    const two = await fixture('two');
    const store = new FileStationSurveyReviewSessionStore({
      listSlugs: () => ['one', 'two'],
      workspace: (slug) => (slug === 'one' ? one : two),
    });

    await expect(store.resolve('review:example:1')).rejects.toThrow(
      'ambiguous',
    );
  });
});
