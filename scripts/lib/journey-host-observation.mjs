import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';

export function startJourneyHostObservation() {
  const start = performance.now();
  let previousCpus = cpus();
  const sample = (initial = false) => {
    const currentCpus = initial ? previousCpus : cpus();
    let cpuBusyPercent = null;
    if (!initial && currentCpus.length === previousCpus.length) {
      let totalDelta = 0;
      let idleDelta = 0;
      let countersAdvanced = true;
      for (const [index, cpu] of currentCpus.entries()) {
        const previous = previousCpus[index].times;
        for (const name of ['user', 'nice', 'sys', 'idle', 'irq']) {
          const delta = cpu.times[name] - previous[name];
          if (delta < 0) countersAdvanced = false;
          totalDelta += delta;
        }
        idleDelta += cpu.times.idle - previous.idle;
      }
      if (
        countersAdvanced &&
        totalDelta > 0 &&
        idleDelta >= 0 &&
        idleDelta <= totalDelta
      )
        cpuBusyPercent = ((totalDelta - idleDelta) / totalDelta) * 100;
    }
    const snapshot = {
      offsetMs: initial ? 0 : performance.now() - start,
      cpuBusyPercent,
      freeMemoryBytes: freemem(),
      loadAverage: platform() === 'win32' ? null : loadavg(),
    };
    previousCpus = currentCpus;
    return snapshot;
  };
  const observation = {
    scope: 'runner-host',
    sampleIntervalMs: 1000,
    logicalCpus: previousCpus.length || null,
    totalMemoryBytes: totalmem(),
    samples: [sample(true)],
  };
  const timer = setInterval(() => {
    observation.samples.push(sample());
  }, observation.sampleIntervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      observation.samples.push(sample());
      return observation;
    },
  };
}
