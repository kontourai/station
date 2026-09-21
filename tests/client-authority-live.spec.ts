import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page } from '@playwright/test';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  type LiveStation,
  pairBrowserDevice,
  startStation,
  stationRootForLiveHome,
  stopStation,
} from './helpers/live-station-task';
import {
  pairBrowser,
  settlePageReason,
} from './live/helpers/station-instance.mjs';

/**
 * Live browser qualification of the #481 client-authority provider through
 * the REAL application stack: an isolated Station process started from this
 * checkout, the normal single-use ui-bootstrap pairing ceremony
 * (`pairBrowser` — mint with the per-boot local grant, then the browser
 * itself exchanges the fragment, exactly the journey `station start` prints),
 * and the production `main.tsx` → `PlatformSessionGate` → `ApiBaseProvider`
 * → `AuthorityQueryProvider` tree. Nothing here mounts a helper provider or
 * seeds an authenticated store: every protected read must pass through the
 * real credential-bound `GET /api/auth/authority` observation.
 *
 * One serial scenario over isolated homes:
 *   1. Ordinary boot reaches usable Home/Project data through the real
 *      authority endpoint with no observation loop (bounded observation
 *      reads after a single pairing navigation).
 *   2. Reload restores the SAME validated identity's Project data from the
 *      durable per-authority shelf while STILL re-observing authority live.
 *      EVERY fresh Project-producing path (`/api/projects` AND the SDK boot
 *      seed `GET /api/boot`, whose `sections.projects` writes the
 *      `['projects']` cache entry — `packages/sdk/src/boot.ts
 *      BOOT_SEED_KEYS`) is held behind a gate until after the fresh 200
 *      authority observation plus the rendered row, so a rendered row can
 *      only come from the shelf; the persisted blob under the exact
 *      authority key must itself contain the Project entry. Gates are
 *      released and unrouted even on assertion failure.
 *   3. A revoked device credential does not leave the prior protected view
 *      active: reload lands on the repair surface with no Project rows, and
 *      the supported request-access → owner-approval → exchange flow repairs
 *      the browser back to the same home's data.
 *   4. Two real Stations with colliding Project slugs but distinct names.
 *      The CANONICAL intended journey is asserted without compensation:
 *      Add → the manager STAYS OPEN with the row's Request access control →
 *      Back returns to the row list. On the current build the manager
 *      unmounts right after Add (the known-changing-connection regression);
 *      that is retained as a real red, and the journey is only run to
 *      completion after the root-supplied source fix.
 *
 * Diagnostic separation in (4): the browser-initiated CROSS-ORIGIN pairing
 * refusal (HTTP 403 `origin_forbidden` from
 * `isTrustedBrowserPairingOrigin`, src-server/runtime/routes/runtime-routes.ts)
 * is a REAL transport refusal, never counted as successful browser pairing.
 * The second home's credential is obtained through the SUPPORTED device
 * handshake (`pairBrowserDevice`: access-request → owner confirm → exchange)
 * and entered through the row's own manual-credential editor — a real DEVICE
 * credential, never an operator credential, never seeded storage. Only that
 * credential-entry path is used to qualify two-home isolation.
 *
 * Wrong-home evidence: a Node-retained recorder (context binding + init
 * script) samples each document's connection chip label, verifying state,
 * and which Project names are rendered; samples survive navigations and are
 * reduced ONLY from the actual activation boundary (first post-click sample
 * naming the newly active home), so old-home observations before a switch
 * are never false positives. The reduction is self-proven in-test against a
 * known wrong-home injection and refuses vacuous windows (no boundary, no
 * positive states). Screenshots are taken only after a positive settled
 * check (no loading treatment, current connection named by the toolbar
 * chip); a surface that cannot settle stays red.
 */

const PROJECT_SLUG = 'authority-collision';
const PROJECT_NAME_A = 'Alpha home authority collision';
const PROJECT_NAME_B = 'Bravo home authority collision';
const CHIP_TEST_ID = 'app-toolbar-connection';

