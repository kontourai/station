import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../../src-server/domain/file-storage-adapter.js';
import { ProjectCreationService } from '../../../../src-server/services/projects/project-creation-service.js';
import { RepositoryAcquisitionService } from '../../../../src-server/services/projects/repository-acquisition-service.js';
import { execGitSync } from '../../../../src-server/utils/git-exec.js';
import {
  createStationHomeBackup,
  createStationHomeUpdateBackup,
  restoreStationHomeUpdateBackup,
  STATION_HOME_BACKUP_MANIFEST,
  STATION_HOME_UPDATE_BACKUP_SCHEMA,
  StationHomeArchiveError,
} from '../station-home-archive.js';
import { acquireStationHomeRuntimeLease } from '../station-home-lifecycle.js';
import {
  consumeStationHomeRestoreMarker,
  readStationHomeRestoreMarker,
  StationHomeRestoreRefusedError,
  stationHomeRestoreMarkerPath,
  writeStationHomeRestoreMarker,
} from '../station-home-restore-marker.js';
import {
  ensureStationHomeSchemaSync,
  STATION_HOME_SCHEMA_FILE,
} from '../station-home-schema.js';

const makeTempDir = trackTempDirs();

/** A stopped home in the shape a service leaves it: state plus live roots. */
function serviceHome(): { root: string; home: string; backupDir: string } {
  const root = makeTempDir('station-update-backup-');
  const home = join(root, 'home');
  ensureStationHomeSchemaSync(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'app.json'), '{"model":"before"}\n');
  mkdirSync(join(home, 'data'), { recursive: true });
  const database = new DatabaseSync(join(home, 'data', 'orchestration.sqlite'));
  database.exec(
    "CREATE TABLE facts (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO facts VALUES ('one', 'before')",
  );
  database.close();
  mkdirSync(join(home, 'service'), { recursive: true });
  writeFileSync(join(home, 'service', 'default.json'), '{"manifest":1}\n');
  writeFileSync(join(home, 'instances.json'), '{"liveness":"launcher"}\n');
  mkdirSync(join(home, 'logs'), { recursive: true });
  writeFileSync(join(home, 'logs', 'default.log'), 'before\n');
  return { root, home, backupDir: join(root, 'update-backups', 'u1') };
}

function acquisitionHome() {
  const fixture = serviceHome();
  const source = join(fixture.root, 'source');
  execGitSync(['init', '--initial-branch=main', source]);
  writeFileSync(join(source, 'README.md'), 'original repository bytes\n');
  execGitSync(['add', '.'], { cwd: source });
  execGitSync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'seed',
    ],
    { cwd: source },
  );
  mkdirSync(join(fixture.root, 'update-backups'));
  return { ...fixture, source };
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function schemaVersion(home: string): unknown {
  return JSON.parse(readFileSync(join(home, STATION_HOME_SCHEMA_FILE), 'utf8'))
    .version;
}

function writeSchemaVersion(home: string, version: number): void {
  const marker = join(home, STATION_HOME_SCHEMA_FILE);
  const value = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, `${JSON.stringify({ ...value, version })}\n`);
}

