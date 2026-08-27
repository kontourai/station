import { describe, expect, test } from 'vitest';
import { escapeHtml, renderSessionsPanel } from '../panel.mjs';

const SAMPLE = [
  {
    threadId: 'sess-1',
    provider: 'codex',
    status: 'running',
    lifecycleState: 'running',
    projectSlug: 'station',
    assignedAgentSlug: 'builder',
    lastEventAt: '2026-06-28T12:00:00.000Z',
  },
  {
    threadId: 'sess-2',
    provider: 'claude',
    status: 'ready',
    projectSlug: 'survey',
    updatedAt: '2026-06-28T11:00:00.000Z',
  },
];

describe('renderSessionsPanel', () => {
  test('renders a row per session with key fields', () => {
    const html = renderSessionsPanel(SAMPLE);
    expect(html).toContain('sess-1');
    expect(html).toContain('sess-2');
    expect(html).toContain('codex');
    expect(html).toContain('builder');
    expect(html).toContain('station');
    // Falls back to status when lifecycleState is absent (sess-2).
    expect(html).toContain('ready');
    expect(html).toContain('Station sessions');
    expect(html).toContain('(2)');
  });

  test('renders an empty state for no sessions', () => {
    const html = renderSessionsPanel([]);
    expect(html).toContain('No active sessions.');
    expect(html).toContain('(0)');
  });

  test('is tolerant of non-array / missing fields', () => {
    expect(() => renderSessionsPanel(undefined)).not.toThrow();
    expect(renderSessionsPanel(undefined)).toContain('No active sessions.');
    const html = renderSessionsPanel([{ threadId: 'bare' }]);
    expect(html).toContain('bare');
    expect(html).toContain('unknown'); // state fallback
  });

  test('is self-contained: no external scripts, styles, or assets', () => {
    const html = renderSessionsPanel(SAMPLE);
    expect(html).not.toMatch(/<script\b/i); // no scripts at all
    expect(html).not.toMatch(/<link\b/i); // no external stylesheets
    expect(html).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).toMatch(/<style>/); // inline styles only
  });

  test('escapes session fields to prevent HTML injection', () => {
    const html = renderSessionsPanel([
      {
        threadId: '<script>alert(1)</script>',
        provider: '"><img src=x>',
        projectSlug: "a&b'c",
      },
    ]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x&gt;');
    expect(html).toContain('a&amp;b&#39;c');
  });

  test('escapeHtml handles the standard entities', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
