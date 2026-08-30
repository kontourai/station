/**
 * @vitest-environment jsdom
 *
 * WebSpeechSTTProvider — unit tests for the state machine and error recovery.
 *
 * SpeechRecognition is mocked as a controllable event emitter so tests can
 * drive state transitions without real microphone access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- SpeechRecognition mock ------------------------------------------------
type RecognitionHandler = ((e?: any) => void) | null;

interface MockRec {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: RecognitionHandler;
  onresult: RecognitionHandler;
  onerror: RecognitionHandler;
  onend: RecognitionHandler;
  start: () => void;
  stop: () => void;
  abort: () => void;
  // Test helpers
  _fireStart(): void;
  _fireResult(transcript: string): void;
  _fireError(): void;
  _fireEnd(): void;
}

function makeMockRec(): MockRec {
  const rec: MockRec = {
    continuous: false,
    interimResults: false,
    lang: '',
    onstart: null,
    onresult: null,
    onerror: null,
    onend: null,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    _fireStart() {
      rec.onstart?.();
    },
    _fireResult(transcript: string) {
      rec.onresult?.({
        results: [{ 0: { transcript }, length: 1 }],
      });
    },
    _fireError() {
      rec.onerror?.();
    },
    _fireEnd() {
      rec.onend?.();
    },
  };
  return rec;
}

// ---- Test setup ------------------------------------------------------------

// We import the provider fresh in each test by resetting the module registry
// so the singleton doesn't bleed state between tests.

let lastRec: MockRec | null = null;
const SpeechRecognitionMock = vi.fn(function MockSpeechRecognition() {
  lastRec = makeMockRec();
  return lastRec;
});

beforeEach(() => {
  vi.useFakeTimers();
  lastRec = null;
  (globalThis as any).window = { SpeechRecognition: SpeechRecognitionMock };
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [] })),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).window;
});

// Import AFTER setting up window so isSupported is computed correctly
async function getProvider() {
  // Force re-import to get a clean singleton per test.
  // With vitest we use vi.resetModules + dynamic import.
  vi.resetModules();
  const mod = await import('../providers/voice/WebSpeechSTTProvider');
  return mod.webSpeechSTTProvider;
}

async function startProvider(p: Awaited<ReturnType<typeof getProvider>>) {
  p.startListening();
  await Promise.resolve();
}

// ---- Tests -----------------------------------------------------------------

describe('WebSpeechSTTProvider', () => {
  describe('initial state', () => {
    it('starts idle with empty transcript', async () => {
      const p = await getProvider();
      expect(p.state).toBe('idle');
      expect(p.transcript).toBe('');
    });

    it('isSupported when SpeechRecognition exists on window', async () => {
      const p = await getProvider();
      expect(p.isSupported).toBe(true);
    });

    it('is unsupported up front when microphone capture is unavailable', async () => {
      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: undefined,
      });
      const p = await getProvider();

      expect(p.isSupported).toBe(false);
      expect(p.unsupportedReason).toContain('Microphone capture');
      await startProvider(p);
      expect(lastRec).toBeNull();
    });
  });

  describe('startListening → listening', () => {
    it('transitions to listening when recognition fires onstart', async () => {
      const p = await getProvider();
      const listener = vi.fn();
      p.subscribe(listener);

      await startProvider(p);
      lastRec!._fireStart();

      expect(p.state).toBe('listening');
      expect(listener).toHaveBeenCalled();
    });

    it('accumulates transcript from onresult events', async () => {
      const p = await getProvider();
      await startProvider(p);
      lastRec!._fireStart();
      lastRec!._fireResult('hello world');

      expect(p.transcript).toBe('hello world');
    });

    it('transitions to idle when recognition ends normally', async () => {
      const p = await getProvider();
      await startProvider(p);
      lastRec!._fireStart();
      lastRec!._fireEnd();

      expect(p.state).toBe('idle');
    });
  });

  describe('error state and recovery', () => {
    it('publishes a visible permission error when capture is denied at click time', async () => {
      Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: vi.fn(() =>
            Promise.reject(
              new DOMException('Permission denied', 'NotAllowedError'),
            ),
          ),
        },
      });
      const p = await getProvider();

      await startProvider(p);
      await Promise.resolve();
      await Promise.resolve();

      expect(p.state).toBe('error');
      expect(p.errorMessage).toContain('permission was denied');
      expect(lastRec).toBeNull();
    });

    it('transitions to error on onerror', async () => {
      const p = await getProvider();
      await startProvider(p);
      lastRec!._fireStart();
      lastRec!._fireError();

      expect(p.state).toBe('error');
    });

    it('auto-recovers to idle after ERROR_RESET_MS', async () => {
      const p = await getProvider();
      await startProvider(p);
      lastRec!._fireStart();
      lastRec!._fireError();

      expect(p.state).toBe('error');
      vi.advanceTimersByTime(1500);
      expect(p.state).toBe('idle');
    });

    it('does not override error state when recognition fires onend', async () => {
      const p = await getProvider();
      await startProvider(p);
      lastRec!._fireStart();
      lastRec!._fireError();
      // onend fires after onerror in some browsers
      lastRec!._fireEnd();

      expect(p.state).toBe('error'); // error state preserved
    });

    it('clears error timer when startListening is called again', async () => {
      const p = await getProvider();
      await startProvider(p);
      lastRec!._fireStart();
      lastRec!._fireError();

      // Start listening again — timer must be cleared
      await startProvider(p);
      lastRec!._fireStart();

      vi.advanceTimersByTime(1500);
      // Should still be listening (new session), not idled by old timer
      expect(p.state).toBe('listening');
    });
  });

  describe('stopListening', () => {
    it('calls stop on the recognition instance', async () => {
      const p = await getProvider();
      await startProvider(p);
      const rec = lastRec!;
      p.stopListening();

      expect(rec.stop).toHaveBeenCalled();
    });

    it('clears error timer when stopped', async () => {
      const p = await getProvider();
      await startProvider(p);
      lastRec!._fireStart();
      lastRec!._fireError();

      p.stopListening();
      vi.advanceTimersByTime(1500);
      // Timer was cleared — state stays error (not reset to idle)
      expect(p.state).toBe('error');
    });
  });

  describe('destroy', () => {
    it('aborts the recognition instance', async () => {
      const p = await getProvider();
      await startProvider(p);
      const rec = lastRec!;
      p.destroy();

      expect(rec.abort).toHaveBeenCalled();
    });

    it('clears subscribers so destroy does not cause further notifications', async () => {
      const p = await getProvider();
      const listener = vi.fn();
      p.subscribe(listener);
      listener.mockClear();

      p.destroy();
      // No notifications after destroy
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
