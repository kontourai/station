import {
  createCustomAppearanceThemePack,
  parseAppearanceProposalReference,
  parseCustomAppearanceThemePack,
} from '@kontourai/station-contracts/custom-appearance';
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

function fixture(
  maxBytes?: number,
  studioEnabled: () => boolean = () => false,
) {
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
      studioEnabled,
      resolveProposalSourceSessionId: (c) =>
        c.req.header('x-test-runtime-session'),
    }),
  );
  type As = 'person' | 'agent-tool' | 'internal';
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    options: { as?: As; who?: string; raw?: string; sessionId?: string } = {},
  ) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (options.who) headers.set('x-test-person', options.who);
    if (options.sessionId)
      headers.set('x-test-runtime-session', options.sessionId);
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
  test('a delegated proposal stays with its granting person and an expired grant cannot write', async () => {
    const home = makeTempDir('delegated-appearance-');
    const store = new CustomAppearanceStore(home);
    const owner = {
      principalId: humanPrincipal('fixture', 'alice', 'Alice').id,
    };
    const another = { principalId: humanPrincipal('fixture', 'bob', 'Bob').id };
    let active = true;
    const app = createCustomAppearanceRoutes({
      store,
      resolvePrincipal: () => {
        throw new Error('The child has no acting principal');
      },
      resolveDelegatedAppearanceOwner: () =>
        active ? owner.principalId : undefined,
      resolveProposalSourceSessionId: () => 'task:appearance',
      tenantId: () => undefined,
    });
    const first = await app.request('/appearance');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      success: true,
      data: { revision: store.read(owner).revision },
    });
    const submit = (revision: string) =>
      app.request('/appearance/proposal', {
        method: 'POST',
        body: JSON.stringify({ revision, appearance }),
      });
    expect((await submit(store.read(owner).revision)).status).toBe(200);
    expect(store.read(owner)).toMatchObject({
      active: null,
      proposal: {
        sourceSessionId: 'task:appearance',
        appearance: { name: 'Quiet' },
      },
    });
    expect(store.read(another).proposal).toBeNull();
    const keep = await app.request('/appearance/proposal/keep', {
      method: 'POST',
      body: JSON.stringify({
        revision: store.read(owner).revision,
        proposalId: store.read(owner).proposal?.id,
      }),
    });
    expect(keep.status).toBe(403);
    active = false;
    expect((await submit(store.read(owner).revision)).status).toBe(403);
    expect(store.read(owner).active).toBeNull();
  });

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
  test('studio gates visual writes and the saved library while legacy read and turn-off work', async () => {
    let enabled = true;
    const f = fixture(undefined, () => enabled);
    const visual = {
      ...appearance,
      visual: { panelOpacity: 0.7, radius: 12, fontSize: 16 },
    };
    const saved = await f.call('PUT', '/appearance', {
      revision: (await f.read()).revision,
      appearance: visual,
    });
    expect(saved.status).toBe(200);
    const proposed = await f.call('POST', '/appearance/proposal', {
      revision: saved.json.data.revision,
      appearance: visual,
    });
    expect(proposed.status).toBe(200);
    enabled = false;
    expect((await f.read()).active.visual).toEqual(visual.visual);
    for (const [method, path, body] of [
      [
        'PUT',
        '/appearance',
        { revision: proposed.json.data.revision, appearance: visual },
      ],
      [
        'POST',
        '/appearance/proposal',
        { revision: proposed.json.data.revision, appearance: visual },
      ],
      [
        'POST',
        '/appearance/proposal/keep',
        {
          revision: proposed.json.data.revision,
          proposalId: proposed.json.data.proposal.id,
        },
      ],
      ['GET', '/appearance/library', undefined],
    ] as const) {
      const refused = await f.call(method, path, body);
      expect(refused.status).toBe(404);
      expect(refused.json.code).toBe('feature_preview_disabled');
    }
    expect(
      (
        await f.call('PUT', '/appearance', {
          revision: (await f.read()).revision,
          appearance: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call('PUT', '/appearance', {
          revision: (await f.read()).revision,
          appearance,
        })
      ).status,
    ).toBe(200);
  });

  test('saved themes persist separately from active appearance, compare revisions and isolate people', async () => {
    const f = fixture(undefined, () => true);
    const empty = (await f.call('GET', '/appearance/library')).json.data;
    const saved = await f.call('POST', '/appearance/library', {
      revision: empty.revision,
      appearance,
      favorite: true,
    });
    expect(saved.status).toBe(200);
    const theme = saved.json.data.themes[0];
    expect(theme).toMatchObject({ name: 'Quiet', favorite: true, appearance });
    expect(theme.id).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.read()).active).toBeNull();
    expect((await f.call('GET', '/appearance/library')).json.data).toEqual(
      saved.json.data,
    );
    expect(
      (await f.call('GET', '/appearance/library', undefined, { who: 'bob' }))
        .json.data.themes,
    ).toEqual([]);
    expect(
      (
        await f.call('PATCH', '/appearance/library', {
          revision: empty.revision,
          id: theme.id,
          name: 'Stale',
        })
      ).status,
    ).toBe(409);
    const updated = await f.call('PATCH', '/appearance/library', {
      revision: saved.json.data.revision,
      id: theme.id,
      name: 'Renamed',
      favorite: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.data.themes[0]).toMatchObject({
      name: 'Renamed',
      favorite: false,
      appearance: { name: 'Renamed' },
    });
    expect(updated.json.data.themes[0].id).not.toBe(theme.id);
    const duplicate = await f.call('POST', '/appearance/library', {
      revision: updated.json.data.revision,
      appearance: updated.json.data.themes[0].appearance,
    });
    expect(duplicate.json.data.themes).toHaveLength(1);
    const edited = await f.call('POST', '/appearance/library', {
      revision: duplicate.json.data.revision,
      id: duplicate.json.data.themes[0].id,
      appearance: { ...appearance, name: 'Edited', css: '' },
    });
    expect(edited.json.data.themes).toHaveLength(1);
    const finalTheme = edited.json.data.themes[0];
    for (const as of ['agent-tool', 'internal'] as const)
      for (const [method, body] of [
        ['POST', { revision: edited.json.data.revision, appearance }],
        [
          'PATCH',
          {
            revision: edited.json.data.revision,
            id: finalTheme.id,
            favorite: true,
          },
        ],
        ['DELETE', { revision: edited.json.data.revision, id: finalTheme.id }],
      ] as const)
        expect(
          (await f.call(method, '/appearance/library', body, { as })).status,
        ).toBe(403);
    expect(
      (
        await f.call('DELETE', '/appearance/library', {
          revision: edited.json.data.revision,
          id: finalTheme.id,
        })
      ).json.data.themes,
    ).toEqual([]);
  });

  test('library caps entries and its total document bytes without changing saved state', async () => {
    const f = fixture(undefined, () => true);
    let library = (await f.call('GET', '/appearance/library')).json.data;
    for (let index = 0; index < 24; index++) {
      const result = await f.call('POST', '/appearance/library', {
        revision: library.revision,
        appearance: { ...appearance, name: `Theme ${index}` },
      });
      expect(result.status).toBe(200);
      library = result.json.data;
    }
    const full = await f.call('POST', '/appearance/library', {
      revision: library.revision,
      appearance: { ...appearance, name: 'Overflow' },
    });
    expect(full.status).toBe(413);
    expect(full.json.code).toBe('custom_appearance_library_full');
    expect((await f.call('GET', '/appearance/library')).json.data).toEqual(
      library,
    );
    const small = fixture(1500, () => true);
    const before = (await small.call('GET', '/appearance/library')).json.data;
    expect(
      (
        await small.call('POST', '/appearance/library', {
          revision: before.revision,
          appearance: { ...appearance, css: `/* ${'x'.repeat(2000)} */` },
        })
      ).status,
    ).toBe(413);
    expect((await small.call('GET', '/appearance/library')).json.data).toEqual(
      before,
    );
  });

  test('proposal references are bound to runtime sessions and superseded ids cannot keep their successor', async () => {
    const f = fixture(undefined, () => true);
    const first = await f.call(
      'POST',
      '/appearance/proposal',
      { revision: (await f.read()).revision, appearance },
      { as: 'internal', sessionId: 'runtime-a' },
    );
    expect(first.json.data.proposal.sourceSessionId).toBe('runtime-a');
    const tool = { success: true, state: 'proposed', data: first.json.data };
    expect(
      parseAppearanceProposalReference(
        'mcp__station-control__propose_appearance',
        { content: [{ type: 'text', text: JSON.stringify(tool) }] },
      ),
    ).toEqual({
      id: first.json.data.proposal.id,
      name: 'Quiet',
      sourceSessionId: 'runtime-a',
    });
    expect(
      parseAppearanceProposalReference('other/propose_appearance', tool),
    ).toBeUndefined();
    expect(
      parseAppearanceProposalReference('station-control/propose_appearance', {
        ...tool,
        success: false,
      }),
    ).toBeUndefined();
    expect(
      (
        await f.call('POST', '/appearance/proposal', {
          revision: first.json.data.revision,
          appearance,
          sourceSessionId: 'forged',
        })
      ).status,
    ).toBe(400);
    const second = await f.call(
      'POST',
      '/appearance/proposal',
      { revision: first.json.data.revision, appearance },
      { as: 'internal', sessionId: 'runtime-b' },
    );
    expect(second.json.data.proposal.id).not.toBe(first.json.data.proposal.id);
    expect(
      (
        await f.call('POST', '/appearance/proposal/keep', {
          revision: second.json.data.revision,
          proposalId: first.json.data.proposal.id,
        })
      ).status,
    ).toBe(409);
    expect((await f.read()).proposal.sourceSessionId).toBe('runtime-b');
  });

  test('admits bounded raster backgrounds and refuses external, SVG, malformed and oversized raster headers', async () => {
    const f = fixture(undefined, () => true);
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=';
    const visual = {
      background: {
        dataUrl: `data:image/png;base64,${png}`,
        size: 'cover',
        position: 'center',
        dim: 0.4,
      },
    };
    const accepted = await f.call('PUT', '/appearance', {
      revision: (await f.read()).revision,
      appearance: { ...appearance, visual },
    });
    expect(accepted.status).toBe(200);
    expect((await f.read()).active.visual).toEqual(visual);
    const huge = Buffer.from(png, 'base64');
    huge.writeUInt32BE(100000, 16);
    const forgedWebp = Buffer.alloc(44);
    forgedWebp.write('RIFF', 0);
    forgedWebp.writeUInt32LE(36, 4);
    forgedWebp.write('WEBPVP8X', 8);
    forgedWebp.writeUInt32LE(10, 16);
    forgedWebp.write('VP8L', 30);
    forgedWebp.writeUInt32LE(5, 34);
    forgedWebp[38] = 47;
    forgedWebp.writeUInt32LE(9999, 39); // A 1px canvas must not disguise a 10,000px frame.
    const malformedJpeg = Buffer.from([
      255, 216, 255, 255, 255, 255, 255, 255, 255, 255, 255, 217,
    ]);
    for (const dataUrl of [
      'https://example.test/background.png',
      'data:image/svg+xml;base64,PHN2Zy8+',
      `data:image/jpeg;base64,${png}`,
      'data:image/png;base64,AAAA',
      `data:image/webp;base64,${forgedWebp.toString('base64')}`,
      `data:image/jpeg;base64,${malformedJpeg.toString('base64')}`,
      `data:image/png;base64,${huge.toString('base64')}`,
      `data:image/png;base64,${'A'.repeat(1400000)}`,
    ]) {
      const refused = await f.call('PUT', '/appearance', {
        revision: (await f.read()).revision,
        appearance: {
          ...appearance,
          visual: { background: { ...visual.background, dataUrl } },
        },
      });
      expect(refused.status, dataUrl.slice(0, 80)).toBe(400);
    }
    for (const bad of [
      { panelOpacity: 0.1 },
      { radius: 25 },
      { fontSize: 21 },
      { background: { ...visual.background, dim: 2 } },
      { unexpected: true },
    ]) {
      expect(
        (
          await f.call('PUT', '/appearance', {
            revision: (await f.read()).revision,
            appearance: { ...appearance, visual: bad },
          })
        ).status,
      ).toBe(400);
    }
    expect((await f.read()).active.visual).toEqual(visual);
  });

  test('portable theme packs contain only validated appearance bytes and reject invalid import data', async () => {
    const pack = createCustomAppearanceThemePack({ ...appearance, version: 1 });
    expect(Object.keys(pack)).toEqual(['format', 'version', 'appearance']);
    expect(parseCustomAppearanceThemePack(JSON.stringify(pack))).toEqual({
      ok: true,
      value: pack,
    });
    for (const invalid of [
      { ...pack, owner: 'person' },
      { ...pack, version: 2 },
      { ...pack, appearance: { ...appearance, revision: 'secret' } },
      {
        ...pack,
        appearance: {
          ...appearance,
          css: 'body{background:url(https://evil.test)}',
        },
      },
      '{broken',
      ' '.repeat(1536 * 1024 + 1),
    ]) {
      expect(parseCustomAppearanceThemePack(invalid).ok).toBe(false);
    }
    const f = fixture(undefined, () => true);
    expect((await f.read()).active).toBeNull();
  });
});
