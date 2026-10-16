import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { publishTitlePolicy } from '../pr-title-check.mjs';

const head = 'a'.repeat(40);
const repository = 'kontourai/station';
const event = {
  pull_request: {
    number: 42,
    head: { sha: head },
    title: 'stale invalid event',
  },
};
const live = {
  number: 42,
  state: 'open',
  title: 'fix(ci): validate live titles',
  head: { sha: head },
  base: { ref: 'main' },
};
type Entry = {
  method: string;
  path: string;
  body?: { context: string; state: string; description: string };
};
type Step = { name?: string; run?: string };
const workflow = load(
  readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  ),
  { schema: JSON_SCHEMA },
) as { jobs: Record<string, { steps: Step[] }> };

async function withApi(
  run: (fixture: {
    entries: Entry[];
    accepted: Entry[];
    setLive: (value: typeof live) => void;
    setOwners: (value: (typeof live)[] | undefined) => void;
    setError: (kind: string) => void;
    execute: (
      payload?: typeof event,
      eventName?: string,
      mergeGroup?: { head_sha: string; base_ref: string },
    ) => Promise<void>;
  }) => Promise<void>,
) {
  const entries: Entry[] = [];
  const accepted: Entry[] = [];
  let current = live;
  let owners: (typeof live)[] | undefined;
  let error = '';
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry: Entry = {
      method: req.method ?? '',
      path: req.url ?? '',
      ...(raw ? { body: JSON.parse(raw) } : {}),
    };
    entries.push(entry);
    res.setHeader('Content-Type', 'application/json');
    if (
      (error === 'read' && req.method === 'GET') ||
      (error === 'terminal' && entry.body?.state === 'success') ||
      (error === 'pending' && entry.body?.state === 'pending') ||
      (error === 'all-terminal' &&
        req.method === 'POST' &&
        entry.body?.state !== 'pending') ||
      (error === 'all-writes' && req.method === 'POST')
    ) {
      res.statusCode = 503;
      res.end('{}');
      return;
    }
    if (req.method === 'POST') accepted.push(entry);
    res.end(
      JSON.stringify(
        req.method === 'GET'
          ? req.url?.includes('/commits/')
            ? (owners ?? [current])
            : current
          : { id: entries.length },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing HTTP fixture listener');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  // Execute the actual bootstrap/fallback JavaScript shipped in the workflow
  // against the same HTTP server as the production terminal publisher.
  const bootstrap = async (name: string, sha: string) => {
    const script = workflow.jobs['pr-title'].steps.find(
      (step) => step.name === name,
    )?.run;
    if (
      !script?.startsWith("node --input-type=module <<'NODE'\n") ||
      !script.endsWith('NODE\n')
    )
      throw new Error('Missing workflow publisher');
    const body = script.slice(script.indexOf('\n') + 1, -'NODE\n'.length);
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction('process', body)({
      env: {
        GITHUB_API_URL: apiUrl,
        GITHUB_REPOSITORY: repository,
        STATUS_SHA: sha,
        GH_TOKEN: 'fixture-token',
      },
    });
  };
  try {
    await run({
      entries,
      accepted,
      setLive: (value) => {
        current = value;
      },
      setOwners: (value) => {
        owners = value;
      },
      setError: (value) => {
        error = value;
      },
      execute: async (
        payload = event,
        eventName = 'pull_request_target',
        mergeGroup,
      ) => {
        const sha =
          eventName === 'merge_group'
            ? mergeGroup?.head_sha
            : payload.pull_request.head.sha;
        if (!sha) throw new Error('Missing fixture status head');
        try {
          await bootstrap('Mark title policy pending before setup', sha);
          await publishTitlePolicy({
            repository,
            event: mergeGroup ? { merge_group: mergeGroup } : payload,
            eventName,
            apiUrl,
            token: 'fixture-token',
          });
        } catch (caught) {
          await bootstrap(
            'Fail title policy after publication or setup error',
            sha,
          );
          throw caught;
        }
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const writes = (entries: Entry[]) =>
  entries.filter((entry) => entry.method === 'POST');

describe('mutable title policy HTTP lifecycle', () => {
  test('an actual invalid-title failure becomes success after correction on the SAME head', async () => {
    await withApi(async ({ entries, accepted, setLive, execute }) => {
      setLive({ ...live, title: 'actually invalid title' });
      await expect(execute()).rejects.toThrow('does not conform');
      expect(accepted.at(-1)?.body?.state).toBe('failure');
      setLive(live);
      // A delayed older event must read the correction before publication.
      await execute();
      expect(accepted.at(-1)?.body?.state).toBe('success');
      expect(
        entries.slice(-4).map((entry) => [entry.method, entry.body?.state]),
      ).toEqual([
        ['POST', 'pending'],
        ['GET', undefined],
        ['GET', undefined],
        ['POST', 'success'],
      ]);
      expect(
        writes(entries).every(
          (entry) =>
            entry.path === `/repos/${repository}/statuses/${head}` &&
            entry.body?.context === 'PR title policy',
        ),
      ).toBe(true);
      expect(
        entries.some((entry) => /check-runs|actions\/runs/.test(entry.path)),
      ).toBe(false);
    });
  });

  test('two PRs sharing one head must both be corrected before either can publish success', async () => {
    await withApi(async ({ accepted, setLive, setOwners, execute }) => {
      const peer = { ...live, number: 43, title: 'invalid peer title' };
      const triggerPeer = {
        ...event,
        pull_request: { ...event.pull_request, number: 43 },
      };
      setOwners([live, peer]);
      // A valid triggering PR must not clear the other owner's invalid title.
      await expect(execute()).rejects.toThrow('does not conform');
      expect(accepted.at(-1)?.body?.state).toBe('failure');
      // Correcting only the peer does not clear a now-invalid triggering PR.
      const invalid = { ...live, title: 'invalid original title' };
      setLive({ ...peer, title: live.title });
      setOwners([invalid, { ...peer, title: live.title }]);
      await expect(execute(triggerPeer)).rejects.toThrow('does not conform');
      expect(accepted.at(-1)?.body?.state).toBe('failure');
      setOwners([live, { ...peer, title: live.title }]);
      await execute(triggerPeer);
      expect(accepted.at(-1)?.body?.state).toBe('success');
    });
  });

  test('associated descendants, closed PRs and other targets do not own the shared head', async () => {
    await withApi(async ({ accepted, setOwners, execute }) => {
      setOwners([
        live,
        {
          ...live,
          number: 43,
          title: 'invalid',
          head: { sha: 'c'.repeat(40) },
        },
        { ...live, number: 44, title: 'invalid', state: 'closed' },
        { ...live, number: 45, title: 'invalid', base: { ref: 'release' } },
      ]);
      await execute();
      expect(accepted.at(-1)?.body?.state).toBe('success');
    });
  });

  test.each(['missing', 'full page'])(
    'incomplete owner inventory (%s) fails closed',
    async (kind) => {
      await withApi(async ({ accepted, setOwners, execute }) => {
        setOwners(
          kind === 'missing'
            ? [{ ...live, number: 43 }]
            : Array.from({ length: 100 }, (_, index) => ({
                ...live,
                number: 42 + index,
              })),
        );
        await expect(execute()).rejects.toThrow(
          /inventory|missing from exact-head/,
        );
        expect(accepted.at(-1)?.body?.state).toBe('failure');
      });
    },
  );

  test('a body edit with stale valid payload cannot keep an earlier success for a now-invalid live title', async () => {
    await withApi(async ({ entries, setLive, execute }) => {
      await execute();
      setLive({ ...live, title: 'invalid live title' });
      await expect(
        execute({
          ...event,
          pull_request: { ...event.pull_request, title: live.title },
        }),
      ).rejects.toThrow('does not conform');
      expect(
        writes(entries)
          .slice(-3)
          .map((entry) => entry.body?.state),
      ).toEqual(['pending', 'failure', 'failure']);
    });
  });

  test.each(['read', 'terminal', 'pending'])(
    '%s API errors invalidate an earlier success via pending/failure, never success',
    async (kind) => {
      await withApi(async ({ entries, setError, execute }) => {
        await execute();
        const start = entries.length;
        setError(kind);
        await expect(execute()).rejects.toThrow(/503/);
        const attempts = writes(entries.slice(start));
        expect(attempts[0].body?.state).toBe('pending');
        expect(attempts.at(-1)?.body?.state).toBe('failure');
      });
    },
  );

  test.each([
    { ...live, head: { sha: 'b'.repeat(40) } },
    { ...live, base: { ref: 'release' } },
  ])('a changed live head or base fails only the event head', async (pr) => {
    await withApi(async ({ entries, setLive, execute }) => {
      setLive(pr);
      await expect(execute()).rejects.toThrow('another head or target');
      expect(
        writes(entries).map((entry) => [entry.path, entry.body?.state]),
      ).toEqual([
        [`/repos/${repository}/statuses/${head}`, 'pending'],
        [`/repos/${repository}/statuses/${head}`, 'failure'],
      ]);
    });
  });

  test('merge-group acknowledgement publishes the new context on the synthesized head without a PR read', async () => {
    await withApi(async ({ entries, execute }) => {
      await execute(event, 'merge_group', {
        head_sha: 'b'.repeat(40),
        base_ref: 'refs/heads/main',
      });
      expect(entries.map((entry) => entry.body?.state)).toEqual([
        'pending',
        'success',
      ]);
      expect(writes(entries).at(-1)?.body?.context).toBe('PR title policy');
      expect(
        entries.every(
          (entry) =>
            entry.path === `/repos/${repository}/statuses/${'b'.repeat(40)}`,
        ),
      ).toBe(true);
    });
  });

  test('rejected terminal and fallback writes leave accepted pending instead of an older success', async () => {
    await withApi(async ({ accepted, setError, execute }) => {
      await execute();
      expect(accepted.at(-1)?.body?.state).toBe('success');
      setError('all-terminal');
      await expect(execute()).rejects.toThrow(/503/);
      expect(accepted.at(-1)?.body?.state).toBe('pending');
    });
  });

  test('total status transport outage is an explicit error, never a claimed publication', async () => {
    await withApi(async ({ entries, setError, execute }) => {
      setError('all-writes');
      await expect(execute()).rejects.toThrow(/503/);
      expect(entries.map((entry) => entry.body?.state)).toEqual([
        'pending',
        'failure',
      ]);
    });
  });
});
