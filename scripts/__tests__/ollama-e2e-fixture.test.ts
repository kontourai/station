import { describe, expect, test } from 'vitest';
import {
  closeFixtureServer,
  startOllamaFixture,
} from '../../tests/helpers/ollama-fixture';

describe('Ollama E2E fixture', () => {
  test('serves both streamed chat and non-streamed scheduled generation', async () => {
    const requests: unknown[] = [];
    const fixture = await startOllamaFixture(
      'fixture-model',
      (body) => requests.push(body),
      'fixture answer',
    );
    try {
      const generated = await fetch(`${fixture.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: fixture.model,
          messages: [{ role: 'user', content: 'scheduled' }],
        }),
      });
      expect(generated.headers.get('content-type')).toBe('application/json');
      await expect(generated.json()).resolves.toMatchObject({
        model: fixture.model,
        choices: [
          {
            message: { role: 'assistant', content: 'fixture answer' },
            finish_reason: 'stop',
          },
        ],
      });

      const streamed = await fetch(`${fixture.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: fixture.model,
          messages: [{ role: 'user', content: 'interactive' }],
          stream: true,
        }),
      });
      expect(streamed.headers.get('content-type')).toBe('text/event-stream');
      await expect(streamed.text()).resolves.toContain('data: [DONE]');
      expect(requests).toEqual([
        expect.objectContaining({ messages: [expect.any(Object)] }),
        expect.objectContaining({ stream: true }),
      ]);
    } finally {
      await closeFixtureServer(fixture.server);
    }
  });
});
