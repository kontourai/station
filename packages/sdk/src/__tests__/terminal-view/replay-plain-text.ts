/**
 * Replays terminal output through Station's Ghostty engine and prints the
 * plain text a person sees: scrollback and screen, as the accessibility
 * mirror reads them. Server process tests run it as a child, because the
 * server program has no WebAssembly types. It sits outside `fixtures/` so the
 * path-read pin scanner resolves the suites that launch it:
 *
 *   node --import tsx <this file> <cols> <rows>   (output on stdin)
 *   node --import tsx <this file> <cols> <rows> --records
 *     (a JSON array of journal records on stdin)
 *
 * With `--records`, a record with `resize` (#4625) sets the size the output
 * after it is parsed at, as the terminal view does while it replays, and the
 * engine returns to `<cols> <rows>` at the end.
 *
 * Prints `{"text": "..."}` on stdout.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TerminalEngine } from '../../terminal-view/engine/terminal-engine';
import { GhosttyVtModule } from '../../terminal-view/engine/wasm';

const [cols, rows] = process.argv.slice(2, 4).map(Number);
const records = process.argv.includes('--records');
if (!Number.isInteger(cols) || !Number.isInteger(rows))
  throw new Error(
    'usage: replay-plain-text <cols> <rows> [--records] < output',
  );

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = Buffer.concat(chunks);

const module = await WebAssembly.compile(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../terminal-view/vendor/ghostty-vt/ghostty-vt.wasm',
        import.meta.url,
      ),
    ),
  ),
);
const box = { cols: cols!, rows: rows!, cellWidth: 8, cellHeight: 16 };
const engine = new TerminalEngine(
  await GhosttyVtModule.instantiate(module),
  box,
  {
    reply: () => {},
    bell: () => {},
    title: () => {},
  },
);
try {
  if (records) {
    const journal = JSON.parse(input.toString('utf8')) as {
      data: string;
      resize?: { cols: number; rows: number };
    }[];
    for (const record of journal)
      if (record.resize) engine.resize({ ...box, ...record.resize });
      else engine.write(new TextEncoder().encode(record.data), 'replay');
    engine.resize(box);
  } else engine.write(new Uint8Array(input), 'replay');
  process.stdout.write(JSON.stringify({ text: engine.plainText() }));
} finally {
  engine.dispose();
}
