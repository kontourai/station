import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allocateFromEnvironment,
  githubOutputWithDate,
} from '../allocate-nightly-version-code.mjs';
import {
  classifyNightlyReservationResponse,
  MAX_NIGHTLY_RESERVATION_RESPONSE_BYTES,
} from '../classify-nightly-reservation-response.mjs';
import {
  allocateNightlyVersionCode,
  classifyNightlyArtifactArchive,
  createNightlyConfig,
  createNightlyDesktopConfig,
  MAX_ANDROID_VERSION_CODE,
  NIGHTLY_PUBLISHED_VERSION_CODE_FLOOR,
  NIGHTLY_VERSION_CODE_TAG_PREFIX,
  nightlyDayNumber,
  nightlyIdentifier,
  nightlyVersion,
  nightlyVersionCode,
  parseNightlyRebuildIndex,
  parseNightlyVersionCodeReservations,
  writeNightlyConfig,
  writeNightlyDesktopConfig,
} from '../lib/nightly-build-identity.mjs';

/**
 * The workflow that consumes this cannot run yet (station#2211), so this is
 * where the contract is actually proven. Every property below is one a broken
 * nightly would violate silently — Play rejects a reused version code with an
 * error nobody sees until upload, and a code can never be lowered afterwards.
 */

const DAY = 86_400_000;

describe('nightly version codes are monotonic and bounded', () => {
  it('increases with every day', () => {
    const first = nightlyVersionCode(new Date('2026-08-09T09:00:00Z'));
    const next = nightlyVersionCode(new Date('2026-08-10T09:00:00Z'));
    expect(next).toBeGreaterThan(first);
  });

  it('is identical for any two moments on the same UTC day', () => {
    // The schedule runs at a fixed UTC hour, but a manual re-run does not.
    // Deriving from the wall clock rather than the day would produce a fresh
    // code for a rebuild of identical content.
    expect(nightlyVersionCode(new Date('2026-08-09T00:00:00Z'))).toBe(
      nightlyVersionCode(new Date('2026-08-09T23:59:59Z')),
    );
  });

  it('separates same-day rebuilds without reaching the next day', () => {
    const day = new Date('2026-08-09T09:00:00Z');
    const base = nightlyVersionCode(day, 0);
    expect(nightlyVersionCode(day, 1)).toBe(base + 1);
    expect(nightlyVersionCode(day, 99)).toBeLessThan(
      nightlyVersionCode(new Date(day.getTime() + DAY), 0),
    );
    expect(() => nightlyVersionCode(day, 100)).toThrow(/build index/);
  });

  it('leaves headroom a YYYYMMDD scheme would not', () => {
    const code = nightlyVersionCode(new Date('2026-08-09T09:00:00Z'));
    expect(code).toBeLessThan(MAX_ANDROID_VERSION_CODE / 100);
    // The scheme this replaced: 2026080900 is 96% of the ceiling, and a
    // version code can never be lowered.
    expect(2_026_080_900).toBeGreaterThan(MAX_ANDROID_VERSION_CODE * 0.9);
  });

  it('stays under the ceiling well past any plausible horizon', () => {
    expect(nightlyVersionCode(new Date('2100-01-01T00:00:00Z'))).toBeLessThan(
      MAX_ANDROID_VERSION_CODE,
    );
  });

  it('refuses a date before its epoch rather than emitting a negative code', () => {
    expect(() => nightlyVersionCode(new Date('2019-12-31T00:00:00Z'))).toThrow(
      /predates its epoch/,
    );
  });
});

describe('Nightly version-code reservation allocation', () => {
  const date = new Date('2026-08-24T09:00:00Z');

  it('uses a sibling ref namespace that can coexist with the rolling nightly tag', () => {
    expect(NIGHTLY_VERSION_CODE_TAG_PREFIX).toBe(
      'refs/tags/nightly-version-code/',
    );
    expect(
      NIGHTLY_VERSION_CODE_TAG_PREFIX.startsWith('refs/tags/nightly/'),
    ).toBe(false);
  });

  it('advances past the published pre-reservation floor on the incident day', () => {
    // 242702 was successfully published before immutable reservations existed.
    // A scheduled build must select 242703, not re-default to 242700.
    expect(NIGHTLY_PUBLISHED_VERSION_CODE_FLOOR).toBe(242_702);
    expect(allocateNightlyVersionCode({ date })).toMatchObject({
      build: 3,
      versionCode: 242_703,
      reservationTag: `${NIGHTLY_VERSION_CODE_TAG_PREFIX}242703`,
    });
  });

  it('advances through all immutable reservations, including failed builds', () => {
    expect(
      allocateNightlyVersionCode({
        date,
        reservedVersionCodes: [242_703, 242_704],
      }),
    ).toMatchObject({ build: 5, versionCode: 242_705 });
  });

  it('accepts an explicit manual build only when it is an upward unused code', () => {
    expect(
      allocateNightlyVersionCode({
        date,
        requestedBuild: '99',
        reservedVersionCodes: [242_703],
      }),
    ).toMatchObject({ build: 99, versionCode: 242_799 });
    expect(() =>
      allocateNightlyVersionCode({ date, requestedBuild: '2' }),
    ).toThrow(/reuse or regress/);
    expect(() =>
      allocateNightlyVersionCode({ date, requestedBuild: '02' }),
    ).toThrow(/must be an integer/);
  });

  it('accepts an omitted or zero rebuild index and rejects ambiguous inputs', () => {
    expect(parseNightlyRebuildIndex()).toBeUndefined();
    expect(parseNightlyRebuildIndex('')).toBeUndefined();
    expect(parseNightlyRebuildIndex('0')).toBe(0);
    expect(parseNightlyRebuildIndex(0)).toBe(0);
    for (const invalid of [true, false, -1, '-1', '100', 100, 'true']) {
      expect(() => parseNightlyRebuildIndex(invalid)).toThrow(
        /nightly rebuild index/,
      );
    }
  });

  it('fails closed on an exhausted day or a clock rollback', () => {
    expect(() =>
      allocateNightlyVersionCode({
        date,
        reservedVersionCodes: [242_799],
      }),
    ).toThrow(/exhausted or would regress/);
    expect(() =>
      allocateNightlyVersionCode({
        date: new Date('2026-08-23T09:00:00Z'),
      }),
    ).toThrow(/exhausted or would regress/);
  });

  it('parses only well-formed immutable reservation refs', () => {
    const refs = [
      `a${'0'.repeat(39)}\t${NIGHTLY_VERSION_CODE_TAG_PREFIX}242704`,
      `b${'0'.repeat(39)}\t${NIGHTLY_VERSION_CODE_TAG_PREFIX}242703`,
      `c${'0'.repeat(39)}\t${NIGHTLY_VERSION_CODE_TAG_PREFIX}242703`,
    ].join('\n');
    expect(parseNightlyVersionCodeReservations(refs)).toEqual([
      242_703, 242_704,
    ]);
    expect(() =>
      parseNightlyVersionCodeReservations('refs/tags/nightly/other'),
    ).toThrow(/unexpected nightly reservation ref/);
    expect(() =>
      parseNightlyVersionCodeReservations(
        `${NIGHTLY_VERSION_CODE_TAG_PREFIX}not-a-number`,
      ),
    ).toThrow(/invalid nightly version-code reservation/);
  });

  it('exposes one allocation and immutable tag to the workflow', () => {
    const allocationDate = new Date('2026-08-24T00:00:00.000Z');
    const allocation = allocateFromEnvironment({
      NIGHTLY_NOW: allocationDate.toISOString(),
      NIGHTLY_RESERVED_TAGS: `${NIGHTLY_VERSION_CODE_TAG_PREFIX}242703`,
    });
    expect(githubOutputWithDate(allocation, allocationDate)).toBe(
      [
        'date=2026-08-24T00:00:00.000Z',
        'build=4',
        'version_code=242704',
        'reservation_tag=nightly-version-code/242704',
      ].join('\n'),
    );
  });
});

