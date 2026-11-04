export interface ITerminalHistoryStore {
  load(sessionId: string): Promise<string>;
  save(sessionId: string, history: string, projectId?: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
