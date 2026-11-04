import {
  downloadMediaTools,
  getMediaToolsStatus,
  type MediaToolsStatus,
} from '@kontourai/station-sdk/client';
import {
  configureApiCredential,
  parseCoreArgs,
  resolveApiBaseDetailed,
} from './core-api.js';

const USAGE =
  'Usage: station media-tools status | station media-tools download --yes [--json]';
function printStatus(status: MediaToolsStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  for (const c of status.components)
    console.log(
      `${c.component} ${c.version}: ${c.resolution.status}${c.resolution.status === 'ready' ? ` (${c.resolution.origin})` : ''}; ${c.bytes} download bytes${c.progress ? `; ${c.progress.receivedBytes}/${c.progress.totalBytes} bytes received` : ''}${c.failure ? `; FAILED: ${c.failure}` : ''}`,
    );
}
export async function runMediaToolsCommand(args: string[]): Promise<void> {
  const parsed = parseCoreArgs(args);
  const [action, ...extra] = parsed.positionals;
  const flags = Object.keys(parsed.flags);
  if (
    !['status', 'download'].includes(action ?? '') ||
    extra.length ||
    flags.some(
      (flag) =>
        !['yes', 'json', 'api-base', 'credential', 'station'].includes(flag),
    ) ||
    ['yes', 'json'].some(
      (flag) => parsed.flags[flag] !== undefined && parsed.flags[flag] !== true,
    ) ||
    (action === 'status' && parsed.flags.yes !== undefined)
  )
    throw new Error(USAGE);
  // Refuse before credential resolution or any network I/O.
  if (action === 'download' && parsed.flags.yes !== true)
    throw new Error(
      'Downloading media tools requires explicit consent. Pass --yes.',
    );
  const { apiBase } = resolveApiBaseDetailed(parsed);
  configureApiCredential(parsed, apiBase);
  const status =
    action === 'download'
      ? await downloadMediaTools(apiBase, { consent: true })
      : await getMediaToolsStatus(apiBase);
  printStatus(status, parsed.flags.json === true);
  if (action === 'download' && parsed.flags.json !== true)
    console.log(
      'Download request accepted. Run station media-tools status to read progress and any failure.',
    );
}