describe('Nightly artifact archive receipt', () => {
  it('requires an artifact ID before asserting archive availability', () => {
    expect(
      classifyNightlyArtifactArchive({ outcome: 'success', artifactId: '123' }),
    ).toMatchObject({ annotation: 'notice', message: /retained/ });
    for (const artifactId of ['', undefined, null]) {
      expect(
        classifyNightlyArtifactArchive({ outcome: 'success', artifactId }),
      ).toMatchObject({ annotation: 'warning', message: /NOT_VERIFIED/ });
    }
  });

  it('keeps skipped and failed archives distinct from signed-artifact absence', () => {
    expect(
      classifyNightlyArtifactArchive({ outcome: 'skipped', artifactId: '' }),
    ).toMatchObject({ annotation: 'notice', message: /skipped.*NOT_VERIFIED/ });
    expect(
      classifyNightlyArtifactArchive({ outcome: 'failure', artifactId: '' }),
    ).toMatchObject({ annotation: 'warning', message: /not retained/ });
  });
});

describe('Nightly reservation API response classification', () => {
  const expectedRef = 'refs/tags/nightly-version-code/242704';
  const expectedSha = 'a'.repeat(40);

  function classify(status: number, response: unknown) {
    return classifyNightlyReservationResponse({
      status,
      responseText: JSON.stringify(response),
      expectedRef,
      expectedSha,
    });
  }

  it('accepts only a created response bound to the exact ref and SHA', () => {
    expect(
      classify(201, { ref: expectedRef, object: { sha: expectedSha } }),
    ).toBe('created');
    expect(
      classify(201, { ref: expectedRef, object: { sha: 'b'.repeat(40) } }),
    ).toBe('rejected');
  });

  it('classifies an exact reference-already-exists response as a collision candidate', () => {
    expect(classify(422, { message: 'Reference already exists' })).toBe(
      'reference-already-exists',
    );
    expect(
      classify(422, {
        message: 'Reference already exists',
        errors: [
          {
            resource: 'Reference',
            field: 'ref',
            code: 'already_exists',
            value: expectedRef,
          },
        ],
      }),
    ).toBe('reference-already-exists');
  });

  it('rejects validation and spam 422 responses instead of retrying them', () => {
    expect(
      classify(422, {
        message: 'Validation Failed',
        errors: [{ resource: 'Reference', field: 'ref', code: 'invalid' }],
      }),
    ).toBe('rejected');
    expect(
      classify(422, {
        message: 'Validation failed, or the endpoint has been spammed.',
      }),
    ).toBe('rejected');
  });

  it('rejects malformed collision details for another ref', () => {
    expect(
      classify(422, {
        message: 'Reference already exists',
        errors: [
          {
            resource: 'Reference',
            field: 'ref',
            code: 'already_exists',
            value: 'refs/tags/nightly-version-code/242705',
          },
        ],
      }),
    ).toBe('rejected');
  });

  it('keeps API response capture bounded', () => {
    expect(MAX_NIGHTLY_RESERVATION_RESPONSE_BYTES).toBe(65_536);
  });
});

describe('marketing version and version code cannot drift', () => {
  it('carries the same day number in both identities', () => {
    const date = new Date('2026-08-09T09:00:00Z');
    const day = nightlyDayNumber(date);
    expect(nightlyVersion('0.1.0', date)).toBe(`0.1.0-nightly.${day}`);
    expect(nightlyVersionCode(date)).toBe(day * 100);
  });

  it('produces a SemVer-valid prerelease', () => {
    const version = nightlyVersion('1.2.3', new Date('2026-08-09T09:00:00Z'));
    expect(version).toMatch(/^\d+\.\d+\.\d+-nightly\.\d+$/);
  });

  it('rejects a base version that is not MAJOR.MINOR.PATCH', () => {
    const date = new Date('2026-08-09T09:00:00Z');
    for (const bad of ['1.2', '1.2.3-preview.1', 'v1.2.3', ''])
      expect(() => nightlyVersion(bad, date)).toThrow(/base version/);
  });
});

