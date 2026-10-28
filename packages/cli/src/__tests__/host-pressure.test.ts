import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PSI_CPU_PATHS,
  parsePsiCpuSomeAvg60,
  readHostPressure,
} from '../commands/host-pressure.js';

// The exact shape the Linux kernel writes to /proc/pressure/cpu and a cgroup
// v2 cpu.pressure (5.13+ also emits the `full` line for cpu).
const psiCpu = (someAvg60: string) => ({
  path: '/proc/pressure/cpu',
  text: `some avg10=12.50 avg60=${someAvg60} avg300=4.10 total=123456789\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
});

// A real read of a path that does not exist: the ENOENT macOS and Windows
// produce for every PSI path, not a stubbed throw.
const absentPsi = () => ({
  path: '/nonexistent-station-psi',
  text: readFileSync(
    join('/nonexistent-station-psi', 'pressure', 'cpu'),
    'utf8',
  ),
});

describe('host pressure', () => {
  test('prefers the cgroup v2 file over the system-wide one', () => {
    expect(PSI_CPU_PATHS).toEqual([
      '/sys/fs/cgroup/cpu.pressure',
      '/proc/pressure/cpu',
    ]);
  });

  test('parses the some-line avg60 and ignores the full line', () => {
    expect(parsePsiCpuSomeAvg60(psiCpu('31.07').text)).toBe(31.07);
    expect(
      parsePsiCpuSomeAvg60(
        'full avg10=0.00 avg60=99.00 avg300=0.00 total=0\nsome avg10=1.00 avg60=2.00 avg300=0.00 total=1\n',
      ),
    ).toBe(2);
    expect(parsePsiCpuSomeAvg60('')).toBeNull();
    expect(parsePsiCpuSomeAvg60('some avg10=1.00 avg300=0.00')).toBeNull();
  });

  test('Linux PSI at or above the threshold reports pressure', () => {
    expect(
      readHostPressure({
        readPsiCpu: () => psiCpu('25.00'),
        loadAverage: () => [0.5, 0.5, 0.5],
        cpuCount: () => 4,
      }),
    ).toEqual({
      pressured: true,
      detail: '/proc/pressure/cpu some avg60=25%',
    });
    expect(
      readHostPressure({
        readPsiCpu: () => psiCpu('24.99'),
        loadAverage: () => [0.5, 0.5, 0.5],
        cpuCount: () => 4,
      })?.pressured,
    ).toBe(false);
  });

  // Linux load averages count tasks blocked on I/O; an I/O stall with idle
  // CPUs is not starvation, so readable PSI overrides a high load.
  test('readable PSI decides alone: low PSI with a high load average is not pressure', () => {
    expect(
      readHostPressure({
        readPsiCpu: () => psiCpu('2.00'),
        loadAverage: () => [12, 12, 12],
        cpuCount: () => 4,
      }),
    ).toEqual({
      pressured: false,
      detail: '/proc/pressure/cpu some avg60=2%',
    });
  });

  test('without PSI (macOS) the load average per CPU decides', () => {
    expect(
      readHostPressure({
        readPsiCpu: absentPsi,
        loadAverage: () => [10.2, 9, 8],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: true, detail: 'load 10.20 on 4 CPUs' });
    expect(
      readHostPressure({
        readPsiCpu: absentPsi,
        loadAverage: () => [5.99, 5, 5],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: false, detail: 'load 5.99 on 4 CPUs' });
  });

  test('malformed PSI falls back to the load average', () => {
    expect(
      readHostPressure({
        readPsiCpu: () => ({ path: '/proc/pressure/cpu', text: 'garbage' }),
        loadAverage: () => [10.2, 9, 8],
        cpuCount: () => 4,
      }),
    ).toEqual({ pressured: true, detail: 'load 10.20 on 4 CPUs' });
  });

  test('Windows (no PSI, zero load average) is unmeasurable, never pressured', () => {
    expect(
      readHostPressure({
        readPsiCpu: absentPsi,
        loadAverage: () => [0, 0, 0],
        cpuCount: () => 8,
      }),
    ).toBeNull();
  });

  test('a throwing load source with no PSI degrades to null instead of throwing', () => {
    expect(
      readHostPressure({
        readPsiCpu: absentPsi,
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
    // The reader uses the first READABLE file, parsing only that one.
    let psiPath: string | undefined;
    for (const path of ['/sys/fs/cgroup/cpu.pressure', '/proc/pressure/cpu']) {
      try {
        const text = readFileSync(path, 'utf8');
        if (parsePsiCpuSomeAvg60(text) !== null) psiPath = path;
        break;
      } catch {}
    }
    if (psiPath) {
      expect(reading?.detail).toMatch(
        new RegExp(`^${psiPath} some avg60=\\d+(\\.\\d+)?%$`),
      );
    } else {
      expect(
        process.platform === 'linux' || process.platform === 'darwin',
      ).toBe(true);
      expect(reading?.detail).toMatch(/^load \d+\.\d{2} on \d+ CPUs$/);
    }
  });
});
