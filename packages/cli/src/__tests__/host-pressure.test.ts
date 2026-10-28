import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  PSI_CPU_PATHS,
  parsePsiCpuSomeAvg60,
  readHostPressure,
} from '../commands/host-pressure.js';

const PSI_ROOT = mkdtempSync(join(tmpdir(), 'station-host-pressure-'));
afterAll(() => {
  rmSync(PSI_ROOT, { force: true, recursive: true });
});
let psiFiles = 0;

/** Writes a real file the reader opens by path; returns the path. */
const rawPsiFile = (text: string) => {
  psiFiles += 1;
  const path = join(PSI_ROOT, `cpu-${psiFiles}.pressure`);
  writeFileSync(path, text);
  return path;
};
// The exact shape the Linux kernel writes to /proc/pressure/cpu and a cgroup
// v2 cpu.pressure (5.13+ also emits the `full` line for cpu).
const psiFile = (someAvg60: string) =>
  rawPsiFile(
    `some avg10=12.50 avg60=${someAvg60} avg300=4.10 total=123456789\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
  );
// A path that does not exist, read for real: the ENOENT macOS and Windows
// produce for every PSI path.
const absent = join(PSI_ROOT, 'absent', 'cpu.pressure');

describe('host pressure', () => {
  // Pinned literally: the default-sources test below reads these same paths.
  test('prefers the cgroup v2 file over the system-wide one', () => {
    expect(PSI_CPU_PATHS).toEqual([
      '/sys/fs/cgroup/cpu.pressure',
      '/proc/pressure/cpu',
    ]);
  });

  test('parses the some-line avg60 and ignores the full line', () => {
    expect(parsePsiCpuSomeAvg60(readFileSync(psiFile('31.07'), 'utf8'))).toBe(
      31.07,
    );
    expect(
      parsePsiCpuSomeAvg60(
        'full avg10=0.00 avg60=99.00 avg300=0.00 total=0\nsome avg10=1.00 avg60=2.00 avg300=0.00 total=1\n',
      ),
    ).toBe(2);
    expect(parsePsiCpuSomeAvg60('')).toBeNull();
    expect(parsePsiCpuSomeAvg60('some avg10=1.00 avg300=0.00')).toBeNull();
  });

  test('Linux PSI at or above the threshold reports pressure', () => {
    const at = psiFile('25.00');
    expect(
      readHostPressure({
        psiCpuPaths: [at],
        loadAverage: () => [0.5, 0.5, 0.5],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: true, detail: `${at} some avg60=25%` });
    expect(
      readHostPressure({
        psiCpuPaths: [psiFile('24.99')],
        loadAverage: () => [0.5, 0.5, 0.5],
        cpuCount: () => 4,
      })?.pressured,
    ).toBe(false);
  });

  // Linux load averages count tasks blocked on I/O; an I/O stall with idle
  // CPUs is not starvation, so readable PSI overrides a high load.
  test('readable PSI decides alone: low PSI with a high load average is not pressure', () => {
    const low = psiFile('2.00');
    expect(
      readHostPressure({
        psiCpuPaths: [low],
        loadAverage: () => [12, 12, 12],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: false, detail: `${low} some avg60=2%` });
  });

  test('a missing first PSI file falls through to the next one', () => {
    const second = psiFile('40.00');
    expect(
      readHostPressure({
        psiCpuPaths: [absent, second],
        loadAverage: () => [0.5, 0.5, 0.5],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: true, detail: `${second} some avg60=40%` });
  });

  test('an unparseable first PSI file falls through to the next one, not to the load average', () => {
    const second = psiFile('2.00');
    expect(
      readHostPressure({
        psiCpuPaths: [rawPsiFile('garbage'), second],
        loadAverage: () => [12, 12, 12],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: false, detail: `${second} some avg60=2%` });
  });

  test('without PSI (macOS) the load average per CPU decides', () => {
    expect(
      readHostPressure({
        psiCpuPaths: [absent],
        loadAverage: () => [10.2, 9, 8],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: true, detail: 'load 10.20 on 4 CPUs' });
    expect(
      readHostPressure({
        psiCpuPaths: [absent],
        loadAverage: () => [5.99, 5, 5],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: false, detail: 'load 5.99 on 4 CPUs' });
  });

  test('malformed PSI falls back to the load average', () => {
    expect(
      readHostPressure({
        psiCpuPaths: [rawPsiFile('garbage')],
        loadAverage: () => [10.2, 9, 8],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: true, detail: 'load 10.20 on 4 CPUs' });
  });

  test('Windows (no PSI, zero load average) is unmeasurable, never pressured', () => {
    expect(
      readHostPressure({
        psiCpuPaths: [absent],
        loadAverage: () => [0, 0, 0],
        cpuCount: () => 8,
      }),
    ).toBeNull();
  });

  test('a throwing load source with no PSI degrades to null instead of throwing', () => {
    expect(
      readHostPressure({
        psiCpuPaths: [absent],
        loadAverage: () => {
          throw new Error('unavailable');
        },
      }),
    ).toBeNull();
  });

  // The shipped defaults, no injection: proves the real paths and os sources
  // are wired. The source must match this platform: macOS has no PSI and a
  // non-zero load average; Windows reports nothing; Linux reads PSI when the
  // kernel provides either file.
  test('the default sources read this platform', () => {
    const reading = readHostPressure();
    if (process.platform === 'win32') {
      expect(reading).toBeNull();
      return;
    }
    expect(reading).not.toBeNull();
    expect(typeof reading?.pressured).toBe('boolean');
    // The reader uses the first file that reads and parses.
    const psiPath = ['/sys/fs/cgroup/cpu.pressure', '/proc/pressure/cpu'].find(
      (path) => {
        try {
          return parsePsiCpuSomeAvg60(readFileSync(path, 'utf8')) !== null;
        } catch {
          return false;
        }
      },
    );
    if (psiPath) {
      expect(reading?.detail).toMatch(
        new RegExp(`^${psiPath} some avg60=\\d+(\\.\\d+)?%$`),
      );
    } else {
      expect(reading?.detail).toMatch(/^load \d+\.\d{2} on \d+ CPUs$/);
    }
  });
});
