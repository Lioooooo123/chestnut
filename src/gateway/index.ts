/**
 * Credential-holding, host-side text/function Chat Completions and Responses gateway.
 *
 * The sandbox receives only the Unix socket. Never pass this object's apiKey,
 * process.env, or a credential-bearing config file into the sandbox. The socket
 * directory must belong to the trusted host process and be mounted read-only.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Socket } from 'node:net';

const BODY_LIMIT = 2 * 1024 * 1024;
const CONCURRENCY_LIMIT = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const ALLOWED_FIELDS = new Set([
  'model', 'messages', 'stream', 'stream_options', 'max_tokens',
  'max_completion_tokens', 'temperature', 'top_p', 'n', 'stop',
  'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs',
  'top_logprobs', 'seed', 'tools', 'tool_choice', 'parallel_tool_calls',
  'response_format', 'reasoning_effort', 'verbosity', 'service_tier', 'store',
]);

export interface ModelGatewayOptions {
  socketPath: string;
  apiKey?: string;
  getApiKey?: (signal:AbortSignal)=>Promise<string>;
  apiProtocol?: 'chat-completions'|'responses';
  model: string;
  /** Only the official HTTPS endpoint is accepted, including in tests. */
  upstreamBaseUrl?: string;
  maxOutputTokens?: number;
  /** Test seam: the production default is the native fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Trusted outer-worker lease/cancellation fence, checked before credential use. */
  authorize?: () => boolean;
  /** Overall request deadline, including upload and streamed generation. */
  requestTimeoutMs?: number;
}

class GatewayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reject(message: string): never {
  throw new GatewayError(400, message);
}

function validateContent(content: unknown): void {
  if (content === null || typeof content === 'string') return;
  if (!Array.isArray(content)) reject('Message content must be text or text parts.');
  for (const part of content) {
    // No image_url, file URL, audio URL, or other upstream retrieval capability.
    if (!record(part) || part.type !== 'text' || typeof part.text !== 'string'
      || Object.keys(part).some((key) => key !== 'type' && key !== 'text')) {
      reject('Only text message content is supported.');
    }
  }
}

function validateRequest(value: unknown, model: string, tokenCap: number): Record<string, unknown> {
  if (!record(value)) reject('Expected a JSON object.');
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) reject('Unsupported Chat Completions field.');
  }
  if (value.model !== model) reject('The requested model is not allowed.');
  if (!Array.isArray(value.messages) || value.messages.length === 0) reject('Messages are required.');
  const messageFields = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'refusal']);
  for (const message of value.messages) {
    if (!record(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(String(message.role))) {
      reject('Unsupported message role.');
    }
    if (Object.keys(message).some((key) => !messageFields.has(key))) reject('Unsupported message field.');
    if ('content' in message) validateContent(message.content);
    if ('tool_calls' in message) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) reject('Invalid tool calls.');
      for (const call of message.tool_calls) {
        if (!record(call) || call.type !== 'function' || typeof call.id !== 'string'
          || !record(call.function) || typeof call.function.name !== 'string'
          || typeof call.function.arguments !== 'string'
          || Object.keys(call).some((key) => !['id', 'type', 'function'].includes(key))
          || Object.keys(call.function).some((key) => !['name', 'arguments'].includes(key))) {
          reject('Only function tool calls are supported.');
        }
      }
    }
  }
  if ('tools' in value) {
    if (!Array.isArray(value.tools)) reject('Tools must be an array.');
    for (const tool of value.tools) {
      if (!record(tool) || tool.type !== 'function' || !record(tool.function)
        || typeof tool.function.name !== 'string'
        || Object.keys(tool).some((key) => !['type', 'function'].includes(key))
        || Object.keys(tool.function).some((key) => !['name', 'description', 'parameters', 'strict'].includes(key))) {
        reject('Only function tools are supported.');
      }
    }
  }
  if ('tool_choice' in value && typeof value.tool_choice !== 'string') {
    const choice = value.tool_choice;
    if (!record(choice) || choice.type !== 'function' || !record(choice.function)
      || typeof choice.function.name !== 'string'
      || Object.keys(choice).some((key) => !['type', 'function'].includes(key))
      || Object.keys(choice.function).some((key) => key !== 'name')) reject('Invalid tool choice.');
  } else if ('tool_choice' in value && !['none', 'auto', 'required'].includes(String(value.tool_choice))) {
    reject('Invalid tool choice.');
  }
  if ('stream' in value && typeof value.stream !== 'boolean') reject('Stream must be a boolean.');
  if ('stream_options' in value) {
    if (!record(value.stream_options)
      || Object.keys(value.stream_options).some((key) => key !== 'include_usage')
      || typeof value.stream_options.include_usage !== 'boolean') reject('Invalid stream options.');
  }
  if ('store' in value && value.store !== false) reject('Stored completions are not supported.');
  // Multiple generations would multiply cost despite the per-generation cap.
  if ('n' in value && value.n !== 1) reject('Only one completion is allowed.');
  if ('max_tokens' in value && 'max_completion_tokens' in value) reject('Use one output token limit.');
  const output: Record<string, unknown> = { ...value, model, n: 1, store: false };
  const limitField = 'max_tokens' in value ? 'max_tokens' : 'max_completion_tokens';
  if (limitField in value && (!Number.isSafeInteger(value[limitField]) || Number(value[limitField]) < 1)) {
    reject('The output token limit must be a positive integer.');
  }
  output[limitField] = Math.min(Number(value[limitField] ?? tokenCap), tokenCap);
  return output;
}

