import { describe, expect, test } from 'vitest';
import {
  ENUMERATING_OPENAI_COMPAT_HOSTS,
  openAICompatCatalogSemantics,
} from '../openai-compat-catalog-semantics';

/*
 * station#3653 delta review HIGH-1. The exception that lets a configured
 * selector stand in for a missing enumeration belongs to endpoints Station
 * has no catalogue knowledge of — not to the OpenAI-compatible adapter as a
 * class, which serves api.openai.com and a localhost llama.cpp alike.
 */
describe('openAICompatCatalogSemantics', () => {
  test('a known cloud service enumerates authoritatively', () => {
    for (const host of ENUMERATING_OPENAI_COMPAT_HOSTS) {
      expect(openAICompatCatalogSemantics(`https://${host}/v1`)).toBe(
        'no-models',
      );
    }
  });

  test('vendor path shapes do not change the answer', () => {
    expect(openAICompatCatalogSemantics('https://api.groq.com/openai/v1')).toBe(
      'no-models',
    );
    expect(
      openAICompatCatalogSemantics('https://api.fireworks.ai/inference/v1'),
    ).toBe('no-models');
  });

  test('a self-hosted or unknown endpoint carries no catalogue statement', () => {
    expect(openAICompatCatalogSemantics('http://localhost:1234/v1')).toBe(
      'no-catalog',
    );
    expect(openAICompatCatalogSemantics('http://127.0.0.1:4601/v1')).toBe(
      'no-catalog',
    );
    expect(
      openAICompatCatalogSemantics('https://llm.internal.example/v1'),
    ).toBe('no-catalog');
  });

  test('a host that merely CONTAINS a known one is not that service', () => {
    // The check is on the parsed host, so neither a lookalike domain nor a
    // path segment can borrow another service's catalogue guarantee.
    expect(
      openAICompatCatalogSemantics('https://api.openai.com.evil.example/v1'),
    ).toBe('no-catalog');
    expect(
      openAICompatCatalogSemantics('https://proxy.example/api.openai.com/v1'),
    ).toBe('no-catalog');
  });

  /*
   * Delta2 review MEDIUM-1: the classifier compared `URL.hostname` alone, so
   * a nonstandard port, plain HTTP, or embedded credentials all inherited the
   * cloud endpoint's catalogue guarantee. None of them is the endpoint this
   * list vouches for.
   */
  test('a nonstandard port is a different endpoint', () => {
    expect(openAICompatCatalogSemantics('https://api.openai.com:8443/v1')).toBe(
      'no-catalog',
    );
    expect(
      openAICompatCatalogSemantics('https://api.groq.com:9000/openai/v1'),
    ).toBe('no-catalog');
    // The default port, written explicitly, IS the same origin.
    expect(openAICompatCatalogSemantics('https://api.openai.com:443/v1')).toBe(
      'no-models',
    );
  });

  test('plain HTTP to a cloud API is not that API', () => {
    expect(openAICompatCatalogSemantics('http://api.openai.com/v1')).toBe(
      'no-catalog',
    );
  });

  test('embedded credentials disqualify the endpoint', () => {
    expect(openAICompatCatalogSemantics('https://user@api.openai.com/v1')).toBe(
      'no-catalog',
    );
    expect(
      openAICompatCatalogSemantics('https://user:pass@api.openai.com/v1'),
    ).toBe('no-catalog');
  });

  test('an absent or unparseable base URL is unknown, not authoritative', () => {
    expect(openAICompatCatalogSemantics(undefined)).toBe('no-catalog');
    expect(openAICompatCatalogSemantics('')).toBe('no-catalog');
    expect(openAICompatCatalogSemantics('not a url')).toBe('no-catalog');
  });
});
