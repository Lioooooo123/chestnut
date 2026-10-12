import { isId } from '../types.ts';
import type { Store } from '../store.ts';

/** Outer channel-process input. Never attach this object to API/worker configuration. */
export interface TelegramConfig {
  token: string;
  telegramBotId: string;
  ownerId: string;
  chatId: string;
  botId: string;
}
const positiveId = (value: string | undefined) => !!value && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
export function telegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  if (env.CHESTNUT_TELEGRAM_ENABLED && !['0', '1'].includes(env.CHESTNUT_TELEGRAM_ENABLED)) throw new Error('CHESTNUT_TELEGRAM_ENABLED must be 0 or 1');
  if (env.CHESTNUT_TELEGRAM_ENABLED !== '1') return null;
  const token = env.CHESTNUT_TELEGRAM_BOT_TOKEN ?? '';
  if (!/^[1-9]\d{3,15}:[A-Za-z0-9_-]{20,128}$/.test(token)) throw new Error('Telegram bot token is missing or invalid');
  const ownerId = env.CHESTNUT_TELEGRAM_OWNER_ID, chatId = env.CHESTNUT_TELEGRAM_CHAT_ID, botId = env.CHESTNUT_TELEGRAM_BOT_ID;
  if (!positiveId(ownerId) || !positiveId(chatId)) throw new Error('Telegram requires explicit positive numeric owner and private chat IDs');
  if (!isId(botId)) throw new Error('Telegram requires an existing Chestnut bot UUID');
  return { token, telegramBotId: token.split(':')[0]!, ownerId: ownerId!, chatId: chatId!, botId };
}

/** Read-only status safe for the local API. Does not parse, return, or persist a token. */
export function telegramReadiness(store: Store, env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.CHESTNUT_TELEGRAM_ENABLED === '1';
  const configured = (env.CHESTNUT_TELEGRAM_TOKEN_CONFIGURED === '1' || !!env.CHESTNUT_TELEGRAM_BOT_TOKEN)
    && positiveId(env.CHESTNUT_TELEGRAM_OWNER_ID) && positiveId(env.CHESTNUT_TELEGRAM_CHAT_ID) && isId(env.CHESTNUT_TELEGRAM_BOT_ID);
  const exists = !!store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_channel'");
  const row = exists ? store.get<{ botId: string; status: string; leaseUntil: number; lastSeen: number | null; lastError: string | null }>('SELECT botId,status,leaseUntil,lastSeen,lastError FROM telegram_channel WHERE id=1') : undefined;
  const counts = exists ? store.all<{ state: string; count: number }>('SELECT state,COUNT(*) AS count FROM telegram_deliveries GROUP BY state') : [];
  return { enabled, configured: !!configured, mode: 'private-long-poll' as const,
    botId: isId(env.CHESTNUT_TELEGRAM_BOT_ID) ? env.CHESTNUT_TELEGRAM_BOT_ID : null,
    online: enabled && !!row && row.leaseUntil > Date.now() && row.status === 'running',
    status: !enabled ? 'disabled' : !configured ? 'unconfigured' : row?.status ?? 'not-started',
    lastSeen: row?.lastSeen ?? null, lastError: row?.lastError ?? null,
    deliveries: Object.fromEntries(counts.map(item => [item.state, item.count])) };
}
