/**
 * A dependency-free interactive single-select, built on Node's own
 * `readline/promises`.
 *
 * Station's published CLI bundle carries only the audited keyring dependency
 * (`packages/cli/src/__tests__/bundle.test.ts`), so the interactive menus the
 * default command and `station service` present must not pull in a prompt
 * library. A numbered list read over `readline` is boring, cross-platform, and
 * adds nothing to the install graph. Callers gate this behind a real TTY; it is
 * never reached in a non-interactive process.
 */
import { createInterface } from 'node:readline/promises';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Presents `options` as a numbered menu and resolves the chosen value, or
 * `null` if the user cancels (empty line, EOF, or an out-of-range entry). The
 * default choice is the first option, selected on a bare Enter.
 */
export async function promptSelect<T extends string>(
  message: string,
  options: SelectOption<T>[],
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<T | null> {
  if (options.length === 0) return null;
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = createInterface({ input, output });
  try {
    output.write(`${message}\n`);
    options.forEach((option, index) => {
      const marker = index === 0 ? ' (default)' : '';
      output.write(`  ${index + 1}) ${option.label}${marker}\n`);
    });
    const answer = (await rl.question(`Select [1-${options.length}]: `)).trim();
    if (answer === '') return options[0].value;
    const index = Number.parseInt(answer, 10);
    if (!Number.isInteger(index) || index < 1 || index > options.length) {
      return null;
    }
    return options[index - 1].value;
  } finally {
    rl.close();
  }
}
