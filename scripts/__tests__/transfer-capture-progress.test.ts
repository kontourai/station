import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { createTransferCaptureProgress } from '../lib/transfer-capture-progress.js';

const makeTempDir = trackTempDirs();

function fixture() {
  const output = join(makeTempDir('transfer-progress-'), 'capture.json');
  const source = {
    subjectSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    toolDigest: 'c'.repeat(64),
    payload: 'private-message-and-tool-output',
  };
  return {
    output,
    source,
    progress: createTransferCaptureProgress(output, source),
  };
}

describe('bounded capture phase diagnostics', () => {
  test('reports diagnostic I/O failure without throwing into measurement or cleanup', () => {
    const { output, source } = fixture();
    const progress = createTransferCaptureProgress(
      join(output, 'missing.json'),
      source,
    );
    const warning = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      expect(progress('service-shutdown')).toBe(false);
      expect(warning).toHaveBeenCalledWith(
        '[transfer-capture] Phase diagnostic unavailable: service-shutdown\n',
      );
      expect(existsSync(output)).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });

  test('persists only provenance and phase timing without producing a success report', () => {
    const { output, source, progress } = fixture();
    expect(progress('imports')).toBe(true);
    const path = `${output}.progress.json`;
    const raw = readFileSync(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: 1,
      kind: 'station-transfer-capture-progress',
      subjectSha: source.subjectSha,
      baseSha: source.baseSha,
      toolDigest: source.toolDigest,
      phase: 'imports',
      elapsedMs: expect.any(Number),
    });
    expect(raw).not.toContain(source.payload);
    expect(raw.length).toBeLessThan(1024);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.failure.json`)).toBe(false);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('retains the latest phase with monotonic elapsed time', () => {
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(110)
      .mockReturnValueOnce(125);
    try {
      const { output, progress } = fixture();
      progress('native-measurement');
      const first = JSON.parse(readFileSync(`${output}.progress.json`, 'utf8'));
      progress('service-shutdown');
      const last = JSON.parse(readFileSync(`${output}.progress.json`, 'utf8'));
      expect(first.elapsedMs).toBe(10);
      expect(last.phase).toBe('service-shutdown');
      expect(last.elapsedMs).toBe(25);
      expect(existsSync(`${output}.progress.json.tmp`)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('refuses an unknown phase without overwriting the retained diagnostic', () => {
    const { output, progress } = fixture();
    progress('source-validation');
    const before = readFileSync(`${output}.progress.json`, 'utf8');
    expect(() =>
      Reflect.apply(progress, undefined, ['private-user-text']),
    ).toThrow('Unknown transfer capture phase');
    expect(readFileSync(`${output}.progress.json`, 'utf8')).toBe(before);
  });
});
