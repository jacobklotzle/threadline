// Tests for the context rules in CLAUDE.md. Run with `npm test`.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrunkRequest,
  buildThreadRequest,
  buildGraftRequest,
  TRUNK_SYSTEM,
  THREAD_SYSTEM,
  GRAFT_SYSTEM,
} from "../context.js";

const MARKER = "(Replying in a thread on the message above.)";

let nextSeq = 1;
const user = (content) => ({ seq: nextSeq++, role: "user", kind: "message", content });
const assistant = (content) => ({ seq: nextSeq++, role: "assistant", kind: "message", content });
const graft = (content) => ({ seq: nextSeq++, role: "user", kind: "graft", content });

// Every content block in order, flattened across messages.
const blocks = (req) => req.messages.flatMap((m) => m.content);
const cachedBlocks = (req) => blocks(req).filter((b) => b.cache_control);
const texts = (req) => blocks(req).map((b) => b.text);

function assertAlternatingRoles(req) {
  req.messages.forEach((m, i) => {
    if (i > 0) assert.notEqual(m.role, req.messages[i - 1].role, `messages ${i - 1} and ${i} share a role`);
  });
}

describe("buildTrunkRequest", () => {
  test("sends trunk messages in order with the trunk system prompt", () => {
    const rows = [user("hi"), assistant("hello"), user("how are you?")];
    const req = buildTrunkRequest(rows);

    assert.equal(req.system, TRUNK_SYSTEM);
    assert.deepEqual(req.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.deepEqual(texts(req), ["hi", "hello", "how are you?"]);
  });

  test("puts a single cache breakpoint on the newest message", () => {
    const rows = [user("a"), assistant("b"), user("c")];
    const req = buildTrunkRequest(rows);

    const cached = cachedBlocks(req);
    assert.equal(cached.length, 1);
    assert.equal(cached[0].text, "c");
    assert.deepEqual(cached[0].cache_control, { type: "ephemeral" });
  });

  test("wraps grafts in <thread_graft> tags", () => {
    const req = buildTrunkRequest([user("q"), assistant("a"), graft("Topic: x"), user("next")]);
    assert.ok(texts(req).includes("<thread_graft>\nTopic: x\n</thread_graft>"));
  });

  test("merges a graft and the following user message into one user turn", () => {
    const req = buildTrunkRequest([user("q"), assistant("a"), graft("Topic: x"), user("next")]);

    assertAlternatingRoles(req);
    assert.equal(req.messages.length, 3);
    const last = req.messages[2];
    assert.equal(last.role, "user");
    assert.equal(last.content.length, 2);
    assert.match(last.content[0].text, /^<thread_graft>/);
    assert.equal(last.content[1].text, "next");
  });

  test("handles an empty trunk without throwing", () => {
    const req = buildTrunkRequest([]);
    assert.deepEqual(req.messages, []);
  });

  test("does not modify the rows passed in", () => {
    const rows = [user("a"), assistant("b"), user("c")];
    const copy = structuredClone(rows);
    buildTrunkRequest(rows);
    assert.deepEqual(rows, copy);
  });
});

describe("buildThreadRequest", () => {
  // Trunk: u1, a1 (anchor), and the thread branches off a1.
  function assistantAnchorCase() {
    const prefix = [user("u1"), assistant("a1 anchor")];
    const thread = [user("t1"), assistant("t2"), user("t3")];
    return { prefix, thread, req: buildThreadRequest(prefix, thread) };
  }

  test("uses the thread system prompt", () => {
    assert.equal(assistantAnchorCase().req.system, THREAD_SYSTEM);
  });

  test("sends the trunk prefix, then the thread replies, in order", () => {
    const { req } = assistantAnchorCase();
    assert.deepEqual(texts(req), ["u1", "a1 anchor", `${MARKER}\n\nt1`, "t2", "t3"]);
    assertAlternatingRoles(req);
  });

  test("prefixes only the first thread message with the marker", () => {
    const { req } = assistantAnchorCase();
    const marked = texts(req).filter((t) => t.includes(MARKER));
    assert.equal(marked.length, 1);
    assert.ok(marked[0].startsWith(MARKER));
  });

  test("places cache breakpoints on the anchor and the newest message only", () => {
    const { req } = assistantAnchorCase();
    const cached = cachedBlocks(req);
    assert.equal(cached.length, 2);
    assert.equal(cached[0].text, "a1 anchor");
    assert.equal(cached[1].text, "t3");
  });

  test("stays within the API's 4 cache breakpoint limit", () => {
    const { req } = assistantAnchorCase();
    assert.ok(cachedBlocks(req).length <= 4);
  });

  test("merges the first thread message into a user anchor's turn", () => {
    // Thread branching off a user message: the anchor and t1 are both user turns.
    const prefix = [user("u1"), assistant("a1"), user("u2 anchor")];
    const thread = [user("t1"), assistant("t2")];
    const req = buildThreadRequest(prefix, thread);

    assertAlternatingRoles(req);
    const anchorTurn = req.messages[2];
    assert.equal(anchorTurn.role, "user");
    assert.deepEqual(anchorTurn.content.map((b) => b.text), ["u2 anchor", `${MARKER}\n\nt1`]);
    // The anchor block keeps its breakpoint even though it shares a turn.
    assert.ok(anchorTurn.content[0].cache_control);
  });

  test("wraps grafts in the trunk prefix", () => {
    const prefix = [user("u1"), assistant("a1"), graft("Topic: earlier"), user("u2"), assistant("a2 anchor")];
    const req = buildThreadRequest(prefix, [user("t1")]);
    assert.ok(texts(req).includes("<thread_graft>\nTopic: earlier\n</thread_graft>"));
    assertAlternatingRoles(req);
  });

  test("with no thread replies yet, only the anchor is cached", () => {
    const req = buildThreadRequest([user("u1"), assistant("a1 anchor")], []);
    const cached = cachedBlocks(req);
    assert.equal(cached.length, 1);
    assert.equal(cached[0].text, "a1 anchor");
  });

  test("produces the same cached prefix on every turn of a thread", () => {
    // The anchor breakpoint only helps if everything up to it is byte-identical
    // across turns, so later thread turns can read the earlier cache.
    const prefix = [user("u1"), assistant("a1 anchor")];
    const turn1 = buildThreadRequest(prefix, [user("t1")]);
    const turn2 = buildThreadRequest(prefix, [user("t1"), assistant("t2"), user("t3")]);

    const upToAnchor = (req) => {
      const out = [];
      for (const b of blocks(req)) {
        out.push(b);
        if (b.text === "a1 anchor") break;
      }
      return out;
    };
    assert.equal(turn1.system, turn2.system);
    assert.deepEqual(upToAnchor(turn1), upToAnchor(turn2));
  });

  test("does not modify the rows passed in", () => {
    const prefix = [user("u1"), assistant("a1")];
    const thread = [user("t1"), assistant("t2")];
    const copy = structuredClone({ prefix, thread });
    buildThreadRequest(prefix, thread);
    assert.deepEqual({ prefix, thread }, copy);
  });
});

describe("buildGraftRequest", () => {
  const anchor = assistant("Here are three options: A, B, C.");
  const thread = [user("Tell me more about B."), assistant("B costs $12 and uses Postgres.")];
  const req = buildGraftRequest(anchor, thread);
  const text = req.messages[0].content[0].text;

  test("uses the graft system prompt", () => {
    assert.equal(req.system, GRAFT_SYSTEM);
  });

  test("sends a single user message", () => {
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, "user");
    assert.equal(req.messages[0].content.length, 1);
  });

  test("includes the anchor with its author", () => {
    assert.match(text, /<anchor_message author="Claude">\nHere are three options: A, B, C\.\n<\/anchor_message>/);
    const userAnchor = buildGraftRequest(user("my question"), thread).messages[0].content[0].text;
    assert.match(userAnchor, /<anchor_message author="User">/);
  });

  test("includes the full thread transcript with speaker labels, in order", () => {
    assert.ok(text.includes("<thread>\nUser: Tell me more about B.\n\nClaude: B costs $12 and uses Postgres.\n</thread>"));
  });

  test("does not set cache breakpoints", () => {
    assert.equal(cachedBlocks(req).length, 0);
  });
});
