import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { AccountPreferencesStore } from '../../../services/identity/account-preferences.js';
import { createAccountPreferencesRoutes } from '../account-preferences.js';

const makeTempDir = trackTempDirs();

async function fixture() {
  const home = makeTempDir('station-account-preferences-');
  const app = new Hono();
  const build = () =>
    createAccountPreferencesRoutes({
      store: new AccountPreferencesStore(home),
      resolvePrincipal: (c) =>
        humanPrincipal(
          c.req.header('x-test-person') === 'unbound' ? 'device' : 'fixture',
          c.req.header('x-test-person') === 'other' ? 'other' : 'person',
          'Fixture person',
        ),
      tenantId: (request) => request.headers.get('x-test-tenant') ?? undefined,
      isInternal: (request) => request.headers.has('x-test-internal'),
    });
  app.route('/api/me', build());
  const call = (
    patch?: unknown,
    headers?: Record<string, string | undefined>,
    target = app,
  ) =>
    target.request('/api/me/preferences', {
      method: patch === undefined ? 'GET' : 'PATCH',
      headers: new Headers(
        Object.entries({
          ...headers,
          'Content-Type': 'application/json',
        }).filter((pair): pair is [string, string] => pair[1] !== undefined),
      ),
      ...(patch === undefined ? {} : { body: JSON.stringify(patch) }),
    });
  return { home, call, build };
}

