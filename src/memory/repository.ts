import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError, requireId, requireText } from '../types.ts';

export type MemoryScope = 'personal' | 'project' | 'bot';
export type MemoryKind = 'preference' | 'correction' | 'decision' | 'lesson';
export interface MemoryEntry {
  id: string; title: string; content: string; scope: MemoryScope; kind: MemoryKind;
  botId: string | null; project: string | null; source: string; revision: string;
  createdAt: number; updatedAt: number; origin?: 'user' | 'agent' | 'automatic';
}
export interface SaveMemory {
  requestId: string; title: string; content: string; scope: MemoryScope; kind: MemoryKind;
  sourceTaskId?: string;
}
export interface UpdateMemory { requestId: string; expectedRevision: string; title: string; content: string; sourceTaskId?: string }
type Metadata = Omit<MemoryEntry, 'content'>;
interface MemoryState {
  schema: 1; enabled: boolean; projects: Record<string, string | null>;
  entries: Record<string, Metadata>;
  forgotten: Record<string, string>;
  requests: Record<string, { hash: string; id: string; action: string }>;
  maintenance?: Record<string, MaintenanceProgress>;
  suppressedBefore?: number;
}
export interface MemoryHistory { version: string; action: string; id: string; date: string }
export interface MemorySnapshot {
  version: string; enabled: boolean; project: string | null; entries: MemoryEntry[]; history: MemoryHistory[];
  writable: boolean;
}
export interface MemoryChange { version: string; id: string; entry?: MemoryEntry; forgotten?: boolean; replayed: boolean }
export interface MemoryConflict { id: string; title: string; content: string; sourceTaskId: string; createdAt: number }
export interface MaintenanceProgress { cursor: number; lastDreamAt: number; suppressedBefore: number; conflicts: MemoryConflict[] }
export interface MaintenanceCommit {
  requestId: string; expectedVersion: string; cursor: number; dreamAt: number;
  additions: { title: string; content: string; kind: MemoryKind; sourceTaskId: string }[];
  removals: { id: string; revision: string; reason: string }[];
  conflicts: { title: string; content: string; sourceTaskId: string }[];
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const line = (value: string) => value.replace(/\s+/gu, ' ').trim();
const fingerprint = (value: string) => hash(line(value).normalize('NFKC').toLocaleLowerCase('en-US'));

/** Only committed Git trees are readable. SQLite is a cross-process mutex, never a second memory store. */
export class MemoryRepository {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(this.path, { recursive: true, mode: 0o700 });
    if (lstatSync(this.path).isSymbolicLink() || realpathSync(this.path) !== this.path) throw new Error('Unsafe memory repository path');
    this.lock(() => {
      if (!existsSync(join(this.path, '.git'))) {
        if (readdirSync(this.path).length) throw new Error('Memory destination must be empty');
        this.git('init', '--initial-branch=main');
        mkdirSync(join(this.path, '.chestnut'), { mode: 0o700 });
        mkdirSync(join(this.path, 'notes'), { mode: 0o700 });
        this.writeState({ schema: 1, enabled: true, projects: {}, entries: {}, forgotten: {}, requests: {} });
        this.commit('init', 'repository');
      }
      if (lstatSync(join(this.path, '.git')).isSymbolicLink() || this.git('rev-parse', '--show-toplevel').trim() !== this.path) throw new Error('Memory must be its own repository');
      this.state(this.version());
    });
  }
  private git(...args: string[]) {
    return this.gitOutput(args).toString('utf8');
  }
  private gitOutput(args: string[], input?: string) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'user.name=Chestnut', '-c', 'user.email=memory@chestnut.local', '-C', this.path, ...args], {
      timeout: 5000, maxBuffer: 32 * 1024 * 1024, input,
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  private lock<T>(operation: () => T): T {
    const lockPath = `${this.path}.lock.sqlite`;
    if (existsSync(lockPath) && lstatSync(lockPath).isSymbolicLink()) throw new Error('Unsafe memory lock');
    const db = new DatabaseSync(lockPath);
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      try { const result = operation(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }
  private version() { return this.git('rev-parse', 'HEAD').trim(); }
  private state(version: string): MemoryState {
    if (!/^[a-f0-9]{40}$/.test(version)) throw new AppError(400, 'Invalid memory version');
    const state = JSON.parse(this.git('show', `${version}:.chestnut/state.json`)) as MemoryState;
    if (state.schema !== 1) throw new Error('Unsupported memory schema');
    return state;
  }
  private clean() { return !this.git('status', '--porcelain', '--untracked-files=all').trim(); }
  private entry(metadata: Metadata, version: string): MemoryEntry {
    requireId(metadata.id);
    return this.parseEntry(metadata, this.git('show', `${version}:notes/${metadata.id}.md`));
  }
  private parseEntry(metadata: Metadata, document: string): MemoryEntry {
    const body = document.split('\n')[2];
    if (!body?.startsWith('- ')) throw new Error('Invalid committed memory note');
    const suffix = ` [source: ${metadata.source}; added: ${new Date(metadata.createdAt).toISOString().slice(0, 10)}]`;
    if (!body.endsWith(suffix)) throw new Error('Invalid committed memory source');
    return { ...metadata, content: body.slice(2, -suffix.length) };
  }
  private entries(metadata: Metadata[], version: string): MemoryEntry[] {
    if (!metadata.length) return [];
    // One Git process for the complete committed bundle, rather than one per note.
    const input = metadata.map(entry => { requireId(entry.id); return `${version}:notes/${entry.id}.md`; }).join('\n') + '\n';
    const output = this.gitOutput(['cat-file', '--batch'], input); let offset = 0;
    return metadata.map(entry => {
      const newline = output.indexOf(10, offset);
      const header = output.subarray(offset, newline).toString('utf8').match(/^[a-f0-9]{40} blob (\d+)$/);
      if (!header) throw new Error('Invalid memory Git object');
      const size = Number(header[1]); offset = newline + 1;
      if (size > 32 * 1024 || offset + size >= output.length) throw new Error('Invalid memory note size');
      const document = output.subarray(offset, offset + size).toString('utf8'); offset += size + 1;
      return this.parseEntry(entry, document);
    });
  }
  private visible(entry: Metadata, botId: string, project: string | null) {
    return entry.scope === 'personal' || (entry.scope === 'bot' && entry.botId === botId) || (entry.scope === 'project' && !!project && entry.project === project);
  }
  snapshot(botId: string, query = '', version?: string): MemorySnapshot {
    requireId(botId);
    return this.lock(() => {
      const current = this.state(this.version());
      const committed = version ?? this.version(); const state = this.state(committed);
      const project = current.projects[botId] ?? null;
      const entries = current.enabled ? this.entries(Object.values(state.entries).filter(entry => current.entries[entry.id] && this.visible(entry, botId, project)), committed) : [];
      const history = this.git('log', '-15', '--format=%H%x09%s%x09%cI').trim().split('\n').filter(Boolean).map(row => {
        const [commit, subject, date] = row.split('\t'); const [, action, id] = subject!.split(' ');
        return { version: commit!, action: action!, id: id!, date: date! };
      });
      return { version: committed, enabled: current.enabled, project, entries: current.enabled ? this.search(entries, query) : [], history, writable: this.clean() };
    });
  }
  private search(entries: MemoryEntry[], query: string) {
    const q = line(query).normalize('NFKC').toLocaleLowerCase('en-US');
    return entries.filter(entry => !q || `${entry.title} ${entry.content}`.normalize('NFKC').toLocaleLowerCase('en-US').includes(q)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  save(botId: string, input: SaveMemory, actor: 'user' | 'agent' = 'user', authorize?: () => void): MemoryChange {
    requireId(botId); requireId(input.requestId); requireText(input.title, 80); requireText(input.content, 4000);
    if (!['personal', 'project', 'bot'].includes(input.scope) || !['preference', 'correction', 'decision', 'lesson'].includes(input.kind)) throw new AppError(400, 'Invalid memory scope or kind');
    if (input.sourceTaskId) requireId(input.sourceTaskId);
    return this.lock(() => {
      authorize?.();
      if (!this.clean()) throw new AppError(409, 'Memory has uncommitted changes. Inspect the repository before writing.');
      const state = this.state(this.version());
      if (!state.enabled) throw new AppError(409, 'Memory is turned off');
      const payload = hash(JSON.stringify({ action: 'save', botId, actor, ...input }));
      const replay = this.replay(state, input.requestId, payload); if (replay) return replay;
      const content = line(input.content), title = line(input.title);
      if (actor === 'agent' && Object.values(state.forgotten).includes(fingerprint(content))) throw new AppError(409, 'This content was forgotten. Only an explicit user save can restore it.');
      const metadata: Metadata = { id: input.requestId, title, scope: input.scope, kind: input.kind,
        botId: input.scope === 'bot' ? botId : null, project: input.scope === 'project' ? state.projects[botId] ?? null : null,
        origin: actor, source: input.sourceTaskId ? `chestnut://tasks/${input.sourceTaskId}` : 'user', revision: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() };
      if (input.scope === 'project' && !metadata.project) throw new AppError(400, 'Bind this bot to a project before saving project memory');
      if (Object.keys(state.entries).length >= 1000) throw new AppError(409, 'Memory entry limit reached');
      state.entries[metadata.id] = metadata;
      state.requests[input.requestId] = { hash: payload, id: metadata.id, action: 'save' };
      this.writeEntry(metadata, content);
      this.writeState(state); this.commit('save', metadata.id);
      const version = this.version();
      return { version, id: metadata.id, entry: this.entry(metadata, version), replayed: false };
    });
  }
  update(botId: string, id: string, input: UpdateMemory, actor: 'user' | 'agent' = 'user', authorize?: () => void): MemoryChange {
    requireId(botId); requireId(id); requireId(input.requestId); requireId(input.expectedRevision);
    requireText(input.title, 80); requireText(input.content, 4000); if (input.sourceTaskId) requireId(input.sourceTaskId);
    return this.lock(() => {
      authorize?.();
      if (!this.clean()) throw new AppError(409, 'Memory has uncommitted changes. Inspect the repository before writing.');
      const state = this.state(this.version()); if (!state.enabled) throw new AppError(409, 'Memory is turned off');
      const payload = hash(JSON.stringify({ action: 'update', botId, id, actor, ...input }));
      const replay = this.replay(state, input.requestId, payload); if (replay) return replay;
      const previous = state.entries[id];
      if (!previous || !this.visible(previous, botId, state.projects[botId] ?? null)) throw new AppError(404, 'Memory not found in this scope');
      if (previous.revision !== input.expectedRevision) throw new AppError(409, 'Memory changed. Read the latest revision before editing.');
      if (actor === 'agent' && Object.values(state.forgotten).includes(fingerprint(input.content))) throw new AppError(409, 'This content was forgotten. Only an explicit user save can restore it.');
      const entry: Metadata = { ...previous, title: line(input.title), origin: actor, source: input.sourceTaskId ? `chestnut://tasks/${input.sourceTaskId}` : 'user', revision: randomUUID(), updatedAt: Date.now() };
      state.entries[id] = entry; state.requests[input.requestId] = { hash: payload, id, action: 'update' };
      this.writeEntry(entry, line(input.content)); this.writeState(state); this.commit('update', id);
      const version = this.version(); return { version, id, entry: this.entry(entry, version), replayed: false };
    });
  }
  forget(botId: string, id: string, input: { requestId: string; expectedRevision: string }, authorize?: () => void): MemoryChange {
    requireId(botId); requireId(id); requireId(input.requestId); requireId(input.expectedRevision);
    return this.lock(() => {
      authorize?.();
      if (!this.clean()) throw new AppError(409, 'Memory has uncommitted changes. Inspect the repository before writing.');
      const version = this.version(), state = this.state(version);
      if (!state.enabled) throw new AppError(409, 'Memory is turned off');
      const payload = hash(JSON.stringify({ action: 'forget', botId, id, ...input }));
      const replay = this.replay(state, input.requestId, payload); if (replay) return { ...replay, forgotten: true };
      const entry = state.entries[id];
      if (!entry || !this.visible(entry, botId, state.projects[botId] ?? null)) throw new AppError(404, 'Memory not found in this scope');
      if (entry.revision !== input.expectedRevision) throw new AppError(409, 'Memory changed. Read the latest revision before forgetting.');
      state.suppressedBefore = Date.now();
      for (const progress of Object.values(state.maintenance ?? {})) progress.conflicts = [];
      state.forgotten[id] = fingerprint(this.entry(entry, version).content);
      delete state.entries[id]; state.requests[input.requestId] = { hash: payload, id, action: 'forget' };
      unlinkSync(join(this.path, 'notes', `${id}.md`)); this.writeState(state); this.commit('forget', id);
      return { version: this.version(), id, forgotten: true, replayed: false };
    });
  }
  settings(botId: string, input: { requestId: string; expectedVersion: string; project: string | null; enabled: boolean }) {
    requireId(botId); requireId(input.requestId);
    if (typeof input.enabled !== 'boolean' || (input.project !== null && (typeof input.project !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.project)))) throw new AppError(400, 'Use a lowercase project slug and a boolean memory setting');
    this.lock(() => {
      if (!this.clean()) throw new AppError(409, 'Memory has uncommitted changes. Inspect the repository before writing.');
      const version = this.version(), state = this.state(version);
      const payload = hash(JSON.stringify({ action: 'settings', botId, ...input }));
      if (this.replay(state, input.requestId, payload)) return;
      if (input.expectedVersion !== version) throw new AppError(409, 'Memory settings changed. Refresh before editing.');
      if (!state.enabled || !input.enabled) state.suppressedBefore = Date.now();
      state.enabled = input.enabled; state.projects[botId] = input.project;
      state.requests[input.requestId] = { hash: payload, id: botId, action: 'settings' };
      this.writeState(state); this.commit('settings', botId);
    });
    return this.snapshot(botId);
  }
  hasMaintenanceReceipt(botId: string, requestId: string) {
    requireId(botId); requireId(requestId);
    return this.lock(() => {
      const receipt = this.state(this.version()).requests[requestId];
      if (receipt && (receipt.action !== 'dream' || receipt.id !== botId)) throw new AppError(409, 'Memory request ID was already used for a different operation');
      return !!receipt;
    });
  }
  maintenanceState(botId: string): MaintenanceProgress {
    requireId(botId);
    return this.lock(() => {
      const state = this.state(this.version());
      return { cursor: 0, lastDreamAt: 0, conflicts: [], ...state.maintenance?.[botId], suppressedBefore: state.suppressedBefore ?? 0 };
    });
  }
  dismissConflict(botId: string, id: string, requestId: string) {
    requireId(botId); requireId(id); requireId(requestId);
    return this.lock(() => {
      if (!this.clean()) throw new AppError(409, 'Memory has uncommitted changes');
      const state = this.state(this.version());
      const payload = hash(JSON.stringify({ action: 'dismiss', botId, id, requestId }));
      if (this.replay(state, requestId, payload)) return;
      const progress = state.maintenance?.[botId];
      if (!progress?.conflicts.some(c => c.id === id)) throw new AppError(404, 'Conflict not found');
      progress.conflicts = progress.conflicts.filter(c => c.id !== id);
      state.requests[requestId] = { hash: payload, id, action: 'dismiss' };
      this.writeState(state); this.commit('dismiss', id);
    });
  }
  applyMaintenance(botId: string, input: MaintenanceCommit, authorize?: () => void) {
    requireId(botId); requireId(input.requestId);
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || !Number.isSafeInteger(input.dreamAt) || input.dreamAt < 0) throw new AppError(400, 'Invalid maintenance cursor');
    if (input.additions.length > 20 || input.removals.length > 20 || input.conflicts.length > 20) throw new AppError(400, 'Maintenance plan too large');
    for (const addition of input.additions) {
      requireText(addition.title, 80); requireText(addition.content, 4000); requireId(addition.sourceTaskId);
      if (!['preference', 'correction', 'decision', 'lesson'].includes(addition.kind)) throw new AppError(400, 'Invalid memory kind');
    }
    for (const conflict of input.conflicts) { requireText(conflict.title, 80); requireText(conflict.content, 4000); requireId(conflict.sourceTaskId); }
    return this.lock(() => {
      authorize?.();
      if (!this.clean()) throw new AppError(409, 'Memory has uncommitted changes');
      const version = this.version(), state = this.state(version);
      if (!state.enabled) throw new AppError(409, 'Memory is turned off');
      const payload = hash(JSON.stringify({ botId, ...input }));
      if (this.replay(state, input.requestId, payload)) return { version, added: 0, removed: 0, replayed: true };
      if (input.expectedVersion !== version) throw new AppError(409, 'Memory changed during maintenance; retry with the latest version');
      const previous = state.maintenance?.[botId];
      if (input.cursor < (previous?.cursor ?? 0)) throw new AppError(409, 'Maintenance cursor cannot move backwards');
      const visible = this.entries(Object.values(state.entries).filter(e => this.visible(e, botId, state.projects[botId] ?? null)), version);
      const deleted = new Set(input.removals.map(r => r.id));
      for (const removal of input.removals) {
        requireId(removal.id); requireId(removal.revision);
        const entry = visible.find(e => e.id === removal.id);
        if (!entry || entry.revision !== removal.revision) throw new AppError(409, 'Memory changed before removal');
        if (entry.origin !== 'automatic' || entry.scope !== 'bot' || entry.botId !== botId || entry.kind !== 'lesson') throw new AppError(409, 'This memory is protected from automatic removal');
        // Automatic pruning is restricted to proven duplicates. Semantic/transient removals remain proposals.
        if (removal.reason !== 'duplicate' || !visible.some(e => !deleted.has(e.id) && e.scope === entry.scope && e.kind === entry.kind && fingerprint(e.content) === fingerprint(entry.content))) throw new AppError(400, 'Removal must preserve an equivalent memory');
      }
      const additions: { entry: Metadata; content: string }[] = [];
      for (const addition of input.additions) {
        const content = line(addition.content);
        if (Object.values(state.forgotten).includes(fingerprint(content))) continue;
        if (visible.some(e => fingerprint(e.content) === fingerprint(content)) || additions.some(e => fingerprint(e.content) === fingerprint(content))) continue;
        const now = Date.now();
        additions.push({ entry: { id: randomUUID(), title: line(addition.title), kind: addition.kind, scope: 'bot', botId, project: null, source: `chestnut://tasks/${addition.sourceTaskId}`, origin: 'automatic', revision: randomUUID(), createdAt: now, updatedAt: now }, content });
      }
      if (Object.keys(state.entries).length + additions.length - deleted.size > 1000) throw new AppError(409, 'Memory entry limit reached');
      const conflicts = [...(previous?.conflicts ?? []), ...input.conflicts.map(c => ({ ...c, title: line(c.title), content: line(c.content), id: randomUUID(), createdAt: Date.now() }))];
      if (conflicts.length > 100) throw new AppError(409, 'Review existing memory conflicts before continuing');
      // All validation precedes filesystem mutations; dirty interrupted writes are preserved by the normal repository policy.
      for (const removal of input.removals) { delete state.entries[removal.id]; unlinkSync(join(this.path, 'notes', `${removal.id}.md`)); }
      for (const { entry, content } of additions) { state.entries[entry.id] = entry; this.writeEntry(entry, content); }
      state.maintenance ??= {};
      state.maintenance[botId] = { cursor: input.cursor, lastDreamAt: Math.max(previous?.lastDreamAt ?? 0, input.dreamAt), suppressedBefore: state.suppressedBefore ?? 0, conflicts };
      state.requests[input.requestId] = { hash: payload, id: botId, action: 'dream' };
      this.writeState(state); this.commit('dream', botId);
      return { version: this.version(), added: additions.length, removed: input.removals.length, replayed: false };
    });
  }
  private writeEntry(entry: Metadata, content: string) {
    writeFileSync(join(this.path, 'notes', `${entry.id}.md`), `# ${entry.title}\n\n- ${content} [source: ${entry.source}; added: ${new Date(entry.createdAt).toISOString().slice(0, 10)}]\n`, { mode: 0o600 });
  }
  private replay(state: MemoryState, requestId: string, payload: string): MemoryChange | undefined {
    const receipt = state.requests[requestId]; if (!receipt) return;
    if (receipt.hash !== payload) throw new AppError(409, 'Memory request ID was already used for different content');
    const version = this.version(); const metadata = state.entries[receipt.id];
    return { version, id: receipt.id, ...(metadata ? { entry: this.entry(metadata, version) } : {}), replayed: true };
  }
  private writeState(state: MemoryState) {
    writeFileSync(join(this.path, '.chestnut', 'state.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    const general = Object.values(state.entries).filter(entry => entry.scope === 'personal').slice(0, 6).map(entry => `- [[notes/${entry.id}]] ${entry.title}`);
    const index = Object.values(state.entries).map(entry => `- [[notes/${entry.id}]] ${entry.title} (${entry.scope})`);
    writeFileSync(join(this.path, 'MEMORY.md'), `# Memory\n\n${general.join('\n')}\n\n## Index\n\n${index.join('\n')}\n`, { mode: 0o600 });
  }
  private commit(action: string, id: string) {
    this.git('add', '--', 'MEMORY.md', '.chestnut/state.json', 'notes');
    this.git('commit', '-m', `memory: ${action} ${id}`);
  }
}
