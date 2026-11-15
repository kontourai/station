import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { CustomAppearanceStore } from '../../../services/identity/custom-appearance.js';
import { createCustomAppearanceRoutes } from '../custom-appearance.js';

const makeTempDir = trackTempDirs();

const appearance = {
  version: 1,
  name: 'Quiet',
  palette: {
    dark: {
      roles: { '--k-bg': '#101418', '--k-text': '#e6e6e6' },
      accent: '#7cc4ff',
    },
  },
  css: '[data-surface="sidebar"] { border-right: 2px solid #334; }',
};

function fixture(maxBytes?: number) {
  const home = makeTempDir('station-custom-appearance-');
  const app = new Hono().route(
    '/api/me',
    createCustomAppearanceRoutes({
      store: new CustomAppearanceStore(home, undefined, maxBytes),
      resolvePrincipal: (c) => {
        const who = c.req.header('x-test-person') ?? 'alice';
        return who === 'device'
          ? humanPrincipal('device', 'phone-1', 'A phone')
          : humanPrincipal('fixture', who, who);
      },
      tenantId: () => undefined,
    }),
  );
  type As = 'person' | 'agent-tool' | 'internal';
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    options: { as?: As; who?: string; raw?: string } = {},
  ) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (options.who) headers.set('x-test-person', options.who);
    if (options.as === 'agent-tool')
      headers.set('x-station-control-origin', 'agent-tool');
    const request = new Request(`http://station.test/api/me${path}`, {
      method,
      headers,
      ...(options.raw !== undefined
        ? { body: options.raw }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
    });
    if (options.as === 'internal')
      setRuntimeAuthenticatedRequestPrincipal(request, {
        kind: 'internal',
        credential: 'fixture-internal',
        authority: undefined,
        source: 'bearer',
      });
    const response = await app.request(request);
    return {
      status: response.status,
      json: (await response.json()) as {
        success: boolean;
        data?: any;
        code?: string;
        violations?: { kind: string; message: string }[];
      },
    };
  };
  const read = async (who?: string) =>
    (await call('GET', '/appearance', undefined, { who })).json.data;
  return { call, read };
}

