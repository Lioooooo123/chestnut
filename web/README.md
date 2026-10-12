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

## Tests

Run from the repository root:

    node --test web/dashboard.test.cjs

These are dependency-free, socket-free controller tests with a minimal DOM and a mocked API. They cover empty/create flows, duplicate submits, retry IDs, steering/follow-ups, cancellation, interrupted states, event cursors, safe text rendering, draft retention, offline/quarantine states, and polling visibility.

They are not real-browser or visual tests. Live browser verification was blocked in the earlier cloud build environment. The macOS closeout checked Safari desktop rendering, Bot creation, task submission, running status and final result against the loopback model-less API/Worker with sample data. Mobile rendering, other browsers and real-model interaction remain unverified; see `docs/verification.md`.
