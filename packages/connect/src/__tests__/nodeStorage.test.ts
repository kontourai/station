import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileStorageAdapter } from '../core/nodeStorage';

const homes: string[] = [];

function makeAdapter(): { adapter: NodeFileStorageAdapter; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'station-connect-node-storage-'));
  homes.push(dir);
  const path = join(dir, 'known-environments.json');
  return { adapter: new NodeFileStorageAdapter(path), path };
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('NodeFileStorageAdapter', () => {
  it('returns null for a key that was never set', () => {
    const { adapter } = makeAdapter();
    expect(adapter.get('missing')).toBeNull();
  });

  it('round-trips a set value, persisted to disk', () => {
    const { adapter, path } = makeAdapter();
    adapter.set('station-known-environments', '[{"id":"a"}]');
    expect(adapter.get('station-known-environments')).toBe('[{"id":"a"}]');
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    expect(onDisk['station-known-environments']).toBe('[{"id":"a"}]');
  });

  it('keeps multiple keys in the same file independently addressable', () => {
    const { adapter } = makeAdapter();
    adapter.set('a', '1');
    adapter.set('b', '2');
    expect(adapter.get('a')).toBe('1');
    expect(adapter.get('b')).toBe('2');
  });

  it('remove() drops only the targeted key', () => {
    const { adapter } = makeAdapter();
    adapter.set('a', '1');
    adapter.set('b', '2');
    adapter.remove('a');
    expect(adapter.get('a')).toBeNull();
    expect(adapter.get('b')).toBe('2');
  });

  it('a corrupt file reads back as empty rather than throwing', () => {
    const { adapter, path } = makeAdapter();
    adapter.set('a', '1');
    // Corrupt the file directly, bypassing the adapter.
    writeFileSync(path, 'not json{{{');
    expect(adapter.get('a')).toBeNull();
    // The next write must still succeed and heal the file.
    adapter.set('b', '2');
    expect(adapter.get('b')).toBe('2');
  });

  it('creates the parent directory if it does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-connect-node-storage-'));
    homes.push(dir);
    const nested = join(dir, 'config', 'nested', 'known-environments.json');
    const adapter = new NodeFileStorageAdapter(nested);
    adapter.set('a', '1');
    expect(adapter.get('a')).toBe('1');
  });
});
