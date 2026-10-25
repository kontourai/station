import { versionText } from './commands/version.js';
import {
  commandHelpText,
  didYouMean,
  knownCommands,
  usageText,
} from './help.js';

function failUnknownCommand(
  label: string,
  suggestion = '',
  extra?: string,
): void {
  console.error(`Unknown command: ${label}`);
  if (extra) console.error(extra);
  console.error(`${suggestion}Run \`station --help\` for the command list.`);
  process.exitCode = 1;
}

/**
 * `--help`/`-h` at any depth is a help request, not a positional. Before this,
 * `station agents --help` failed with `Missing action for agents` and
 * `station chat --help` with `Missing required argument: agent`, because the
 * flag fell through to the command's own argument parsing.
 */
function printHelpFor(command: string | undefined): boolean {
  if (command === undefined) {
    console.log(usageText());
    return true;
  }
  const help = commandHelpText(command);
  if (help) {
    console.log(help);
    return true;
  }
  return false;
}

export function runPassiveCli(argv: string[]): boolean {
  const [command, ...args] = argv;
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(versionText().trimEnd());
    return true;
  }

  // Explicit help (`--help`/`-h`, `station help`, `station help --help`) prints
  // usage as a success. Handled before the default launcher so a bare `--help`
  // never lazy-starts.
  if (
    command === '--help' ||
    command === '-h' ||
    (command === 'help' && (args.length === 0 || args[0].startsWith('-')))
  ) {
    console.log(usageText());
    return true;
  }

  // `station help <verb>` and `station <verb> [...] --help` land here, at any
  // depth: a help flag anywhere wins over the command's own parsing.
  if (command === 'help') {
    if (printHelpFor(args[0])) return true;
    failUnknownCommand(args[0], didYouMean(args[0], knownCommands()));
    return true;
  }
  if (
    command !== undefined &&
    (args.includes('--help') || args.includes('-h'))
  ) {
    if (printHelpFor(command)) return true;
  }

  return false;
}
