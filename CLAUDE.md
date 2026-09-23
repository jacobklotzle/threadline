# CLAUDE.md

Guidance for Claude Code when working in this repo. Read this before making changes.

## What this is

Threadline is a personal Claude chat web app with Slack-style threads. The owner built it because claude.ai has no way to reply to part of a conversation in a side thread without bloating the main conversation's context.

Core idea: a main conversation (the "trunk") plus side threads that branch off individual trunk messages. Threads are isolated to save tokens. When a thread reaches something worth keeping, the user "grafts" it: a cheap model summarizes it and the summary is inserted into the trunk.

Stack: Node 20+ (ESM), Express 5, Postgres (`pg`), `@anthropic-ai/sdk`, vanilla JS frontend with no build step. Hosted on Railway (app service + Railway Postgres).

## Commands

- `npm install`
- `npm run dev`: runs with `--watch`, loads `.env` if present
- `npm start`: production start (used by Railway)
- Health check: `GET /health`

Required env vars: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `APP_PASSWORD`. Optional: `CHAT_MODEL` (default `claude-sonnet-5`), `SUMMARY_MODEL` (default `claude-haiku-4-5-20251001`), `MAX_TOKENS` (default 4096). See `.env.example`.

The schema is created automatically on startup (`migrate()` in `db.js`, `CREATE TABLE IF NOT EXISTS`). There is no migration tool yet; if the schema needs a breaking change, add one (e.g. node-pg-migrate) rather than editing `migrate()` in ways that fail on an existing database.

## Files

- `server.js`: Express app, auth middleware, REST routes, SSE streaming, graft endpoint
- `context.js`: builds the message arrays sent to Claude (trunk, thread, graft) and places prompt-cache breakpoints. Most context logic lives here.
- `db.js`: Postgres pool and schema
- `public/index.html`, `public/styles.css`, `public/app.js`: frontend
- `railway.json`: Railway deploy config

## Data model

One `messages` table holds the trunk and every thread:

- `thread_root_id IS NULL`: message is on the trunk
- `thread_root_id = <trunk message id>`: reply inside that message's thread
- `kind = 'graft'`: a thread summary living on the trunk (stored as `role = 'user'`), with `source_thread_id` pointing at the thread's anchor message
- Ordering uses `seq` (bigserial), never `created_at`
- `usage` (jsonb) stores the API usage object for assistant replies and grafts

Threads only branch from trunk messages. Threads inside threads are not supported, on purpose (same as Slack).

## Context rules (the most important part; don't break these)

1. **Trunk request** = all trunk messages in order, including graft summaries. Never includes thread contents.
2. **Thread request** = trunk messages up to and including the anchor (by `seq`), then the thread's replies. It excludes later trunk messages and other threads. The first thread message is prefixed with `(Replying in a thread on the message above.)` so the model can see where the branch starts, even when turns merge.
3. **Graft request** = only the anchor message plus the thread transcript, sent to `SUMMARY_MODEL`. The output format (Topic / Decisions / Resolutions / Clarifications / Open, empty sections omitted) is meant for another model to read, not a human. Grafts are wrapped in `<thread_graft>` tags when sent back in the trunk.
4. Consecutive same-role turns are merged into one message with multiple content blocks (`mergeTurns`). This happens whenever a graft is followed by a user message.
5. **Prompt caching:** trunk requests put a breakpoint on the newest message. Thread requests put one on the anchor (so all turns of a thread reuse the cached prefix) and one on the newest message. The API allows 4 breakpoints; we use at most 2. The thread system prompt is deliberately constant (no per-thread details) so the cached prefix stays reusable.

Token efficiency is the owner's top priority. Any feature that adds context to requests needs a clear reason.

## API surface

All `/api/*` routes require `Authorization: Bearer <APP_PASSWORD>` (compared with `timingSafeEqual`).

- `GET/POST /api/conversations`, `PATCH/DELETE /api/conversations/:id`
- `GET /api/conversations/:id`: trunk messages plus a `threads` map of `{ rootId: { count, last_at } }`
- `GET /api/threads/:rootId`: anchor plus thread replies
- `POST /api/conversations/:id/messages` with `{ content, threadRootId? }`: streams SSE events `user` (the saved user row), `delta` (`{text}`), `done` (`{message, usage}`), `error`. On failure or client disconnect, partial text is still saved so the history keeps alternating user/assistant turns.
- `POST /api/threads/:rootId/graft`: returns the new graft row
- `PATCH/DELETE /api/messages/:id`: edits or removes graft rows only

The conversation title is set from the first trunk message (truncated to 60 characters); no API call is made for it.

## Frontend conventions

These keep the frontend portable into a Chrome extension side panel (Manifest V3) for phase 2:

- **No inline scripts or inline event handlers.** All JS lives in `public/app.js`.
- **No remote JS.** Libraries (`marked`, `DOMPurify`) are served from `node_modules` via `/vendor/*`. Don't add CDN script tags.
- Always sanitize rendered markdown with DOMPurify.
- It must work at side-panel width (~400px). Below 960px the sidebar becomes a drawer and the thread panel covers the full view.
- Keep vanilla JS unless the owner agrees to adopt a framework and build step.

Design language: the trunk is drawn as a vertical rail with a node for each message. Messages that have threads sprout a moss-green branch pill; grafts rejoin the rail as ochre diamond nodes with a collapsible card. Colors are CSS custom properties on `:root`, with light and dark variants. Typeface is Atkinson Hyperlegible Next (JetBrains Mono for code). Keep this identity; don't swap in generic chat-bubble styling. UI copy is sentence case, plain verbs, and the user-facing term is "graft".

## Roadmap

**Phase 1 (current): ship threaded chat.** Deploy to Railway and test against the real API. Possible next items, in rough priority:
- Verify prompt-cache hits on real conversations (the `usage` field shows `cache_read_input_tokens`)
- Stop/cancel button during streaming (the server already aborts on client disconnect)
- Edit and resend a user message
- Search across conversations
- Proper migrations before any schema change
- Tests for `context.js` (pure functions, easy to unit test)

**Phase 2: tab control via a Chrome extension.**
- Package the frontend as an MV3 extension with a side panel that talks to the Railway backend. The API key stays on the server.
- Browser actions use Claude API tool use: define tools like navigate, click, type, read_page, and screenshot. The model returns tool calls, the extension executes them in the active tab (`chrome.scripting`, `chrome.tabs`, `chrome.debugger` if needed), and results go back to the model.
- Prefer reading the page's DOM/accessibility tree over screenshots (cheaper, more accurate).
- Run browsing tasks inside threads so screenshots and step-by-step output stay out of the trunk; graft only the outcome.
- Safety: treat all page content as untrusted (prompt injection), and require user confirmation before form submissions, purchases, sending messages, or other consequential actions.
- Not a server-side headless browser: it wouldn't have the user's tabs or logins.

## Working with the owner

- Explain tradeoffs briefly before large architectural changes, and ask before adding dependencies or a build step.
- Keep changes small and deployable; Railway deploys from the main branch.
- Never commit `.env` or secrets.
