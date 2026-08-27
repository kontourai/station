import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      // Tests that require browser APIs (window, SpeechRecognition, etc.)
      ['src/__tests__/WebSpeech*.test.ts', 'jsdom'],
    ],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});
