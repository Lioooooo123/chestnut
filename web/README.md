# Chestnut dashboard

A build-free browser client. The API server serves `index.html`, `styles.css`, and `app.js` from this directory at the same origin. No CDN, external fonts, trackers, npm runtime dependencies, or frontend build step are required.

## Behavior

- Create and switch between bots; chat drafts and selected tasks survive same-tab reload in session storage.
- Submit tasks, inspect task-specific states, output, errors, and expandable events.
- Steer running tasks at the next worker boundary; queue follow-ups as new tasks.
- Disable follow-ups after cancellation or interruption; cancelled/interrupted work can be restarted from the main composer.
- Request cancellation and wait for the server's actual terminal state.
- Show demo mode, worker connectivity, request failures, and sandbox quarantines explicitly.
- Poll every two seconds while visible. Keep existing history when a refresh fails.
- Retain stable UUIDs for ambiguous Bot/task/command sends across reload. Query durable server receipts read-only; never automatically resend a mutation. Manual unchanged retries reuse the original ID. Duplicate clicks are disabled.
- Keep only the selected bot ID in local storage; a bounded chat-only journal uses session storage. It excludes model callbacks, credentials and maintenance state. Closing a tab may discard drafts; SQLite history remains.
- Preserve expired Steer drafts without converting them into new work. Copy a terminal task prompt into a fresh composer without execution or overwriting another draft.
- Hide model connection controls in explicit demo mode, which never reads auth status.
- Render API and user text with `textContent`, never HTML.
- Use native labels, keyboard focus, a modal dialog, and Ctrl/Cmd + Enter to submit.
- Inspect per-bot Environment registry state and capability declarations, with explicit not-live-verified wording.
- Edit revision-checked operator package/HTTPS-host allowlists; empty lists deny all access. Policy edits survive polling and bot switches. Conflicts retain the original revision and draft until an explicit reload.
- Request service-environment stop only after an in-page confirmation. Accepted stops remain pending until the worker reports their outcome. Repeated ambiguous requests retain the same request ID.
- Create one-time schedules using explicitly labeled UTC input, or five-field cron with a named IANA time zone. Pause/resume schedules, confirm deletion, and inspect the durable fire ledger. Queued fires are not reported as completed tasks.
- Abort superseded Environment, Schedule and history reads on bot/view switches or history Close. Selection revisions also reject late responses when cancellation is ignored by a transport.
- Preserve schedule drafts per bot; use stable creation request IDs on retries, including an accepted one-time schedule whose due time passed before its response could be confirmed.
- Show token-free Telegram configuration, polling and delivery readiness without sending messages, connecting accounts, or accepting credentials. Setup remains an explicit operator action; see `docs/telegram-channel.md`.
- Disclose the separate bridge-network package downloader. The runtime’s network-none boundary is not described as egress isolation for that helper.

## Tests

Run from the repository root:

    node --test web/dashboard.test.cjs

These are dependency-free, socket-free controller tests with a minimal DOM and a mocked API. They cover empty/create flows, duplicate submits, retry IDs, steering/follow-ups, cancellation, interrupted states, event cursors, safe text rendering, draft retention, offline/quarantine states, and polling visibility.

The suite has 42 passing controller tests, including reload, lost acknowledgments, creation deduplication and expired Steer recovery. They are not real-browser or visual tests. The latest macOS pass separately exercised Safari Bot creation, task/Steer/Follow-up/Cancel, same-tab draft reload, API/Worker restart and history recovery, plus 320/390px read-only WebKit frames. These are simulated tasks, not real AI or real phone hardware; see `docs/mvp-acceptance.md` and `docs/verification.md`.


## New management UI verification

The Environment and Schedules additions were verified on 2026-10-12 using socket-free mocked-DOM tests, `node --check web/app.js`, and whitespace checks. These new views have **not** had a real-browser, screenshot, mobile, screen-reader or visual pass in this executor. Earlier Safari results cover the older dashboard only. No live Docker/service persistence, package installation, HTTPS fetch, scheduler delivery or Telegram message is claimed. See `docs/dashboard-management.md` for coverage and manual acceptance steps.
