import { subscribe } from 'node:diagnostics_channel';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Loaded before the real server bundle. IPC keeps measurement traffic off HTTP.
const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();
let started = performance.now();
let cpu = process.cpuUsage();
let requests = 0;
subscribe('http.server.request.start', () => {
  requests += 1;
});
process.on('message', (message) => {
  if (message?.type !== 'server-scenario-probe') return;
  if (message.action === 'reset') {
    delay.reset();
    started = performance.now();
    cpu = process.cpuUsage();
    requests = 0;
  }
  const usage = process.cpuUsage(cpu);
  process.send({
    type: 'server-scenario-probe',
    id: message.id,
    elapsedMs: performance.now() - started,
    cpuMs: (usage.user + usage.system) / 1000,
    requests,
    rssBytes: process.memoryUsage().rss,
    eventLoopDelayMs: {
      samples: delay.count,
      p50: delay.count ? delay.percentile(50) / 1e6 : null,
      p99: delay.count ? delay.percentile(99) / 1e6 : null,
      max: delay.count ? delay.max / 1e6 : null,
    },
  });
});
