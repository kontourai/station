import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const execFile = childProcess.execFile;
childProcess.execFile = (command, args, ...options) => {
  if (command === '/usr/bin/systemctl' && args.includes('--version'))
    return execFile('/bin/echo', ['systemd 249'], ...options);
  return execFile(command, args, ...options);
};
syncBuiltinESMExports();