/** One retained observation, serializable across the exposure binding. */
interface ConnectionSample {
  /** ms epoch of the sample. */
  time: number;
  /** performance.timeOrigin of the document that produced the sample. */
  documentId: number;
  /** Visible connection chip text (state + identity). */
  chip: string;
  /** Whether a verifying skeleton / authority pending treatment is shown. */
  verifying: boolean;
  /** Whether PROJECT_NAME_A is rendered anywhere in the document. */
  alphaProject: boolean;
  /** Whether PROJECT_NAME_B is rendered anywhere in the document. */
  bravoProject: boolean;
}

/**
 * Whether a sample renders a row for `name` (body flags) or names it on the
 * connection chip.
 */
function sampleNamesProject(sample: ConnectionSample, name: string): boolean {
  if (sample.chip.includes(name)) return true;
  if (name === PROJECT_NAME_A) return sample.alphaProject;
  if (name === PROJECT_NAME_B) return sample.bravoProject;
  return false;
}

/**
 * Index of the first sample at/after `afterTime` satisfying `boundaryOf` —
 * the ACTIVATION boundary (first observation of the newly active
 * connection), so pre-switch observations of the old home can never enter
 * the window.
 */
function activationBoundaryIndex(
  samples: ConnectionSample[],
  boundaryOf: (sample: ConnectionSample) => boolean,
  afterTime: number,
): number {
  return samples.findIndex(
    (sample) => sample.time >= afterTime && boundaryOf(sample),
  );
}

/**
 * Wrong-home reduction over the ACTIVATION window. Refuses to pass
 * vacuously: the boundary must exist, the window must contain positive
 * observations of the newly active home's Project, and any sample in the
 * window naming `wrongName` is a leak. Pre-boundary samples (the old
 * home's own rows) are excluded by the boundary, never by text filtering.
 */
function reduceActivationWindow(
  samples: ConnectionSample[],
  boundaryOf: (sample: ConnectionSample) => boolean,
  activeProjectSeen: (sample: ConnectionSample) => boolean,
  wrongName: string,
  afterTime: number,
): { boundary: number; window: ConnectionSample[]; leaks: ConnectionSample[] } {
  const boundary = activationBoundaryIndex(samples, boundaryOf, afterTime);
  if (boundary < 0)
    throw new Error(
      'no recorded sample crosses the activation boundary after the switch click',
    );
  const window = samples.slice(boundary);
  const positives = window.filter((sample) => activeProjectSeen(sample));
  if (positives.length === 0)
    throw new Error(
      "the recorder never observed the activated home's Project after activation — the window is not proven (no vacuous pass)",
    );
  const leaks = window.filter((sample) =>
    sampleNamesProject(sample, wrongName),
  );
  return { boundary, window, leaks };
}

/** Live stations owned for the whole serial scenario. */
const stations: Record<'alpha' | 'bravo', LiveStation | null> = {
  alpha: null,
  bravo: null,
};
/** Browser contexts kept open across serial tests (cookies + IndexedDB). */
const openContexts: BrowserContext[] = [];

/**
 * Inherited environment for the launched Station processes: user/session
 * Station state and temp overrides are stripped so the isolated homes are
 * the only state the processes can see. `startStation` re-adds the
 * instance's own STATION_ROOT/STATION_HOME on top of this.
 */
function sanitizedLaunchEnvironment(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key.startsWith('STATION_') ||
      key === 'TMPDIR' ||
      key === 'TMP' ||
      key === 'TEMP'
    )
      continue;
    clean[key] = value;
  }
  return {
    ...clean,
    STATION_LOG_LEVEL: 'error',
    OTEL_SDK_DISABLED: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}

