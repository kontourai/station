export type WindowsSystemUtility =
  | 'cmd'
  | 'powershell'
  | 'schtasks'
  | 'taskkill'
  | 'whoami';
export function windowsSystemUtilityPath(
  utility: WindowsSystemUtility,
  env?: NodeJS.ProcessEnv,
): string;
export function windowsPowerShell7Path(
  env?: NodeJS.ProcessEnv,
  fileExists?: (path: string) => boolean,
): string;
