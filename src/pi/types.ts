/** Outer-worker contract. ACKs are events; only agent_settled completes a run. */
export interface WorkerInput {
  botId: string;
  taskId: string;
  runId: string;
  prompt: string;
  workspace: string;
  sessionPath: string;
}
export interface WorkerEvent { type: string; data?: unknown }
export type WorkerEventHandler = (event: WorkerEvent) => void;
export interface WorkerAdapter {
  start(input: WorkerInput, onEvent: WorkerEventHandler): Promise<void>;
  steer(messageId: string, text: string): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
export interface RpcTransport {
  write(line: string): Promise<void>;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (error?: Error) => void): void;
  stop(): Promise<void>;
}
export interface SandboxBackend { launch(input: WorkerInput): Promise<RpcTransport> }
export class CommandUncertainError extends Error {
  readonly commandId: string;
  constructor(commandId: string, message: string) {
    super(message); this.name = 'CommandUncertainError'; this.commandId = commandId;
  }
}