test.describe
  .serial('client authority live qualification (#481)', () => {
    test.setTimeout(300_000);

    async function closeStations(keepHomes: boolean) {
      const errors: unknown[] = [];
      for (const key of ['alpha', 'bravo'] as const) {
        const live = stations[key];
        if (!live) continue;
        try {
          await stopStation(live);
        } catch (error) {
          errors.push(error);
        }
        stations[key] = null;
        if (!keepHomes && !errors.length) {
          rmSync(stationRootForLiveHome(live.home), {
            recursive: true,
            force: true,
          });
        }
      }
      if (errors.length > 0)
        throw new Error(
          'Failed to stop isolated client-authority Stations; diagnostic homes preserved',
          { cause: errors },
        );
    }

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(420_000);
      const alpha = await allocateLiveStation(
        'station-client-authority-',
        'client-authority-alpha',
      );
      stations.alpha = alpha;
      const bravo = await allocateLiveStation(
        'station-client-authority-',
        'client-authority-bravo',
      );
      stations.bravo = bravo;
      // Cleanup is owned by afterAll (and this catch) before the slow
      // startup awaits are attempted; a bravo failure must not orphan an
      // alpha process.
      try {
        await startStation(alpha, true, {
          logFile: testInfo.outputPath(`${alpha.instance}.log`),
          environment: {
            ...sanitizedLaunchEnvironment(),
            ALLOWED_ORIGINS: `${alpha.ui},${bravo.ui}`,
          },
        });
        await startStation(bravo, true, {
          logFile: testInfo.outputPath(`${bravo.instance}.log`),
          environment: {
            ...sanitizedLaunchEnvironment(),
            ALLOWED_ORIGINS: `${alpha.ui},${bravo.ui}`,
          },
        });
      } catch (error) {
        await closeStations(false).catch(() => {});
        throw error;
      }
    });

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.afterAll(async ({}, testInfo) => {
      testInfo.setTimeout(180_000);
      for (const context of openContexts.splice(0)) {
        await context.close().catch(() => {});
      }
      await closeStations(testInfo.status === testInfo.expectedStatus);
    });

    const operatorHeadersFor = (live: LiveStation) => ({
      Authorization: `Bearer ${readE2EOperatorCredential(live.home)}`,
      'Content-Type': 'application/json',
      Origin: live.ui,
    });

    async function createHomeProject(live: LiveStation, name: string) {
      const response = await fetch(`${live.api}/api/projects`, {
        method: 'POST',
        headers: operatorHeadersFor(live),
        body: JSON.stringify({
          name,
          slug: PROJECT_SLUG,
          workingDirectory: live.home,
        }),
      });
      const body = (await response.json()) as { success?: boolean };
      expect(
        response.status,
        `Project creation on ${live.instance} failed`,
      ).toBe(201);
      expect(body.success).toBe(true);
    }

    /** Every /api/auth/authority request the page issues from now on. */
    function observeAuthorityReads(page: Page): string[] {
      const reads: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/auth/authority')
          reads.push(request.url());
      });
      return reads;
    }

    async function expectProjectRowVisible(page: Page, name: string) {
      await expect(
        page.getByRole('main').getByText(name).first(),
        `${name} must be visible through the verified authority tree`,
      ).toBeVisible({ timeout: 45_000 });
    }

    async function connectionChipLabel(page: Page): Promise<string> {
      return (
        (await page.getByTestId(CHIP_TEST_ID).getAttribute('aria-label')) ?? ''
      );
    }

    async function pollChipLabel(
      page: Page,
      assertion: 'contains' | 'notContains',
      label: string,
    ) {
      const poll = expect.poll(() => connectionChipLabel(page), {
        timeout: 30_000,
      });
      if (assertion === 'contains') await poll.toContain(label);
      else await poll.not.toContain(label);
    }

    /**
     * Positive settled-capture gate: no loading treatment anywhere (the
     * canonical settle helper), AND the toolbar chip positively names the
     * expected current connection. A surface that cannot settle stays red
     * BEFORE any capture is taken.
     */
    async function expectSettledActiveSurface(
      page: Page,
      activeLabel: string | null,
    ) {
      const reason = await settlePageReason(page, 45_000);
      expect(
        reason,
        `the surface must settle (no overlay/skeleton) before capture: ${reason ?? 'ok'}`,
      ).toBeNull();
      if (activeLabel !== null)
        await pollChipLabel(page, 'contains', activeLabel);
    }

    /**
     * Node-retained wrong-home recorder: samples are pushed to the TEST
     * process through a context binding, so navigation and reload can never
     * erase them (the per-document init script only (re)starts the
     * interval; the buffer lives in Node). The recorder is armed once per
     * context, before the first page exists.
     */
    async function installSampleRecorder(
      context: BrowserContext,
    ): Promise<ConnectionSample[]> {
      const samples: ConnectionSample[] = [];
      await context.exposeBinding(
        '__clientAuthoritySample',
        async (_source, sample: ConnectionSample) => {
          samples.push(sample);
        },
      );
      await context.addInitScript(() => {
        const globalWindow = window as Window & {
          __clientAuthoritySample?: (sample: unknown) => Promise<void>;
          __clientAuthorityRecorderTimer?: number;
        };
        if (globalWindow.__clientAuthorityRecorderTimer !== undefined) return;
        const documentId = performance.timeOrigin;
        const record = () => {
          void globalWindow.__clientAuthoritySample?.({
            time: Date.now(),
            documentId,
            chip:
              document.querySelector('[data-testid="app-toolbar-connection"]')
                ?.textContent ?? '',
            verifying:
              document.querySelector('[role="status"][aria-busy="true"]') !==
                null ||
              document.querySelector('.skeleton') !== null ||
              document.querySelector('.fs-screen') !== null,
            alphaProject: document.body.innerText.includes(
              'Alpha home authority collision',
            ),
            bravoProject: document.body.innerText.includes(
              'Bravo home authority collision',
            ),
          });
        };
        globalWindow.__clientAuthorityRecorderTimer = window.setInterval(
          record,
          100,
        );
        window.addEventListener('pagehide', () => {
          window.clearInterval(globalWindow.__clientAuthorityRecorderTimer);
          globalWindow.__clientAuthorityRecorderTimer = undefined;
          record();
        });
      });
      return samples;
    }

    /**
     * Owner-side approval of a pending device pairing request on `live` —
     * the supported handshake, performed with the host's operator
     * credential against the host's own API (never through a collaborator
     * UI). Returns whether a pending request was found: a loopback peer on
     * the SAME machine can be auto-approved by the host's own local-trust
     * policy, in which case no pending request exists to confirm.
     */
    async function approvePendingPairing(live: LiveStation): Promise<boolean> {
      const deadline = Date.now() + 20_000;
      let requestId = '';
      while (!requestId && Date.now() < deadline) {
        const pending = await fetch(`${live.api}/api/pairing/requests`, {
          headers: operatorHeadersFor(live),
        });
        expect(pending.status).toBe(200);
        const body = (await pending.json()) as {
          requests?: Array<{ requestId?: string }>;
        };
        requestId = body.requests?.find((entry) => entry.requestId)
          ?.requestId as string;
        if (!requestId)
          await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!requestId) return false;
      const confirmation = await fetch(
        `${live.api}/api/pairing/requests/${encodeURIComponent(requestId)}/confirm`,
        { method: 'POST', headers: operatorHeadersFor(live) },
      );
      expect(
        confirmation.status,
        'the owner must be able to approve the pending device',
      ).toBe(200);
      await confirmation.text();
      return true;
    }

    /** A settled verified boot: real main content, no loading treatments. */
    async function expectSettledVerifiedHome(page: Page) {
      const reason = await settlePageReason(page, 45_000);
      expect(reason, 'the paired boot must settle to real content').toBeNull();
    }

    /**
     * Reads the persisted shelf blob stored under the exact per-authority
     * key in IndexedDB (`station-query-cache`/`cache`). Returns the raw
     * stored string, or null when the key is absent.
     */
    async function readPersistedShelf(
      page: Page,
    ): Promise<{ key: string; value: string | null }> {
      return page.evaluate(async () => {
        if (typeof indexedDB === 'undefined') return { key: '', value: null };
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('station-query-cache');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        try {
          const store = database
            .transaction('cache', 'readonly')
            .objectStore('cache');
          const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
            const request = store.getAllKeys();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
          });
          const namespaced = keys
            .map(String)
            .filter((name) => name.startsWith('station-query-cache-v1::'));
          if (namespaced.length === 0) return { key: '', value: null };
          const key = namespaced[namespaced.length - 1]!;
          const value = await new Promise<string | undefined>(
            (resolve, reject) => {
              const request = store.get(key);
              request.onerror = () => reject(request.error);
              request.onsuccess = () =>
                resolve(request.result as string | undefined);
            },
          );
          return { key, value: value ?? null };
        } finally {
          database.close();
        }
      });
    }

    test('boot reaches Home/Project data through the real authority endpoint with no loop', async ({
      browser,
    }, testInfo) => {
      const alpha = stations.alpha!;
      const context = await browser.newContext({ colorScheme: 'dark' });
      openContexts.push(context);
      const page = await context.newPage();
      const authorityReads = observeAuthorityReads(page);

      // The home's Project data exists before the browser ever pairs.
      await createHomeProject(alpha, PROJECT_NAME_A);

      await pairBrowser(page, {
        root: process.cwd(),
        instance: alpha.instance,
        serverPort: alpha.serverPort,
        uiOrigin: alpha.ui,
      });
      await expectSettledVerifiedHome(page);

      // The protected tree only mounts after a live observation succeeded:
      // at least one real /api/auth/authority read must have happened before
      // Project data renders, and only a bounded number of them — an
      // observation deadlock/loop would keep issuing reads or never settle.
      expect(
        authorityReads.length,
        'boot must observe authority through the real endpoint',
      ).toBeGreaterThanOrEqual(1);
      expect(
        authorityReads.length,
        'boot must not loop authority observations',
      ).toBeLessThanOrEqual(4);

      await page.goto(`${alpha.ui}/projects/${PROJECT_SLUG}`);
      await expectProjectRowVisible(page, PROJECT_NAME_A);
      await expectSettledActiveSurface(page, null);

      // Evidence: the verified dark wide boot.
      await page.screenshot({
        path: testInfo.outputPath('client-authority-alpha-boot-dark.png'),
        fullPage: true,
      });
    });

    test('reload restores the same validated identity data and re-observes authority', async () => {
      const page = openContexts[0]!.pages()[0]!;
      const authorityReads = observeAuthorityReads(page);

      // Controlled delayed reads: EVERY fresh Project-producing path is
      // held behind gates across the reload — the /api/projects list AND
      // the SDK boot seed (GET /api/boot, whose sections.projects writes
      // the ['projects'] cache entry; see packages/sdk/src/boot.ts
      // BOOT_SEED_KEYS). Everything the page renders before both gates
      // open therefore comes from the durable shelf, not from any fresh
      // network read. The gates hold the REAL responses (route.continue) —
      // no fixture answer, no offline bypass — and the authority endpoint
      // stays live. Release and unroute happen even on assertion failure.
      let releaseGates: () => void = () => {};
      const gates = new Promise<void>((resolve) => {
        releaseGates = resolve;
      });
      await page.route(
        (url) => url.pathname === '/api/projects',
        async (route) => {
          await gates;
          await route.continue();
        },
      );
      await page.route(
        (url) => url.pathname === '/api/boot',
        async (route) => {
          await gates;
          await route.continue();
        },
      );
      try {
        const authorityObserved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/auth/authority' &&
            response.status() === 200,
          { timeout: 60_000 },
        );
        await page.reload();
        await authorityObserved;

        // The SAME validated identity's Project row must render from the
        // restored shelf while BOTH fresh Project-producing paths are still
        // held, AFTER the fresh successful authority observation.
        await expect(
          page.getByRole('navigation').getByText(PROJECT_NAME_A).first(),
          'the restored shelf must render the same identity Project data behind held fresh reads',
        ).toBeVisible({ timeout: 45_000 });

        // Discriminator on the persisted state itself: a REAL Project entry
        // must exist under the exact per-authority key. With persistence
        // disabled or the shelf removed, this assertion (and the held-read
        // rendering above) goes red — the pass is not reachable from a
        // boot-seed or fresh-fetch path alone.
        const shelf = await readPersistedShelf(page);
        expect(
          shelf.key,
          'a per-authority persistence key must exist (station-query-cache-v1::<namespace>)',
        ).not.toBe('');
        expect(
          shelf.value,
          `the shelf under ${shelf.key} must contain stored data`,
        ).not.toBeNull();
        expect(
          shelf.value,
          'the persisted shelf under the exact authority key must contain the Project entry',
        ).toContain(PROJECT_NAME_A);

        await expect(
          page.getByRole('navigation').getByText(PROJECT_NAME_A).first(),
        ).toBeVisible({ timeout: 15_000 });
      } finally {
        releaseGates();
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }

      // Reload MUST re-observe (staleTime 0 / refetchOnMount always), not
      // silently trust the restored shelf.
      expect(
        authorityReads.length,
        'reload must issue a fresh /api/auth/authority observation',
      ).toBeGreaterThanOrEqual(1);
    });

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test('revoked credential quarantines the protected view and retains a repair path', async ({}, testInfo) => {
      const alpha = stations.alpha!;
      const page = openContexts[0]!.pages()[0]!;

      // The browser's own active device, read from the server's record —
      // the bootstrap pairing admitted exactly one interactive device.
      const devicesResponse = await fetch(`${alpha.api}/api/pairing/devices`, {
        headers: operatorHeadersFor(alpha),
      });
      expect(devicesResponse.status).toBe(200);
      const { devices } = (await devicesResponse.json()) as {
        devices: Array<{ id: string; name: string; revokedAt: number | null }>;
      };
      const active = devices.filter((device) => device.revokedAt === null);
      expect(
        active.length,
        `expected exactly one active device, saw ${JSON.stringify(devices.map((device) => device.name))}`,
      ).toBe(1);
      const deviceId = active[0]!.id;
      const revoke = await fetch(
        `${alpha.api}/api/pairing/devices/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE', headers: operatorHeadersFor(alpha) },
      );
      expect(revoke.status, 'the owner must be able to revoke').toBe(200);
      await revoke.text();

      // The revoked credential must NOT keep the prior protected view: a
      // reload re-observes, the observation is refused, and the tree runs
      // ephemeral on the repair surface with no remembered Project rows.
      await page.reload();
      await expect(
        page.getByRole('region', { name: 'Station access required' }),
        'the revoked browser must land on the access/repair surface',
      ).toBeVisible({ timeout: 45_000 });
      await expect(
        page.getByRole('main').getByText(PROJECT_NAME_A),
      ).toHaveCount(0);

      // Repair path: the supported request → owner approval → exchange
      // flow, entirely through real user-facing controls. The gate's
      // "Current Station" region offers request access for this browser.
      await page
        .getByRole('region', { name: 'Station access required' })
        .getByRole('region', { name: 'Current Station' })
        .getByRole('button', { name: 'Request access', exact: true })
        .click();
      // The request-access dialog confirms with its own Request access
      // button (device name prefilled from the browser).
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Request access', exact: true })
        .click();
      await approvePendingPairing(alpha);

      // The pending-exchange poll completes the pairing and the app boots
      // back into the same home's protected data.
      await expectProjectRowVisible(page, PROJECT_NAME_A);
      await expectSettledActiveSurface(page, null);
      await page.screenshot({
        path: testInfo.outputPath('client-authority-repaired-after-revoke.png'),
        fullPage: true,
      });
    });

    test('two homes with colliding Project slugs: canonical modal continuity, real refusal diagnostic, credential-entry isolation', async ({
      browser,
    }, testInfo) => {
      const alpha = stations.alpha!;
      const bravo = stations.bravo!;
      // Alpha's colliding Project already exists from test 1; only bravo's
      // row is new here.
      await createHomeProject(bravo, PROJECT_NAME_B);

      const context = await browser.newContext({ colorScheme: 'dark' });
      openContexts.push(context);
      // The recorder is bound to the CONTEXT before the page exists, so its
      // Node-side buffer survives every navigation and reload below.
      const samples = await installSampleRecorder(context);
      const page = await context.newPage();
      await pairBrowser(page, {
        root: process.cwd(),
        instance: alpha.instance,
        serverPort: alpha.serverPort,
        uiOrigin: alpha.ui,
      });
      await expectSettledVerifiedHome(page);
      await page.goto(`${alpha.ui}/projects/${PROJECT_SLUG}`);
      await expectProjectRowVisible(page, PROJECT_NAME_A);

      // Real user-facing connection controls: the toolbar's connection
      // chip opens the connections manager.
      await page.getByTestId(CHIP_TEST_ID).click();
      const dialog = page.getByRole('dialog');
      await dialog
        .getByRole('button', { name: 'Add a Station address' })
        .click();
      await dialog.getByLabel('Name (optional)').fill('Bravo home');
      await dialog
        .getByLabel('Station address')
        .fill(`http://127.0.0.1:${bravo.serverPort}`);
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();

      // CANONICAL CONTINUITY (no compensation, no alternative states): the
      // manager must stay open on the row list and offer the row's own
      // Request access control. On the current build the whole children
      // subtree (including this modal flow) unmounts right after Add —
      // the known changing-connection regression — and this assertion
      // retains that red. Do not reopen; the journey resumes only after
      // the root-supplied source fix.
      await expect(
        dialog.getByRole('button', { name: 'Request access to Bravo home' }),
        'the connections manager must stay open with the row Request access control after Add',
      ).toBeVisible({ timeout: 30_000 });
      await dialog
        .getByRole('button', { name: 'Request access to Bravo home' })
        .click();
      // The request-access journey confirms with its own dialog (device
      // name prefilled from the browser), and Back must return to the row
      // list — the continuity the hosted regression named.
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Request access', exact: true })
        .click();

      // REAL TRANSPORT REFUSAL, retained as a diagnostic — this is NOT
      // successful browser pairing: bravo refuses every browser-initiated
      // cross-site fetch (HTTP 403 `origin_forbidden`,
      // isTrustedBrowserPairingOrigin,
      // src-server/runtime/routes/runtime-routes.ts), and the UI names the
      // refusal verbatim.
      await expect(
        page.getByText(
          'This Station does not allow access requests from this app address.',
        ),
        'the browser-initiated cross-origin pairing refusal is real',
      ).toBeVisible({ timeout: 30_000 });
      await page.screenshot({
        path: testInfo.outputPath(
          'client-authority-cross-origin-pairing-refused.png',
        ),
        fullPage: true,
      });
      // Back continuity: the refusal view must hand back to the journey.
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(
        dialog.getByRole('button', { name: 'Request access to Bravo home' }),
        'Back must return to the row list',
      ).toBeVisible({ timeout: 30_000 });

      // Named diagnostic transport (NOT browser pairing): the credential
      // comes from the SUPPORTED device handshake (pairBrowserDevice:
      // access-request → owner confirm → exchange, the handshake the
      // device-pairing specs prove) and is entered through the row's own
      // manual-credential editor — a real DEVICE credential, never an
      // operator credential, never seeded storage.
      const bravoDevice = await pairBrowserDevice(
        bravo,
        readE2EOperatorCredential(bravo.home),
        'Client authority live browser',
      );
      await dialog
        .getByRole('button', { name: 'More actions for Bravo home' })
        .click();
      await dialog
        .getByRole('menu', { name: 'Actions for Bravo home' })
        .getByRole('menuitem', { name: 'Edit Station' })
        .click();
      await dialog
        .getByLabel('Station access credential')
        .fill(bravoDevice.credential);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();

      // Canonical activation: the row's own select control.
      const switchClickTime = Date.now();
      await dialog.getByRole('button', { name: 'Select Bravo home' }).click();
      await expect(
        page.getByRole('main').getByText(PROJECT_NAME_B).first(),
        'bravo must become the active authority after Select',
      ).toBeVisible({ timeout: 45_000 });
      await pollChipLabel(page, 'contains', 'Bravo home');
      await expect(
        page.getByRole('main').getByText(PROJECT_NAME_A),
      ).toHaveCount(0);

      // Wrong-home reduction over the ACTIVATION window only: samples are
      // retained in Node across the whole journey; the window starts at the
      // first post-click sample naming bravo, so alpha's own pre-switch
      // rows can never be false positives.
      const bravoWindow = reduceActivationWindow(
        samples,
        (sample) => sample.chip.includes('Bravo home'),
        (sample) => sample.bravoProject,
        'Alpha home authority collision',
        switchClickTime,
      );
      expect(
        bravoWindow.leaks,
        `alpha rows must never render while bravo is active (window of ${bravoWindow.window.length} samples)`,
      ).toEqual([]);

      // Evidence: bravo verified, dark, wide — captured only after the
      // positive settled/active gate.
      await expectSettledActiveSurface(page, 'Bravo home');
      await page.screenshot({
        path: testInfo.outputPath('client-authority-bravo-switch-dark.png'),
        fullPage: true,
      });

      // Narrow light variant of the same verified bravo surface: the app
      // theme is the persisted device-settings preference. The capture is
      // gated the same way; a washed-out overlay/skeleton surface stays
      // red instead of being captured.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => {
        localStorage.setItem(
          'station-device-settings-v1',
          JSON.stringify({ version: 2, values: { theme: 'light' } }),
        );
      });
      const narrowReloadTime = Date.now();
      await page.reload();
      await expectProjectRowVisible(page, PROJECT_NAME_B);
      const narrowWindow = reduceActivationWindow(
        samples,
        (sample) => sample.chip.includes('Bravo home'),
        (sample) => sample.bravoProject,
        'Alpha home authority collision',
        narrowReloadTime,
      );
      expect(
        narrowWindow.leaks,
        `reload on bravo must never show alpha rows (window of ${narrowWindow.window.length} samples)`,
      ).toEqual([]);
      await expectSettledActiveSurface(page, 'Bravo home');
      await page.screenshot({
        path: testInfo.outputPath('client-authority-bravo-narrow-light.png'),
        fullPage: true,
      });

      // Switch back to alpha through the same real controls: open the
      // manager (a fresh canonical user action, not a workaround), select
      // the alpha row, and reduce the activation window for alpha.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByTestId(CHIP_TEST_ID).click();
      const switchBackDialog = page.getByRole('dialog');
      const alphaSelect = switchBackDialog
        .getByRole('button', { name: /^Select (?!Bravo)/ })
        .first();
      await expect(alphaSelect).toBeVisible({ timeout: 30_000 });
      const switchBackTime = Date.now();
      await alphaSelect.click();
      await expect(
        page.getByRole('main').getByText(PROJECT_NAME_A).first(),
        'alpha must become the active authority after switching back',
      ).toBeVisible({ timeout: 45_000 });
      await pollChipLabel(page, 'notContains', 'Bravo home');
      const alphaWindow = reduceActivationWindow(
        samples,
        (sample) =>
          sample.chip.length > 0 && !sample.chip.includes('Bravo home'),
        (sample) => sample.alphaProject,
        'Bravo home authority collision',
        switchBackTime,
      );
      expect(
        alphaWindow.leaks,
        `bravo rows must never render while alpha is active (window of ${alphaWindow.window.length} samples)`,
      ).toEqual([]);
      await expect(
        page.getByRole('main').getByText(PROJECT_NAME_B),
      ).toHaveCount(0);

      // Oracle power proof (Node-side, no browser): the reduction must
      // flag a KNOWN wrong-home injection inside the window, must NOT flag
      // the same observation BEFORE the boundary (old home is not a leak),
      // and must refuse vacuous windows (no boundary / no positive states).
      const synthetic: ConnectionSample[] = [
        {
          time: switchClickTime - 1000,
          documentId: 1,
          chip: 'Connected · Default',
          verifying: false,
          alphaProject: true,
          bravoProject: false,
        },
        {
          time: switchClickTime + 1000,
          documentId: 1,
          chip: 'Connected · Bravo home',
          verifying: false,
          alphaProject: true,
          bravoProject: true,
        },
        {
          time: switchClickTime + 2000,
          documentId: 1,
          chip: 'Connected · Bravo home',
          verifying: false,
          alphaProject: false,
          bravoProject: true,
        },
      ];
      expect(
        reduceActivationWindow(
          synthetic,
          (sample) => sample.chip.includes('Bravo home'),
          (sample) => sample.bravoProject,
          'Alpha home authority collision',
          switchClickTime,
        ).leaks,
        'the oracle must flag a known wrong-home row inside the activation window',
      ).toHaveLength(1);
      expect(
        () =>
          reduceActivationWindow(
            synthetic.slice(0, 1),
            (sample) => sample.chip.includes('Bravo home'),
            (sample) => sample.bravoProject,
            'Alpha home authority collision',
            switchClickTime,
          ),
        'the oracle must refuse a window with no activation boundary',
      ).toThrow();
      expect(
        () =>
          reduceActivationWindow(
            [
              {
                time: switchClickTime + 1000,
                documentId: 1,
                chip: 'Connected · Bravo home',
                verifying: true,
                alphaProject: false,
                bravoProject: false,
              },
            ],
            (sample) => sample.chip.includes('Bravo home'),
            (sample) => sample.bravoProject,
            'Alpha home authority collision',
            switchClickTime,
          ),
        'the oracle must refuse a window with no positive observation of the active home',
      ).toThrow();

      // Evidence retention for the caller (optional, mirroring the guest
      // acceptance suite's pattern).
      const evidenceDir = process.env.STATION_CLIENT_AUTHORITY_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        for (const name of [
          'client-authority-cross-origin-pairing-refused.png',
          'client-authority-bravo-switch-dark.png',
          'client-authority-bravo-narrow-light.png',
        ]) {
          cpSync(testInfo.outputPath(name), join(evidenceDir, name));
        }
      }
    });
  });
