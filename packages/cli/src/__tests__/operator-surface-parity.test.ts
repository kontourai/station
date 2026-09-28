import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  REVIEW_EVIDENCE_OPERATOR_SURFACE,
  type ReviewEvidenceOperatorOperation,
} from '@kontourai/station-contracts/review-evidence';
import {
  SCHEDULER_OPERATOR_SURFACE,
  type SchedulerOperatorOperation,
} from '@kontourai/station-contracts/scheduler';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { actionsFor } from '../help.js';
import { readBody } from './helpers/http-test-helpers.js';
import {
  completedReviewRequest,
  reviewReceipt,
} from './helpers/review-evidence-fixtures.js';

// The operator contracts name each verb's CLI action and HTTP route. Help
// advertises the actions and `surfaces.ts` dispatches them; these tests drive
// every contract entry through the real CLI and check the request it sends.

const RECEIPT_ID = reviewReceipt.receiptId;
const REVIEW_REQUEST =
  '{"requestId":"request-1","mode":"initial","target":{"kind":"git-range","projectSlug":"demo","baseRevision":"origin/main","headRevision":"HEAD"},"implementerAgentSlug":"terra","reviewers":[{"reviewerId":"reviewer-1","executorAgentSlug":"station","lens":{"id":"architecture","instructions":"Review exact seams."}}]}';

const REVIEW_ARGS: Record<ReviewEvidenceOperatorOperation, string[]> = {
  run: ['demo', `--data=${REVIEW_REQUEST}`],
  status: ['demo', 'request-1'],
  list: ['demo'],
  read: ['demo', RECEIPT_ID],
};

const SCHEDULE_ARGS: Record<SchedulerOperatorOperation, string[]> = {
  list: [],
  providers: [],
  stats: [],
  status: [],
  preview: ['0 9 * * *', '1'],
  logs: ['daily-report', '5'],
  create: ['--data={"name":"daily-report","prompt":"Generate report"}'],
  update: ['daily-report', '--data={"prompt":"Updated report"}'],
  run: ['daily-report'],
  enable: ['daily-report'],
  disable: ['daily-report'],
  delete: ['daily-report'],
};

function concretePath(template: string): string {
  return template
    .replace(':projectSlug', 'demo')
    .replace(':requestId', 'request-1')
    .replace(':receiptId', RECEIPT_ID)
    .replace(':target', 'daily-report');
}

const requests: string[] = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  requests.push(`${req.method} ${url.pathname}`);
  if (req.method !== 'GET') await readBody(req);
  // The review client validates what it reads back, so its routes answer with
  // real shapes; scheduler replies are printed as-is.
  const reviews = url.pathname.match(/^\/api\/projects\/demo\/reviews(\/.*)?$/);
  const data = !reviews
    ? {}
    : reviews[1]?.startsWith('/requests/') || req.method === 'POST'
      ? completedReviewRequest
      : reviews[1]
        ? reviewReceipt
        : [reviewReceipt];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, data }));
});
let apiBase = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  requests.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return () => vi.restoreAllMocks();
});

async function dispatch(command: string, args: string[]): Promise<string[]> {
  const { runCli } = await import('../cli.js');
  await runCli([command, ...args, `--api-base=${apiBase}`]);
  return [...requests];
}

describe('independent review operator surface', () => {
  it('help advertises exactly the contract CLI actions', () => {
    expect(actionsFor('review')).toEqual(
      Object.values(REVIEW_EVIDENCE_OPERATOR_SURFACE).map(({ cli }) => cli),
    );
  });

  it.each(
    Object.entries(REVIEW_EVIDENCE_OPERATOR_SURFACE) as Array<
      [
        ReviewEvidenceOperatorOperation,
        { cli: string; method: string; path: string },
      ]
    >,
  )('review %s dispatches to its contract route', async (operation, entry) => {
    expect(
      await dispatch('review', [entry.cli, ...REVIEW_ARGS[operation]]),
    ).toEqual([`${entry.method} ${concretePath(entry.path)}`]);
  });
});

describe('scheduler operator surface', () => {
  it('help advertises exactly the contract CLI actions plus the jobs alias', () => {
    expect(actionsFor('schedule')).toEqual([
      'list',
      'jobs',
      ...Object.values(SCHEDULER_OPERATOR_SURFACE)
        .map(({ cli }) => cli)
        .filter((action) => action !== 'list'),
    ]);
  });

  it.each(
    Object.entries(SCHEDULER_OPERATOR_SURFACE) as Array<
      [
        SchedulerOperatorOperation,
        { cli: string; method: string; path: string },
      ]
    >,
  )(
    'schedule %s dispatches to its contract route',
    async (operation, entry) => {
      expect(
        await dispatch('schedule', [entry.cli, ...SCHEDULE_ARGS[operation]]),
      ).toEqual([`${entry.method} ${concretePath(entry.path)}`]);
    },
  );

  it('schedule jobs is the list alias', async () => {
    const { method, path } = SCHEDULER_OPERATOR_SURFACE.list;
    expect(await dispatch('schedule', ['jobs'])).toEqual([`${method} ${path}`]);
  });
});
