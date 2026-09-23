import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { q, migrate } from "./db.js";
import { buildTrunkRequest, buildThreadRequest, buildGraftRequest } from "./context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CHAT_MODEL = process.env.CHAT_MODEL || "claude-sonnet-5";
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 4096);
const APP_PASSWORD = process.env.APP_PASSWORD || "";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}
if (!APP_PASSWORD) {
  console.warn("APP_PASSWORD is not set: the app is open to anyone with the URL. Set it before deploying.");
}

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- static ----------
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor", express.static(path.join(__dirname, "node_modules/marked/lib")));
app.use("/vendor", express.static(path.join(__dirname, "node_modules/dompurify/dist")));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- auth ----------
const digest = (s) => crypto.createHash("sha256").update(s).digest();
app.use("/api", (req, res, next) => {
  if (!APP_PASSWORD) return next();
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (crypto.timingSafeEqual(digest(token), digest(APP_PASSWORD))) return next();
  res.status(401).json({ error: "Password required." });
});

// ---------- helpers ----------
const MSG_COLS = "id, conversation_id, thread_root_id, role, kind, source_thread_id, content, usage, created_at";
const UUID = /^[0-9a-f-]{36}$/i;

function assertUuid(id, res) {
  if (UUID.test(id)) return true;
  res.status(400).json({ error: "Invalid id." });
  return false;
}

async function trunkRows(conversationId, uptoSeq = null) {
  const { rows } = await q(
    `SELECT ${MSG_COLS}, seq FROM messages
     WHERE conversation_id = $1 AND thread_root_id IS NULL ${uptoSeq ? "AND seq <= $2" : ""}
     ORDER BY seq`,
    uptoSeq ? [conversationId, uptoSeq] : [conversationId]
  );
  return rows;
}

async function threadRows(rootId) {
  const { rows } = await q(
    `SELECT ${MSG_COLS} FROM messages WHERE thread_root_id = $1 ORDER BY seq`,
    [rootId]
  );
  return rows;
}

async function getMessage(id) {
  const { rows } = await q(`SELECT ${MSG_COLS}, seq FROM messages WHERE id = $1`, [id]);
  return rows[0];
}

async function insertMessage({ conversationId, threadRootId = null, role, kind = "message", sourceThreadId = null, content, usage = null }) {
  const { rows } = await q(
    `INSERT INTO messages (conversation_id, thread_root_id, role, kind, source_thread_id, content, usage)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${MSG_COLS}`,
    [conversationId, threadRootId, role, kind, sourceThreadId, content, usage]
  );
  await q("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
  return rows[0];
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- conversations ----------
app.get("/api/conversations", async (_req, res) => {
  const { rows } = await q("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 200");
  res.json(rows);
});

app.post("/api/conversations", async (req, res) => {
  const title = (req.body?.title || "New conversation").slice(0, 120);
  const { rows } = await q("INSERT INTO conversations (title) VALUES ($1) RETURNING id, title, updated_at", [title]);
  res.status(201).json(rows[0]);
});

app.patch("/api/conversations/:id", async (req, res) => {
  if (!assertUuid(req.params.id, res)) return;
  const title = String(req.body?.title || "").trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: "Title can't be empty." });
  const { rows } = await q("UPDATE conversations SET title = $2 WHERE id = $1 RETURNING id, title, updated_at", [req.params.id, title]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: "Conversation not found." });
});