function validateResponses(value:unknown,model:string):Record<string,unknown>{
  if(!record(value)||value.model!==model||value.stream!==true||value.store!==false||!Array.isArray(value.input))reject('Responses requires the fixed model, full input array, stream=true and store=false.');
  const fields=new Set(['model','input','instructions','tools','tool_choice','parallel_tool_calls','stream','store','reasoning','text','include','max_output_tokens','temperature','top_p','service_tier','prompt_cache_key','prompt_cache_retention','prompt_cache_options']);
  if(Object.keys(value).some(key=>!fields.has(key)))reject('Unsupported Responses field.');
  // This is the pinned Pi text/function replay subset, not a general Responses proxy.
  // In particular annotations, remote item references and hosted tool capabilities
  // must not become an alternate path to provider-side retrieval.
  const checkText=(content:unknown,types:readonly string[],allowString=true)=>{
    if(allowString&&typeof content==='string')return;
    if(!Array.isArray(content)||content.some(part=>!record(part)||!types.includes(String(part.type))||typeof part.text!=='string'
      ||Object.keys(part).some(k=>!['type','text','annotations'].includes(k))
      ||('annotations'in part&&(part.type!=='output_text'||!Array.isArray(part.annotations)||part.annotations.length!==0))))reject('Responses accepts only inline text.');
  };
  const checkReplayMetadata=(item:Record<string,unknown>)=>{
    if(('id'in item&&(typeof item.id!=='string'||!item.id))
      ||('status'in item&&!['completed','in_progress','incomplete'].includes(String(item.status))))reject('Invalid Responses replay metadata.');
  };
  const input=value.input.map(item=>{
    if(!record(item))reject('Invalid Responses input.');
    checkReplayMetadata(item);
    if(item.type==='function_call'){if(typeof item.call_id!=='string'||!item.call_id||typeof item.name!=='string'||!item.name||typeof item.arguments!=='string'||('namespace'in item&&item.namespace!=='chestnut')||Object.keys(item).some(k=>!['type','id','call_id','name','arguments','status','namespace'].includes(k)))reject('Invalid function call.');return item;}
    if(item.type==='function_call_output'){if(typeof item.call_id!=='string'||!item.call_id||Object.keys(item).some(k=>!['type','call_id','output','id','status'].includes(k)))reject('Invalid function output.');checkText(item.output,['input_text']);return item;}
    if(item.type==='reasoning'){
      if(typeof item.encrypted_content!=='string'||!item.encrypted_content||Object.keys(item).some(k=>!['type','id','encrypted_content','summary','content','status'].includes(k)))reject('Reasoning must contain inline encrypted state.');
      checkText(item.summary??[],['summary_text'],false);if(item.content!==undefined)checkText(item.content,['reasoning_text'],false);return item;
    }
    if((item.type!==undefined&&item.type!=='message')||!['system','developer','user','assistant'].includes(String(item.role))||Object.keys(item).some(k=>!['type','role','content','id','status','phase'].includes(k)))reject('Unsupported Responses input type.');
    if('phase'in item&&(item.role!=='assistant'||!['commentary','final_answer'].includes(String(item.phase))))reject('Invalid assistant message phase.');
    checkText(item.content,item.role==='assistant'?['input_text','output_text']:['input_text']);return {...item,role:item.role==='system'?'developer':item.role};
  });
  if(value.instructions!==undefined&&typeof value.instructions!=='string')reject('Invalid instructions.');
  const validateTool=(tool:unknown)=>{if(!record(tool)||tool.type!=='function'||typeof tool.name!=='string'||Object.keys(tool).some(k=>!['type','name','description','parameters','strict'].includes(k))||!record(tool.parameters))reject('Only function tools are supported.');return tool;};
  let tools:unknown[]|undefined;
  if(value.tools!==undefined){if(!Array.isArray(value.tools))reject('Invalid tools.');const functions=value.tools.flatMap(tool=>{if(record(tool)&&tool.type==='namespace'){if(tool.name!=='chestnut'||!Array.isArray(tool.tools)||Object.keys(tool).some(k=>!['type','name','description','tools'].includes(k)))reject('Only the Chestnut function namespace is supported.');return tool.tools.map(validateTool);}return [validateTool(tool)];});tools=functions.length?[{type:'namespace',name:'chestnut',tools:functions}]:[];}
  if(value.tool_choice!==undefined&&!['auto','none','required'].includes(String(value.tool_choice)))reject('Invalid tool choice.');
  if(value.reasoning!==undefined&&(!record(value.reasoning)||Object.keys(value.reasoning).some(k=>!['effort','summary'].includes(k))))reject('Invalid reasoning options.');
  if(value.text!==undefined&&(!record(value.text)||Object.keys(value.text).some(k=>!['format','verbosity'].includes(k))))reject('Invalid text options.');
  if(value.include!==undefined&&(!Array.isArray(value.include)||value.include.some(x=>x!=='reasoning.encrypted_content')))reject('Unsupported included data.');
  // store:false replay needs the opaque reasoning state even when Pi has reasoning
  // disabled or omits include. Never weaken validation to accept server-side IDs.
  const body:Record<string,unknown>={...value,input,include:['reasoning.encrypted_content'],...(tools?{tools}:{})};
  // ChatGPT plan usage rejects these fields. Bounds are enforced by deadline and stream bytes instead.
  for(const field of ['max_output_tokens','temperature','top_p','prompt_cache_retention','prompt_cache_options','service_tier'])delete body[field];
  return body;
}

