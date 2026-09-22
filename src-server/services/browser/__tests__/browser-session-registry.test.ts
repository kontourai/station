import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BrowserHost, CdpTransport } from '../browser-host.js';
import {
  BROWSER_SESSION_HISTORY_LIMIT,
  type BrowserSessionActor,
  BrowserSessionError,
  BrowserSessionRegistry,
  browserProfileDir,
} from '../browser-session-registry.js';

const OPERATOR: BrowserSessionActor = { kind: 'operator' };
const AGENT: BrowserSessionActor = {
  kind: 'agent',
  sessionId: 'agent-session-1',
};

/** A fake host: one per launch, like the real single-use Chromium host. */
function fakeHost(id: number) {
  const exitListeners = new Set<(reason: string) => void>();
  const sent: Array<{ method: string; params?: object; sessionId?: string }> =
    [];
  let targetSeq = 0;
  const cdp: CdpTransport = {
    async send<R>(method: string, params?: object, sessionId?: string) {
      sent.push({ method, params, sessionId });
      return {} as R;
    },
    on: () => () => {},
    close: async () => {},
    closed: new Promise(() => {}),
  };
  const host = {
    kind: 'server-chromium' as const,
    profileDirs: [] as string[],
    closedTargets: [] as string[],
    shutdown: vi.fn(async () => {}),
    async openTarget(p: { profileDir: string }) {
      host.profileDirs.push(p.profileDir);
      targetSeq += 1;
      return {
        targetId: `H${id}-T${targetSeq}`,
        cdpSessionId: `H${id}-S${targetSeq}`,
      };
    },
    cdp: () => cdp,
    async closeTarget(targetId: string) {
      host.closedTargets.push(targetId);
    },
    onExit(fn: (reason: string) => void) {
      exitListeners.add(fn);
      return () => exitListeners.delete(fn);
    },
    crash(reason = 'browser process exited (signal SIGKILL)') {
      for (const fn of [...exitListeners]) fn(reason);
    },
    sent,
  } satisfies BrowserHost & Record<string, unknown>;
  return host;
}

const homes: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function harness(
  options: { stationHome?: string; idleShutdownMs?: number } = {},
) {
  const stationHome =
    options.stationHome ?? mkdtempSync(join(tmpdir(), 'station-browser-reg-'));
  if (!options.stationHome) homes.push(stationHome);
  const hosts: Array<ReturnType<typeof fakeHost>> = [];
  let ids = 0;
  const registry = new BrowserSessionRegistry({
    stationHome,
    idleShutdownMs: options.idleShutdownMs ?? 1_000,
    createHost: () => {
      const host = fakeHost(hosts.length + 1);
      hosts.push(host);
      return host;
    },
    newId: () => `bs_${++ids}`,
  });
  return { registry, hosts, stationHome };
}