describe('/api/me/appearance', () => {
  test('an agent proposes; only the person keeps, saves, dismisses, turns off or reports', async () => {
    const f = fixture();
    const empty = await f.read();
    expect(empty).toMatchObject({ active: null, proposal: null });

    for (const as of ['agent-tool', 'internal'] as const) {
      const proposed = await f.call(
        'POST',
        '/appearance/proposal',
        { revision: (await f.read()).revision, appearance },
        { as },
      );
      expect(proposed.status).toBe(200);
      expect(proposed.json.data.proposal.appearance.name).toBe('Quiet');
    }
    const pending = await f.read();
    const proposalId = pending.proposal.id;
    const report = {
      proposalId,
      mode: 'dark',
      hooks: [
        { id: 'sidebar', selector: '[data-surface="sidebar"]', matched: 1 },
      ],
      contrast: [],
      stripped: [],
    };
    for (const as of ['agent-tool', 'internal'] as const) {
      for (const [method, path, body] of [
        [
          'POST',
          '/appearance/proposal/keep',
          { revision: pending.revision, proposalId },
        ],
        ['DELETE', '/appearance/proposal', { revision: pending.revision }],
        ['PUT', '/appearance', { revision: pending.revision, appearance }],
        [
          'PUT',
          '/appearance',
          { revision: pending.revision, appearance: null },
        ],
        ['POST', '/appearance/proposal/report', report],
      ] as const) {
        const refused = await f.call(method, path, body, { as });
        expect(refused.status, `${as} ${method} ${path}`).toBe(403);
        expect(refused.json.code).toBe('custom_appearance_person_only');
      }
    }
    // Nothing the refused calls named changed.
    expect(await f.read()).toEqual(pending);

    const reported = await f.call(
      'POST',
      '/appearance/proposal/report',
      report,
    );
    expect(reported.status).toBe(200);
    // The agent's read returns the person's render report; the revision the
    // person keeps with is unchanged by reporting.
    const seen = await f.call('GET', '/appearance', undefined, {
      as: 'internal',
    });
    expect(seen.json.data.renderReport).toMatchObject({
      proposalId,
      hooks: report.hooks,
    });
    expect(seen.json.data.revision).toBe(pending.revision);

    const kept = await f.call('POST', '/appearance/proposal/keep', {
      revision: pending.revision,
      proposalId,
    });
    expect(kept.status).toBe(200);
    expect(kept.json.data).toMatchObject({
      active: { name: 'Quiet' },
      proposal: null,
      renderReport: null,
    });

    const off = await f.call('PUT', '/appearance', {
      revision: kept.json.data.revision,
      appearance: null,
    });
    expect(off.status).toBe(200);
    expect(off.json.data.active).toBeNull();
  });

  test('a stale revision is a 409 conflict, and a report for a replaced proposal is refused', async () => {
    const f = fixture();
    const first = await f.read();
    expect(
      (
        await f.call(
          'POST',
          '/appearance/proposal',
          { revision: first.revision, appearance },
          { as: 'agent-tool' },
        )
      ).status,
    ).toBe(200);
    const stale = await f.call(
      'POST',
      '/appearance/proposal',
      {
        revision: first.revision,
        appearance: { ...appearance, name: 'Other' },
      },
      { as: 'agent-tool' },
    );
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('custom_appearance_changed');
    const current = await f.read();
    expect(
      (
        await f.call('PUT', '/appearance', {
          revision: first.revision,
          appearance,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.call('POST', '/appearance/proposal/keep', {
          revision: current.revision,
          proposalId: 'not-it',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.call('POST', '/appearance/proposal/report', {
          proposalId: 'not-it',
          mode: 'dark',
          hooks: [],
          contrast: [],
          stripped: [],
        })
      ).status,
    ).toBe(409);
  });

  test('refuses oversize CSS, remote fetches and failing contrast with the reason', async () => {
    const f = fixture();
    const revision = (await f.read()).revision;
    const propose = (patch: Record<string, unknown>) =>
      f.call(
        'POST',
        '/appearance/proposal',
        { revision, appearance: { ...appearance, ...patch } },
        { as: 'agent-tool' },
      );
    const big = await propose({ css: `a{color:red}${' '.repeat(50_000)}` });
    expect(big.status).toBe(400);
    expect(big.json.violations?.map((v) => v.kind)).toContain('too-long');
    const huge = await f.call('POST', '/appearance/proposal', undefined, {
      as: 'agent-tool',
      raw: JSON.stringify({
        revision,
        appearance: { ...appearance, css: 'x'.repeat(200_000) },
      }),
    });
    expect(huge.status).toBe(413);
    for (const [css, kind] of [
      ['body{background:url(https://evil.test/x.png)}', 'remote-url'],
      ['body{background:URL( "//evil.test/x" )}', 'remote-url'],
      ['@import "https://evil.test/a.css";', 'import'],
      ['body{background:image-set("x.png" 1x)}', 'image-function'],
      ['body{background:\\75rl(https://evil.test)}', 'escape'],
      ['@font-face{font-family:x;src:local(x)}', 'font-face'],
      // A fragment URL is a local reference only in filter, mask, clip-path
      // and marker; elsewhere it loads the page itself.
      ['#a{background-image:url(#x)}', 'remote-url'],
      // A ";" inside a string does not end the declaration it sits in.
      [
        '#a{content:";"; background-image: url(http://evil.test/s)}',
        'remote-url',
      ],
      // The browser would escape this quote and its guard would refuse the
      // backslash next to url(), so the server refuses it first.
      [
        `#a{background-image:url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>')}`,
        'escape',
      ],
      // A comment opener inside a string must not hide what follows it.
      [
        '#a{content:"/*"; background-image:url(http://evil.test/x); content:"*/"}',
        'remote-url',
      ],
    ] as const) {
      const refused = await propose({ css });
      expect(refused.status, css).toBe(400);
      expect(
        refused.json.violations?.map((v) => v.kind),
        css,
      ).toContain(kind);
    }
    expect(
      (
        await propose({
          css: 'body{background:url(data:image/png;base64,AAAA)} svg{filter:url(#glow)}',
        })
      ).status,
    ).toBe(200);
    const contrast = await f.call(
      'POST',
      '/appearance/proposal',
      {
        revision: (await f.read()).revision,
        appearance: {
          ...appearance,
          palette: {
            light: { roles: { '--k-bg': '#ffffff', '--k-text': '#dddddd' } },
          },
        },
      },
      { as: 'agent-tool' },
    );
    expect(contrast.status).toBe(400);
    expect(contrast.json.violations?.[0]).toMatchObject({ kind: 'contrast' });
    expect(contrast.json.violations?.[0]?.message).toContain(
      '--k-text on --k-bg',
    );
    expect(
      (await propose({ palette: { dark: { roles: { '--k-bg': 'red' } } } }))
        .json.violations?.[0]?.kind,
    ).toBe('invalid-color');
  });

  test('another person cannot read or write yours, and a device without a person is refused', async () => {
    const f = fixture();
    const revision = (await f.read()).revision;
    expect(
      (await f.call('PUT', '/appearance', { revision, appearance })).status,
    ).toBe(200);
    const mine = await f.read();
    expect(mine.active.name).toBe('Quiet');
    const theirs = await f.read('bob');
    expect(theirs.active).toBeNull();
    // Bob's write with Alice's revision lands nowhere near Alice's document.
    expect(
      (
        await f.call(
          'PUT',
          '/appearance',
          { revision: mine.revision, appearance: null },
          { who: 'bob' },
        )
      ).status,
    ).toBe(409);
    expect((await f.read()).active.name).toBe('Quiet');
    const device = await f.call('GET', '/appearance', undefined, {
      who: 'device',
    });
    expect(device.status).toBe(403);
    expect(device.json.code).toBe('custom_appearance_identity_required');
  });

  test('a document over the store limit is a 413 with a code, not a 500, and changes nothing', async () => {
    const f = fixture(1500);
    const revision = (await f.read()).revision;
    const full = await f.call(
      'POST',
      '/appearance/proposal',
      {
        revision,
        appearance: { ...appearance, css: `/* ${'x'.repeat(2000)} */` },
      },
      { as: 'agent-tool' },
    );
    expect(full.status).toBe(413);
    expect(full.json.code).toBe('custom_appearance_store_full');
    expect((await f.read()).proposal).toBeNull();
  });

  test('a name with bidirectional or control characters is refused', async () => {
    const f = fixture();
    const revision = (await f.read()).revision;
    for (const name of ['Calm\u202eesrever', 'a\u2066b', 'tab\there']) {
      const refused = await f.call(
        'POST',
        '/appearance/proposal',
        { revision, appearance: { ...appearance, name } },
        { as: 'agent-tool' },
      );
      expect(refused.status, JSON.stringify(name)).toBe(400);
      expect(refused.json.violations?.[0]?.kind).toBe('invalid-shape');
    }
  });
});