async function prepareSocketDirectory(socketPath: string): Promise<void> {
  if (!isAbsolute(socketPath) || resolve(socketPath) !== socketPath || socketPath.includes('\0')) {
    throw new Error('Gateway socket path must be a normalized absolute path.');
  }
  const parent = dirname(socketPath);
  const root = parse(parent).root;
  let current = root;
  for (const component of parent.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Gateway path must not contain symlinks.');
  }
  const info = await lstat(parent);
  if ((info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Gateway socket directory must be owned by this user with mode 0700.');
  }
  try {
    await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Never unlink a stale socket or another file on startup.
  throw new Error('Gateway socket path already exists.');
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
    return Promise.reject(new GatewayError(413, 'Request body exceeds 2 MiB.'));
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const clean = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => { clean(); request.pause(); rejectBody(error); };
    const onError = (error: Error) => fail(error);
    const onAbort = () => fail(signal.reason);
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) return fail(new GatewayError(413, 'Request body exceeds 2 MiB.'));
      chunks.push(chunk);
    };
    const onEnd = () => {
      clean();
      try { resolveBody(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))); }
      catch { rejectBody(new GatewayError(400, 'Invalid JSON body.')); }
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Redact an accidental upstream echo of the exact key, even across chunks. */
class SecretRedactor extends Transform {
  readonly secret: Buffer;
  pending = Buffer.alloc(0);
  constructor(secret: string) { super(); this.secret = Buffer.from(secret); }
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    let match = data.indexOf(this.secret, offset);
    while (match !== -1) {
      this.push(data.subarray(offset, match));
      this.push('[REDACTED]');
      offset = match + this.secret.length;
      match = data.indexOf(this.secret, offset);
    }
    let held = Math.min(this.secret.length - 1, data.length - offset);
    while (held > 0 && !data.subarray(data.length - held).equals(this.secret.subarray(0, held))) held--;
    this.push(data.subarray(offset, data.length - held));
    this.pending = Buffer.from(data.subarray(data.length - held));
    callback();
  }
  _flush(callback: TransformCallback): void { this.push(this.pending); this.pending = Buffer.alloc(0); callback(); }
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', connection: 'close',
  });
  response.end(JSON.stringify({ error: { message, type: 'gateway_error' } }));
}

