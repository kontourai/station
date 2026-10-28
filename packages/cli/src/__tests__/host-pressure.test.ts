import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  parsePsiCpuSomeAvg60,
  readHostPressure,
} from '../commands/host-pressure.js';

// The exact shape the Linux kernel writes to /proc/pressure/cpu (5.13+ also
// emits the `full` line for cpu).
const psiCpu = (someAvg60: string) =>
  `some avg10=12.50 avg60=${someAvg60} avg300=4.10 total=123456789\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;

// A real read of a path that does not exist: the ENOENT macOS and Windows
// produce for /proc/pressure/cpu, not a stubbed throw.
const absentPsi = () =>
  readFileSync(join('/nonexistent-station-psi', 'pressure', 'cpu'), 'utf8');

describe('host pressure', () => {
  test('parses the some-line avg60 and ignores the full line', () => {
    expect(parsePsiCpuSomeAvg60(psiCpu('31.07'))).toBe(31.07);
    expect(
      parsePsiCpuSomeAvg60(
        'full avg10=0.00 avg60=99.00 avg300=0.00 total=0\nsome avg10=1.00 avg60=2.00 avg300=0.00 total=1\n',
      ),
    ).toBe(2);
    expect(parsePsiCpuSomeAvg60('')).toBeNull();
    expect(parsePsiCpuSomeAvg60('some avg10=1.00 avg300=0.00')).toBeNull();
  });

  test('Linux PSI at or above the threshold reports pressure even with a low load average', () => {
    expect(
      readHostPressure({
        readPsiCpu: () => psiCpu('25.00'),
        loadAverage: () => [0.5, 0.5, 0.5],
        cpuCount: () => 4,
      }),
    ).toEqual({
      pressured: true,
      detail: 'PSI cpu some avg60=25%, load 0.50 on 4 CPUs',
    });
    expect(
      readHostPressure({
        readPsiCpu: () => psiCpu('24.99'),
        loadAverage: () => [0.5, 0.5, 0.5],
        cpuCount: () => 4,
      })?.pressured,
    ).toBe(false);
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

  test('Windows (no PSI, zero load average) is unmeasurable, never pressured', () => {
    expect(
      readHostPressure({
        readPsiCpu: absentPsi,
        loadAverage: () => [0, 0, 0],
        cpuCount: () => 8,
      }),
    ).toBeNull();
  });

  test('malformed PSI and a throwing load source degrade to null instead of throwing', () => {
    expect(
      readHostPressure({
        readPsiCpu: () => 'garbage',
        loadAverage: () => {
          throw new Error('unavailable');
        },
      }),
    ).toBeNull();
  });
});