describe('account preference HTTP persistence', () => {
  test('two devices of one person share durable preferences while another person and tenant remain separate', async () => {
    const f = await fixture();
    expect((await f.call()).status).toBe(200);
    expect(
      (
        await f.call(
          { theme: 'light', interactiveApprovalModes: { codex: 'never' } },
          { 'x-test-device': 'phone' },
        )
      ).status,
    ).toBe(200);
    const desktop = await f.call(undefined, { 'x-test-device': 'desktop' });
    expect(await desktop.json()).toMatchObject({
      data: {
        values: {
          theme: 'light',
          interactiveApprovalModes: { codex: 'never' },
        },
      },
    });
    for (const headers of [
      { 'x-test-person': 'other' },
      { 'x-test-tenant': 'other-tenant' },
    ]) {
      expect(await (await f.call(undefined, headers)).json()).toMatchObject({
        data: { values: {} },
      });
    }
    const restarted = new Hono().route('/api/me', f.build());
    expect(
      await (await f.call(undefined, undefined, restarted)).json(),
    ).toEqual(await (await f.call()).json());
  });

  test('independent concurrent field updates survive, and reset removes only the named account preference', async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.call({ theme: 'light' }),
      f.call({ diffWrap: true }),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    expect(await (await f.call()).json()).toMatchObject({
      data: { values: { theme: 'light', diffWrap: true } },
    });
    const store = new AccountPreferencesStore(f.home);
    const owner = {
      principalId: humanPrincipal('fixture', 'person', 'Fixture person').id,
    };
    await store.patch(owner, { theme: 'dark', chatShowReasoning: true }, true);
    expect(store.read(owner).values).toMatchObject({
      theme: 'light',
      chatShowReasoning: true,
    });
    await store.patch(owner, { interactiveApprovalModes: { codex: 'auto' } });
    await store.patch(owner, { interactiveApprovalModes: { claude: 'ask' } });
    await store.patch(owner, { interactiveApprovalModes: { codex: null } });
    expect(store.read(owner).values.interactiveApprovalModes).toEqual({
      claude: 'ask',
    });
    await store.patch(owner, {
      chatShowReasoning: null,
      interactiveApprovalModes: null,
    });
    expect((await f.call({ theme: null })).status).toBe(200);
    expect(await (await f.call()).json()).toMatchObject({
      success: true,
      data: { schemaVersion: 1, values: { diffWrap: true } },
    });
  });

  test.each([
    { chatDockWidth: 500 },
    { sttProvider: 'remote' },
    { principalId: 'another-person' },
    { featureSettings: { pushNotificationsEnabled: true } },
    { approvalGrant: 'full-access' },
    { interactiveApprovalModes: { unknown: 'never' } },
    { chatFontSize: 200 },
    { modelPickerPreferences: { favorites: ['x'] } },
  ])(
    'rejects nonportable, unknown, or malformed input %j without changing saved state',
    async (patch) => {
      const f = await fixture();
      expect((await f.call({ theme: 'dark' })).status).toBe(200);
      expect((await f.call(patch)).status).toBe(400);
      expect(await (await f.call()).json()).toMatchObject({
        data: { values: { theme: 'dark' } },
      });
    },
  );

  test('a stale composite replacement is refused instead of losing another device’s favorites', async () => {
    const f = await fixture();
    const first = (await (await f.call()).json()) as {
      data: { revision: string };
    };
    const picker = { favorites: ['a'], recents: [], hidden: [], order: [] };
    expect(
      (
        await f.call(
          { modelPickerPreferences: picker },
          { 'If-Match': first.data.revision },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call(
          { modelPickerPreferences: { ...picker, favorites: ['b'] } },
          { 'If-Match': first.data.revision },
        )
      ).status,
    ).toBe(409);
    expect(await (await f.call()).json()).toMatchObject({
      data: { values: { modelPickerPreferences: { favorites: ['a'] } } },
    });
  });

  test('unbound devices and internal callers cannot store personal preferences', async () => {
    const f = await fixture();
    for (const headers of [
      { 'x-test-person': 'unbound' },
      { 'x-test-internal': 'true' },
    ]) {
      expect((await f.call(undefined, headers)).status).toBe(403);
      expect((await f.call({ theme: 'dark' }, headers)).status).toBe(403);
    }
    expect(await (await f.call()).json()).toMatchObject({
      data: { values: {} },
    });
  });

  test('color-theme ids round-trip as ids, including a family this server has never heard of', async () => {
    const f = await fixture();
    // A newer client may name a family the UI catalog here does not have; the
    // server keeps the id (the UI resolves an unknown one to Station) instead
    // of refusing the whole patch.
    expect(
      (
        await f.call({
          colorTheme: 'some-future-family',
          colorThemeFlavor: 'mocha',
          colorThemeAccent: 'mauve',
        })
      ).status,
    ).toBe(200);
    expect(await (await f.call()).json()).toMatchObject({
      data: {
        values: {
          colorTheme: 'some-future-family',
          colorThemeFlavor: 'mocha',
          colorThemeAccent: 'mauve',
        },
      },
    });
    // Null resets to the family default, as for every account preference.
    expect((await f.call({ colorThemeFlavor: null })).status).toBe(200);
    const after = (await (await f.call()).json()) as {
      data: { values: Record<string, unknown> };
    };
    expect(after.data.values).not.toHaveProperty('colorThemeFlavor');
    // An id is still parsed: not text, markup or an unbounded string.
    for (const colorTheme of ['Catppuccin', '<style>', '', 'a'.repeat(49), 42])
      expect((await f.call({ colorTheme })).status).toBe(400);
    expect((await f.call({ colorThemeAccent: 'x y' })).status).toBe(400);
  });

  test('a server from before color themes still reads what this one writes', async () => {
    // Verbatim from src-server/services/identity/account-preferences.ts at
    // e880e9c9203 (the last main without color themes): that reader parses
    // its document strictly, so one unknown key would fail every account
    // preference after a downgrade or with a shared home.
    const list = z.array(z.string().min(1).max(1024)).max(512);
    const mode = z.enum(['ask', 'auto', 'never']);
    const fields = {
      theme: z.enum(['light', 'dark']),
      accentColor: z.string().max(128).nullable(),
      diffStyle: z.enum(['unified', 'split']),
      diffWrap: z.boolean(),
      chatShowReasoning: z.boolean(),
      chatShowToolDetails: z.boolean(),
      chatFontSize: z.number().int().min(10).max(24).nullable(),
      chatDockAutoHide: z.boolean(),
      confirmConversationDelete: z.boolean(),
      developerToolsEnabled: z.boolean(),
      modelPickerPreferences: z
        .object({ favorites: list, recents: list, hidden: list, order: list })
        .strict(),
      smoothReveal: z.boolean(),
      bufferedDelivery: z.boolean(),
      interactiveApprovalModes: z
        .object({
          codex: mode.optional(),
          claude: mode.optional(),
          muse: mode.optional(),
        })
        .strict(),
    };
    const oldDocument = z
      .object({
        schemaVersion: z.literal(1),
        values: z.object(fields).partial().strict(),
      })
      .strict();

    const f = await fixture();
    expect(
      (
        await f.call({
          theme: 'light',
          colorTheme: 'catppuccin',
          colorThemeFlavor: 'frappe',
          colorThemeAccent: 'pink',
        })
      ).status,
    ).toBe(200);
    const dir = join(f.home, 'config', 'account-preferences');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    const mainFile = files.find((name) => !name.includes('.appearance.'))!;
    expect(files).toHaveLength(2);
    // The old reader opens only <key>.json, and it parses.
    const old = oldDocument.parse(
      JSON.parse(await readFile(join(dir, mainFile), 'utf8')),
    );
    expect(old.values).toEqual({ theme: 'light' });
    // This server reads both and returns one view.
    expect(await (await f.call()).json()).toMatchObject({
      data: {
        values: {
          theme: 'light',
          colorTheme: 'catppuccin',
          colorThemeFlavor: 'frappe',
          colorThemeAccent: 'pink',
        },
      },
    });
  });

  test('a key written by a newer server is kept on write and left out of the view', async () => {
    const f = await fixture();
    await f.call({ theme: 'dark' });
    const dir = join(f.home, 'config', 'account-preferences');
    const [file] = (await readdir(dir)).filter((name) =>
      name.endsWith('.json'),
    );
    const path = join(dir, file!);
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        values: { theme: 'dark', someFutureKey: { nested: true } },
      }),
    );
    const read = (await (await f.call()).json()) as {
      data: { values: Record<string, unknown> };
    };
    expect(read.data.values).toEqual({ theme: 'dark' });
    expect((await f.call({ diffWrap: true })).status).toBe(200);
    expect(JSON.parse(await readFile(path, 'utf8')).values).toEqual({
      theme: 'dark',
      diffWrap: true,
      someFutureKey: { nested: true },
    });
    // A known key is still validated.
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, values: { theme: 'sepia' } }),
    );
    expect((await f.call()).status).toBe(503);
  });

  test('a corrupt saved record is reported rather than replaced by defaults or a later patch', async () => {
    const f = await fixture();
    await f.call({ theme: 'light' });
    const [file] = await readdir(join(f.home, 'config', 'account-preferences'));
    const path = join(f.home, 'config', 'account-preferences', file!);
    await writeFile(path, '{broken');
    expect((await f.call()).status).toBe(503);
    expect((await f.call({ diffWrap: false })).status).toBe(503);
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });
});
