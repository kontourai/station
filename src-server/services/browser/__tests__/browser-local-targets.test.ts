import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  LocalTargetStore,
  normalizeLocalTargetHost,
} from '../browser-local-targets.js';
import { egressPolicyFor } from '../browser-service.js';
import { decideEgress } from '../egress-policy.js';
import { deriveStationListeners } from '../station-listeners.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const listeners = deriveStationListeners({
  serverPort: 4100,
  configuredOrigins: [],
});

function store() {
  const home = mkdtempSync(join(tmpdir(), 'station-browser-targets-'));
  homes.push(home);
  return { home, store: new LocalTargetStore(home) };
}

describe('normalizeLocalTargetHost', () => {
  test.each([
    ['localhost', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['::ffff:7f00:1', '127.0.0.1'],
    ['192.168.1.20', '192.168.1.20'],
    ['10.0.0.5', '10.0.0.5'],
    ['100.101.102.103', '100.101.102.103'],
    ['fd00::1', 'fd00:0:0:0:0:0:0:1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeLocalTargetHost(input)).toBe(expected);
  });

  test.each([
    ['93.184.216.34'],
    ['169.254.169.254'],
    ['fe80::1'],
    ['224.0.0.1'],
    ['0.0.0.0'],
    ['0.1.2.3'],
    ['0.0.0.1'],
    ['::ffff:0.1.2.3'],
    ['::'],
    ['example.com'],
    [''],
    [42],
  ])('%j is not a registrable local target', (input) => {
    expect(normalizeLocalTargetHost(input)).toBeUndefined();
  });
});

describe('LocalTargetStore', () => {
  test('adds, lists per Project, removes, and persists across instances', () => {
    const { home, store: targets } = store();
    const added = targets.add(
      'p-1',
      { host: 'localhost', port: 5173, label: 'Vite' },
      'operator',
      listeners,
    );
    expect(added).toMatchObject({
      host: 'localhost',
      port: 5173,
      label: 'Vite',
      addedBy: 'operator',
    });
    expect(targets.list('p-2')).toEqual([]);
    expect(new LocalTargetStore(home).list('p-1')).toEqual([added]);
    targets.remove('p-1', added.id);
    expect(new LocalTargetStore(home).list('p-1')).toEqual([]);
  });

  test('refuses Station listener ports, duplicates and bad labels', () => {
    const { store: targets } = store();
    for (const port of [4100, 4101, 4102, 4103]) {
      expect(() =>
        targets.add(
          'p-1',
          { host: 'localhost', port, label: 'x' },
          'operator',
          listeners,
        ),
      ).toThrow(expect.objectContaining({ code: 'station-listener' }));
    }
    targets.add(
      'p-1',
      { host: '127.0.0.1', port: 5173, label: 'x' },
      'operator',
      listeners,
    );
    expect(() =>
      targets.add(
        'p-1',
        { host: '::ffff:7f00:1', port: 5173, label: 'y' },
        'operator',
        listeners,
      ),
    ).toThrow(expect.objectContaining({ code: 'duplicate' }));
    for (const label of ['', ' ', 'a'.repeat(81), 'line\nbreak']) {
      expect(() =>
        targets.add(
          'p-1',
          { host: 'localhost', port: 5174, label },
          'operator',
          listeners,
        ),
      ).toThrow(expect.objectContaining({ code: 'invalid-label' }));
    }
    expect(() => targets.remove('p-1', 'lt_missing')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
  });

  test('a tampered store entry with a disallowed host is dropped on load', () => {
    const { home } = store();
    const path = join(home, 'browser', 'local-targets.json');
    const first = new LocalTargetStore(home);
    first.add(
      'p-1',
      { host: 'localhost', port: 5173, label: 'ok' },
      'operator',
      listeners,
    );
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.projects['p-1'].push({
      id: 'lt_evil',
      host: '169.254.169.254',
      port: 80,
      label: 'm',
      addedBy: 'x',
      addedAt: 'x',
    });
    writeFileSync(path, JSON.stringify(raw));
    expect(new LocalTargetStore(home).list('p-1').map((t) => t.host)).toEqual([
      'localhost',
    ]);
  });

  test('D7 end to end: a Project profile policy follows the store live', () => {
    const { store: targets } = store();
    const policy = egressPolicyFor(
      { projectId: 'p-1', reach: 'project' },
      () => listeners,
      targets,
    );
    const operator = egressPolicyFor(
      { projectId: 'p-1', reach: 'operator' },
      () => listeners,
      targets,
    );
    expect(decideEgress('127.0.0.1', 5173, policy)).toBe('non-public-address');
    expect(decideEgress('127.0.0.1', 5173, operator)).toBeUndefined();
    const added = targets.add(
      'p-1',
      { host: 'localhost', port: 5173, label: 'x' },
      'operator',
      listeners,
    );
    expect(decideEgress('127.0.0.1', 5173, policy)).toBeUndefined();
    // Another Project's registration does not leak across.
    const other = egressPolicyFor(
      { projectId: 'p-2', reach: 'project' },
      () => listeners,
      targets,
    );
    expect(decideEgress('127.0.0.1', 5173, other)).toBe('non-public-address');
    targets.remove('p-1', added.id);
    expect(decideEgress('127.0.0.1', 5173, policy)).toBe('non-public-address');
  });
});
