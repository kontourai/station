/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
  delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown })
    .SpeechSynthesisUtterance;
});

async function getProvider() {
  vi.resetModules();
  return (await import('../providers/voice/WebSpeechTTSProvider'))
    .webSpeechTTSProvider;
}

describe('WebSpeechTTSProvider', () => {
  it('preserves direct speak and cancel provider behavior', async () => {
    const cancel = vi.fn();
    const speak = vi.fn();
    (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
      cancel,
      speak,
    };
    class FakeUtterance {
      lang = '';
      rate = 1;
      pitch = 1;
      volume = 1;
      onstart: ((event: Event) => void) | null = null;
      onend: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(readonly text: string) {}
    }
    (
      globalThis as unknown as { SpeechSynthesisUtterance: unknown }
    ).SpeechSynthesisUtterance = FakeUtterance;
    const provider = await getProvider();
    const listener = vi.fn();
    provider.subscribe(listener);

    provider.speak('read this', { rate: 1.2 });
    const utterance = speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    utterance.onstart?.({} as SpeechSynthesisEvent);
    expect(provider.speaking).toBe(true);

    provider.cancel();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(provider.speaking).toBe(false);
    expect(listener).toHaveBeenCalled();
  });
});
