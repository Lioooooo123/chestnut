import { randomUUID } from 'node:crypto';
import { CommandUncertainError } from './types.ts';
import type { RpcTransport, SandboxBackend, WorkerAdapter, WorkerEventHandler, WorkerInput } from './types.ts';

interface PendingCommand {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
/** Pinned Pi JSONL protocol. Never replays a prompt or steering command. */
export class PiRpcAdapter implements WorkerAdapter {
  private readonly backend: SandboxBackend;
  private readonly ackTimeoutMs: number;
  private readonly beforePrompt?: () => void;
  private readonly beforeSteer?: () => void;
  private transport?: RpcTransport;
  private pending = new Map<string, PendingCommand>();
  private sentIds = new Set<string>();
  private onEvent: WorkerEventHandler = () => {};
  private resolveRun?: () => void;
  private rejectRun?: (error: Error) => void;
  private cancelled = false;
  private started = false;
  private closed = false;
  private cancelPromise?: Promise<void>;
  constructor(backend: SandboxBackend, options: { ackTimeoutMs?: number; beforePrompt?: () => void; beforeSteer?: () => void } = {}) {
    this.backend = backend; this.ackTimeoutMs = options.ackTimeoutMs ?? 30_000;
    this.beforePrompt = options.beforePrompt; this.beforeSteer = options.beforeSteer;
  }
  async start(input: WorkerInput, onEvent: WorkerEventHandler): Promise<void> {
    if (this.started) throw new Error('An adapter instance accepts exactly one run');
    this.started = true; this.onEvent = onEvent;
    const completion = new Promise<void>((resolve, reject) => { this.resolveRun = resolve; this.rejectRun = reject; });
    // A launch or ACK error can arrive before we await completion.
    void completion.catch(() => {});
    try {
      this.transport = await this.backend.launch(input);
      this.transport.onLine(line => this.receive(line));
      this.transport.onClose(error => this.fail(error ?? new Error('Pi transport closed before settlement')));
      if (this.cancelled) { await this.transport.stop(); throw new Error('Run cancelled before prompt'); }
      await this.command(randomUUID(), 'get_state');
      if (this.cancelled || this.closed) throw new Error('Run cancelled before prompt');
      this.beforePrompt?.();
      await this.command(input.runId, 'prompt', { message: input.prompt });
      await completion;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  async steer(messageId: string, text: string): Promise<void> {
    if (!this.resolveRun || this.cancelled || this.closed) throw new Error('Run is not accepting steering');
    this.beforeSteer?.();
    await this.command(messageId, 'steer', { message: text });
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.cancelPromise) return this.cancelPromise;
    this.cancelPromise = this.cancelRun();
    return this.cancelPromise;
  }
  private async cancelRun(): Promise<void> {
    if (!this.transport || this.closed) return;
    // clear_queue cannot cancel in-flight transforms. Close ingress first, abort all
    // execution classes, clear queued input, then destroy the whole container.
    try {
      await Promise.allSettled([
        this.command(randomUUID(), 'abort', {}, 2_000),
        this.command(randomUUID(), 'abort_bash', {}, 2_000),
        this.command(randomUUID(), 'abort_retry', {}, 2_000),
        this.command(randomUUID(), 'clear_queue', {}, 2_000),
      ]);
    } finally {
      try { await this.transport.stop(); }
      finally { this.fail(new Error('Run cancelled')); }
    }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.fail(new Error('Pi adapter disposed'));
    await this.transport?.stop();
  }
  private async command(id: string, type: string, payload: Record<string, unknown> = {}, timeoutMs = this.ackTimeoutMs): Promise<void> {
    if (!this.transport || this.closed) throw new Error('Pi transport unavailable');
    if (this.sentIds.has(id)) throw new Error('Duplicate command ID; replay is forbidden');
    this.sentIds.add(id);
    const ack = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new CommandUncertainError(id, `No authoritative ${type} ACK; command must not be replayed`);
        try { this.onEvent({ type: 'command_uncertain', data: { id, command: type, error: error.message } }); }
        catch { /* Command uncertainty must still reach the durable caller. */ }
        reject(error);
      }, Math.min(timeoutMs, this.ackTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });
    });
    void ack.catch(() => {});
    try {
      this.onEvent({ type: 'command_dispatch', data: { id, command: type } });
      await this.transport.write(`${JSON.stringify({ id, type, ...payload })}\n`);
    }
    catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(id);
        pending.reject(new CommandUncertainError(id, `Transport write failed; do not replay: ${String(error)}`));
      }
    }
    await ack;
  }
  private receive(line: string): void {
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).type !== 'string') throw new Error('Malformed Pi event');
      value = parsed as Record<string, unknown>;
    } catch { this.fail(new Error('Malformed Pi JSONL protocol')); void this.transport?.stop().catch(() => {}); return; }
    const type = value.type as string;
    try { this.onEvent({ type, data: value }); }
    catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return; // Caller owns disposal and must retain its lease until it succeeds.
    }
    if (type === 'response' && typeof value.id === 'string') {
      const pending = this.pending.get(value.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(value.id);
        if (value.success === true) {
          const data = value.data as Record<string, unknown> | undefined;
          // Handled prompts produce no run/settled event. Fail explicitly rather
          // than pretending an ACK completes a run or waiting forever.
          if (value.command === 'prompt' && data?.disposition === 'handled') pending.reject(new Error('Prompt handled without starting an agent run'));
          else pending.resolve();
        } else pending.reject(new Error(typeof value.error === 'string' ? value.error : 'Pi command rejected'));
      }
    }
    if (type === 'agent_settled') {
      this.resolveRun?.(); this.resolveRun = undefined; this.rejectRun = undefined;
    }
  }
  private fail(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CommandUncertainError(id, `${error.message}; command must not be replayed`));
    }
    this.pending.clear(); this.rejectRun?.(error); this.resolveRun = undefined; this.rejectRun = undefined;
  }
}
