# Personal Telegram task channel

Chestnut includes an opt-in Telegram **private-chat, plain-text, long-poll** adapter. It accepts requests from one explicitly configured Telegram user in one explicitly configured private chat, addressed to one existing Chestnut bot. The existing task queue, worker leases, command handling, cancellation, follow-up dependencies, and sandbox boundary remain authoritative.

This implementation is synthetic-test verified. No real token, Telegram account, external message, deployment, or public listener was used for the implementation checks. Operator-controlled live verification remains required before relying on it.

## Configure on the outer host

1. Create a Telegram bot using the official [BotFather flow](https://core.telegram.org/bots/tutorial#obtain-your-bot-token). Keep its token off task prompts, screenshots, chat messages, guest files, and source control.
2. Create or select a Chestnut bot in the local dashboard and copy its UUID.
3. Verify your numeric Telegram user ID and the private chat ID using an update you manually review from the [Telegram Bot API](https://core.telegram.org/bots/api#getupdates). Both values must be explicitly configured. There is no automatic enrollment, username matching, or first-sender trust.
4. Put the following configuration in the protected outer environment or an owner-readable `.env` file. Do not paste a real token into this document. Restrict the file to its OS owner, and use a separate data directory if switching the channel's owner, chat, Telegram bot, or Chestnut bot.

```dotenv
CHESTNUT_TELEGRAM_ENABLED=1
CHESTNUT_TELEGRAM_BOT_TOKEN=<secret from BotFather>
CHESTNUT_TELEGRAM_OWNER_ID=<positive numeric user ID>
CHESTNUT_TELEGRAM_CHAT_ID=<positive numeric private chat ID>
CHESTNUT_TELEGRAM_BOT_ID=<existing Chestnut bot UUID>
```

The dedicated `channel` CLI process performs outbound HTTPS polling and sending. The coordinator worker must also run to execute tasks. `dev` can supervise the optional channel process alongside the API and worker. Only the channel process receives the Telegram token; the API receives a boolean configured marker. The token is not part of the application `Config` or readiness response.

Do not configure a Telegram webhook for this bot. The adapter does not create, delete, or modify webhooks; a webhook conflict or another active poller blocks startup/polling with a safe diagnostic. The API continues to bind only to loopback. No inbound port, public domain, tunnel, or public webhook is required.

## Commands

| Input | Behavior |
| --- | --- |
| Ordinary text | Creates a durable task for the configured Chestnut bot |
| `/help` or `/start` | Explains commands |
| `/status` | Worker presence and the five most recent tasks for that bot |
| `/status <task UUID>` | Current task state and bounded result, if successful |
| `/cancel <task UUID>` | Requests cancellation using the existing command path |
| `/steer <task UUID> <instruction>` | Queues steering for a running task |
| `/followup <task UUID> <instruction>` | Queues a dependent follow-up task |

Task UUIDs are explicit for commands that change work. Text is bounded to 4,096 characters. Edited messages, group/channel posts, other senders, forwarded or bot-mediated content, attachments, voice, callbacks, business updates, and guest updates are not task inputs. Unsupported content from the allowed owner receives a short explanation; unauthorized input receives no response and its content is not stored. Token-looking text is rejected before it reaches the task queue.

This channel does not grant a new ability to execute arbitrary host commands, install tools, access credentials, or bypass approvals. It only submits the same task and command records used by the local dashboard.

## Receipts, progress, and recovery

Accepted requests receive a queued receipt containing the task UUID. Progress notifications cover task state changes, not token-by-token model output or raw tool logs. Terminal notifications cover success, failure, cancellation, or interruption. Results are plain text with previews disabled, credential-shaped strings redacted, and a truncation notice when necessary. Open the local dashboard for full results and failure details.

An accepted cancellation or steering receipt is not a claim that an agent applied the command. A cancellation completion notification reflects the coordinator's terminal task state. An interrupted task has an unknown outcome and is never automatically resubmitted.

Channel state is stored in `telegram_*` tables in the existing protected SQLite database:

- Incoming IDs and the next polling offset are durable. A deterministic UUID maps each update to the coordinator's existing idempotent submission/command handling.
- If the process crashes between task submission and channel checkpoint, replay completes the handoff without creating another task or command.
- A delivery record and its dedupe key are committed before sending. Pending deliveries survive restart.
- Telegram's `sendMessage` does not accept an idempotency key. A timeout, dropped connection, invalid response, server failure, or crash after dispatch may have delivered the message. Such records become `uncertain` and are **not automatically resent**. This avoids duplicate external messages at the cost of a possibly missing notification. `/status <task UUID>` is an explicit way to retrieve current results.
- A definite flood-control rejection retries at the supplied deadline, up to five attempts. Other definite rejections become `failed`. Failed and uncertain counts are available in token-free readiness.
- An exclusive, renewable SQLite lease prevents two local channel processes from polling/sending together. Restart after a hard crash waits for the previous 60-second lease to expire. Changing the binding fails closed instead of sending old queued messages to a new owner or chat.

Operational bounds include 50 updates per poll, a 1 MiB response cap, request deadlines, one outgoing attempt per second, bounded exponential polling backoff, a 200-pending-delivery ingress threshold, and at most 100 task projections per delivery tick. Telegram retains unreceived updates for a limited time, so extended downtime or delivery backpressure can lose older inputs; there is no promise of indefinite offline delivery. Durable task and receipt history is retained in SQLite and follows the application's local data lifecycle.

## Integration hooks

```typescript
import { TelegramChannelRunner, telegramConfig, telegramReadiness } from './channels/telegram.ts';

const channel = telegramConfig(process.env); // null unless explicitly enabled
if (channel) {
  const runner = new TelegramChannelRunner(store, channel);
  process.once('SIGINT', () => runner.stop());
  process.once('SIGTERM', () => runner.stop());
  await runner.run(); // Abortable poll loop, delivery loop, and lease lifecycle
}
// Safe to expose to the loopback dashboard:
const readiness = telegramReadiness(store, process.env);
```

Do not pass `channel` into the API, worker, sandbox configuration, logging, or task events. Strip `CHESTNUT_TELEGRAM_BOT_TOKEN` from API and worker child environments; set only `CHESTNUT_TELEGRAM_TOKEN_CONFIGURED=1` for readiness. The runner and transport retain the token in private fields and errors discard provider bodies/URLs.

## Verification

Run `node --test tests/telegram-channel.test.ts` and `npm run typecheck`, then the repository-wide checks. Synthetic fetch tests cover owner/chat isolation, unsupported data, commands, cancellation, receipts/progress/results, state persistence, restart dedupe, partial handoff recovery, malformed responses, secret redaction, ambiguous and failed deliveries, flood-control bounds, poll backoff, exclusive leases, shutdown, and backlog control. They open no HTTP server and send no external requests.

For a later live opt-in check, use a dedicated test bot and private chat. Confirm exactly one task and receipt on replay, commands operate only on the configured Chestnut bot, group/unknown-user messages cannot create work, worker interruption stays interrupted, and a stopped/restarted channel retains pending receipts. Do not call a live check complete without observing both the Telegram message and the corresponding local task state.

## Memoh mapping and deliberate scope

The [Memoh Telegram integration](https://docs.memoh.ai/integrations/channels/telegram.html) provides the design reference for binding a communication channel to a bot. Chestnut maps that channel concept onto its existing SQLite task coordinator and outer credential boundary. This first personal-self-hosted implementation deliberately keeps a single explicit owner/chat binding, long polling, and plain text. Rich streaming, attachments, multiple channel accounts, channel setup UI, group permissions, and webhook hosting are not implemented.

Protocol references: [getUpdates](https://core.telegram.org/bots/api#getupdates), [sendMessage](https://core.telegram.org/bots/api#sendmessage), and [ResponseParameters](https://core.telegram.org/bots/api#responseparameters).
