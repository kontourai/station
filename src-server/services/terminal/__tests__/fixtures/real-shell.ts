/**
 * The real shell the PTY process suites type into: `/bin/sh` on POSIX, and
 * cmd.exe (COMSPEC) on Windows, where node-pty hosts it on ConPTY. Each
 * helper returns command text whose typed echo never contains the marker it
 * prints, so waiting for a marker waits for the shell's output, never for the
 * terminal echoing the keystrokes. On POSIX the text is the suites' original
 * `printf` form byte for byte.
 */
import { writeFile } from 'node:fs/promises';
// TEMPORARY (#3994): hosted Windows floor worker breadcrumbs.
import './floor-diagnostics.js';
import { join } from 'node:path';

export const windows = process.platform === 'win32';
export const SHELL = windows ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh';
/** The last character of the shell's idle prompt. */
export const PROMPT = windows ? '>' : '$';

/**
 * ECMA-48 control functions: CSI, OSC (ended by BEL or ST), DCS, SOS, PM and
 * APC strings, two-byte escapes, their 8-bit C1 forms, and C0 controls other
 * than tab, line feed and carriage return.
 */
const CONTROL_FUNCTIONS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control functions is exactly the job.
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c)|\x1b[ -/]*[0-~]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Output with its control functions removed: the characters it prints. */
export function visibleText(data: string): string {
  return data.replace(CONTROL_FUNCTIONS, '');
}

/**
 * What a marker check reads. ConPTY renders rather than passes bytes through:
 * between two characters of one printed word it may write a title update or
 * a cursor show (\`http-l\` ESC ]0;… BEL ESC [?25h \`inks:done\`), depending on
 * when it paints a frame. On Windows a check of printed text therefore reads
 * the characters printed; a POSIX PTY's bytes are read as they are.
 */
export function shown(data: string): string {
  return windows ? visibleText(data) : data;
}

/** Prints `left` and `right` joined on one line. */
export function print(left: string, right: string): string {
  // cmd's caret escapes the next character: the echo shows `left^right`.
  return windows
    ? `echo ${left}^${right}`
    : `printf '%s%s\\n' '${left}' '${right}'`;
}

/** Prints `prefix` followed by the shell's working directory. */
export function printCwd(prefix: string): string {
  return windows
    ? `echo ${prefix}%CD%`
    : `printf '%s%s\\n' '${prefix}' "$(pwd)"`;
}

/** One typed line running each command in turn, then Enter. */
export function line(...commands: string[]): string {
  return `${commands.join(windows ? ' & ' : '; ')}\r`;
}

/** Prints a file's content. */
export function cat(file: string): string {
  return `${windows ? 'type' : 'cat'} ${file}`;
}

/** A program that runs `script` in the shell, without a PTY. */
export function runScript(script: string): { file: string; args: string[] } {
  return windows
    ? { file: SHELL, args: ['/d', '/s', '/c', script] }
    : { file: '/bin/sh', args: ['-c', script] };
}

/**
 * Writes a Node program into `directory` and returns the command that runs
 * it: how a Windows test produces output cmd.exe cannot (a timed loop, an
 * exact byte count) without depending on `printf` or `sleep`.
 */
export async function nodeProgram(
  directory: string,
  name: string,
  source: string,
): Promise<string> {
  await writeFile(join(directory, name), source);
  return `"${process.execPath}" ${name}`;
}
