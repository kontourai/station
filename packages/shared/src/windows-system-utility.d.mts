export type WindowsSystemUtility = 'cmd' | 'powershell' | 'schtasks' | 'whoami';
export function windowsSystemUtilityPath(
  utility: WindowsSystemUtility,
  env?: NodeJS.ProcessEnv,
): string;