describe('the nightly is a separate application', () => {
  it('derives a distinct identifier', () => {
    expect(nightlyIdentifier('io.kontourai.station')).toBe(
      'io.kontourai.station.nightly',
    );
  });

  it('refuses to double-suffix an already-nightly identifier', () => {
    // A second application of the overlay would otherwise silently produce
    // io.kontourai.station.nightly.nightly — a third app nobody installed.
    expect(() => nightlyIdentifier('io.kontourai.station.nightly')).toThrow(
      /already a nightly/,
    );
  });

  it('never emits the production identifier', () => {
    const config = createNightlyConfig({
      packageVersion: '0.1.0',
      productionIdentifier: 'io.kontourai.station',
      date: new Date('2026-08-09T09:00:00Z'),
    });
    expect(config.identifier).not.toBe('io.kontourai.station');
  });
});

describe('the tauri config overlay', () => {
  it('sets the nightly marketing version and numeric Android/macOS build identity', () => {
    const config = createNightlyConfig({
      packageVersion: '0.1.0',
      productionIdentifier: 'io.kontourai.station',
      date: new Date('2026-08-09T09:00:00Z'),
      build: 2,
    });
    expect(config).toEqual({
      productName: 'Station Nightly',
      version: '0.1.0-nightly.2412',
      identifier: 'io.kontourai.station.nightly',
      bundle: {
        android: { versionCode: 241_202 },
        macOS: { bundleVersion: '241202' },
      },
    });
  });

  it('writes an ephemeral overlay when the GitHub output sink is omitted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-nightly-identity-'));
    const output = join(directory, 'tauri.nightly.version.json');
    const config = writeNightlyConfig({
      packageJsonPath: resolve(import.meta.dirname, '../../package.json'),
      tauriConfigPath: resolve(
        import.meta.dirname,
        '../../src-desktop/tauri.conf.json',
      ),
      date: '2026-08-09T00:00:00Z',
      build: 3,
      outputPath: output,
    });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(config);
    expect(readdirSync(directory)).toEqual(['tauri.nightly.version.json']);
    expect(config.version).toBe('0.1.2-nightly.2412');
    expect(config.bundle.android.versionCode).toBe(241_203);
    expect(config.bundle.macOS.bundleVersion).toBe('241203');
  });
});

describe('the desktop tauri config overlay (station#575)', () => {
  it('carries the same day-numbered version as the Android identity, plus the updater plugin', () => {
    const config = createNightlyDesktopConfig({
      packageVersion: '0.1.0',
      productionIdentifier: 'io.kontourai.station',
      date: new Date('2026-08-09T09:00:00Z'),
      updaterPublicKey: 'trusted-public-key',
      updaterEndpoint:
        'https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json',
    });
    expect(config).toEqual({
      productName: 'Station Nightly',
      version: '0.1.0-nightly.2412',
      identifier: 'io.kontourai.station.nightly',
      bundle: {
        createUpdaterArtifacts: 'v1Compatible',
        macOS: { bundleVersion: '241200' },
      },
      plugins: {
        updater: {
          pubkey: 'trusted-public-key',
          endpoints: [
            'https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json',
          ],
        },
      },
    });
    // Same day number the Android overlay above would derive for this date.
    expect(config.version).toBe(
      createNightlyConfig({
        packageVersion: '0.1.0',
        productionIdentifier: 'io.kontourai.station',
        date: new Date('2026-08-09T09:00:00Z'),
      }).version,
    );
  });

  it('has no Android-style version-code allocation', () => {
    const config = createNightlyDesktopConfig({
      packageVersion: '0.1.0',
      productionIdentifier: 'io.kontourai.station',
      date: new Date('2026-08-09T09:00:00Z'),
      updaterPublicKey: 'trusted-public-key',
    });
    expect(config).not.toHaveProperty('bundle.android');
    expect(config.plugins.updater).not.toHaveProperty('endpoints');
  });

  it('fails closed on a missing or empty updater public key', () => {
    expect(() =>
      createNightlyDesktopConfig({
        packageVersion: '0.1.0',
        productionIdentifier: 'io.kontourai.station',
        date: new Date('2026-08-09T09:00:00Z'),
        updaterPublicKey: '   ',
      }),
    ).toThrow('updater public key must be non-empty');
  });

  it('fails closed on a non-https updater endpoint', () => {
    expect(() =>
      createNightlyDesktopConfig({
        packageVersion: '0.1.0',
        productionIdentifier: 'io.kontourai.station',
        date: new Date('2026-08-09T09:00:00Z'),
        updaterPublicKey: 'trusted-public-key',
        updaterEndpoint: 'http://example.com/latest.json',
      }),
    ).toThrow('updater endpoint must be a non-empty https URL');
  });

  it('writes an ephemeral desktop overlay from the stable checked-in authority', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'station-nightly-desktop-identity-'),
    );
    const output = join(directory, 'tauri.nightly-desktop.conf.json');
    const githubOutput = join(directory, 'github-output');
    const config = writeNightlyDesktopConfig({
      packageJsonPath: resolve(import.meta.dirname, '../../package.json'),
      tauriConfigPath: resolve(
        import.meta.dirname,
        '../../src-desktop/tauri.conf.json',
      ),
      date: '2026-08-09T00:00:00Z',
      updaterPublicKey: 'trusted-public-key',
      updaterEndpoint:
        'https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json',
      outputPath: output,
      githubOutput,
    });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(config);
    expect(readFileSync(githubOutput, 'utf8')).toBe(
      [
        'version=0.1.2-nightly.2412',
        'identifier=io.kontourai.station.nightly',
        'product_name=Station Nightly',
        'bundle_version=241200',
        '',
      ].join('\n'),
    );
    expect(readdirSync(directory).sort()).toEqual([
      'github-output',
      'tauri.nightly-desktop.conf.json',
    ]);
    expect(config.version).toBe('0.1.2-nightly.2412');
    expect(config.identifier).toBe('io.kontourai.station.nightly');
    expect(config.bundle.macOS.bundleVersion).toBe('241200');
  });
});

