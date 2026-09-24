/**
 * The session action history under page pressure (#90 wave 2, review B1/S2)
 * and the registry's own page operations (viewport, history, early dialogs).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BrowserHost, CdpTransport } from '../browser-host.js';
import {
  BROWSER_SESSION_HISTORY_LIMIT,
  BROWSER_SESSION_PAGE_NOISE_LIMIT,
  type BrowserSessionActor,
  BrowserSessionRegistry,
} from '../browser-session-registry.js';

const OPERATOR: BrowserSessionActor = { kind: 'operator' };
const AGENT: BrowserSessionActor = {
  kind: 'agent',
  principalId: 'agent-principal',
  sessionId: 'agent-session-1',
};

type Responder = (
  method: string,
  params: Record<string, unknown> | undefined,
) => unknown;

function eventHost(respond: Responder = () => ({})) {
  const listeners = new Map<string, Set<(p: unknown, s?: string) => void>>();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const emit = (event: string, params: unknown, sessionId = 'S1') => {
    for (const fn of listeners.get(event) ?? []) fn(params, sessionId);
  };
  const cdp: CdpTransport = {
    async send<R>(method: string, params?: object) {
      const p = params as Record<string, unknown> | undefined;
      sent.push({ method, params: p });
      return (await respond(method, p)) as R;
    },
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
    close: async () => {},
    closed: new Promise(() => {}),
  };
  const host: BrowserHost = {
    kind: 'server-chromium',
    openTarget: async () => ({ targetId: 'T1', cdpSessionId: 'S1' }),
    cdp: () => cdp,
    closeTarget: async () => {},
    onExit: () => () => {},
    shutdown: async () => {},
  };
  return { host, sent, emit, listeners };
}

const homes: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function harness(
  respond?: Responder,
  isStationAddress?: (url: string) => boolean,
) {
  const stationHome = mkdtempSync(join(tmpdir(), 'station-browser-hist-'));
  homes.push(stationHome);
  const fake = eventHost(respond);
  const registry = new BrowserSessionRegistry({
    stationHome,
    ...(isStationAddress ? { isStationAddress } : {}),
    createHost: () => fake.host,
    newId: () => 'bs_00000000-0000-4000-8000-000000000001',
  });
  // Every synchronous store write goes through this one private method.
  const persist = vi.spyOn(
    registry as unknown as { persist: () => void },
    'persist',
  );
  return { registry, fake, persist };
}

async function openLive(registry: BrowserSessionRegistry) {
  return registry.createSession({
    projectId: 'alpha',
    projectSlug: 'alpha',
    url: 'https://example.com/',
    actor: AGENT,
  });
}

describe('session history under a page that floods it (B1)', () => {
  test('hundreds of dialogs cannot evict what people and agents did, and are written to disk on a debounce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { registry, persist } = harness();
    const session = await openLive(registry);
    const id = session.browserSessionId;
    await registry.navigate(id, 'https://example.com/next', {
      actor: OPERATOR,
    });
    const actorEntries = registry
      .getSession(id)!
      .history.entries.filter((entry) => entry.actor.kind !== 'system');
    expect(actorEntries.map((entry) => entry.kind)).toEqual([
      'created',
      'navigated',
    ]);
    persist.mockClear();
    for (let i = 0; i < 500; i += 1) {
      registry.recordDialog(id, session.generation, {
        type: 'alert',
        message: `spam ${i}`,
        accepted: false,
      });
      // Spread the flood over time so folding alone cannot absorb it.
      vi.advanceTimersByTime(i % 2 === 0 ? 11_000 : 5);
    }
    const record = registry.getSession(id)!;
    // What the agent and the operator did survives the flood.
    expect(
      record.history.entries
        .filter((entry) => entry.actor.kind !== 'system')
        .map((entry) => entry.kind),
    ).toEqual(['created', 'navigated']);
    expect(record.activity.lastDriver).toEqual(OPERATOR);
    expect(record.activity.agentDriven).toBe(true);
    // The flood is folded and bounded on its own.
    const dialogs = record.history.entries.filter(
      (entry) => entry.kind === 'dialog-handled',
    );
    expect(dialogs.length).toBeLessThanOrEqual(
      BROWSER_SESSION_PAGE_NOISE_LIMIT,
    );
    expect(dialogs.some((entry) => (entry.count ?? 1) > 1)).toBe(true);
    expect(record.history.total).toBe(2 + 500);
    expect(record.activity.lastDialog).toMatchObject({
      type: 'alert',
      message: 'spam 499',
    });
    // At most one write per debounce window, never one per dialog.
    expect(persist.mock.calls.length).toBeLessThan(260);
    expect(persist.mock.calls.length).toBeGreaterThan(0);
  });

  test('a burst of the same page event folds into one counted entry and one debounced write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { registry, persist } = harness();
    const session = await openLive(registry);
    persist.mockClear();
    for (let i = 0; i < 200; i += 1)
      registry.recordDialog(session.browserSessionId, session.generation, {
        type: 'alert',
        message: '1',
        accepted: false,
      });
    const dialogs = registry
      .getSession(session.browserSessionId)!
      .history.entries.filter((entry) => entry.kind === 'dialog-handled');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.count).toBe(200);
    // No synchronous write per dialog; one write once the burst settles.
    expect(persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(
      registry.getSession(session.browserSessionId)!.activity.lastDialog,
    ).toMatchObject({ count: 200 });
  });

  test('a meta-refresh loop of page navigations folds and never evicts actor entries', async () => {
    const { registry } = harness();
    const session = await openLive(registry);
    for (let i = 0; i < BROWSER_SESSION_HISTORY_LIMIT * 2; i += 1)
      registry.observeCommittedUrl(
        session.browserSessionId,
        session.generation,
        `https://example.com/${i % 2}`,
      );
    const record = registry.getSession(session.browserSessionId)!;
    expect(record.history.entries[0]?.kind).toBe('created');
    expect(
      record.history.entries.filter((entry) => entry.kind === 'page-navigated'),
    ).toHaveLength(1);
  });
});

describe('page-originated URLs (S2)', () => {
  test('a page navigation is recorded and adopted without its query or fragment', async () => {
    const { registry } = harness();
    const session = await openLive(registry);
    registry.observeCommittedUrl(
      session.browserSessionId,
      session.generation,
      'https://example.com/callback?code=SECRET#token=SECRET',
    );
    const record = registry.getSession(session.browserSessionId)!;
    expect(record.url).toBe('https://example.com/callback');
    expect(JSON.stringify(record)).not.toContain('SECRET');
  });
});

describe('actor-driven navigation keeps the full URL; reload is not recorded twice', () => {
  test('Back to an entry with a query keeps it in the address (only page URLs are redacted)', async () => {
    const { registry } = harness((method) =>
      method === 'Page.getNavigationHistory'
        ? {
            currentIndex: 1,
            entries: [
              { id: 1, url: 'https://example.com/search?q=station' },
              { id: 2, url: 'https://example.com/' },
            ],
          }
        : {},
    );
    const session = await openLive(registry);
    await registry.navigateHistory(session.browserSessionId, 'back', {
      actor: OPERATOR,
    });
    const record = registry.getSession(session.browserSessionId)!;
    expect(record.url).toBe('https://example.com/search?q=station');
    expect(record.history.entries.at(-1)?.url).toBe(
      'https://example.com/search?q=station',
    );
  });

  test("reloading a page whose URL was adopted redacted does not record the page's own commit", async () => {
    const holder: { fake?: ReturnType<typeof eventHost> } = {};
    const { registry, fake } = harness((method) => {
      if (method === 'Page.reload')
        holder.fake?.emit('Page.frameNavigated', {
          frame: { id: 'f', url: 'https://example.com/cb?code=1' },
        });
      return {};
    });
    holder.fake = fake;
    const session = await openLive(registry);
    const id = session.browserSessionId;
    fake.host
      .cdp()
      .on('Page.frameNavigated', (params) =>
        registry.observeCommittedUrl(
          id,
          session.generation,
          (params as { frame: { url: string } }).frame.url,
        ),
      );
    // The page moved itself here; its URL was adopted without the query.
    registry.observeCommittedUrl(
      id,
      session.generation,
      'https://example.com/cb?code=1',
    );
    await registry.navigateHistory(id, 'reload', { actor: OPERATOR });
    const entries = registry.getSession(id)!.history.entries;
    expect(entries.map((entry) => entry.kind)).toEqual([
      'created',
      'page-navigated',
      'reloaded',
    ]);
    // Not even folded in as a repeat: the reload's commit is the same page.
    expect(entries[1]?.count ?? 1).toBe(1);
    expect(registry.getSession(id)!.history.total).toBe(3);
  });
});

describe('registry page operations', () => {
  test('a viewport change that fails half-way is rolled back (atomic)', async () => {
    let failTouch = false;
    const { registry, fake } = harness((method) => {
      if (method === 'Emulation.setTouchEmulationEnabled' && failTouch) {
        failTouch = false;
        throw new Error('touch emulation failed');
      }
      return {};
    });
    const session = await openLive(registry);
    fake.sent.length = 0;
    failTouch = true;
    await expect(
      registry.setViewport(
        session.browserSessionId,
        { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
        { actor: OPERATOR },
      ),
    ).rejects.toThrow('touch emulation failed');
    // The size that was applied is put back, with the old touch mode.
    expect(fake.sent.slice(2)).toEqual([
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: {
          width: 1280,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        },
      },
      {
        method: 'Emulation.setTouchEmulationEnabled',
        params: { enabled: false },
      },
    ]);
    expect(registry.getSession(session.browserSessionId)!.viewport).toEqual({
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
    });
  });

  test('Back records one history-navigated entry, not a second page-navigated for the same commit', async () => {
    const holder: { fake?: ReturnType<typeof eventHost> } = {};
    const { registry, fake } = harness((method) => {
      if (method === 'Page.getNavigationHistory')
        return {
          currentIndex: 1,
          entries: [
            { id: 1, url: 'https://example.com/a' },
            { id: 2, url: 'https://example.com/' },
          ],
        };
      if (method === 'Page.navigateToHistoryEntry')
        // The page commits the entry while the command is in flight.
        holder.fake?.emit('Page.frameNavigated', {
          frame: { id: 'f', url: 'https://example.com/a' },
        });
      return {};
    });
    holder.fake = fake;
    const session = await openLive(registry);
    const id = session.browserSessionId;
    // What the live-surface binder does for every live session.
    fake.host
      .cdp()
      .on('Page.frameNavigated', (params) =>
        registry.observeCommittedUrl(
          id,
          session.generation,
          (params as { frame: { url: string } }).frame.url,
        ),
      );
    await registry.navigateHistory(id, 'back', { actor: OPERATOR });
    const kinds = registry
      .getSession(id)!
      .history.entries.map((entry) => entry.kind);
    expect(kinds).toEqual(['created', 'history-navigated']);
  });

  test('a dialog the page shows while it first loads is answered before the session is live', async () => {
    const holder: { fake?: ReturnType<typeof eventHost> } = {};
    const { registry, fake } = harness((method) => {
      if (method === 'Page.navigate')
        holder.fake?.emit('Page.javascriptDialogOpening', {
          type: 'alert',
          message: 'welcome',
        });
      return {};
    });
    holder.fake = fake;
    const session = await openLive(registry);
    expect(fake.sent).toContainEqual({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false },
    });
    expect(
      registry.getSession(session.browserSessionId)!.activity.lastDialog,
    ).toMatchObject({ type: 'alert', message: 'welcome', accepted: false });
    // The early answerer hands over once live: nothing of it remains.
    expect(fake.listeners.get('Page.javascriptDialogOpening')?.size ?? 0).toBe(
      0,
    );
  });
});

describe('history wording from the live verify', () => {
  test("a navigation right after someone's click is the page's entry with that click as provenance, consumed once (F1)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { registry } = harness();
    const session = await openLive(registry);
    const id = session.browserSessionId;
    registry.noteInput(id, OPERATOR);
    vi.advanceTimersByTime(500);
    registry.observeCommittedUrl(
      id,
      session.generation,
      'https://example.com/a',
    );
    // A second commit inside the window: the arm was consumed.
    vi.advanceTimersByTime(500);
    registry.observeCommittedUrl(
      id,
      session.generation,
      'https://example.com/b',
    );
    const entries = registry.getSession(id)!.history.entries;
    expect(
      entries
        .slice(1)
        .map((entry) => [entry.kind, entry.actor.kind, entry.cause]),
    ).toEqual([
      ['link-followed', 'system', OPERATOR],
      ['page-navigated', 'system', undefined],
    ]);
    // Provenance never makes the clicker the session's driver.
    expect(registry.getSession(id)!.activity.lastDriver).toEqual(AGENT);
  });

  test('a page that redirects after every click cannot forge actor history or evict it (F1)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { registry } = harness();
    const session = await openLive(registry);
    const id = session.browserSessionId;
    for (let i = 0; i < 200; i += 1) {
      registry.noteInput(id, OPERATOR);
      registry.observeCommittedUrl(
        id,
        session.generation,
        `https://example.com/${i}`,
      );
      vi.advanceTimersByTime(11_000);
    }
    const record = registry.getSession(id)!;
    expect(
      record.history.entries
        .filter((entry) => entry.actor.kind !== 'system')
        .map((entry) => entry.kind),
    ).toEqual(['created']);
    expect(
      record.history.entries.filter((entry) => entry.kind === 'link-followed')
        .length,
    ).toBeLessThanOrEqual(BROWSER_SESSION_PAGE_NOISE_LIMIT);
    expect(record.activity.lastDriver).toEqual(AGENT);
  });

  test("a navigation Station refused is recorded as Station's refusal — for the operator only", async () => {
    const { registry } = harness(
      (method) =>
        method === 'Page.navigate'
          ? { errorText: 'net::ERR_BLOCKED_BY_CLIENT' }
          : {},
      (url) => url.startsWith('http://127.0.0.1:3141'),
    );
    // The operator's own session (an admin could never read its history).
    const session = await registry.createSession({
      projectId: 'alpha',
      projectSlug: 'alpha',
      url: 'https://example.com/',
      actor: OPERATOR,
    });
    const id = session.browserSessionId;
    await registry.navigate(id, 'http://127.0.0.1:3141/', { actor: OPERATOR });
    expect(registry.getSession(id)!.history.entries.at(-1)).toMatchObject({
      kind: 'navigation-blocked',
      detail: "blocked by Station: it is one of Station's own services",
    });
    const admin: BrowserSessionActor = {
      kind: 'project-admin',
      principalId: 'admin-1',
    };
    await registry.navigate(id, 'http://127.0.0.1:3141/x', { actor: admin });
    expect(registry.getSession(id)!.history.entries.at(-1)).toMatchObject({
      kind: 'navigated',
      detail: 'net::ERR_BLOCKED_BY_CLIENT',
    });
  });

  test("the operator driving an ADMIN's session never leaves a Station-block entry an admin can read", async () => {
    const { registry } = harness(
      (method) =>
        method === 'Page.navigate'
          ? { errorText: 'net::ERR_BLOCKED_BY_CLIENT' }
          : {},
      (url) => url.startsWith('http://127.0.0.1:3141'),
    );
    const session = await registry.createSession({
      projectId: 'alpha',
      projectSlug: 'alpha',
      url: 'https://example.com/',
      actor: { kind: 'project-admin', principalId: 'admin-1' },
    });
    await registry.navigate(
      session.browserSessionId,
      'http://127.0.0.1:3141/',
      {
        actor: OPERATOR,
      },
    );
    expect(
      registry.getSession(session.browserSessionId)!.history.entries.at(-1),
    ).toMatchObject({
      kind: 'navigated',
      detail: 'net::ERR_BLOCKED_BY_CLIENT',
    });
  });
});
