# Threadline

A Claude chat app with Slack-style threads. Reply to any message in a side thread; threads stay out of the main conversation's context until you graft a compact summary back in.

## How context works

- **Main conversation (trunk):** sees every trunk message plus any graft summaries. Never sees thread contents.
- **Thread:** sees the trunk up to and including the message it branched from, plus its own replies. Nothing later in the trunk, nothing from other threads.
- **Graft:** a cheap model (Haiku by default) compresses the thread into Topic / Decisions / Resolutions / Clarifications / Open, which is inserted into the trunk wrapped in `<thread_graft>` tags. You can edit or remove a graft afterwards, and graft again if the thread keeps going.
- **Prompt caching:** each request marks cache breakpoints so repeated turns reuse the conversation prefix. Hover a reply to see its token usage, including how much came from cache. (Caching only kicks in once a prefix passes the model's minimum cacheable length, so short chats won't show cache hits.)

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. In the same project: **New → Database → PostgreSQL**.
4. On the app service, open **Variables** and add:
   - `ANTHROPIC_API_KEY` – from console.anthropic.com
   - `DATABASE_URL` – set to `${{Postgres.DATABASE_URL}}` (reference variable)
   - `APP_PASSWORD` – anything long; the app asks for it once per browser
5. **Settings → Networking → Generate Domain**, then open the URL.

Tables are created automatically on first start.

## Run locally

```bash
cp .env.example .env   # fill in values; needs a local Postgres
npm install
npm run dev
```

Open http://localhost:3000.

## Project layout

```
server.js        Express API, SSE streaming, grafting
context.js       Builds trunk/thread/graft requests and cache breakpoints
db.js            Postgres pool and schema
public/          Frontend (vanilla JS, no build step)
```

The frontend uses no inline scripts and loads its libraries from the server rather than a CDN, so it can later be dropped into a Chrome extension side panel (Manifest V3 rules) for the tab-control phase.
