/**
 * The real shell the PTY process suites type into: `/bin/sh` on POSIX, and
 * cmd.exe (COMSPEC) on Windows, where node-pty hosts it on ConPTY. Each
 * helper returns command text whose typed echo never contains the marker it
 * prints, so waiting for a marker waits for the shell's output, never for the
 * terminal echoing the keystrokes. On POSIX the text is the suites' original
 * `printf` form byte for byte.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const windows = process.platform === 'win32';
export const SHELL = windows ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh';
/** The last character of the shell's idle prompt. */
export const PROMPT = windows ? '>' : '$';

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
