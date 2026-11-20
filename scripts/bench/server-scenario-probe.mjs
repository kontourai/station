import { subscribe } from 'node:diagnostics_channel';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Loaded before the real server bundle. IPC keeps measurement traffic off HTTP.
const resolutionMs = 1;
const delay = monitorEventLoopDelay({ resolution: resolutionMs });
delay.enable();
let started = performance.now();
let cpu = process.cpuUsage();
let requests = 0;
let pending;
subscribe('http.server.request.start', () => {
  requests += 1;
});

function clearPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = undefined;
}

function reply(id, result, deadline) {
  if (!process.connected) return;
  if (deadline !== undefined && performance.now() >= deadline) {
    result = { error: 'probe local sampling budget expired' };
  }
  const onSendError = () => {
    if (!process.connected) {
      clearPending();
      delay.disable();
    } else if (pending?.id === id) {
      clearPending();
    }
  };
  try {
    process.send({ type: 'server-scenario-probe', id, ...result }, (error) => {
      if (error) onSendError();
    });
  } catch {
    onSendError();
  }
}

process.on('message', (message) => {
  if (message?.type !== 'server-scenario-probe') return;
  if (message.action === 'cancel') {
    if (pending?.id === message.id) clearPending();
    return;
  }
  if (pending) {
    reply(message.id, { error: 'probe request overlaps a pending operation' });
    return;
  }
  if (
    !['reset', 'sample'].includes(message.action) ||
    !Number.isFinite(message.remainingBudgetMs) ||
    message.remainingBudgetMs <= 0 ||
    message.remainingBudgetMs > 30_000
  ) {
    reply(message.id, { error: 'invalid probe budget or action' });
    return;
  }
  const deadline = performance.now() + message.remainingBudgetMs;
  const resetting = message.action === 'reset';
  if (resetting) {
    delay.reset();
    started = performance.now();
    cpu = process.cpuUsage();
    requests = 0;
  }
  const sampleRequested = performance.now();
  const samplesAtRequest = delay.count;
  pending = { id: message.id, timer: undefined };
  const observe = () => {
    if (!process.connected) {
      clearPending();
      return;
    }
    if (performance.now() >= deadline) {
      clearPending();
      reply(message.id, {
        error: 'probe deadline expired before observation delivery',
      });
      return;
    }
    if (delay.count === 0 || (!resetting && delay.count <= samplesAtRequest)) {
      pending.timer = setTimeout(
        observe,
        Math.max(1, Math.min(resolutionMs, deadline - performance.now())),
      );
      return;
    }
    if (resetting) {
      clearPending();
      reply(message.id, { reset: true }, deadline);
      return;
    }
    const usage = process.cpuUsage(cpu);
    const elapsedMs = performance.now() - started;
    const settlementMs = performance.now() - sampleRequested;
    const sample = {
      elapsedMs,
      cpuMs: (usage.user + usage.system) / 1000,
      requests,
      rssBytes: process.memoryUsage().rss,
      sampleSettlementMs: settlementMs,
      eventLoopDelayMs: {
        samples: delay.count,
        p50: delay.percentile(50) / 1e6,
        p99: delay.percentile(99) / 1e6,
        max: delay.max / 1e6,
      },
    };
    clearPending();
    reply(message.id, sample, deadline);
  };
  observe();
});
process.once('disconnect', () => {
  clearPending();
  delay.disable();
});
process.once('exit', () => {
  clearPending();
  delay.disable();
});