describe('update backup and in-place restore (#2675 D)', () => {
  it('restores an uncertain creation intent without admitting another publication', async () => {
    const fixture = serviceHome();
    const service = new ProjectCreationService(
      fixture.home,
      new FileStorageAdapter(fixture.home),
    );
    const id = randomUUID();
    const request = { slug: 'research', name: 'Research' };
    let publications = 0;
    const publish = async (): Promise<never> => {
      publications += 1;
      throw new Error('publication interrupted');
    };
    await expect(service.create(id, request, publish)).rejects.toThrow(
      'publication interrupted',
    );
    const before = service.get(id);
    expect(before?.phase).toBe('uncertain');
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    rmSync(join(fixture.home, 'project-creation-requests'), {
      recursive: true,
    });
    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const restarted = new ProjectCreationService(
      fixture.home,
      new FileStorageAdapter(fixture.home),
    );
    expect(restarted.get(id)).toEqual(before);
    expect(await restarted.create(id, request, publish)).toEqual(before);
    expect(publications).toBe(1);
  });

  it('preserves user edits in a real acquired Project checkout while restoring receipts', async () => {
    const fixture = acquisitionHome();
    const acquisitions = new RepositoryAcquisitionService(fixture.home);
    const request = {
      requestId: randomUUID().toUpperCase(),
      sourceUrl: fixture.source,
    };
    const acquired = await acquisitions.acquire(request);
    expect(acquired.phase).toBe('ready');
    const storage = new FileStorageAdapter(fixture.home);
    const now = new Date().toISOString();
    const project = {
      id: randomUUID(),
      slug: 'acquired',
      name: 'Acquired',
      createdAt: now,
      updatedAt: now,
      ...(await acquisitions.projectSource(request.requestId)),
    };
    await storage.createProject(project);
    const receipt = join(
      fixture.home,
      'repository-acquisitions',
      request.requestId,
      'operation.json',
    );
    const receiptBefore = readFileSync(receipt);
    const userFile = join(acquired.checkoutPath, 'README.md');
    const human = createStationHomeBackup({
      homeDir: fixture.home,
      outputDir: join(fixture.root, 'human-backup'),
    });
    const userPath = [
      'repository-acquisitions',
      request.requestId,
      'checkout-1',
      'README.md',
    ];
    expect(
      human.manifest.files.some(
        (file) => file.path.join('/') === userPath.join('/'),
      ),
    ).toBe(true);
    const { manifest } = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    writeFileSync(userFile, 'user edits during trial\n');
    writeFileSync(
      join(acquired.checkoutPath, 'untracked.txt'),
      'new user work\n',
    );
    writeFileSync(receipt, '{}');
    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    expect(
      readFileSync(userFile, 'utf8'),
      'rollback must preserve user edits',
    ).toBe('user edits during trial\n');
    expect(
      readFileSync(join(acquired.checkoutPath, 'untracked.txt'), 'utf8'),
    ).toBe('new user work\n');
    expect(existsSync(join(fixture.backupDir, 'home', ...userPath))).toBe(
      false,
    );
    expect(
      manifest.files.some((file) => file.path.join('/') === userPath.join('/')),
    ).toBe(false);
    expect(readFileSync(receipt)).toEqual(receiptBefore);
    expect(
      new RepositoryAcquisitionService(fixture.home).get(request.requestId),
    ).toEqual(acquired);
    expect(
      new FileStorageAdapter(fixture.home).getProject('acquired')
        .workingDirectory,
    ).toBe(acquired.checkoutPath);
  });

  it('restores a real started-effect receipt while preserving a later retry checkout', async () => {
    const fixture = acquisitionHome();
    const service = new RepositoryAcquisitionService(fixture.home);
    const request = { requestId: randomUUID(), sourceUrl: fixture.source };
    const directory = join(
      fixture.home,
      'repository-acquisitions',
      request.requestId,
    );
    const checkout = join(directory, 'checkout-1');
    await expect(
      service.acquire(request, false, () => {
        if (existsSync(join(checkout, '.git')))
          throw new Error('authority lost after clone');
      }),
    ).rejects.toThrow('authority lost after clone');
    const started = service.get(request.requestId);
    expect(started?.phase).toBe('acquiring');
    expect(existsSync(join(checkout, '.git'))).toBe(true);
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const retry = await service.acquire(request, true);
    expect(retry.phase).toBe('ready');
    expect(retry.attempt).toBe(2);
    writeFileSync(join(checkout, 'retained.txt'), 'first attempt work');
    writeFileSync(join(retry.checkoutPath, 'README.md'), 'second attempt work');
    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const restarted = new RepositoryAcquisitionService(fixture.home);
    expect(restarted.get(request.requestId)).toEqual(started);
    expect(await restarted.acquire(request)).toEqual(started);
    expect(readFileSync(join(checkout, 'retained.txt'), 'utf8')).toBe(
      'first attempt work',
    );
    expect(readFileSync(join(retry.checkoutPath, 'README.md'), 'utf8')).toBe(
      'second attempt work',
    );
  });

  it('preserves orphan checkout directories but restores adjacent state, files and links without following them', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const root = join(fixture.home, 'repository-acquisitions');
    const id = '00000000-0000-0000-0000-000000000000';
    const directory = join(root, id);
    const orphan = join(directory, 'checkout-9');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'work.txt'), 'legacy work');
    const state = [
      [id, 'checkout-1'],
      [id, 'checkout-1.json'],
      [id, 'checkout-0', 'work.txt'],
      [id, 'checkout-01', 'work.txt'],
      [id, 'checkout-2.previous'],
      [id, 'operation.json'],
      [id, 'operation.mutation'],
      ['not-a-uuid', 'checkout-1', 'work.txt'],
    ];
    for (const segments of state) {
      const path = join(root, ...segments);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'state before');
    }
    const outside = join(fixture.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'work.txt'), 'outside work');
    const linkedCheckout = join(directory, 'checkout-3');
    const linkedParent = join(root, randomUUID());
    symlinkSync(outside, linkedCheckout, 'dir');
    symlinkSync(outside, linkedParent, 'dir');
    const missing = join(directory, 'checkout-4');
    mkdirSync(missing);
    writeFileSync(join(missing, 'work.txt'), 'removed work');
    const { manifest } = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    for (const segments of state) {
      expect(
        manifest.files.some(
          (file) =>
            file.path.join('/') ===
            ['repository-acquisitions', ...segments].join('/'),
        ),
      ).toBe(true);
      writeFileSync(join(root, ...segments), 'trial state');
    }
    const future = join(root, randomUUID(), 'checkout-12');
    mkdirSync(future, { recursive: true });
    writeFileSync(join(future, 'work.txt'), 'future work');
    writeFileSync(join(orphan, 'work.txt'), 'legacy edits');
    rmSync(linkedCheckout);
    symlinkSync('missing-target', linkedCheckout, 'dir');
    rmSync(missing, { recursive: true });
    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    for (const segments of state)
      expect(readFileSync(join(root, ...segments), 'utf8')).toBe(
        'state before',
      );
    expect(readFileSync(join(orphan, 'work.txt'), 'utf8')).toBe('legacy edits');
    expect(readFileSync(join(future, 'work.txt'), 'utf8')).toBe('future work');
    expect(existsSync(missing)).toBe(false);
    expect(readlinkSync(linkedCheckout)).toBe(outside);
    expect(readlinkSync(linkedParent)).toBe(outside);
    expect(readFileSync(join(outside, 'work.txt'), 'utf8')).toBe(
      'outside work',
    );
  });

  it.each([
    ['file', 'checkout', false],
    ['link', 'checkout', false],
    ['file', 'request', false],
    ['link', 'request', false],
    ['file', 'root', false],
    ['link', 'root', false],
    ['file', 'request', true],
    ['link', 'request', true],
  ] as const)(
    'refuses a saved %s at the %s boundary (case alias: %s) before removing state when it now holds a checkout',
    (kind, boundary, caseAlias) => {
      const fixture = serviceHome();
      mkdirSync(join(fixture.root, 'update-backups'));
      const root = join(fixture.home, 'repository-acquisitions');
      const id = randomUUID();
      const directory = join(root, id);
      const checkout = join(directory, 'checkout-1');
      const collision =
        boundary === 'root'
          ? root
          : boundary === 'request'
            ? join(root, caseAlias ? id.toUpperCase() : id)
            : checkout;
      mkdirSync(join(collision, '..'), { recursive: true });
      const outside = join(fixture.root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'work.txt'), 'outside work');
      if (kind === 'file') writeFileSync(collision, 'saved state');
      else symlinkSync(outside, collision, 'dir');
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      });
      rmSync(collision);
      mkdirSync(checkout, { recursive: true });
      writeFileSync(join(checkout, 'work.txt'), 'user work');
      const receipt = join(directory, 'operation.json');
      writeFileSync(receipt, 'trial receipt');
      const config = join(fixture.home, 'config', 'app.json');
      writeFileSync(config, 'trial config');
      const marker = sha(join(fixture.home, STATION_HOME_SCHEMA_FILE));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let removed = false;
        expect(() =>
          restoreStationHomeUpdateBackup({
            homeDir: fixture.home,
            backupDir: fixture.backupDir,
            afterRemove: () => {
              removed = true;
            },
          }),
        ).toThrow(StationHomeArchiveError);
        expect(removed, 'conflict must be refused before removing state').toBe(
          false,
        );
        expect(readFileSync(config, 'utf8')).toBe('trial config');
        expect(readFileSync(receipt, 'utf8')).toBe('trial receipt');
        expect(sha(join(fixture.home, STATION_HOME_SCHEMA_FILE))).toBe(marker);
        expect(readdirSync(checkout)).toEqual(['work.txt']);
        expect(readFileSync(join(checkout, 'work.txt'), 'utf8')).toBe(
          'user work',
        );
        expect(readFileSync(join(outside, 'work.txt'), 'utf8')).toBe(
          'outside work',
        );
      }
    },
  );

  it.each([
    ['file', 'absent', false, false],
    ['file', 'existing', false, false],
    ['link', 'absent', false, false],
    ['link', 'existing', false, false],
    ['file', 'absent', true, false],
    ['link', 'existing', true, false],
    ['file', 'absent', true, true],
    ['link', 'existing', true, true],
  ] as const)(
    'refuses a saved %s descendant alias with an %s target (UUID alias: %s, NFC name: %s) before removing state',
    (kind, destination, parentAlias, unicode) => {
      const fixture = serviceHome();
      mkdirSync(join(fixture.root, 'update-backups'));
      const id = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
      const root = join(fixture.home, 'repository-acquisitions');
      const savedRequest = join(root, parentAlias ? id.toUpperCase() : id);
      const savedCheckout = join(savedRequest, 'CHECKOUT-1');
      const savedChild = unicode ? 'cafe\u0301' : 'nested';
      const currentChild = unicode ? 'caf\u00e9' : 'nested';
      const saved = join(savedCheckout, savedChild, 'old.txt');
      mkdirSync(join(saved, '..'), { recursive: true });
      const outside = join(fixture.root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'work.txt'), 'outside work');
      if (kind === 'file') writeFileSync(saved, 'saved state');
      else symlinkSync(outside, saved, 'dir');
      const { manifest } = createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      });
      // An admissible update-v1 snapshot: noncanonical CHECKOUT-1 is state.
      expect(
        [...manifest.files, ...(manifest.symlinks ?? [])].some(
          (entry) =>
            entry.path[2] === 'CHECKOUT-1' && entry.path.at(-1) === 'old.txt',
        ),
      ).toBe(true);
      expect(
        createStationHomeUpdateBackup({
          homeDir: fixture.home,
          backupDir: fixture.backupDir,
        }).reused,
      ).toBe(true);
      rmSync(savedRequest, { recursive: true });
      const request = join(root, id);
      const checkout = join(request, 'checkout-1');
      const current = join(checkout, currentChild, 'old.txt');
      mkdirSync(join(current, '..'), { recursive: true });
      if (destination === 'existing')
        writeFileSync(current, 'trial user bytes');
      writeFileSync(join(checkout, 'work.txt'), 'new user work');
      const receipt = join(request, 'operation.json');
      writeFileSync(receipt, 'trial receipt');
      const config = join(fixture.home, 'config', 'app.json');
      writeFileSync(config, 'trial config');
      const schema = sha(join(fixture.home, STATION_HOME_SCHEMA_FILE));
      const from = { version: '1.0.0', root: join(fixture.root, 'from') };
      const target = { version: '1.1.0', root: join(fixture.root, 'target') };
      mkdirSync(from.root);
      mkdirSync(target.root);
      writeStationHomeRestoreMarker(fixture.home, {
        fromRelease: from,
        targetRelease: target,
        backupDir: fixture.backupDir,
      });
      const markerPath = stationHomeRestoreMarkerPath(fixture.home);
      const marker = sha(markerPath);
      const assertUntouched = () => {
        expect(
          readdirSync(join(current, '..')),
          'saved descendants must not populate the retained user checkout',
        ).toEqual(destination === 'existing' ? ['old.txt'] : []);
        if (destination === 'existing') {
          expect(lstatSync(current).isFile()).toBe(true);
          expect(readFileSync(current, 'utf8')).toBe('trial user bytes');
        }
        expect(readFileSync(join(checkout, 'work.txt'), 'utf8')).toBe(
          'new user work',
        );
        expect(readFileSync(join(outside, 'work.txt'), 'utf8')).toBe(
          'outside work',
        );
        expect(readFileSync(config, 'utf8')).toBe('trial config');
        expect(readFileSync(receipt, 'utf8')).toBe('trial receipt');
        expect(sha(join(fixture.home, STATION_HOME_SCHEMA_FILE))).toBe(schema);
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let removed = false;
        try {
          expect(() =>
            restoreStationHomeUpdateBackup({
              homeDir: fixture.home,
              backupDir: fixture.backupDir,
              afterRemove: () => {
                removed = true;
              },
            }),
          ).toThrow(/conflicts with a preserved home directory/);
        } finally {
          // Observe destructive effects even if a later copy or verification fails.
          assertUntouched();
          expect(
            removed,
            'descendant conflict must precede state removal',
          ).toBe(false);
          expect(sha(markerPath)).toBe(marker);
        }
      }
      expect(() =>
        consumeStationHomeRestoreMarker({
          homeDir: fixture.home,
          running: () => from,
        }),
      ).toThrow(StationHomeRestoreRefusedError);
      assertUntouched();
      const failed = readStationHomeRestoreMarker(fixture.home);
      expect(failed.kind).toBe('present');
      if (failed.kind !== 'present') throw new Error('restore marker missing');
      expect(failed.marker.restoreFailed?.error).toMatch(
        /conflicts with a preserved home directory/,
      );
      const failedMarker = sha(markerPath);
      expect(() =>
        consumeStationHomeRestoreMarker({
          homeDir: fixture.home,
          running: () => from,
        }),
      ).toThrow(/not tried again automatically/);
      expect(sha(markerPath)).toBe(failedMarker);
      assertUntouched();
    },
  );

  it.each([true, false])(
    'refuses receipt restoration through a renamed retained UUID container before cleanup (saved uppercase: %s)',
    (savedUppercase) => {
      const fixture = serviceHome();
      mkdirSync(join(fixture.root, 'update-backups'));
      const id = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
      const root = join(fixture.home, 'repository-acquisitions');
      const savedRequest = join(root, savedUppercase ? id.toUpperCase() : id);
      const savedReceipt = join(savedRequest, 'receipts', 'operation.json');
      mkdirSync(join(savedReceipt, '..'), { recursive: true });
      writeFileSync(savedReceipt, 'saved receipt');
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      });
      rmSync(savedRequest, { recursive: true });
      const request = join(root, savedUppercase ? id : id.toUpperCase());
      const checkout = join(request, 'checkout-1');
      mkdirSync(checkout, { recursive: true });
      const work = join(checkout, 'work.txt');
      writeFileSync(work, 'user work');
      const receipt = join(request, 'receipts', 'operation.json');
      mkdirSync(join(receipt, '..'));
      writeFileSync(receipt, 'trial receipt');
      const config = join(fixture.home, 'config', 'app.json');
      writeFileSync(config, 'trial config');
      const schema = sha(join(fixture.home, STATION_HOME_SCHEMA_FILE));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let removed = false;
        let failure: unknown;
        try {
          restoreStationHomeUpdateBackup({
            homeDir: fixture.home,
            backupDir: fixture.backupDir,
            afterRemove: () => {
              removed = true;
            },
          });
        } catch (error) {
          failure = error;
        }
        expect(
          removed,
          'alias conflict must refuse before removing state',
        ).toBe(false);
        expect(failure).toBeInstanceOf(StationHomeArchiveError);
        expect(readFileSync(config, 'utf8')).toBe('trial config');
        expect(readFileSync(receipt, 'utf8')).toBe('trial receipt');
        expect(readFileSync(work, 'utf8')).toBe('user work');
        expect(sha(join(fixture.home, STATION_HOME_SCHEMA_FILE))).toBe(schema);
      }
    },
  );

  it('restores receipt descendants and sibling path segments beside a retained checkout', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const request = join(fixture.home, 'repository-acquisitions', randomUUID());
    const receipt = join(request, 'receipts', 'operation.json');
    const sibling = join(request, 'CHECKOUT-10', 'old.txt');
    for (const file of [receipt, sibling]) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'saved state');
    }
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const checkout = join(request, 'checkout-1');
    mkdirSync(checkout);
    writeFileSync(join(checkout, 'work.txt'), 'user work');
    for (const file of [receipt, sibling]) writeFileSync(file, 'trial state');
    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    for (const file of [receipt, sibling])
      expect(readFileSync(file, 'utf8')).toBe('saved state');
    expect(readFileSync(join(checkout, 'work.txt'), 'utf8')).toBe('user work');
  });

  it.skipIf(process.platform === 'win32').each([
    ['current', 'edited'],
    ['current', 'deleted'],
    ['older', 'edited'],
    ['older', 'deleted'],
  ] as const)(
    'restores receipts from a %s snapshot while leaving %s POSIX raw checkout names alone',
    (version, change) => {
      const fixture = serviceHome();
      mkdirSync(join(fixture.root, 'update-backups'));
      const directory = join(
        fixture.home,
        'repository-acquisitions',
        randomUUID(),
      );
      const checkout = join(directory, 'checkout-1');
      const names = ['a\\b.txt', join('dir\\name', 'note.txt'), 'ordinary.txt'];
      for (const name of names) {
        const file = join(checkout, name);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'saved user bytes');
      }
      const receipt = join(directory, 'operation.json');
      writeFileSync(receipt, 'saved receipt');
      if (version === 'older') {
        // Before checkout exclusion, update v1 held these regular files.
        // The full backup API produces their bytes/hashes in manifest order;
        // the update v1 envelope adds its (empty here) symbolic-link list.
        const { manifest } = createStationHomeBackup({
          homeDir: fixture.home,
          outputDir: fixture.backupDir,
        });
        writeFileSync(
          join(fixture.backupDir, STATION_HOME_BACKUP_MANIFEST),
          JSON.stringify({
            ...manifest,
            schemaVersion: STATION_HOME_UPDATE_BACKUP_SCHEMA,
            symlinks: [],
          }),
        );
      }
      const backup = createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      });
      expect(backup.reused).toBe(version === 'older');
      expect(
        backup.manifest.files.some((file) => file.path.at(-1) === 'a\\b.txt'),
      ).toBe(version === 'older');
      for (const name of names) {
        const file = join(checkout, name);
        if (change === 'edited') writeFileSync(file, 'trial user bytes');
        else rmSync(file);
      }
      const newWork = join(checkout, 'new.txt');
      writeFileSync(newWork, 'new user work');
      writeFileSync(receipt, 'trial receipt');
      writeFileSync(join(fixture.home, 'config', 'app.json'), 'trial config');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          restoreStationHomeUpdateBackup({
            homeDir: fixture.home,
            backupDir: fixture.backupDir,
          });
        } finally {
          // Also observe user bytes when restore throws after a partial copy.
          for (const name of names) {
            const file = join(checkout, name);
            if (change === 'edited')
              expect(readFileSync(file, 'utf8')).toBe('trial user bytes');
            else
              expect(
                existsSync(file),
                'deleted user file must stay absent',
              ).toBe(false);
          }
        }
        expect(readFileSync(newWork, 'utf8')).toBe('new user work');
        expect(readFileSync(receipt, 'utf8')).toBe('saved receipt');
        expect(
          readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8'),
        ).toBe('{"model":"before"}\n');
      }
    },
  );

  it('backs up state including the schema marker and leaves live roots out', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const { manifest, reused } = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    expect(reused).toBe(false);
    const paths = manifest.files.map((file) => file.path.join('/'));
    expect(paths).toContain(STATION_HOME_SCHEMA_FILE);
    expect(paths).toContain('config/app.json');
    expect(paths).toContain('data/orchestration.sqlite');
    for (const live of ['service', 'instances.json', 'logs'])
      expect(paths.some((path) => path.split('/')[0] === live)).toBe(false);
  });

  it('rolls a trial that bumped the schema and wrote new data back, keeping live roots as they are', () => {
    const fixture = serviceHome();
    const model = join(
      fixture.home,
      'media-tools',
      'speech-model',
      'model.bin',
    );
    mkdirSync(join(model, '..'), { recursive: true });
    writeFileSync(model, 'verified model before trial');
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const before = sha(join(fixture.home, STATION_HOME_SCHEMA_FILE));

    // The trial: migrates the home, rewrites data, adds a store, and the
    // service lifecycle keeps writing its live entries meanwhile.
    writeSchemaVersion(fixture.home, 99);
    writeFileSync(model, 'trial replaced model');
    writeFileSync(
      join(fixture.home, 'config', 'app.json'),
      '{"model":"trial"}\n',
    );
    const database = new DatabaseSync(
      join(fixture.home, 'data', 'orchestration.sqlite'),
    );
    database.exec("UPDATE facts SET value = 'trial'");
    database.close();
    mkdirSync(join(fixture.home, 'trial-only-store'));
    writeFileSync(join(fixture.home, 'trial-only-store', 'x.json'), '{}\n');
    writeFileSync(join(fixture.home, 'logs', 'default.log'), 'trial crashed\n');
    writeFileSync(join(fixture.home, 'instances.json'), '{"liveness":"now"}\n');

    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });

    expect(sha(join(fixture.home, STATION_HOME_SCHEMA_FILE))).toBe(before);
    expect(readFileSync(model, 'utf8')).toBe('verified model before trial');
    expect(schemaVersion(fixture.home)).not.toBe(99);
    expect(readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"before"}\n',
    );
    const restored = new DatabaseSync(
      join(fixture.home, 'data', 'orchestration.sqlite'),
      { readOnly: true },
    );
    expect(restored.prepare('SELECT value FROM facts').get()).toEqual({
      value: 'before',
    });
    restored.close();
    expect(existsSync(join(fixture.home, 'trial-only-store'))).toBe(false);
    // Live roots: exactly as the service lifecycle left them.
    expect(
      readFileSync(join(fixture.home, 'logs', 'default.log'), 'utf8'),
    ).toBe('trial crashed\n');
    expect(readFileSync(join(fixture.home, 'instances.json'), 'utf8')).toBe(
      '{"liveness":"now"}\n',
    );
    expect(
      readFileSync(join(fixture.home, 'service', 'default.json'), 'utf8'),
    ).toBe('{"manifest":1}\n');
  });

  it('finishes a restore interrupted after it removed the state entries', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    writeSchemaVersion(fixture.home, 99);
    expect(() =>
      restoreStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
        afterRemove: () => {
          throw new Error('crash mid-restore');
        },
      }),
    ).toThrow(StationHomeArchiveError);
    // Interrupted: the state is gone, the live roots are not.
    expect(existsSync(join(fixture.home, STATION_HOME_SCHEMA_FILE))).toBe(
      false,
    );
    expect(existsSync(join(fixture.home, 'service', 'default.json'))).toBe(
      true,
    );

    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    expect(schemaVersion(fixture.home)).not.toBe(99);
    expect(readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"before"}\n',
    );
  });

  it('takes the backup once: a second call reuses it instead of snapshotting the trial', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const first = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    writeFileSync(
      join(fixture.home, 'config', 'app.json'),
      '{"model":"trial"}\n',
    );
    const second = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    expect(second.reused).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
  });

  it('ENOSPC while copying leaves no backup and the home untouched', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const appBefore = sha(join(fixture.home, 'config', 'app.json'));
    let copies = 0;
    expect(() =>
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
        copyFile: () => {
          copies += 1;
          throw Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC',
          });
        },
      }),
    ).toThrow(StationHomeArchiveError);
    expect(copies).toBe(1);
    expect(existsSync(fixture.backupDir)).toBe(false);
    // No staging directory is left behind beside it either.
    expect(readdirSync(join(fixture.root, 'update-backups'))).toEqual([]);
    expect(sha(join(fixture.home, 'config', 'app.json'))).toBe(appBefore);
  });

  it('refuses to back up or restore a home a runtime still holds', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const lease = acquireStationHomeRuntimeLease(fixture.home);
    try {
      expect(() =>
        createStationHomeUpdateBackup({
          homeDir: fixture.home,
          backupDir: fixture.backupDir,
        }),
      ).toThrow(/inactive/);
    } finally {
      lease.release();
    }
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const again = acquireStationHomeRuntimeLease(fixture.home);
    try {
      expect(() =>
        restoreStationHomeUpdateBackup({
          homeDir: fixture.home,
          backupDir: fixture.backupDir,
        }),
      ).toThrow(/inactive/);
      expect(existsSync(join(fixture.home, 'config', 'app.json'))).toBe(true);
    } finally {
      again.release();
    }
  });

  it('checkpoints a registered WAL store that is not named *.sqlite, so its commits survive', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    mkdirSync(join(fixture.home, 'knowledge-index'));
    const path = join(fixture.home, 'knowledge-index', 'index.db');
    const writer = new DatabaseSync(path);
    writer.exec(
      'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE chunks (id INTEGER PRIMARY KEY, body TEXT);',
    );
    const insert = writer.prepare('INSERT INTO chunks (body) VALUES (?)');
    for (let index = 0; index < 500; index++) insert.run('x'.repeat(200));
    expect(existsSync(`${path}-wal`)).toBe(true);
    try {
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      });
    } finally {
      writer.close();
    }
    rmSync(join(fixture.home, 'knowledge-index'), { recursive: true });
    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const restored = new DatabaseSync(path, { readOnly: true });
    expect(
      restored.prepare('SELECT count(*) AS count FROM chunks').get(),
    ).toEqual({ count: 500 });
    restored.close();
  });
});

