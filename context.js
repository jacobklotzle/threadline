// Builds the message arrays sent to the Claude API.
//
// Token strategy:
// - A thread sees the trunk only up to (and including) its anchor message,
//   plus its own replies. Nothing from other threads, nothing later in the trunk.
// - The trunk never sees thread contents, only graft summaries the user merges in.
// - Prompt caching: a breakpoint on the anchor lets every turn in a thread reuse
//   the cached trunk prefix; a breakpoint on the newest message lets the next
//   turn reuse the whole conversation so far.

export const TRUNK_SYSTEM = `You are Claude, talking with the user in the main conversation of a threaded chat app.
Messages wrapped in <thread_graft> tags are compact summaries of side threads the user chose to merge back in. Treat the decisions, resolutions and clarifications in them as settled context, and don't mention the tags themselves.`;

export const THREAD_SYSTEM = `You are Claude, replying inside a side thread of a threaded chat app, like a thread in Slack.
The thread branches off the main conversation at the message just before the note "(Replying in a thread on the message above.)". Everything before that point is shared context; the thread is a focused side discussion about that message. Stay on the thread's topic and keep replies tight. You can't see anything the main conversation discussed after the thread began.`;

export const GRAFT_SYSTEM = `You compress a side thread from a chat into a summary that will be inserted into the main conversation for another AI model to read. Optimize for machine readability and brevity, not for a human reader.

Output exactly this format, omitting any section that would be empty:
Topic: <one line, what the thread was about>
Decisions:
- <each decision reached>
Resolutions:
- <each question answered or problem solved, with the answer>
Clarifications:
- <each clarified requirement, definition, constraint or preference>
Open:
- <anything left unresolved>

Rules: terse fragments, no filler, no narration of who said what, keep exact names, numbers, code identifiers and values. Never invent anything not in the thread.`;

const THREAD_MARKER = "(Replying in a thread on the message above.)";

function rowToBlock(row) {
  if (row.kind === "graft") {
    return { type: "text", text: `<thread_graft>\n${row.content}\n</thread_graft>` };
  }
  return { type: "text", text: row.content };
}

// The API wants alternating roles; merge consecutive same-role rows
// (e.g. a graft followed by the user's next message) into one turn.
function mergeTurns(entries) {
  const out = [];
  for (const { role, block } of entries) {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  }
  return out;
}

function cacheBlock(block) {
  block.cache_control = { type: "ephemeral" };
  return block;
}

// trunkRows: trunk messages in order, ending with the newly saved user message.
export function buildTrunkRequest(trunkRows) {
  const entries = trunkRows.map((r) => ({ role: r.role, block: rowToBlock(r) }));
  if (entries.length) cacheBlock(entries[entries.length - 1].block);
  return { system: TRUNK_SYSTEM, messages: mergeTurns(entries) };
}

// prefixRows: trunk messages up to and including the anchor.
// threadRows: the thread's replies in order, ending with the new user message.
export function buildThreadRequest(prefixRows, threadRows) {
  const entries = prefixRows.map((r) => ({ role: r.role, block: rowToBlock(r) }));
  if (entries.length) cacheBlock(entries[entries.length - 1].block);

  threadRows.forEach((r, i) => {
    const block = rowToBlock(r);
    if (i === 0) block.text = `${THREAD_MARKER}\n\n${block.text}`;
    entries.push({ role: r.role, block });
  });
  if (threadRows.length) cacheBlock(entries[entries.length - 1].block);

  // Keep at most 4 cache breakpoints (API limit); we use 2.
  return { system: THREAD_SYSTEM, messages: mergeTurns(entries) };
}

// The summarizer only needs the anchor plus the thread, not the whole trunk.
export function buildGraftRequest(anchorRow, threadRows) {
  const who = (r) => (r.role === "user" ? "User" : "Claude");
  const transcript = threadRows.map((r) => `${who(r)}: ${r.content}`).join("\n\n");
  const text = `<anchor_message author="${who(anchorRow)}">\n${anchorRow.content}\n</anchor_message>\n\n<thread>\n${transcript}\n</thread>\n\nSummarize the thread.`;
  return { system: GRAFT_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text }] }] };
}
