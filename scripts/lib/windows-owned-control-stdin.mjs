/** Owns the guard's private control stdin so a late EPIPE cannot escape. */
export function createWindowsOwnedControlStdin(stdin) {
  let closed = !stdin;
  const markClosed = () => {
    closed = true;
  };
  const markWriteFailure = (error) => {
    if (error) markClosed();
  };
  stdin?.on?.('error', markClosed);
  stdin?.on?.('close', markClosed);
  stdin?.on?.('finish', markClosed);

  const writable = () => !closed && !stdin?.destroyed && !stdin?.writableEnded;

  return {
    write(record) {
      if (!writable()) return false;
      try {
        stdin.write(`${record}\n`, markWriteFailure);
        return true;
      } catch {
        markClosed();
        return false;
      }
    },
    end() {
      if (!writable()) return false;
      try {
        stdin.end(markClosed);
        return true;
      } catch {
        markClosed();
        return false;
      }
    },
    writeAndEnd(record) {
      const wrote = this.write(record);
      const ended = this.end();
      return wrote && ended;
    },
  };
}
