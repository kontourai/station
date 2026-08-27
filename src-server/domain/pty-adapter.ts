export interface IPtyProcess {
  pid: number;
  /**
   * The shell process's current directory at the time of the call. A launch
   * cwd is not a substitute: shells can `cd` after their PTY is opened.
   */
  getCwd?(): Promise<string | null>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): () => void;
  onExit(
    cb: (event: { exitCode: number; signal: number | null }) => void,
  ): () => void;
}

export interface IPtyAdapter {
  spawn(input: {
    shell: string;
    args?: string[];
    cwd: string;
    cols: number;
    rows: number;
    env: NodeJS.ProcessEnv;
  }): Promise<IPtyProcess>;
}
