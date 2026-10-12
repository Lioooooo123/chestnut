# Chestnut dashboard

A build-free browser client. The API server serves `index.html`, `styles.css`, and `app.js` from this directory at the same origin. No CDN, external fonts, trackers, npm runtime dependencies, or frontend build step are required.

## Behavior

- Create and switch between bots; drafts stay in memory when switching.
- Submit tasks, inspect task-specific states, output, errors, and expandable events.
- Steer running tasks at the next worker boundary; queue follow-ups as new tasks.
- Disable follow-ups after cancellation or interruption; cancelled/interrupted work can be restarted from the main composer.
- Request cancellation and wait for the server's actual terminal state.
- Show demo mode, worker connectivity, request failures, and sandbox quarantines explicitly.
- Poll every two seconds while visible. Keep existing history when a refresh fails.
- Use a stable UUID to retry the same failed task or command in the current page. Duplicate clicks are disabled. Request IDs and drafts are not persisted across reloads.
- Keep only the selected bot ID in local storage. There is no frontend token storage.
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

The expanded management suite currently has 34 passing controller tests, including the original task/memory/auth tests. They are not real-browser or visual tests. Live browser verification was blocked in the earlier cloud build environment. The macOS closeout checked Safari desktop rendering, Bot creation, task submission, running status and final result against the loopback model-less API/Worker with sample data. Mobile rendering, other browsers and real-model interaction remain unverified; see `docs/verification.md`.


## New management UI verification

The Environment and Schedules additions were verified on 2026-10-12 using socket-free mocked-DOM tests, `node --check web/app.js`, and whitespace checks. These new views have **not** had a real-browser, screenshot, mobile, screen-reader or visual pass in this executor. Earlier Safari results cover the older dashboard only. No live Docker/service persistence, package installation, HTTPS fetch, scheduler delivery or Telegram message is claimed. See `docs/dashboard-management.md` for coverage and manual acceptance steps.
