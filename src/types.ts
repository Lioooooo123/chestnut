export type TaskState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface Bot { id: string; name: string; createdAt: number }
export interface Task { id: string; botId: string; prompt: string; state: TaskState; parentTaskId: string | null; result: string | null; error: string | null; createdAt: number; updatedAt: number }
export interface Run { id: string; taskId: string; botId: string; workerId: string; token: string; fence: number; leaseUntil: number }
export interface Command { id: string; messageId: string; taskId: string; botId: string; type: 'steer' | 'cancel'; text: string | null; state: string }
export class AppError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export const isId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export function requireId(s: unknown): asserts s is string { if (!isId(s)) throw new AppError(400, 'Invalid ID'); }
export function requireText(s: unknown, max = 32000): asserts s is string { if (typeof s !== 'string' || !s.trim() || s.length > max) throw new AppError(400, `Text must contain 1–${max} characters`); }