/** Internal HTTP core, exported to enable tests without opening a network socket. */
export function createGatewayHttpServer(options: Omit<ModelGatewayOptions, 'socketPath'>): {
  server: Server;
  close(): Promise<void>;
} {
  const { apiKey, model } = options;
  if (!options.getApiKey && (!apiKey || !/^[\x21-\x7e]{1,4096}$/.test(apiKey))) throw new Error('A valid API key is required.');
  if (!model || typeof model !== 'string' || model.length > 200) throw new Error('A model is required.');
  // Literal allowlist, not a hostname suffix check. Disable redirects as well.
  const base = options.upstreamBaseUrl ?? 'https://api.openai.com/v1';
  if (base !== 'https://api.openai.com/v1' && base !== 'https://api.openai.com/v1/') {
    throw new Error('Only the official OpenAI HTTPS v1 endpoint is allowed.');
  }
  const tokenCap = options.maxOutputTokens ?? 4096;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(tokenCap) || tokenCap < 1) throw new Error('Invalid output token cap.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid request timeout.');
  const endpoint = options.apiProtocol==='responses' ? '/v1/responses' : '/v1/chat/completions';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controllers = new Set<AbortController>();
  const sockets = new Set<Socket>();
  let active = 0;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    if(options.authorize && !options.authorize()){sendError(response,403,'Model capability is no longer authorized.');return;}
    // Never use the incoming host, authorization, proxy, or arbitrary headers.
    if (request.method !== 'POST' || request.url !== endpoint) {
      sendError(response, 404, 'Endpoint not found.'); return;
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) {
      sendError(response, 415, 'Content-Type must be application/json.'); return;
    }
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
      sendError(response, 415, 'Encoded request bodies are not supported.'); return;
    }
    if (active >= CONCURRENCY_LIMIT) { sendError(response, 429, 'Gateway concurrency limit reached.'); return; }
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    timer.unref();
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    request.once('aborted', disconnect);
    response.once('close', disconnect);
    void (async () => {
      try {
        const incoming=await readBody(request,controller.signal);
        const body=options.apiProtocol==='responses'?validateResponses(incoming,model):validateRequest(incoming,model,tokenCap);
        const credential=options.getApiKey?await options.getApiKey(controller.signal):apiKey!;
        if(!/^[\x21-\x7e]{1,16000}$/.test(credential))throw new GatewayError(401,'Model credential unavailable.');
        if(options.authorize && !options.authorize())throw new GatewayError(403,'Model capability is no longer authorized.');
        const upstream = await fetchImpl(`https://api.openai.com${endpoint}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {
            authorization: `Bearer ${credential}`, 'content-type': 'application/json',
            accept: body.stream === true ? 'text/event-stream' : 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!upstream.ok) {
          await upstream.body?.cancel().catch(() => {});
          // Upstream errors can contain credential fragments. Never forward them.
          sendError(response, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502,
            'The upstream model request failed.');
          return;
        }
        response.writeHead(200, {
          'content-type': body.stream === true ? 'text/event-stream; charset=utf-8' : 'application/json',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        });
        response.flushHeaders();
        if (!upstream.body) { response.end(); return; }
        let responseBytes=0;const limiter=new Transform({transform(chunk:Buffer,_encoding,done){responseBytes+=chunk.length;if(responseBytes>8*1024*1024)done(new Error('Model stream exceeded limit'));else done(null,chunk);}});
        await pipeline(Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>), limiter, new SecretRedactor(credential), response,
          { signal: controller.signal });
      } catch (error) {
        if (timedOut) sendError(response, 504, 'The model request timed out.');
        else if (error instanceof GatewayError) sendError(response, error.status, error.message);
        else if (!controller.signal.aborted) sendError(response, 502, 'The model gateway request failed.');
      } finally {
        clearTimeout(timer);
        request.off('aborted', disconnect);
        response.off('close', disconnect);
        controllers.delete(controller);
        active--;
      }
    })();
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 32;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  let closing: Promise<void> | undefined;
  return {
    server,
    close() {
      closing ??= (async () => {
        for (const controller of controllers) controller.abort();
        for (const socket of sockets) socket.destroy();
        if (server.listening) {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          });
        }
      })();
      return closing;
    },
  };
}

export async function startModelGateway(options: ModelGatewayOptions): Promise<{ close(): Promise<void> }> {
  const { socketPath } = options;
  if(Buffer.byteLength(socketPath)>103)throw new Error('Gateway socket path is too long; use a shorter CHESTNUT_DATA_DIR (for example /tmp/chestnut-pi)');
  const gateway = createGatewayHttpServer(options);
  const { server } = gateway;
  await prepareSocketDirectory(socketPath);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(socketPath, () => { server.off('error', rejectListen); resolveListen(); });
  });
  const ownedSocket = await lstat(socketPath);
  if (!ownedSocket.isSocket() || ownedSocket.isSymbolicLink()) {
    server.close();
    throw new Error('Gateway failed to create a Unix socket.');
  }
  try { await chmod(socketPath, 0o600); }
  catch (error) { server.close(); throw error; }
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        await gateway.close();
        // Node normally removes its Unix socket itself; this is a guarded fallback.
        try {
          const current = await lstat(socketPath);
          if (current.isSocket() && current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) {
            await unlink(socketPath);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      })();
      return closing;
    },
  };
}