describe('BrowserSessionRegistry', () => {
  test('creates a live session in the Project profile and navigates it', async () => {
    const { registry, hosts, stationHome } = harness();
    const session = await registry.createSession({
      projectId: 'alpha',
      threadId: 'thread-1',
      url: 'localhost:5173',
      actor: OPERATOR,
    });
    expect(session).toMatchObject({
      browserSessionId: 'bs_1',
      projectId: 'alpha',
      threadId: 'thread-1',
      url: 'http://localhost:5173/',
      generation: 1,
      hostKind: 'server-chromium',
      profileRef: 'projects/alpha/browser/profile',
      state: 'live',
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });
    expect(hosts[0]?.profileDirs).toEqual([
      browserProfileDir(stationHome, 'projects/alpha/browser/profile'),
    ]);
    expect(hosts[0]?.sent).toContainEqual({
      method: 'Page.navigate',
      params: { url: 'http://localhost:5173/' },
      sessionId: 'H1-S1',
    });
  });

  test('one browser process per Project profile, several targets in it', async () => {
    const { registry, hosts } = harness();
    await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    await registry.createSession({
      projectId: 'beta',
      url: 'about:blank',
      actor: OPERATOR,
    });
    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.profileDirs).toHaveLength(2);
  });

  test('refuses out-of-scope URLs, bad Project ids and bad viewports before launching anything', async () => {
    const { registry, hosts } = harness();
    await expect(
      registry.createSession({
        projectId: 'alpha',
        url: 'file:///etc/passwd',
        actor: OPERATOR,
      }),
    ).rejects.toMatchObject({
      code: 'url-not-allowed',
      detail: { urlRejection: 'unsupported-scheme' },
    });
    for (const projectId of ['..', '../x', 'a/b', '', '.hidden']) {
      await expect(
        registry.createSession({
          projectId,
          url: 'about:blank',
          actor: OPERATOR,
        }),
      ).rejects.toMatchObject({ code: 'invalid-project' });
    }
    await expect(
      registry.createSession({
        projectId: 'alpha',
        url: 'about:blank',
        viewport: { width: 99999, height: 10, deviceScaleFactor: 1 },
        actor: OPERATOR,
      }),
    ).rejects.toMatchObject({ code: 'invalid-viewport' });
    expect(hosts).toEqual([]);
    expect(registry.listSessions()).toEqual([]);
  });

  test('a crash marks sessions needs-reopen; reopening bumps the generation and stale references fail', async () => {
    const { registry, hosts } = harness();
    const session = await registry.createSession({
      projectId: 'alpha',
      url: 'https://example.com',
      actor: OPERATOR,
    });
    expect(session.generation).toBe(1);
    hosts[0]?.crash();
    expect(registry.getSession(session.browserSessionId)).toMatchObject({
      state: 'needs-reopen',
      endReason: 'host-exited',
      generation: 1,
    });
    await expect(
      registry.navigate(session.browserSessionId, 'https://example.org', {
        actor: AGENT,
      }),
    ).rejects.toMatchObject({ code: 'not-live' });
    const reopened = await registry.reopenSession(
      session.browserSessionId,
      OPERATOR,
    );
    expect(reopened).toMatchObject({ state: 'live', generation: 2 });
    expect(hosts).toHaveLength(2);
    // The reopened session lands on its last URL in the NEW browser.
    expect(hosts[1]?.sent).toContainEqual({
      method: 'Page.navigate',
      params: { url: 'https://example.com/' },
      sessionId: 'H2-S1',
    });
    const stale = await registry
      .navigate(session.browserSessionId, 'https://example.org', {
        generation: 1,
        actor: AGENT,
      })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(BrowserSessionError);
    expect(stale).toMatchObject({
      code: 'stale-generation',
      detail: { generation: 2 },
    });
    const fresh = await registry.navigate(
      session.browserSessionId,
      'https://example.org',
      {
        generation: 2,
        actor: AGENT,
      },
    );
    expect(fresh.session.url).toBe('https://example.org/');
  });

  test('closing the last session shuts the browser down after the idle delay', async () => {
    vi.useFakeTimers();
    const { registry, hosts } = harness({ idleShutdownMs: 5_000 });
    const a = await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    const b = await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    await registry.closeSession(a.browserSessionId, OPERATOR);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hosts[0]?.shutdown).not.toHaveBeenCalled();
    await registry.closeSession(b.browserSessionId, OPERATOR);
    expect(hosts[0]?.closedTargets).toEqual(['H1-T1', 'H1-T2']);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(hosts[0]?.shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hosts[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(registry.hasRunningHost('alpha')).toBe(false);
    expect(registry.getSession(b.browserSessionId)).toMatchObject({
      state: 'closed',
    });
  });

  test('a new session during the idle delay keeps the browser', async () => {
    vi.useFakeTimers();
    const { registry, hosts } = harness({ idleShutdownMs: 5_000 });
    const a = await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    await registry.closeSession(a.browserSessionId, OPERATOR);
    await vi.advanceTimersByTimeAsync(2_000);
    await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hosts[0]?.shutdown).not.toHaveBeenCalled();
    expect(hosts).toHaveLength(1);
  });

  test('server stop shuts every browser down and refuses new work', async () => {
    const { registry, hosts } = harness();
    const a = await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    await registry.createSession({
      projectId: 'beta',
      url: 'about:blank',
      actor: OPERATOR,
    });
    await registry.shutdown();
    for (const host of hosts) expect(host.shutdown).toHaveBeenCalledTimes(1);
    expect(registry.getSession(a.browserSessionId)).toMatchObject({
      state: 'needs-reopen',
      endReason: 'server-stopped',
    });
    await expect(
      registry.createSession({
        projectId: 'alpha',
        url: 'about:blank',
        actor: OPERATOR,
      }),
    ).rejects.toMatchObject({ code: 'stopped' });
  });

  test('a restart never resurrects a session as live, and generations keep growing', async () => {
    const first = harness();
    const live = await first.registry.createSession({
      projectId: 'alpha',
      url: 'https://example.com',
      actor: OPERATOR,
    });
    const closed = await first.registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    await first.registry.closeSession(closed.browserSessionId, OPERATOR);
    // Simulate the server dying WITHOUT a graceful shutdown.
    const second = harness({ stationHome: first.stationHome });
    expect(second.registry.getSession(live.browserSessionId)).toMatchObject({
      state: 'needs-reopen',
      endReason: 'server-restarted',
      generation: 1,
      url: 'https://example.com/',
    });
    expect(second.registry.getSession(closed.browserSessionId)).toMatchObject({
      state: 'closed',
    });
    expect(second.registry.hasRunningHost('alpha')).toBe(false);
    expect(second.hosts).toEqual([]);
    await expect(
      second.registry.navigate(live.browserSessionId, 'https://example.org', {
        generation: 1,
        actor: AGENT,
      }),
    ).rejects.toMatchObject({ code: 'not-live' });
    const reopened = await second.registry.reopenSession(
      live.browserSessionId,
      OPERATOR,
    );
    expect(reopened.generation).toBe(2);
  });

  test('an unreadable store starts empty and cannot let an old generation match', async () => {
    const stationHome = mkdtempSync(join(tmpdir(), 'station-browser-reg-'));
    homes.push(stationHome);
    mkdirSync(join(stationHome, 'browser'), { recursive: true });
    writeFileSync(join(stationHome, 'browser', 'sessions.json'), '{not json');
    const { registry } = harness({ stationHome });
    expect(registry.listSessions()).toEqual([]);
    const session = await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    expect(session.generation).toBeGreaterThan(1_000_000);
    const stored = JSON.parse(
      readFileSync(join(stationHome, 'browser', 'sessions.json'), 'utf8'),
    );
    expect(stored.generations.alpha).toBe(session.generation);
  });

  test('persisted records hold no live state after a clean shutdown either', async () => {
    const { registry, stationHome } = harness();
    await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: OPERATOR,
    });
    await registry.shutdown();
    const stored = JSON.parse(
      readFileSync(join(stationHome, 'browser', 'sessions.json'), 'utf8'),
    ) as { sessions: Array<{ state: string }> };
    expect(stored.sessions.map((s) => s.state)).toEqual(['needs-reopen']);
  });

  test('records an attributed, append-only action history for every session (D6)', async () => {
    const { registry, hosts } = harness();
    const session = await registry.createSession({
      projectId: 'alpha',
      url: 'https://example.com',
      actor: AGENT,
    });
    await registry.navigate(session.browserSessionId, 'https://example.org', {
      actor: AGENT,
    });
    await expect(
      registry.navigate(session.browserSessionId, 'file:///etc/passwd', {
        actor: AGENT,
      }),
    ).rejects.toMatchObject({ code: 'url-not-allowed' });
    hosts[0]?.crash('browser process exited (code none, signal SIGKILL)');
    await registry.reopenSession(session.browserSessionId, OPERATOR);
    await registry.closeSession(session.browserSessionId, {
      kind: 'project-admin',
      principalId: 'p-1',
    });
    const history = registry.getSession(session.browserSessionId)?.history;
    expect(history?.total).toBe(6);
    expect(
      history?.entries.map((e) => [
        e.seq,
        e.kind,
        e.actor.kind,
        e.url ?? e.detail ?? null,
        e.generation,
      ]),
    ).toEqual([
      [1, 'created', 'agent', 'https://example.com/', 1],
      [2, 'navigated', 'agent', 'https://example.org/', 1],
      [3, 'navigation-refused', 'agent', 'unsupported-scheme', 1],
      [
        4,
        'host-exited',
        'system',
        'browser process exited (code none, signal SIGKILL)',
        1,
      ],
      [5, 'reopened', 'operator', 'https://example.org/', 2],
      [6, 'closed', 'project-admin', null, 2],
    ]);
  });

  test('history is bounded, and the drop is counted rather than silent', async () => {
    const { registry } = harness();
    const session = await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: AGENT,
    });
    for (let i = 0; i < BROWSER_SESSION_HISTORY_LIMIT + 10; i += 1) {
      await registry.navigate(
        session.browserSessionId,
        `https://example.com/${i}`,
        { actor: AGENT },
      );
    }
    const history = registry.getSession(session.browserSessionId)?.history;
    expect(history?.entries).toHaveLength(BROWSER_SESSION_HISTORY_LIMIT);
    expect(history?.total).toBe(BROWSER_SESSION_HISTORY_LIMIT + 11);
    expect(history?.entries.at(-1)?.url).toBe(
      `https://example.com/${BROWSER_SESSION_HISTORY_LIMIT + 9}`,
    );
    expect(history?.entries[0]?.seq).toBe(12);
  });

  test('every session stays listed, with a history summary, in any state', async () => {
    const { registry, hosts } = harness();
    const live = await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: AGENT,
    });
    const crashed = await registry.createSession({
      projectId: 'beta',
      url: 'about:blank',
      actor: AGENT,
    });
    const closed = await registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: AGENT,
    });
    await registry.closeSession(closed.browserSessionId, OPERATOR);
    hosts[1]?.crash();
    for (let i = 0; i < 8; i += 1)
      await registry.navigate(
        live.browserSessionId,
        `https://example.com/${i}`,
        { actor: AGENT },
      );
    const listed = registry.listSessions();
    expect(listed.map((s) => [s.browserSessionId, s.state]).sort()).toEqual(
      [
        [live.browserSessionId, 'live'],
        [crashed.browserSessionId, 'needs-reopen'],
        [closed.browserSessionId, 'closed'],
      ].sort(),
    );
    const summary = listed.find(
      (s) => s.browserSessionId === live.browserSessionId,
    );
    expect(summary?.history.total).toBe(9);
    expect(summary?.history.entries).toHaveLength(5);
    expect(summary?.history.omittedFromSummary).toBe(4);
    expect(
      registry
        .listSessions((s) => s.projectId === 'beta')
        .map((s) => s.browserSessionId),
    ).toEqual([crashed.browserSessionId]);
  });

  test('a restart appends a server-restarted action to sessions it demotes', async () => {
    const first = harness();
    const live = await first.registry.createSession({
      projectId: 'alpha',
      url: 'about:blank',
      actor: AGENT,
    });
    const second = harness({ stationHome: first.stationHome });
    const history = second.registry.getSession(live.browserSessionId)?.history;
    expect(history?.entries.map((e) => e.kind)).toEqual([
      'created',
      'server-restarted',
    ]);
  });
});