/**
 * A home in the shape real use leaves it (#2675 D review F1): a default
 * project directory holding a repository with `node_modules/.bin` links, a
 * plugin whose selection alias is an absolute link into its generations, a
 * plugin draft linked to a package outside the home, and a browser root
 * whose Chromium profiles are large and hold Chromium's dangling
 * `SingletonLock` link.
 */
function realisticHome() {
  const fixture = serviceHome();
  const { home } = fixture;
  const repo = join(home, 'workspaces', 'my-app');
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', '.bin'));
  writeFileSync(join(repo, 'package.json'), '{"name":"my-app"}\n');
  writeFileSync(join(repo, 'node_modules', 'pkg', 'cli.js'), 'run()\n');
  symlinkSync('../pkg/cli.js', join(repo, 'node_modules', '.bin', 'pkg'));

  const generation = join(home, 'plugins', '.generations', 'k1', 'g1');
  mkdirSync(join(generation, 'package'), { recursive: true });
  writeFileSync(join(generation, 'package', 'index.js'), 'export {}\n');
  const alias = join(home, 'plugins', 'demo');
  symlinkSync(join(generation, 'package'), alias, 'dir');
  const outside = join(fixture.root, 'installs', 'versions', '1.0.0', 'shared');
  mkdirSync(outside, { recursive: true });
  const draftLink = join(
    home,
    'plugins',
    'draft',
    'node_modules',
    '@kontourai',
    'station-shared',
  );
  mkdirSync(join(draftLink, '..'), { recursive: true });
  symlinkSync(outside, draftLink, 'dir');

  mkdirSync(join(home, 'browser', 'chromium'), { recursive: true });
  writeFileSync(join(home, 'browser', 'chromium', 'chrome'), 'binary\n');
  writeFileSync(join(home, 'browser', 'sessions.json'), '{"sessions":1}\n');
  const profile = join(home, 'browser', 'profiles', 'p1', 'q1');
  mkdirSync(join(profile, 'Cache'), { recursive: true });
  for (let index = 0; index < 300; index += 1)
    writeFileSync(join(profile, 'Cache', `f_${index}`), `${index}\n`);
  symlinkSync('host-12345', join(profile, 'SingletonLock'));
  return { ...fixture, repo, alias, draftLink, outside, profile, generation };
}

