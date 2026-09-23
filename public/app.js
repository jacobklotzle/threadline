(() => {
  "use strict";

  // ---------- state ----------
  const state = {
    token: safeGet("threadline-token") || "",
    conversations: [],
    convId: null,
    trunk: [],
    threads: {},          // rootId -> { count, last_at }
    thread: null,         // { root, messages }
    busy: { trunk: false, thread: false, graft: false },
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

  // ---------- api ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}`, ...(opts.headers || {}) },
    });
    if (res.status === 401) { showLogin(); throw new Error("Password required."); }
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    return body;
  }

  // POST that streams server-sent events back.
  async function streamPost(path, payload, handlers) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) { showLogin(); throw new Error("Password required."); }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status}).`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (event && data && handlers[event]) handlers[event](JSON.parse(data));
      }
    }
  }

  // ---------- rendering helpers ----------
  function renderMarkdown(target, text) {
    target.innerHTML = DOMPurify.sanitize(marked.parse(text || "", { breaks: true, gfm: true }));
    target.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  }

  function relTime(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function usageText(u) {
    if (!u) return "";
    const n = (x) => (x || 0).toLocaleString();
    const cached = u.cache_read_input_tokens ? `, ${n(u.cache_read_input_tokens)} from cache` : "";
    return `${n(u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0))} in${cached}, ${n(u.output_tokens)} out`;
  }

  function toast(msg, isError = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = `toast show${isError ? " error" : ""}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.className = "toast"), isError ? 5000 : 2500);
  }

  function scrollToEnd(scroller) {
    requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  }

  function nearBottom(scroller) {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  }

  // ---------- message nodes ----------
  function messageNode(m, { inThread = false } = {}) {
    if (m.kind === "graft") return graftNode(m);

    const li = el("li", `msg ${m.role}`);
    li.dataset.id = m.id;
    const meta = el("div", "msg-meta");
    meta.append(el("span", "msg-author", m.role === "user" ? "You" : "Claude"));
    if (m.usage) meta.append(el("span", "msg-usage", usageText(m.usage)));
    const body = el("div", "msg-body md");
    renderMarkdown(body, m.content);
    li.append(meta, body);

    if (!inThread && m.id) {
      const actions = el("div", "msg-actions");
      const info = state.threads[m.id];
      if (info?.count) {
        const b = el("button", "branch");
        b.type = "button";
        b.append(el("span", null, `${info.count} ${info.count === 1 ? "reply" : "replies"}`), el("span", "when", relTime(info.last_at)));
        b.addEventListener("click", () => openThread(m.id));
        actions.append(b);
      } else {
        const r = el("button", "btn btn-quiet", "Reply in thread");
        r.type = "button";
        r.addEventListener("click", () => openThread(m.id));
        actions.append(r);
      }
      li.append(actions);
      if (state.thread?.root.id === m.id) li.classList.add("open-thread");
    }
    return li;
  }

  function graftNode(m) {
    const li = el("li", "msg graft");
    li.dataset.id = m.id;
    const card = el("details", "graft-card");
    const summary = el("summary", null, "Grafted from a thread");
    const text = el("pre", "graft-text", m.content);
    const tools = el("div", "graft-tools");

    const view = el("button", "btn btn-quiet", "Open thread");
    view.type = "button";
    view.disabled = !m.source_thread_id;
    view.addEventListener("click", () => openThread(m.source_thread_id));

    const edit = el("button", "btn btn-quiet", "Edit summary");
    edit.type = "button";
    edit.addEventListener("click", () => {
      const ta = el("textarea");
      ta.value = m.content;
      const save = el("button", "btn btn-quiet", "Save summary");
      save.type = "button";
      save.addEventListener("click", async () => {
        try {
          const updated = await api(`/api/messages/${m.id}`, { method: "PATCH", body: JSON.stringify({ content: ta.value }) });
          Object.assign(m, updated);
          li.replaceWith(graftNode(m));
          toast("Summary saved");
        } catch (e) { toast(e.message, true); }
      });
      text.replaceWith(ta);
      edit.replaceWith(save);
      ta.focus();
    });

    const del = el("button", "btn btn-quiet btn-danger", "Remove graft");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm("Remove this summary from the main conversation? The thread itself stays.")) return;
      try {
        await api(`/api/messages/${m.id}`, { method: "DELETE" });
        state.trunk = state.trunk.filter((x) => x.id !== m.id);
        renderTrunk();
        toast("Graft removed");
      } catch (e) { toast(e.message, true); }
    });

    tools.append(view, edit, del);
    card.append(summary, text, tools);
    li.append(card);
    return li;
  }

  // ---------- sidebar ----------
  function renderConversations() {
    const list = $("#conv-list");
    list.replaceChildren();
    if (!state.conversations.length) {
      list.append(el("p", "empty-note", "No conversations yet."));
      return;
    }
    for (const c of state.conversations) {
      const row = el("div", `conv${c.id === state.convId ? " active" : ""}`);
      const a = el("a", null, c.title);
      a.href = `#${c.id}`;
      a.addEventListener("click", () => $("#app").classList.remove("drawer-open"));
      const del = el("button", "icon-btn");
      del.type = "button";
      del.setAttribute("aria-label", `Delete ${c.title}`);
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
      del.addEventListener("click", async () => {
        if (!confirm(`Delete "${c.title}" and all its threads?`)) return;
        try {
          await api(`/api/conversations/${c.id}`, { method: "DELETE" });
          state.conversations = state.conversations.filter((x) => x.id !== c.id);
          if (state.convId === c.id) location.hash = "";
          renderConversations();
        } catch (e) { toast(e.message, true); }
      });
      row.append(a, del);
      list.append(row);
    }
  }

  async function loadConversations() {
    state.conversations = await api("/api/conversations");
    renderConversations();
  }

  // ---------- trunk ----------
  function renderTrunk() {
    const list = $("#trunk-list");
    list.replaceChildren(...state.trunk.map((m) => messageNode(m)));
    $("#trunk-empty").hidden = state.trunk.length > 0;
    const conv = state.conversations.find((c) => c.id === state.convId);
    $("#trunk-title").textContent = conv?.title || "New conversation";
    document.title = conv ? `${conv.title} – Threadline` : "Threadline";
  }

  async function loadConversation(id) {
    closeThread();
    state.convId = id;
    state.trunk = [];
    state.threads = {};
    renderConversations();
    if (!id) { renderTrunk(); return; }
    try {
      const data = await api(`/api/conversations/${id}`);
      state.trunk = data.trunk;
      state.threads = data.threads;
      renderTrunk();
      scrollToEnd($("#trunk-scroller"));
    } catch (e) {
      toast(e.message, true);
      location.hash = "";
    }
  }

  async function ensureConversation() {
    if (state.convId) return state.convId;
    const conv = await api("/api/conversations", { method: "POST", body: "{}" });
    state.conversations.unshift(conv);
    state.convId = conv.id;
    history.replaceState(null, "", `#${conv.id}`);
    renderConversations();
    return conv.id;
  }

  // ---------- sending (shared by trunk and thread) ----------
  async function send(where, text) {
    const isThread = where === "thread";
    if (state.busy[where]) return;
    const convId = isThread ? state.thread.root.conversation_id : await ensureConversation();
    const list = isThread ? $("#thread-list") : $("#trunk-list");
    const scroller = isThread ? $("#thread-scroller") : $("#trunk-scroller");
    const bucket = isThread ? state.thread.messages : state.trunk;
    const rootId = isThread ? state.thread.root.id : null;

    state.busy[where] = true;
    setComposerBusy(where, true);
    $("#trunk-empty").hidden = true;

    // Optimistic user message + a live assistant node.
    const pendingUser = messageNode({ role: "user", content: text }, { inThread: true });
    const live = messageNode({ role: "assistant", content: "" }, { inThread: true });
    live.classList.add("streaming");
    list.append(pendingUser, live);
    scrollToEnd(scroller);
    const liveBody = live.querySelector(".msg-body");
    let acc = "";
    let frame = 0;

    try {
      await streamPost(`/api/conversations/${convId}/messages`, { content: text, threadRootId: rootId }, {
        user: (m) => bucket.push(m),
        delta: ({ text: d }) => {
          acc += d;
          if (!frame) frame = requestAnimationFrame(() => {
            frame = 0;
            const stick = nearBottom(scroller);
            renderMarkdown(liveBody, acc);
            if (stick) scroller.scrollTop = scroller.scrollHeight;
          });
        },
        done: ({ message }) => bucket.push(message),
        error: ({ error, message }) => { if (message) bucket.push(message); toast(error, true); },
      });
    } catch (e) {
      toast(e.message, true);
    } finally {
      cancelAnimationFrame(frame);
      state.busy[where] = false;
      setComposerBusy(where, false);
    }

    if (isThread) {
      const info = (state.threads[rootId] ||= { count: 0, last_at: null });
      info.count = state.thread.messages.length;
      info.last_at = new Date().toISOString();
      renderThread();
      renderTrunk(); // refresh the reply-count branch on the anchor
    } else {
      // Title is set server-side from the first message.
      const conv = state.conversations.find((c) => c.id === convId);
      if (conv && conv.title === "New conversation") conv.title = text.replace(/\s+/g, " ").slice(0, 60) + (text.length > 60 ? "…" : "");
      state.conversations.sort((a, b) => (a.id === convId ? -1 : b.id === convId ? 1 : 0));
      renderConversations();
      renderTrunk();
    }
    scrollToEnd(scroller);
  }

  function setComposerBusy(where, busy) {
    const form = where === "thread" ? $("#thread-composer") : $("#trunk-composer");
    form.querySelector("button").disabled = busy;
    form.querySelector("button").textContent = busy ? "Replying…" : "Send";
    if (where === "thread") updateGraftButton();
  }

  // ---------- threads ----------
  async function openThread(rootId) {
    try {
      const data = await api(`/api/threads/${rootId}`);
      state.thread = data;
      $("#thread").hidden = false;
      renderThread();
      renderTrunk();
      scrollToEnd($("#thread-scroller"));
      $("#thread-composer textarea").focus();
    } catch (e) { toast(e.message, true); }
  }

  function closeThread() {
    state.thread = null;
    $("#thread").hidden = true;
    document.querySelectorAll(".msg.open-thread").forEach((n) => n.classList.remove("open-thread"));
  }

  function renderThread() {
    if (!state.thread) return;
    const { root, messages } = state.thread;
    const anchor = $("#thread-anchor");
    anchor.replaceChildren();
    const meta = el("div", "msg-meta");
    meta.append(el("span", "msg-author", root.kind === "graft" ? "Graft summary" : root.role === "user" ? "You" : "Claude"));
    const body = el("div", "md");
    renderMarkdown(body, root.content);
    anchor.append(meta, body);
    $("#thread-list").replaceChildren(...messages.map((m) => messageNode(m, { inThread: true })));
    updateGraftButton();
  }

  function updateGraftButton() {
    const btn = $("#graft-btn");
    const hasReplies = state.thread?.messages.some((m) => m.role === "assistant");
    btn.disabled = !hasReplies || state.busy.thread || state.busy.graft;
    btn.textContent = state.busy.graft ? "Summarizing thread…" : "Graft into main conversation";
  }

  async function graft() {
    if (!state.thread || state.busy.graft) return;
    state.busy.graft = true;
    updateGraftButton();
    try {
      const g = await api(`/api/threads/${state.thread.root.id}/graft`, { method: "POST", body: "{}" });
      if (g.conversation_id === state.convId) {
        state.trunk.push(g);
        renderTrunk();
        scrollToEnd($("#trunk-scroller"));
      }
      toast("Grafted into main conversation");
      if (window.matchMedia("(max-width: 960px)").matches) closeThread();
    } catch (e) {
      toast(e.message, true);
    } finally {
      state.busy.graft = false;
      updateGraftButton();
    }
  }

  // ---------- composers ----------
  function wireComposer(form, where) {
    const ta = form.querySelector("textarea");
    const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 192)}px`; };
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text || state.busy[where]) return;
      ta.value = "";
      grow();
      send(where, text);
    });
  }

  // ---------- login ----------
  function showLogin() {
    $("#login").hidden = false;
    $("#login-input").focus();
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.token = $("#login-input").value;
    $("#login-error").textContent = "";
    try {
      const res = await fetch("/api/conversations", { headers: { Authorization: `Bearer ${state.token}` } });
      if (res.status === 401) { $("#login-error").textContent = "That password didn't match. Check APP_PASSWORD on Railway."; return; }
      safeSet("threadline-token", state.token);
      $("#login").hidden = true;
      await boot();
    } catch { $("#login-error").textContent = "Couldn't reach the server. Check that the app is running."; }
  });

  // ---------- wiring ----------
  wireComposer($("#trunk-composer"), "trunk");
  wireComposer($("#thread-composer"), "thread");
  $("#thread-close").addEventListener("click", () => { closeThread(); renderTrunk(); });
  $("#graft-btn").addEventListener("click", graft);
  $("#new-conv").addEventListener("click", () => {
    location.hash = "";
    $("#app").classList.remove("drawer-open");
    $("#trunk-composer textarea").focus();
  });
  $("#menu-btn").addEventListener("click", () => $("#app").classList.toggle("drawer-open"));
  document.addEventListener("click", (e) => {
    const app = $("#app");
    if (app.classList.contains("drawer-open") && !e.target.closest(".sidebar, #menu-btn")) app.classList.remove("drawer-open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.thread) { closeThread(); renderTrunk(); }
  });
  window.addEventListener("hashchange", () => loadConversation(location.hash.slice(1) || null));

  async function boot() {
    try {
      await loadConversations();
      await loadConversation(location.hash.slice(1) || null);
    } catch (e) {
      if (e.message !== "Password required.") toast(e.message, true);
    }
  }
  boot();
})();
