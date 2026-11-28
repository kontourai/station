export type TaskSettingName =
  | 'Priority'
  | 'ExecutionTimeLimit'
  | 'RestartCount'
  | 'RestartInterval'
  | 'DisallowStartIfOnBatteries'
  | 'StopIfGoingOnBatteries';
export type TaskSettings = Record<TaskSettingName, string>;

export function schtasksDefaultSettings(): TaskSettings {
  return {
    Priority: '7',
    ExecutionTimeLimit: 'PT72H',
    RestartCount: '0',
    RestartInterval: '',
    DisallowStartIfOnBatteries: 'True',
    StopIfGoingOnBatteries: 'True',
  };
}

export function formatTaskSettings(settings: TaskSettings): string {
  return `Priority=${settings.Priority}, ExecutionTimeLimit=${settings.ExecutionTimeLimit}, RestartCount=${settings.RestartCount}, RestartInterval=${settings.RestartInterval}, DisallowStartIfOnBatteries=${settings.DisallowStartIfOnBatteries}, StopIfGoingOnBatteries=${settings.StopIfGoingOnBatteries}`;
}
