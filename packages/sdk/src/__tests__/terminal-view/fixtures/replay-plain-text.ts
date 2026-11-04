/**
 * Replays terminal output through Station's Ghostty engine and prints the
 * plain text a person sees: scrollback and screen, as the accessibility
 * mirror reads them. Server process tests run it as a child, because the
 * server program has no WebAssembly types:
 *
 *   node --import tsx <this file> <cols> <rows>   (output on stdin)
 *
 * Prints `{"text": "..."}` on stdout.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TerminalEngine } from '../../../terminal-view/engine/terminal-engine';
import { GhosttyVtModule } from '../../../terminal-view/engine/wasm';

const [cols, rows] = process.argv.slice(2).map(Number);
if (!Number.isInteger(cols) || !Number.isInteger(rows))
  throw new Error('usage: replay-plain-text <cols> <rows> < output');

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

const module = await WebAssembly.compile(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../terminal-view/vendor/ghostty-vt/ghostty-vt.wasm',
        import.meta.url,
      ),
    ),
  ),
);
const engine = new TerminalEngine(
  await GhosttyVtModule.instantiate(module),
  { cols: cols!, rows: rows!, cellWidth: 8, cellHeight: 16 },
  { reply: () => {}, bell: () => {}, title: () => {} },
);
try {
  engine.write(new Uint8Array(Buffer.concat(chunks)), 'replay');
  process.stdout.write(JSON.stringify({ text: engine.plainText() }));
} finally {
  engine.dispose();
}