/**
 * The workflow cannot run until the fleet allow-list and store credentials
 * land, so these pin the properties that would otherwise be discovered only
 * by a wrong build reaching testers.
 */
describe('the nightly workflow keeps its promises', () => {
  const workflow = readFileSync(
    resolve(import.meta.dirname, '../../.github/workflows/nightly.yml'),
    'utf8',
  );

  it('is scheduled daily rather than triggered by pushes', () => {
    // The whole point of the channel: "nightly" is a claim about cadence.
    expect(workflow).toMatch(
      /schedule:\s*\n\s*(#[^\n]*\n\s*)*- cron: '0 9 \* \* \*'/,
    );
    expect(workflow).not.toMatch(/^\s{2}push:/m);
  });

  it('runs the pr-smoke browser suite in a test-gate job on the commit it ships', () => {
    // station#4539's mechanism, pinned so the gate job cannot be silently
    // dropped: before it, this workflow shipped with zero test steps.
    const gateStart = workflow.indexOf('\n  test-gate:');
    const nightlyStart = workflow.indexOf('\n  nightly:');
    expect(gateStart).toBeGreaterThanOrEqual(0);
    expect(nightlyStart).toBeGreaterThan(gateStart);
    const gateJob = workflow.slice(gateStart, nightlyStart);
    expect(gateJob).toContain('run: npm run test:e2e:pr-smoke');
    // Gate-SHA == ship-SHA, written out on both sides rather than left to
    // checkout's implicit default, so the tests' verdict stays bound to the
    // exact bytes the build ships.
    expect(gateJob).toContain('ref: $' + '{{ github.sha }}');
    const nightlyCheckout = workflow.slice(
      nightlyStart,
      workflow.indexOf(
        'Validate requested Nightly rebuild index',
        nightlyStart,
      ),
    );
    expect(nightlyCheckout).toContain('ref: $' + '{{ github.sha }}');
  });

  it('makes the nightly build job need the test gate', () => {
    const nightlyJob = workflow.slice(workflow.indexOf('\n  nightly:'));
    expect(nightlyJob.slice(0, nightlyJob.indexOf('runs-on:'))).toContain(
      'needs: [test-gate]',
    );
  });

  it('publishes only on a literal success result from the test gate', () => {
    // `!= 'failure'` would admit a skipped or cancelled gate — the exact
    // green-looking hole this predicate exists to close. Pinned as one
    // literal LINE (not a whole-file substring: a `#`-commented copy of the
    // literal would satisfy toContain while the real `if:` was gutted —
    // delta-review probe R2), because the conjunct order is also
    // load-bearing (gate:workflows accepts only the literal prefix ladder).
    const ifLiteral =
      'if: $' +
      "{{ always() && !cancelled() && github.event_name != 'pull_request' && needs['test-gate'].result == 'success' }}";
    const lines = workflow.split('\n').map((line) => line.trim());
    expect(lines).toContain(ifLiteral);
  });

  it('reserves an immutable monotonic code before deriving or building it', () => {
    const reservation = workflow.indexOf(
      'Reserve a monotonic nightly version code',
    );
    const identity = workflow.indexOf('Derive nightly build identity');
    const build = workflow.indexOf('Build signed nightly AAB');
    expect(reservation).toBeGreaterThanOrEqual(0);
    expect(identity).toBeGreaterThan(reservation);
    expect(build).toBeGreaterThan(identity);
    const reservationStep = workflow.slice(reservation, identity);
    expect(reservationStep).toContain(
      'reservation_remote="https://github.com/$' + '{{ github.repository }}"',
    );
    expect(reservationStep).toContain(
      "GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'",
    );
    expect(reservationStep).toContain('GIT_CONFIG_COUNT=1');
    expect(reservationStep).toContain(
      'nightly_git ls-remote --refs "$reservation_remote"',
    );
    expect(reservationStep).toContain('for attempt in $(seq 1 100)');
    expect(reservationStep).toContain(
      'node scripts/allocate-nightly-version-code.mjs',
    );
    expect(reservationStep).toContain('reservation_ref="refs/tags/$tag"');
    expect(reservationStep).toContain(
      '--url "$GITHUB_API_URL/repos/$' + '{{ github.repository }}/git/refs"',
    );
    expect(reservationStep).toContain('--request POST');
    expect(reservationStep).toContain('--max-filesize 65536');
    expect(reservationStep).toContain('Authorization: Bearer $GITHUB_TOKEN');
    expect(reservationStep).toContain(
      "--header 'X-GitHub-Api-Version: 2022-11-28'",
    );
    expect(reservationStep).toContain(
      'node scripts/classify-nightly-reservation-response.mjs',
    );
    expect(reservationStep).toContain(
      'if [ "$classification" = \'reference-already-exists\' ]; then',
    );
    expect(reservationStep).toContain(
      'nightly_git ls-remote --refs "$reservation_remote" "$reservation_ref"',
    );
    expect(reservationStep).toContain(
      'cat "$allocation_output" >> "$GITHUB_OUTPUT"',
    );
    // The authenticated Git header is process-scoped, while the API token is
    // only a request header. Neither is persisted, logged, or placed in a URL.
    expect(reservationStep).toContain('unset -f nightly_git');
    expect(reservationStep).not.toContain('git ls-remote --refs origin');
    expect(reservationStep).not.toContain(
      'x-access-token:$' + '{GITHUB_TOKEN}@',
    );
    expect(reservationStep).not.toMatch(/\bgit\s+config\b/);
    expect(reservationStep).not.toMatch(/\becho\s+.*GITHUB_TOKEN/);
    expect(reservationStep).not.toContain('cat "$reservation_response"');
    expect(reservationStep).not.toMatch(/\bset\s+-x\b/);
    expect(reservationStep).not.toContain('git push');
    expect(reservationStep).not.toContain('--no-verify');
    expect(reservationStep).not.toContain('STATION_ALLOW_STALE_BASE');
    expect(reservationStep).not.toContain('git push -f');
    expect(reservationStep).not.toContain('steps.allocate.outputs');
    expect(workflow).toContain(
      'NIGHTLY_BUILD: $' + '{{ steps.allocate.outputs.build }}',
    );
    expect(workflow).toContain('scripts/lib/nightly-build-identity.mjs');
    expect(workflow).toContain('--github-output "$GITHUB_OUTPUT"');
    expect(workflow).toContain(
      `STATION_BUILD_VERSION="\${{ steps.identity.outputs.version }}" npm run build:desktop:resources`,
    );
  });

  it('permits an explicit manual index to request a safe same-commit rebuild', () => {
    const decide = workflow.slice(
      workflow.indexOf('Decide whether there is anything to build'),
      workflow.indexOf('Reserve a monotonic nightly version code'),
    );
    expect(decide).toContain(
      'NIGHTLY_REBUILD_INDEX: $' + '{{ inputs.rebuild_index }}',
    );
    expect(decide).toContain(
      'node scripts/normalize-deploy-ledger-head.mjs --head-sha "$head_sha" --stop-sha "$last_sha"',
    );
    expect(decide).toContain(
      '[ "$normalized_head_sha" = "$last_sha" ] && [ -z "$NIGHTLY_REBUILD_INDEX" ]',
    );
  });

  it('uses an explicit non-boolean rebuild input and validates it before the nightly job builds', () => {
    const nightlyJob = workflow.slice(workflow.indexOf('\n  nightly:'));
    const validation = nightlyJob.indexOf(
      'Validate requested Nightly rebuild index',
    );
    const decide = nightlyJob.indexOf(
      'Decide whether there is anything to build',
    );
    expect(validation).toBeGreaterThanOrEqual(0);
    expect(validation).toBeLessThan(decide);
    const validationStep = nightlyJob.slice(validation, decide);
    expect(workflow).toContain('rebuild_index:');
    expect(workflow).not.toMatch(/^\s{6}build:/m);
    expect(workflow).not.toContain('inputs.build');
    expect(validationStep).toContain(
      'NIGHTLY_REBUILD_INDEX: $' + '{{ inputs.rebuild_index }}',
    );
    expect(validationStep).toContain('parseNightlyRebuildIndex');
  });

  it('separates artifact archive retention from Play publication', () => {
    const archive = workflow.indexOf('Archive signed nightly artifacts');
    const archiveOutcome = workflow.indexOf(
      'Record signed artifact archive outcome',
    );
    const publication = workflow.indexOf(
      'Upload to Play internal testing track',
    );
    const skippedPublication = workflow.indexOf('Note skipped publication');
    expect(archive).toBeGreaterThanOrEqual(0);
    expect(archiveOutcome).toBeGreaterThan(archive);
    expect(publication).toBeGreaterThan(archiveOutcome);
    expect(skippedPublication).toBeGreaterThan(publication);
    const archiveStep = workflow.slice(archive, archiveOutcome);
    const archiveOutcomeStep = workflow.slice(archiveOutcome, publication);
    const skippedPublicationStep = workflow.slice(skippedPublication);
    expect(archiveStep).toContain('id: nightly_artifact');
    expect(archiveStep).toContain('continue-on-error: true');
    expect(archiveStep).toContain('if-no-files-found: error');
    expect(archiveOutcomeStep).toContain('steps.nightly_artifact.outcome');
    expect(archiveOutcomeStep).toContain(
      'steps.nightly_artifact.outputs.artifact-id',
    );
    expect(archiveOutcomeStep).toContain('classifyNightlyArtifactArchive');
    expect(archiveOutcomeStep).toContain('NIGHTLY_ARTIFACT_ID');
    expect(archiveOutcomeStep).not.toContain('for seven days');
    expect(skippedPublicationStep).toContain(
      'available only if its archive outcome above reports success',
    );
    expect(skippedPublicationStep).not.toContain('still installable by hand');
  });

  it('publishes under the derived nightly identifier, never a literal', () => {
    // A hardcoded packageName is how a nightly ends up in the production
    // listing, and Play version codes cannot be taken back.
    const upload = workflow.slice(workflow.indexOf('Upload to Play'));
    expect(upload).toContain(
      'INPUT_PACKAGENAME: $' + '{{ steps.identity.outputs.identifier }}',
    );
    expect(upload).not.toMatch(/INPUT_PACKAGENAME:\s*io\.kontourai\.station\b/);
  });

  it('retries only the pinned Play uploader over the already-built AAB', () => {
    const build = workflow.indexOf('name: Build signed nightly AAB');
    const download = workflow.indexOf(
      'name: Download pinned Play upload action',
    );
    const upload = workflow.indexOf(
      'name: Upload to Play internal testing track',
    );
    const rollingTag = workflow.indexOf(
      'name: Advance the rolling nightly tag',
    );
    expect(build).toBeGreaterThan(download);
    expect(upload).toBeGreaterThan(build);
    expect(rollingTag).toBeGreaterThan(upload);
    const uploadStep = workflow.slice(upload, rollingTag);
    expect(uploadStep).toContain('run: node scripts/play-upload-retry.mjs');
    expect(uploadStep).toContain(
      'INPUT_RELEASEFILES: src-desktop/gen/android/app/build/outputs/bundle/universalRelease/*.aab',
    );
    expect(uploadStep).toContain('INPUT_TRACKS: internal');
    expect(uploadStep).not.toMatch(/^\s+INPUT_TRACK:/m);
    expect(workflow).not.toContain('uses: r0adkll/upload-google-play@');
    expect(workflow).toContain(
      'PLAY_UPLOAD_ACTION_DIGEST: 15b27f8937f30f20d81bb585c4ad7ec7032e84491be51ac4dda330767a287f6b',
    );
  });

  it('proves the built package carries the nightly identity', () => {
    // The config overlay is passed to a subprocess; if it silently failed to
    // apply, the build would be production-identified and nothing upstream
    // would say so.
    expect(workflow).toContain(
      "package: name='$" + "{{ steps.identity.outputs.identifier }}'",
    );
    expect(workflow).toContain(
      "application-label:'$" + "{{ steps.identity.outputs.product_name }}'",
    );
  });

  it('reapplies the Nightly launcher identity after Android init', () => {
    const init = workflow.indexOf('tauri android init');
    const icons = workflow.indexOf(
      'node scripts/apply-android-channel-icons.mjs nightly',
    );
    const build = workflow.indexOf('tauri android build');
    expect(init).toBeGreaterThanOrEqual(0);
    expect(icons).toBeGreaterThan(init);
    expect(build).toBeGreaterThan(icons);
    expect(workflow).not.toContain('cp -R src-desktop/icons/nightly');
  });

  it('advances the rolling tag only when the build actually published', () => {
    const tagStep = workflow.slice(
      workflow.indexOf('Advance the rolling nightly tag'),
    );
    expect(tagStep).toContain(
      "steps.android_signing.outputs.keystore_base64 != ''",
    );
    // The tag is what suppresses tomorrow's run; moving it after a failure
    // would silently skip a day.
    expect(tagStep).toContain('refs/tags/nightly');
  });

  it('advances rolling tags through the refs API, never a git push', () => {
    // GITHUB_TOKEN cannot hold the workflows scope, so only the refs API
    // can move these tags; asserted per step so one leg cannot quietly
    // lose the mechanism.
    expect(workflow).not.toMatch(/git push[^\n]*refs\/tags\/nightly/);
    for (const stepName of [
      'Advance the rolling nightly tag',
      'Advance the rolling desktop nightly tag',
    ]) {
      const start = workflow.indexOf(`- name: ${stepName}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextStep = workflow.indexOf('\n      - name: ', start + 1);
      const step = workflow.slice(
        start,
        nextStep === -1 ? workflow.length : nextStep,
      );
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the workflow's literal placeholder, not a template.
      expect(step).toContain('/git/' + '${TAG_REF}');
      expect(step).toContain('Reference does not exist');
      expect(step).toContain('ref update response mismatch');
    }
  });

  it('records ledger ships independently of the tag advance, gated on each publish outcome', () => {
    for (const literal of [
      "always() && steps.decide.outputs.build == 'true' && steps.android_signing.outputs.keystore_base64 != '' && steps.play_upload.outcome == 'success'",
      "always() && steps.decide.outputs.build == 'true' && steps.cli_npm_publish.outcome == 'success'",
      "always() && steps.decide.outputs.build == 'true' && steps.desktop_publish.outcome == 'success'",
    ]) {
      expect(workflow).toContain(literal);
    }
  });

  it('checks out full history in both publishing jobs', () => {
    // The decide steps read the rolling tags and the changelog slice walks
    // previousSha..sha, so a shallow checkout silently breaks both.
    const jobSlice = (name: string): string => {
      const start = workflow.indexOf(`\n  ${name}:`);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = workflow
        .slice(start + 1)
        .match(/\n {2}[A-Za-z0-9_-]+:\s*\n/);
      return workflow.slice(
        start,
        next ? start + 1 + (next.index ?? 0) : workflow.length,
      );
    };
    expect(jobSlice('nightly')).toContain('fetch-depth: 0');
    expect(jobSlice('nightly-desktop')).toContain('fetch-depth: 0');
  });

  it('uses keyless GitHub OIDC for Play without a service-account key', () => {
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain(
      'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093',
    );
    expect(workflow).toContain(
      'google-github-actions/get-secretmanager-secrets@bc9c54b29fdffb8a47776820a7d26e77b379d262',
    );
    expect(workflow).toContain(
      'INPUT_SERVICEACCOUNTJSON: $' +
        '{{ steps.google_auth.outputs.credentials_file_path }}',
    );
    expect(workflow).not.toContain('PLAY_SERVICE_ACCOUNT_JSON');
    expect(workflow).not.toContain('serviceAccountJsonPlainText');
    expect(workflow).not.toContain('secrets.ANDROID_KEYSTORE');
  });

  it('retains the signed artifact when Play requires the first manual upload', () => {
    const artifact = workflow.indexOf('name: station-nightly-');
    const playUpload = workflow.indexOf(
      'name: Upload to Play internal testing track',
    );
    expect(artifact).toBeGreaterThanOrEqual(0);
    expect(playUpload).toBeGreaterThan(artifact);
  });
});

describe('the desktop nightly job keeps the same promises (station#575)', () => {
  const workflow = readFileSync(
    resolve(import.meta.dirname, '../../.github/workflows/nightly.yml'),
    'utf8',
  );
  const jobStart = workflow.indexOf('\n  nightly-desktop:');
  // Bounded to the NEXT top-level (2-space-indented) job key, not EOF: a
  // future job appended after this one must not silently leak its steps
  // into every indexOf-based assertion below.
  const nextJob = workflow
    .slice(jobStart + 1)
    .match(/\n {2}[A-Za-z0-9_-]+:\s*\n/);
  const jobEnd = nextJob
    ? jobStart + 1 + (nextJob.index ?? 0)
    : workflow.length;
  const desktopJob = workflow.slice(jobStart, jobEnd);

  it('exists as its own job, gated identically to the Android job', () => {
    expect(jobStart).toBeGreaterThan(0);
    expect(desktopJob.slice(0, desktopJob.indexOf('runs-on:'))).toContain(
      'needs: [test-gate]',
    );
  });

  it('reserves macOS release cleanup time before setup and passes the absolute deadline to notarization', () => {
    expect(desktopJob).toContain('timeout-minutes: 120');
    const reserve = desktopJob.slice(
      desktopJob.indexOf('name: Reserve nightly macOS release cleanup window'),
      desktopJob.indexOf('uses: actions/checkout'),
    );
    expect(reserve).toContain('id: nightly_macos_release_deadline');
    expect(reserve).toContain('105 * 60');
    const notarize = desktopJob.slice(
      desktopJob.indexOf('name: Seal, notarize'),
      desktopJob.indexOf('name: Assemble the signed updater manifest'),
    );
    expect(notarize).toContain(
      '--deadline-epoch "$' +
        '{{ steps.nightly_macos_release_deadline.outputs.epoch }}"',
    );
  });

  it('publishes only on a literal success result from the test gate', () => {
    // Same literal line as the Android job's pin above, and the same
    // conjunct-order reasoning: scripts/actionlint-gate.mjs's
    // skipsAutomaticPullRequest accepts only this exact prefix ladder.
    const ifLiteral =
      'if: $' +
      "{{ always() && !cancelled() && github.event_name != 'pull_request' && needs['test-gate'].result == 'success' }}";
    const lines = desktopJob.split('\n').map((line) => line.trim());
    expect(lines).toContain(ifLiteral);
  });

  it('builds at the pinned decide-step SHA, never an implicit checkout default', () => {
    const checkout = desktopJob.slice(0, desktopJob.indexOf('Decide whether'));
    expect(checkout).toContain('ref: $' + '{{ github.sha }}');
    const decide = desktopJob.slice(
      desktopJob.indexOf('Decide whether'),
      desktopJob.indexOf('Build an unsigned macOS nightly staging candidate'),
    );
    expect(decide).toContain('id: decide');
    expect(decide).toContain('head_sha=$(git rev-parse HEAD)');
    expect(decide).toContain('echo "head_sha=$head_sha"');
    expect(decide).toContain('} >> "$GITHUB_OUTPUT"');
    expect(decide).toContain('refs/tags/nightly-desktop^{commit}');
    const build = desktopJob.slice(
      desktopJob.indexOf('Build an unsigned macOS nightly staging candidate'),
      desktopJob.indexOf('Seal, notarize'),
    );
    expect(build).toContain(
      'STATION_BUILD_VERSION: $' + '{{ steps.identity.outputs.version }}',
    );
    const notarize = desktopJob.slice(
      desktopJob.indexOf('Seal, notarize'),
      desktopJob.indexOf('Assemble the signed updater manifest'),
    );
    expect(notarize).toContain('--release-tag nightly-desktop');
    expect(notarize).toContain('--bundle-id io.kontourai.station.nightly');
    expect(notarize).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the workflow's literal GitHub expression.
      'expected_bundle_version="${{ steps.identity.outputs.bundle_version }}"',
    );
    expect(notarize).toContain('Print :CFBundleVersion');
    expect(notarize).toContain('must be numeric before notarization');
    expect(notarize).toContain(
      'if [[ "$actual_bundle_version" != "$expected_bundle_version" ]]; then',
    );
    expect(notarize).toContain(
      'CFBundleVersion does not match the generated desktop identity',
    );
    expect(notarize).toContain('macos-signing-readiness.mjs unlock');
    expect(notarize).toContain('macos-signing-readiness.mjs probe');
    expect(notarize.indexOf('macos-signing-readiness.mjs unlock')).toBeLessThan(
      notarize.indexOf('macos-notarized-artifacts.mjs'),
    );
    expect(notarize.indexOf('Print :CFBundleVersion')).toBeLessThan(
      notarize.indexOf('macos-notarized-artifacts.mjs'),
    );
    expect(desktopJob).toContain('Cleanup macOS Developer ID keychain');
  });

  it('does not depend on the Android job succeeding, and allocates no Android version code', () => {
    const needsLine = desktopJob
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('needs:'));
    // Exactly [test-gate]: a broader needs edge (e.g. adding `nightly`) would
    // make the Android build a silent precondition for the desktop ship,
    // which the header comment above explicitly disclaims.
    expect(needsLine).toBe('needs: [test-gate]');
    expect(desktopJob).not.toContain('allocate-nightly-version-code.mjs');
  });

  it('publishes the prerelease, THEN advances the rolling tag, THEN records the ledger (station#575 HIGH-1)', () => {
    // Android's own ordering: the tag suppresses tomorrow's build, so
    // moving it before a publish that can still fail would assert a ship
    // that never happened — and desktop has no rebuild input to recover
    // with, so a hand-deleted tag would be the only fix.
    const publish = desktopJob.indexOf(
      'name: Publish the rolling desktop nightly prerelease',
    );
    const advance = desktopJob.indexOf(
      'name: Advance the rolling desktop nightly tag',
    );
    const ledger = desktopJob.indexOf('name: Record the nightly desktop ship');
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(advance).toBeGreaterThan(publish);
    expect(ledger).toBeGreaterThan(advance);
  });

  it('refuses draft and unbootstrapped rolling releases rather than asking GITHUB_TOKEN to create a workflow-changing ref', () => {
    const publish = desktopJob.slice(
      desktopJob.indexOf(
        'name: Publish the rolling desktop nightly prerelease',
      ),
      desktopJob.indexOf('name: Advance the rolling desktop nightly tag'),
    );
    expect(publish).toContain('--json isDraft');
    expect(publish).toMatch(/grep -qx true/);
    expect(publish).toMatch(/::error::[^\n]*draft[^\n]*\n\s+exit 1/i);
    expect(publish).toContain('nightly-desktop does not exist; bootstrap');
    expect(publish).toContain('workflow-changing target is blocked');
    expect(publish).not.toContain('gh release create nightly-desktop');
    expect(publish).not.toContain('--target');
  });

  it('uploads latest.json as its OWN gh release upload invocation, after the binaries invocation completes (station#575 MED-3)', () => {
    const publish = desktopJob.slice(
      desktopJob.indexOf(
        'name: Publish the rolling desktop nightly prerelease',
      ),
      desktopJob.indexOf('name: Advance the rolling desktop nightly tag'),
    );
    expect(publish).toContain('gh release view nightly-desktop');
    expect(publish).toContain('--clobber');
    const invocations =
      publish.match(/gh release upload nightly-desktop/g) ?? [];
    // Exactly two: merging latest.json into the binaries' command (which
    // uploads its arguments concurrently) would collapse this to one.
    expect(invocations).toHaveLength(2);
    // The second invocation is a single physical line naming ONLY
    // latest.json — no trailing `\` continuation and no binary asset name
    // on that line — so it cannot be the same shell command as the
    // binaries' multi-line upload above it.
    const manifestUploadLine = publish
      .split('\n')
      .find(
        (line) =>
          line.includes('gh release upload nightly-desktop') &&
          line.includes('latest.json'),
      );
    expect(manifestUploadLine).toBeDefined();
    expect(manifestUploadLine).not.toContain('\\');
    expect(manifestUploadLine).not.toContain('.dmg');
    expect(manifestUploadLine).not.toContain('.app.tar.gz');
    const binariesIndex = publish.indexOf(
      'gh release upload nightly-desktop --repo "$' +
        '{{ github.repository }}" --clobber \\\n            release-assets/station-nightly-desktop-macos-aarch64.dmg',
    );
    const manifestIndex = publish.lastIndexOf(manifestUploadLine ?? '');
    expect(binariesIndex).toBeGreaterThanOrEqual(0);
    expect(manifestIndex).toBeGreaterThan(binariesIndex);
  });

  it('agrees on one release tag across the notarize step, the manifest step, and the upload asset names (station#575 MED-2)', () => {
    const notarize = desktopJob.slice(
      desktopJob.indexOf('name: Seal, notarize'),
      desktopJob.indexOf('name: Assemble the signed updater manifest'),
    );
    expect(notarize).toContain('--release-tag nightly-desktop');
    const manifestStep = desktopJob.slice(
      desktopJob.indexOf('name: Assemble the signed updater manifest'),
      desktopJob.indexOf(
        'name: Publish the rolling desktop nightly prerelease',
      ),
    );
    expect(manifestStep).toContain('--release-tag nightly-desktop');
    expect(manifestStep).toContain(
      '/releases/download/nightly-desktop/station-nightly-desktop-macos-aarch64.app.tar.gz',
    );
    const publish = desktopJob.slice(
      desktopJob.indexOf(
        'name: Publish the rolling desktop nightly prerelease',
      ),
      desktopJob.indexOf('name: Advance the rolling desktop nightly tag'),
    );
    expect(publish).toContain('station-nightly-desktop-macos-aarch64.dmg');
    expect(publish).toContain(
      'station-nightly-desktop-macos-aarch64.app.tar.gz',
    );
  });

  it('verifies the nightly product name and bundle id on the notarized app (station#575 L6)', () => {
    const notarize = desktopJob.slice(
      desktopJob.indexOf('name: Seal, notarize'),
      desktopJob.indexOf('name: Assemble the signed updater manifest'),
    );
    expect(notarize).toContain('CFBundleShortVersionString');
    expect(notarize).toContain('CFBundleName');
    expect(notarize).toContain(
      '$' + '{{ steps.identity.outputs.product_name }}',
    );
    expect(notarize).toContain('CFBundleIdentifier');
    expect(notarize).toContain('io.kontourai.station.nightly');
  });

  it('scopes secret access to native-release and fails loud on any missing secret, all nine, no shortcut (station#575 L1)', () => {
    expect(desktopJob).toContain('environment: native-release');
    const identityStep = desktopJob.slice(
      desktopJob.indexOf(
        'name: Fail closed and create the desktop nightly updater configuration',
      ),
      desktopJob.indexOf('name: Import macOS Developer ID certificate'),
    );
    for (const name of [
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
      'TAURI_SIGNING_PUBLIC_KEY',
      'APPLE_DEVELOPER_ID_CERTIFICATE_BASE64',
      'APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD',
      'APPLE_DEVELOPER_ID_SIGNING_IDENTITY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER_ID',
      'APPLE_API_PRIVATE_KEY',
    ]) {
      expect(identityStep).toContain(name);
    }
    expect(identityStep).toContain('test -n "$' + '{!name}"');
    expect(identityStep).toContain('exit 1');
  });

  it('records the desktop ship in the deploy ledger after publish, at the decided SHA', () => {
    const publish = desktopJob.indexOf(
      'name: Publish the rolling desktop nightly prerelease',
    );
    const ledger = desktopJob.indexOf('name: Record the nightly desktop ship');
    expect(ledger).toBeGreaterThan(publish);
    const ledgerStep = desktopJob.slice(
      ledger,
      desktopJob.indexOf('name: Retain this run'),
    );
    expect(ledgerStep).toContain('--channel nightly-desktop');
    expect(ledgerStep).toContain(
      'DEPLOY_LEDGER_SHA: $' + '{{ steps.decide.outputs.head_sha }}',
    );
    expect(ledgerStep).not.toMatch(/git rev-parse/);
    expect(ledgerStep).not.toContain('continue-on-error');
  });
});
