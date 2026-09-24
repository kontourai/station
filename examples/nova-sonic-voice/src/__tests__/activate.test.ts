/**
 * The plugin host calls a bundle's `activate({ apiBase })` and keeps the
 * disposer it returns (#2401). This bundle used to register at import time
 * from an undeclared `station` global instead.
 */
import { voiceRegistry } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import { activate } from '../index';

describe('nova-sonic-voice activate', () => {
  test('registers STT and TTS on activate, and removes both on dispose', () => {
    expect(voiceRegistry.getSTT('nova-sonic')).toBeUndefined();

    const dispose = activate({ apiBase: 'https://station.test' });
    expect(voiceRegistry.getSTT('nova-sonic')?.name).toBe('Nova Sonic');
    expect(voiceRegistry.getTTS('nova-sonic')?.name).toBe('Nova Sonic');

    dispose();
    expect(voiceRegistry.getSTT('nova-sonic')).toBeUndefined();
    expect(voiceRegistry.getTTS('nova-sonic')).toBeUndefined();
  });
});
