const DEFAULT_INTERVAL_MS = 30_000;
const MAX_IN_FLIGHT_MODULES = 16;
const MAX_MODULE_LABEL_LENGTH = 240;

function moduleLabel(testModule) {
  return String(
    testModule?.relativeModuleId ?? testModule?.moduleId ?? '<unknown module>',
  )
    .replace(/[\r\n]+/g, ' ')
    .slice(0, MAX_MODULE_LABEL_LENGTH);
}

/**
 * Emits a bounded heartbeat naming every test module that started but has not
 * ended. The interval is unref'd so diagnostics can never keep Vitest alive.
 */
export class VitestInflightReporter {
  constructor({
    intervalMs = DEFAULT_INTERVAL_MS,
    write = (message) => process.stdout.write(message),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.intervalMs = intervalMs;
    this.write = write;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.inFlight = new Map();
    this.timer = null;
  }

  onTestRunStart() {
    this.stopTimer();
    this.timer = this.setIntervalFn(
      () => this.emit('[vitest-progress] in-flight:'),
      this.intervalMs,
    );
    this.timer?.unref?.();
  }

  onTestModuleStart(testModule) {
    const key = String(testModule?.moduleId ?? moduleLabel(testModule));
    this.inFlight.set(key, moduleLabel(testModule));
  }

  onTestModuleEnd(testModule) {
    const key = String(testModule?.moduleId ?? moduleLabel(testModule));
    this.inFlight.delete(key);
  }

  onTestRunEnd() {
    this.stopTimer();
    this.emit('[vitest-progress] final in-flight:');
  }

  emit(prefix) {
    const labels = [...this.inFlight.values()].sort();
    const visible = labels.slice(0, MAX_IN_FLIGHT_MODULES);
    const omitted = labels.length - visible.length;
    const summary = visible.length === 0 ? 'none' : visible.join(', ');
    this.write(
      `${prefix} ${summary}${omitted > 0 ? `, ... +${omitted}` : ''}\n`,
    );
  }

  stopTimer() {
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
  }
}

export default VitestInflightReporter;