describe('update backup of a realistic home (#2675 D review F1)', () => {
  it('records links as links, leaves external paths out, and stays inside a small file budget', () => {
    const fixture = realisticHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    // A home backup still refuses a link, as before.
    expect(() =>
      createStationHomeBackup({
        homeDir: fixture.home,
        outputDir: join(fixture.root, 'home-backup'),
      }),
    ).toThrow(/symbolic link/);
    const { manifest } = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
      // The profile alone holds 300 files: excluded, it cannot count.
      maxFiles: 50,
    });
    expect(manifest.schemaVersion).toBe(STATION_HOME_UPDATE_BACKUP_SCHEMA);
    const files = manifest.files.map((file) => file.path.join('/'));
    expect(files).toContain('browser/sessions.json');
    expect(files).toContain('plugins/.generations/k1/g1/package/index.js');
    for (const file of files) {
      expect(file.startsWith('workspaces/')).toBe(false);
      expect(file.startsWith('browser/profiles/')).toBe(false);
      expect(file.startsWith('browser/chromium/')).toBe(false);
    }
    expect(
      manifest.symlinks?.map((link) => [link.path.join('/'), link.target]),
    ).toEqual([
      ['plugins/demo', join(fixture.generation, 'package')],
      ['plugins/draft/node_modules/@kontourai/station-shared', fixture.outside],
    ]);
    // Never followed: the backup's copy holds no link and nothing of the
    // package outside the home (the draft holds only its link).
    const copied = join(fixture.backupDir, 'home', 'plugins');
    expect(readdirSync(copied)).toEqual(['.generations']);
  });

  it('a rollback restores links as links and leaves users repositories and the browser profiles as the trial left them', () => {
    const fixture = realisticHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    // The trial: re-points the plugin alias, drops the draft link, rewrites
    // Station's browser state; the user keeps working in the repository and
    // Chromium keeps writing its profile.
    rmSync(fixture.alias);
    symlinkSync(join(fixture.home, 'plugins'), fixture.alias, 'dir');
    rmSync(fixture.draftLink);
    writeFileSync(join(fixture.home, 'plugins', 'trial.json'), '{}\n');
    writeFileSync(
      join(fixture.home, 'browser', 'sessions.json'),
      '{"sessions":"trial"}\n',
    );
    writeFileSync(join(fixture.repo, 'written-during-trial.ts'), 'x\n');
    writeFileSync(join(fixture.profile, 'Cookies'), 'trial\n');

    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });

    expect(lstatSync(fixture.alias).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fixture.alias)).toBe(
      join(fixture.generation, 'package'),
    );
    expect(lstatSync(fixture.draftLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fixture.draftLink)).toBe(fixture.outside);
    expect(existsSync(join(fixture.home, 'plugins', 'trial.json'))).toBe(false);
    expect(
      readFileSync(join(fixture.home, 'browser', 'sessions.json'), 'utf8'),
    ).toBe('{"sessions":1}\n');
    // External: exactly as the trial window left it, links included.
    expect(
      readFileSync(join(fixture.repo, 'written-during-trial.ts'), 'utf8'),
    ).toBe('x\n');
    expect(
      readlinkSync(join(fixture.repo, 'node_modules', '.bin', 'pkg')),
    ).toBe('../pkg/cli.js');
    expect(readFileSync(join(fixture.profile, 'Cookies'), 'utf8')).toBe(
      'trial\n',
    );
    expect(readlinkSync(join(fixture.profile, 'SingletonLock'))).toBe(
      'host-12345',
    );
    expect(
      readFileSync(join(fixture.home, 'browser', 'chromium', 'chrome'), 'utf8'),
    ).toBe('binary\n');
  });

  it('refuses a manifest whose link would land outside the home', () => {
    const fixture = realisticHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const manifestPath = join(fixture.backupDir, STATION_HOME_BACKUP_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.symlinks.push({
      path: ['..', 'escaped'],
      target: '/etc',
      directory: true,
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() =>
      restoreStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      }),
    ).toThrow(/unsafe path segment/);
    expect(existsSync(join(fixture.root, 'escaped'))).toBe(false);
    // Nothing was removed before the manifest was refused.
    expect(lstatSync(fixture.alias).isSymbolicLink()).toBe(true);
  });

  it('refuses a manifest that places a file or a link below a recorded link (review L1)', () => {
    for (const [entry, recordedName] of [
      ['link', 'station-shared'],
      ['file', 'station-shared'],
      // A case-insensitive volume resolves this through the same link.
      ['link', 'STATION-SHARED'],
      ['file', 'Station-Shared'],
    ] as const) {
      const fixture = realisticHome();
      mkdirSync(join(fixture.root, 'update-backups'));
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      });
      const manifestPath = join(
        fixture.backupDir,
        STATION_HOME_BACKUP_MANIFEST,
      );
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      // The draft's link points outside the home: anything restored below
      // it would land there.
      const below = [
        'plugins',
        'draft',
        'node_modules',
        '@kontourai',
        recordedName,
        'planted',
      ];
      if (entry === 'link') {
        manifest.symlinks.push({
          path: below,
          target: '/etc',
          directory: true,
        });
      } else {
        manifest.files.push({
          path: below,
          size: 0,
          sha256: createHash('sha256').update('').digest('hex'),
          mode: 0o600,
        });
      }
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() =>
        restoreStationHomeUpdateBackup({
          homeDir: fixture.home,
          backupDir: fixture.backupDir,
        }),
      ).toThrow(/below a symbolic link/);
      expect(existsSync(join(fixture.outside, 'planted'))).toBe(false);
    }
  });

  it('refuses a backup its volume cannot hold, counting whole blocks per file (review L3)', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    // Many small files: their bytes are few, their blocks are not.
    mkdirSync(join(fixture.home, 'skills'), { recursive: true });
    for (let index = 0; index < 64; index += 1)
      writeFileSync(join(fixture.home, 'skills', `s${index}.md`), 'x');
    const margin = 256 * 1024 * 1024;
    const bsize = 1024 * 1024;
    // Room for every byte plus the margin, but not for 64+ one-MiB blocks.
    const statfs = () => ({ bavail: margin / bsize + 8, bsize });
    expect(() =>
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
        statfs,
      }),
    ).toThrow(/not enough free space for the update backup/);
    // Refused before anything was staged or published.
    expect(readdirSync(join(fixture.root, 'update-backups'))).toEqual([]);
    // With room, the same backup goes through.
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
      statfs: () => ({ bavail: margin / bsize + 1024, bsize }),
    });
    expect(existsSync(fixture.backupDir)).toBe(true);
  });

  it('reusing an existing backup takes the maintenance lease too (F3)', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    // A desktop sidecar started on the home while the launcher was down.
    const lease = acquireStationHomeRuntimeLease(fixture.home);
    try {
      expect(() =>
        createStationHomeUpdateBackup({
          homeDir: fixture.home,
          backupDir: fixture.backupDir,
        }),
      ).toThrow(/inactive/);
    } finally {
      lease.release();
    }
    expect(
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      }).reused,
    ).toBe(true);
  });
});
