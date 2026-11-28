import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startJourneyHostObservation } from '../lib/journey-host-observation.mjs';

vi.mock('node:os', () => ({
  cpus: vi.fn(),
  freemem: vi.fn(),
  loadavg: vi.fn(),
  platform: vi.fn(),
  totalmem: vi.fn(),
}));

function cpu(user: number, idle: number) {
  return {
    model: 'test',
    speed: 1000,
    times: { user, nice: 0, sys: 0, idle, irq: 0 },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  vi.mocked(cpus).mockReturnValue([cpu(100, 100), cpu(100, 100)]);
  vi.mocked(freemem).mockReturnValue(512);
  vi.mocked(totalmem).mockReturnValue(1024);
  vi.mocked(platform).mockReturnValue('linux');
  vi.mocked(loadavg).mockReturnValue([1, 2, 3]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

test('records host-wide interval deltas and a final partial interval, then stops sampling', () => {
  const observation = startJourneyHostObservation();
  vi.mocked(cpus).mockReturnValue([cpu(175, 125), cpu(125, 175)]);
  vi.advanceTimersByTime(1000);
  vi.mocked(cpus).mockReturnValue([cpu(200, 125), cpu(150, 175)]);
  vi.mocked(freemem).mockReturnValue(400);
  vi.advanceTimersByTime(250);
  const report = observation.stop();
  expect(report).toEqual({
    scope: 'runner-host',
    sampleIntervalMs: 1000,
    logicalCpus: 2,
    totalMemoryBytes: 1024,
    samples: [
      {
        offsetMs: 0,
        cpuBusyPercent: null,
        freeMemoryBytes: 512,
        loadAverage: [1, 2, 3],
      },
      {
        offsetMs: 1000,
        cpuBusyPercent: 50,
        freeMemoryBytes: 512,
        loadAverage: [1, 2, 3],
      },
      {
        offsetMs: 1250,
        cpuBusyPercent: 100,
        freeMemoryBytes: 400,
        loadAverage: [1, 2, 3],
      },
    ],
  });
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(2000);
  expect(report.samples).toHaveLength(3);
});

test('short Windows phases retain boundary samples without treating unsupported load averages as idle', () => {
  vi.mocked(platform).mockReturnValue('win32');
  vi.mocked(loadavg).mockReturnValue([0, 0, 0]);
  const observation = startJourneyHostObservation();
  vi.mocked(cpus).mockReturnValue([cpu(100, 200), cpu(100, 200)]);
  vi.advanceTimersByTime(100);
  expect(observation.stop().samples).toEqual([
    {
      offsetMs: 0,
      cpuBusyPercent: null,
      freeMemoryBytes: 512,
      loadAverage: null,
    },
    {
      offsetMs: 100,
      cpuBusyPercent: 0,
      freeMemoryBytes: 512,
      loadAverage: null,
    },
  ]);
});

test.each([
  { name: 'unchanged counters', next: [cpu(100, 100), cpu(100, 100)] },
  { name: 'unavailable CPUs', next: [] },
  { name: 'changed CPU count', next: [cpu(200, 200)] },
  { name: 'reset counter', next: [cpu(99, 200), cpu(200, 200)] },
])('does not report a CPU percentage for $name', ({ next }) => {
  const observation = startJourneyHostObservation();
  vi.mocked(cpus).mockReturnValue(next);
  vi.advanceTimersByTime(100);
  expect(observation.stop().samples[1].cpuBusyPercent).toBeNull();
});

test('represents unavailable initial CPU inventory as unknown rather than a zero-CPU host', () => {
  vi.mocked(cpus).mockReturnValue([]);
  const observation = startJourneyHostObservation();
  vi.advanceTimersByTime(100);
  expect(observation.stop()).toMatchObject({
    logicalCpus: null,
    samples: [
      { cpuBusyPercent: null },
      { offsetMs: 100, cpuBusyPercent: null },
    ],
  });
});
