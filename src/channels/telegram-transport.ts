/** Telegram transport deliberately drops raw URL/provider/error strings: bot URLs contain secrets. */
export type TelegramErrorKind = 'rate_limited' | 'unauthorized' | 'forbidden' | 'conflict' | 'rejected' | 'unavailable' | 'invalid_response' | 'network' | 'stopped';
export class TelegramError extends Error {
  readonly kind: TelegramErrorKind;
  readonly retryAfterMs: number;
  constructor(kind: TelegramErrorKind, retryAfterMs = 0) { super(`Telegram ${kind}`); this.kind = kind; this.retryAfterMs = retryAfterMs; }
}
export type TelegramFetch = (input: string, init: RequestInit) => Promise<Response>;
const MAX_RESPONSE_BYTES = 1_048_576;
export class TelegramTransport {
  #token: string;
  private fetcher: TelegramFetch;
  constructor(token: string, fetcher: TelegramFetch = fetch) { this.#token = token; this.fetcher = fetcher; }
  async call(method: 'getUpdates' | 'sendMessage', body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 15_000)]);
      const response = await this.fetcher(`https://api.telegram.org/bot${this.#token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: deadline,
      });
      // Consume with a hard cap; never include remote descriptions or body bytes in errors.
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new TelegramError('invalid_response'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      let parsed: any;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new TelegramError('invalid_response'); }
      if (!response.ok || parsed?.ok !== true) {
        const code = Number.isSafeInteger(parsed?.error_code) ? parsed.error_code : response.status;
        if (code === 429) {
          const seconds = parsed?.parameters?.retry_after;
          // Respect the server's delay, with a finite one-day bound; excessive values halt retry.
          if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) throw new TelegramError('rejected');
          throw new TelegramError('rate_limited', seconds * 1000);
        }
        throw new TelegramError(code === 401 ? 'unauthorized' : code === 403 ? 'forbidden' : code === 409 ? 'conflict' : code >= 500 ? 'unavailable' : 'rejected');
      }
      return parsed.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError(signal.aborted ? 'stopped' : 'network');
    }
  }
}
