import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

export function registerHtmlReplyTools(registry: StationControlToolRegistry) {
  const shape = {
    html: z
      .string()
      .max(256 * 1024)
      .describe(
        'Self-contained HTML. Inline scripts run only in an isolated sandbox; CSP blocks ordinary network loads; In the published viewer, WebRTC isolation is incomplete for nested srcdoc frames. Never ask viewers for secrets. Use --background, --foreground, --accent, --chart-1..6 theme variables. Quoted absolute PNG/JPEG/GIF/WebP paths within this session workspace are embedded.',
      ),
    height: z.number().int().min(100).max(2000).default(500),
  };
  registry.tool(
    'html_render',
    'Publish a self-contained visual reply inline in this conversation. Call html_preview first to inspect it. The page is retained with its publishing session and deleted with that conversation lineage. Returns a small page reference; do not repeat its HTML in prose.',
    shape,
    async (args) =>
      jsonToolResult(
        await api('/api/html-replies/render', {
          method: 'POST',
          body: JSON.stringify(args),
        }),
      ),
  );
  registry.tool(
    'html_preview',
    'Render HTML in a disposable headless Chromium using the same isolated page document. Returns a PNG, contentHeight and console output. Rejects oversized input/output, excessive content height, concurrency above two and previews exceeding 15 seconds. Does not publish or retain the page.',
    {
      ...shape,
      width: z.number().int().min(320).max(1920).default(1024),
      theme: z.enum(['light', 'dark']).default('dark'),
    },
    async (args) => {
      const result = await api('/api/html-replies/preview', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      if (result?.success !== true) return jsonToolResult(result);
      const { png, ...metadata } = result.data;
      return {
        content: [
          { type: 'image' as const, data: png, mimeType: 'image/png' },
          { type: 'text' as const, text: JSON.stringify(metadata) },
        ],
      };
    },
  );
}