app.delete("/api/conversations/:id", async (req, res) => {
  if (!assertUuid(req.params.id, res)) return;
  await q("DELETE FROM conversations WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

// Trunk messages plus a reply count for every message that has a thread.
app.get("/api/conversations/:id", async (req, res) => {
  if (!assertUuid(req.params.id, res)) return;
  const conv = await q("SELECT id, title, updated_at FROM conversations WHERE id = $1", [req.params.id]);
  if (!conv.rows[0]) return res.status(404).json({ error: "Conversation not found." });
  const trunk = await trunkRows(req.params.id);
  const counts = await q(
    `SELECT thread_root_id, count(*)::int AS count, max(created_at) AS last_at
     FROM messages WHERE conversation_id = $1 AND thread_root_id IS NOT NULL
     GROUP BY thread_root_id`,
    [req.params.id]
  );
  const threads = Object.fromEntries(counts.rows.map((r) => [r.thread_root_id, { count: r.count, last_at: r.last_at }]));
  res.json({ conversation: conv.rows[0], trunk: trunk.map(({ seq, ...m }) => m), threads });
});

app.get("/api/threads/:rootId", async (req, res) => {
  if (!assertUuid(req.params.rootId, res)) return;
  const root = await getMessage(req.params.rootId);
  if (!root || root.thread_root_id) return res.status(404).json({ error: "Thread anchor not found." });
  const { seq, ...anchor } = root;
  res.json({ root: anchor, messages: await threadRows(root.id) });
});

// ---------- send a message (trunk or thread), streamed back as SSE ----------
app.post("/api/conversations/:id/messages", async (req, res) => {
  if (!assertUuid(req.params.id, res)) return;
  const conversationId = req.params.id;
  const content = String(req.body?.content || "").trim();
  const threadRootId = req.body?.threadRootId || null;
  if (!content) return res.status(400).json({ error: "Message is empty." });

  let root = null;
  if (threadRootId) {
    if (!assertUuid(threadRootId, res)) return;
    root = await getMessage(threadRootId);
    if (!root || root.conversation_id !== conversationId || root.thread_root_id) {
      return res.status(400).json({ error: "Threads can only branch from main-conversation messages." });
    }
  }

  const conv = await q("SELECT title FROM conversations WHERE id = $1", [conversationId]);
  if (!conv.rows[0]) return res.status(404).json({ error: "Conversation not found." });

  const userMsg = await insertMessage({ conversationId, threadRootId, role: "user", content });

  // Name the conversation after its first trunk message (no API call needed).
  if (!threadRootId && conv.rows[0].title === "New conversation") {
    const title = content.replace(/\s+/g, " ").slice(0, 60) + (content.length > 60 ? "…" : "");
    await q("UPDATE conversations SET title = $2 WHERE id = $1", [conversationId, title]);
  }

  const request = threadRootId
    ? buildThreadRequest(await trunkRows(conversationId, root.seq), await threadRows(threadRootId))
    : buildTrunkRequest(await trunkRows(conversationId));

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  sse(res, "user", userMsg);

  let text = "";
  let clientGone = false;
  const stream = anthropic.messages.stream({ model: CHAT_MODEL, max_tokens: MAX_TOKENS, ...request });
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      stream.abort();
    }
  });
  stream.on("text", (delta) => {
    text += delta;
    if (!clientGone) sse(res, "delta", { text: delta });
  });

  try {
    const final = await stream.finalMessage();
    const assistant = await insertMessage({ conversationId, threadRootId, role: "assistant", content: text, usage: final.usage });
    sse(res, "done", { message: assistant, usage: final.usage });
  } catch (err) {
    // Keep whatever arrived so the history stays consistent (user turn, then assistant turn).
    const partial = text || "(No reply. The request failed before Claude responded.)";
    const assistant = await insertMessage({ conversationId, threadRootId, role: "assistant", content: partial }).catch(() => null);
    if (!clientGone) sse(res, "error", { error: err?.message || "Request failed.", message: assistant });
    console.error("stream error:", err?.message);
  }
  if (!clientGone) res.end();
});

// ---------- graft a thread's summary into the trunk ----------
app.post("/api/threads/:rootId/graft", async (req, res) => {
  if (!assertUuid(req.params.rootId, res)) return;
  const root = await getMessage(req.params.rootId);
  if (!root || root.thread_root_id) return res.status(404).json({ error: "Thread anchor not found." });
  const replies = await threadRows(root.id);
  if (!replies.length) return res.status(400).json({ error: "This thread has no replies to summarize." });

  try {
    const response = await anthropic.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 1024,
      ...buildGraftRequest(root, replies),
    });
    const summary = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const graft = await insertMessage({
      conversationId: root.conversation_id,
      role: "user",
      kind: "graft",
      sourceThreadId: root.id,
      content: summary,
      usage: response.usage,
    });
    res.status(201).json(graft);
  } catch (err) {
    console.error("graft error:", err?.message);
    res.status(502).json({ error: `Couldn't summarize the thread: ${err?.message || "request failed"}` });
  }
});

// Edit a graft summary by hand (it's just text in the trunk).
app.patch("/api/messages/:id", async (req, res) => {
  if (!assertUuid(req.params.id, res)) return;
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "Summary can't be empty." });
  const { rows } = await q(`UPDATE messages SET content = $2 WHERE id = $1 AND kind = 'graft' RETURNING ${MSG_COLS}`, [req.params.id, content]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: "Only graft summaries can be edited." });
});

app.delete("/api/messages/:id", async (req, res) => {
  if (!assertUuid(req.params.id, res)) return;
  await q("DELETE FROM messages WHERE id = $1 AND kind = 'graft'", [req.params.id]);
  res.status(204).end();
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

await migrate();
app.listen(PORT, () => console.log(`Threadline listening on :${PORT} (chat: ${CHAT_MODEL}, summaries: ${SUMMARY_MODEL})`));
