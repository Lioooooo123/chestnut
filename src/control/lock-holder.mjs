// Trusted host control utility. Input comes only from the outer backend, never task code.
// flock --no-fork owns this process. Never exit on an ambiguous Docker command outcome.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { constants, openSync, closeSync, writeSync, ftruncateSync, fsyncSync, unlinkSync } from 'node:fs';

const [markerPath, fixtureFlag, fixtureExecutable] = process.argv.slice(2);
const docker = fixtureFlag === '--test-docker-fixture' && fixtureExecutable ? fixtureExecutable : 'docker';
const MAX_FRAME = 8 * 1024 * 1024, MAX_OUTPUT = 2 * 1024 * 1024, MAX_LINE = 1024 * 1024;
const commands = new Map(), attachments = new Map();
let input = '', ending = false, finished = false, poisoned = false, outputUsable = true, outputBytes = 0, markerFd;
let keepAlive;
const description = reason => `Environment lock quarantined: ${String(reason).slice(0, 1000)}. Operator must reconcile Docker state and stop holder PID ${process.pid} before removing ${markerPath}; never unlink the lock file.`;
function send(value) {
  if (!outputUsable) return;
  const frame = JSON.stringify(value) + '\n';
  if (outputBytes + Buffer.byteLength(frame) > 24 * 1024 * 1024) {
    outputUsable = false;
    poison('owner output pipe exceeded bounded backlog');
    shutdown();
    return;
  }
  outputBytes += Buffer.byteLength(frame);
  process.stdout.write(frame, () => { outputBytes -= Buffer.byteLength(frame); });
}
function record(reason) {
  const body = JSON.stringify({ pid: process.pid, state: reason ? 'quarantined' : 'held', reason: reason ? String(reason).slice(0,1000) : undefined, since: new Date().toISOString() }) + '\n';
  ftruncateSync(markerFd, 0); writeSync(markerFd, body, 0, 'utf8'); fsyncSync(markerFd);
}
function poison(reason) {
  if (poisoned) return;
  poisoned = true; ending = true;
  for (const attachment of attachments.values()) attachment.child.kill('SIGKILL');
  try { record(reason); } catch { /* The existing marker still denies future acquisition. */ }
  keepAlive = setInterval(() => {}, 60_000);
  send({ type: 'poison', error: description(reason) });
}
function finish() {
  if (finished || !ending || commands.size || attachments.size || poisoned) return;
  try { unlinkSync(markerPath); closeSync(markerFd); }
  catch (error) { poison(`cannot clear ownership marker: ${error.message}`); return; }
  finished = true;
  send({ type: 'released' });
  process.stdin.destroy();
  process.stdout.end(() => process.exit(0));
}
function shutdown() {
  if (finished) return;
  ending = true;
  for (const attachment of attachments.values()) attachment.child.kill('SIGKILL');
  finish();
}
process.stdout.on('error', () => { outputUsable = false; shutdown(); });
process.stdin.on('error', () => { poison('owner input transport failed'); shutdown(); });
process.stdin.on('end', shutdown);
// A termination request cannot release the lock with a possibly live lifecycle operation.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { poison(`holder received ${signal}`); shutdown(); });
try {
  if (!markerPath || (fixtureFlag && fixtureFlag !== '--test-docker-fixture')) throw new Error('invalid trusted holder invocation');
  markerFd = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  record();
  const directoryFd = openSync(dirname(markerPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
} catch (error) {
  if (markerFd !== undefined) { try { closeSync(markerFd); } catch {} markerFd = undefined; }
  send({ type: 'failed', error: description(`existing ownership marker or unsafe marker: ${error.message}`) });
  process.stdout.end(() => process.exit(3));
}
if (markerFd !== undefined) {
  send({ type: 'ready', pid: process.pid });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (ending || poisoned) return;
    input += chunk;
    if (Buffer.byteLength(input) > MAX_FRAME) { poison('owner input frame exceeded limit'); shutdown(); return; }
    let newline;
    while ((newline = input.indexOf('\n')) >= 0) {
      const frame = input.slice(0,newline); input = input.slice(newline + 1);
      try { dispatch(JSON.parse(frame)); } catch (error) { poison(`invalid owner protocol: ${error.message}`); shutdown(); return; }
    }
  });
}
function argsValid(args) {
  return Array.isArray(args) && args.length > 0 && args.length <= 256 && args.every(arg => typeof arg === 'string' && !arg.includes('\0')) && Buffer.byteLength(JSON.stringify(args)) <= 128 * 1024;
}
function dispatch(message) {
  if (ending || poisoned) return;
  if (!message || !Number.isSafeInteger(message.id) || message.id < 1) throw new Error('invalid request id');
  const { id, type } = message;
  if (type === 'poison') { poison(message.reason || 'owner reported an unverified transport'); shutdown(); return; }
  if (type === 'command' || type === 'start_attach') {
    if (!argsValid(message.args) || commands.has(id) || attachments.has(id) || commands.size + attachments.size >= 16) throw new Error('invalid or excessive Docker operation');
    if (type === 'command') command(id, message.args, message.timeoutMs);
    else attach(id, message.args);
    return;
  }
  const attachment = attachments.get(message.attachmentId);
  if (type === 'write') {
    if (typeof message.line !== 'string' || Buffer.byteLength(message.line) > MAX_LINE) throw new Error('invalid attachment write');
    if (!attachment) { send({ type: 'result', id, error: 'Docker attachment is closed' }); return; }
    attachment.child.stdin.write(message.line, error => send({ type: 'result', id, error: error ? String(error.message).slice(0,1024) : undefined }));
  } else if (type === 'terminate') {
    if (!attachment) { send({ type: 'result', id }); return; }
    attachment.terminators.push(id); attachment.child.kill('SIGKILL');
  } else throw new Error('unsupported protocol operation');
}
function command(id, args, timeoutMs = 15_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('invalid Docker command timeout');
  const child = spawn(docker, args, { stdio: ['ignore','pipe','pipe'], shell: false });
  const operation = { child, output: [], bytes: 0, error: '', failed: false };
  commands.set(id, operation);
  const fail = reason => { if (operation.failed) return; operation.failed = true; poison(reason); child.kill('SIGKILL'); };
  const timeout = setTimeout(() => fail(`Docker lifecycle command ${id} timed out; daemon side effects are unverified`), timeoutMs);
  child.stdout.on('data', chunk => {
    operation.bytes += chunk.length;
    if (operation.bytes > MAX_OUTPUT) { fail(`Docker lifecycle command ${id} exceeded output limit`); return; }
    operation.output.push(chunk);
  });
  child.stderr.on('data', chunk => { operation.error = (operation.error + chunk.toString('utf8')).slice(-4096); });
  for (const stream of [child.stdout,child.stderr]) stream.on('error', error => fail(`Docker lifecycle command ${id} pipe failed: ${error.message}`));
  child.on('error', error => fail(`Docker lifecycle command ${id} failed to spawn: ${error.message}`));
  child.on('close', (code,signal) => {
    clearTimeout(timeout);
    if (code !== 0 || signal) fail(`Docker lifecycle command ${id} exited ${code ?? signal}: ${operation.error}`);
    commands.delete(id);
    if (!operation.failed) send({ type: 'result', id, output: Buffer.concat(operation.output).toString('utf8') });
    finish();
  });
}
function attach(id,args) {
  const child = spawn(docker, args, { stdio: ['pipe','pipe','pipe'], shell: false });
  const operation = { child, buffer: '', stderr: '', failure: undefined, terminators: [] };
  attachments.set(id,operation);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdin.on('error', error => { operation.failure ??= error.message; });
  child.stdout.on('data', chunk => {
    operation.buffer += chunk;
    if (Buffer.byteLength(operation.buffer) > MAX_LINE) { operation.failure = 'Docker attachment frame exceeded limit'; child.kill('SIGKILL'); return; }
    let newline;
    while ((newline = operation.buffer.indexOf('\n')) >= 0) {
      const line = operation.buffer.slice(0,newline); operation.buffer = operation.buffer.slice(newline + 1);
      if (line.trim()) send({ type: 'line', attachmentId: id, line });
    }
  });
  child.stderr.on('data', chunk => { operation.stderr = (operation.stderr + chunk).slice(-4096); });
  for (const stream of [child.stdout,child.stderr]) stream.on('error', error => { operation.failure ??= error.message; child.kill('SIGKILL'); });
  child.on('error', error => { operation.failure = error.message; });
  child.on('close', (code,signal) => {
    attachments.delete(id);
    send({ type: 'closed', attachmentId: id, error: operation.failure || `Docker attachment exited (${code ?? signal}): ${operation.stderr}` });
    for (const requestId of operation.terminators) send({ type: 'result', id: requestId });
    finish();
  });
}
