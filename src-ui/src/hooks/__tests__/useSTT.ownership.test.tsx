// @vitest-environment jsdom
/**
 * One dictation provider serves every composer on screen. The composer that
 * started listening is the one its transcript belongs to: a start composer's
 * dictation must not also land in the open chat's draft (and the reverse).
 */
import type { STTProvider, STTState } from '@kontourai/station-sdk';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type UseSTTResult, useSTT } from '../useSTT';

class FakeSTT implements STTProvider {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly isSupported = true;
  state: STTState = 'idle';
  transcript = '';
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private emit() {
    for (const fn of this.listeners) fn();
  }
  startListening() {
    this.state = 'listening';
    this.transcript = '';
    this.emit();
  }
  stopListening() {
    this.state = 'idle';
    this.emit();
  }
  /** A finished utterance, as a provider reports it. */
  finish(text: string) {
    this.transcript = text;
    this.state = 'idle';
    this.emit();
  }
}

const provider = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../contexts/VoiceProviderContext', () => ({
  useVoiceProviderContext: () => ({ activeSTT: provider.current }),
  useOptionalVoiceProviderContext: () => ({ activeSTT: provider.current }),
}));

afterEach(cleanup);

function renderTwoComposers() {
  const seen: Record<'start' | 'chat', UseSTTResult | null> = {
    start: null,
    chat: null,
  };
  function Probe({ name }: { name: 'start' | 'chat' }) {
    seen[name] = useSTT();
    return null;
  }
  render(
    <>
      <Probe name="start" />
      <Probe name="chat" />
    </>,
  );
  return seen;
}

describe('useSTT dictation ownership', () => {
  // Ownership is module state for the app's life, so this runs first.
  test('before anyone starts listening every composer reads the provider', () => {
    const stt = new FakeSTT();
    provider.current = stt;
    stt.state = 'error';
    const seen = renderTwoComposers();
    expect(seen.start!.state).toBe('error');
    expect(seen.chat!.state).toBe('error');
  });

  test('the transcript goes only to the composer that started listening', () => {
    const stt = new FakeSTT();
    provider.current = stt;
    const seen = renderTwoComposers();

    act(() => seen.start!.startListening());
    expect(seen.start!.state).toBe('listening');
    expect(seen.chat!.state).toBe('idle');

    act(() => stt.finish('fix the build'));
    expect(seen.start!.transcript).toBe('fix the build');
    expect(seen.chat!.transcript).toBe('');

    // The other composer takes the mic: now it alone hears.
    act(() => seen.chat!.startListening());
    act(() => stt.finish('and the tests'));
    expect(seen.chat!.transcript).toBe('and the tests');
    expect(seen.start!.transcript).toBe('');
  });

  test('a composer that closes takes its dictation with it', () => {
    const stt = new FakeSTT();
    provider.current = stt;
    const stop = vi.spyOn(stt, 'stopListening');
    const seen: Record<'start' | 'chat', UseSTTResult | null> = {
      start: null,
      chat: null,
    };
    function Probe({ name }: { name: 'start' | 'chat' }) {
      seen[name] = useSTT();
      return null;
    }
    const view = render(
      <>
        <Probe key="start" name="start" />
        <Probe key="chat" name="chat" />
      </>,
    );
    // Dictated into the start composer, which then closes (Start pressed).
    act(() => seen.start!.startListening());
    act(() => stt.finish('fix the build'));
    view.rerender(
      <>
        <Probe key="chat" name="chat" />
      </>,
    );
    expect(seen.chat!.transcript).toBe('');
    expect(seen.chat!.state).toBe('idle');

    // One that closes mid-dictation stops the mic rather than leaving it
    // running for whichever composer is still on screen.
    act(() => seen.chat!.startListening());
    view.rerender(<></>);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
