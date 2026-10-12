import { createServer } from 'node:http';
import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { AppError, requireId } from '../types.ts';
import { MemoryRepository, type SaveMemory, type UpdateMemory } from './repository.ts';

interface MemoryBrokerOptions {
  repo: MemoryRepository; botId: string; taskId: string; version: string;
  authorize: () => boolean; onEvent: (type: string, data: unknown) => void;
}
const fields: Record<string, string[]> = {
  search: ['query'], read: ['id'], save: ['requestId', 'title', 'content', 'scope', 'kind'],
  update: ['requestId', 'id', 'expectedRevision', 'title', 'content'], forget: ['requestId', 'id', 'expectedRevision'],
};
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function createMemoryHandler(options: MemoryBrokerOptions) {
  const admit = () => { if (!options.authorize()) throw new AppError(403, 'Memory lease revoked or task cancelled'); };
  return (request: unknown): unknown => {
    admit();
    if (!record(request) || typeof request.action !== 'string' || !record(request.input) || Object.keys(request).some(key => !['action', 'input'].includes(key))) throw new AppError(400, 'Invalid memory request');
    const { action, input } = request;
    if (!fields[action] || Object.keys(input).some(key => !fields[action]!.includes(key))) throw new AppError(400, 'Unsupported memory action or field');
    const snapshot = options.repo.snapshot(options.botId, '', options.version);
    if (!snapshot.enabled) throw new AppError(403, 'Memory is turned off');
    if (action === 'search' || action === 'read') {
      let entries = snapshot.entries;
      if (action === 'read') { requireId(input.id); entries = entries.filter(entry => entry.id === input.id); if (!entries.length) throw new AppError(404, 'Memory not found in this snapshot'); }
      else {
        if (typeof input.query !== 'string' || input.query.length > 300) throw new AppError(400, 'Invalid memory query');
        const query = input.query.normalize('NFKC').toLowerCase(); entries = entries.filter(entry => `${entry.title} ${entry.content}`.normalize('NFKC').toLowerCase().includes(query)).slice(0, 20);
      }
      admit(); options.onEvent('memory.accessed', { version: snapshot.version, entries: entries.map(entry => ({ id: entry.id, title: entry.title })) });
      return { version: snapshot.version, entries: action === 'search' ? entries.map(entry => ({ ...entry, content: [...entry.content].slice(0, 320).join(''), snippet: true })) : entries };
    }
    admit();
    let changed;
    if (action === 'save') changed = options.repo.save(options.botId, { ...input, sourceTaskId: options.taskId } as unknown as SaveMemory, 'agent', admit);
    else if (action === 'update') { requireId(input.id); changed = options.repo.update(options.botId, input.id, { ...input, sourceTaskId: options.taskId } as unknown as UpdateMemory, 'agent', admit); }
    else { requireId(input.id); changed = options.repo.forget(options.botId, input.id, { requestId: input.requestId as string, expectedRevision: input.expectedRevision as string }, admit); }
    admit();
    options.onEvent('memory.updated', { action, version: changed.version, id: changed.id, title: changed.entry?.title, replayed: changed.replayed });
    return changed;
  };
}

export async function startMemoryBroker(options: MemoryBrokerOptions & { socketPath: string }): Promise<{ close(): Promise<void> }> {
  const path = resolve(options.socketPath);
  if (Buffer.byteLength(path) >= 104) throw new Error('Memory Unix socket path is too long; use a shorter private data directory');
  if (path !== options.socketPath || await realpath(dirname(path)) !== dirname(path)) throw new Error('Unsafe memory socket path');
  try { await lstat(path); throw new Error('Memory socket path already exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const handle = createMemoryHandler(options), connections = new Set<Socket>();
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      if (req.method !== 'POST' || req.url !== '/memory') throw new AppError(403, 'Route not allowed');
      if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'Use application/json');
      if (!options.authorize()) throw new AppError(403, 'Memory lease revoked or task cancelled');
      req.setEncoding('utf8'); let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 32 * 1024) throw new AppError(413, 'Memory request too large'); }
      let input: unknown; try { input = JSON.parse(body); } catch { throw new AppError(400, 'Invalid JSON'); }
      send(200, handle(input));
    } catch (error) { send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'Memory storage unavailable' }); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.on('connection', socket => { connections.add(socket); socket.setTimeout(10_000, () => socket.destroy()); socket.on('close', () => connections.delete(socket)); });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolveListen(); }); });
  try { await chmod(path, 0o600); } catch (error) { for (const socket of connections) socket.destroy(); server.close(); throw error; }
  const identity = await lstat(path); let closing: Promise<void> | undefined;
  return { close() {
    return closing ??= (async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      try { const current = await lstat(path); if (!current.isSocket() || current.ino !== identity.ino) throw new Error('Memory socket identity changed'); await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    })();
  } };
}
