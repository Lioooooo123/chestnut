import type { WorkerAdapter, WorkerEventHandler, WorkerInput } from './types.ts';
/** Demonstration only: deterministic timers, no tool execution, shell, or network. */
export class FakeAdapter implements WorkerAdapter {
  private onEvent: WorkerEventHandler = () => {};
  private timer?: ReturnType<typeof setTimeout>;
  private resolve?: () => void;
  private started = false;
  private cancelled = false;
  private readonly delayMs: number;
  constructor(options: { delayMs?: number } = {}) { this.delayMs = options.delayMs ?? 300; }
  async start(input: WorkerInput, onEvent: WorkerEventHandler): Promise<void> {
    if (this.started) throw new Error('An adapter instance accepts exactly one run');
    this.started = true; this.onEvent = onEvent;
    onEvent({ type: 'response', data: { type: 'response', id: input.runId, command: 'prompt', success: true, data: { disposition: 'started' } } });
    onEvent({ type: 'agent_start', data: { demo: true } });
    await new Promise<void>(resolve => {
      this.resolve = resolve;
      this.timer = setTimeout(() => {
        const text = `Demo result: ${input.prompt}`;
        onEvent({ type: 'message_update', data: { assistantMessageEvent: { type: 'text_delta', delta: text } } });
        onEvent({ type: 'message_end', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });
        onEvent({ type: 'agent_end', data: { demo: true } });
        onEvent({ type: 'agent_settled', data: { aborted: false, demo: true } });
        this.resolve = undefined; resolve();
      }, this.delayMs);
    });
  }
  async steer(messageId: string, text: string): Promise<void> {
    if (!this.resolve || this.cancelled) throw new Error('Run is not accepting steering');
    this.onEvent({ type: 'response', data: { type: 'response', id: messageId, command: 'steer', success: true, data: { disposition: 'queued' } } });
    this.onEvent({ type: 'queue_update', data: { steering: [text], followUp: [], demo: true } });
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.resolve) {
      this.onEvent({ type: 'agent_settled', data: { aborted: true, demo: true } });
      this.resolve(); this.resolve = undefined;
    }
  }
  async dispose(): Promise<void> { await this.cancel(); }
}
