// JavaScript, public/app.js, browser runtime
"use strict";
const $ = (s) => document.querySelector(s);
const state = { inbox: null, messages: [], selectedId: null, pollTimer: null, tickTimer: null, loading: false, refreshing: false, status: null };

function showNotice(message, isError = false) {
  const el = $("#notice");
  el.textContent = message;
  el.classList.remove("hidden", "error");
  if (isError) el.classList.add("error");
}
function hideNotice() { $("#notice").classList.add("hidden"); }
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (response.status === 204) return null;
  // 401 with needsLogin → session expired; bounce to the login page.
  if (response.status === 401) {
    const data = await response.json().catch(() => ({}));
    if (data.needsLogin) {
      window.location.href = "/login";
      // Throw so callers stop; the redirect is already in flight.
      throw new Error("Session expired. Redirecting to login…");
    }
    throw new Error(data.error || "Authentication required.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function setBusy(busy) {
  state.loading = busy;
  $("#create-btn").disabled = busy;
  $("#create-label").textContent = busy ? "Creating inbox…" : "Generate an address";
}
function updateInboxLimitBadge() {
  // Show how many inboxes are in use out of the configured maximum.
  const el = $("#inbox-limit-badge");
  if (!el) return;
  if (state.status && state.status.maxInboxes) {
    const used = state.status.activeInboxes;
    const max = state.status.maxInboxes;
    el.textContent = `${used} / ${max} inboxes used`;
    el.classList.toggle("limit-near", used >= max - 1);
    el.classList.toggle("limit-hit", used >= max);
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}
async function createInbox() {
  if (state.loading) return;
  hideNotice(); setBusy(true);
  try {
    const data = await request("/api/inboxes", { method: "POST" });
    state.inbox = data.inbox; state.messages = []; state.selectedId = null;
    $("#address").textContent = state.inbox.address;
    $("#workspace").classList.remove("hidden");
    $("#welcome-card").classList.add("hidden");
    $("#message-view").innerHTML = '<div class="reader-empty"><div class="reader-icon">↙</div><strong>Select a message</strong><p>Choose an email from the list to read it here.</p></div>';
    renderMessages();
    startTimers();
    await refreshMessages();
    await refreshStatus();
    $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { showNotice(e.message, true); }
  finally { setBusy(false); }
}
async function refreshStatus() {
  try {
    const s = await request("/api/status");
    state.status = s;
    $("#provider-label").textContent = `${s.provider.toUpperCase()} CONNECTED`;
    const expiryEl = $("#expiry-note-text");
    if (expiryEl) {
      expiryEl.innerHTML = s.permanent
        ? "Inbox stays until you <b>end it</b> (permanent)"
        : `Inbox expires after <b>${s.ttlMinutes} minutes</b>`;
    }
    updateInboxLimitBadge();
  } catch {
    $("#provider-label").textContent = "PROVIDER STATUS UNKNOWN";
  }
}
// Show or hide the Sign-out button depending on whether auth is enabled.
async function refreshAuthState() {
  try {
    const a = await fetch("/api/auth-status").then(r => r.json()).catch(() => null);
    if (a && a.authRequired) {
      $("#logout-btn").classList.remove("hidden");
    } else {
      $("#logout-btn").classList.add("hidden");
    }
  } catch {
    $("#logout-btn").classList.add("hidden");
  }
}
function startTimers() {
  clearInterval(state.pollTimer); clearInterval(state.tickTimer);
  state.pollTimer = setInterval(refreshMessages, 9000);
  // Only tick the countdown for time-limited inboxes; permanent ones show "Persistent".
  if (state.inbox && !state.inbox.permanent) {
    state.tickTimer = setInterval(updateCountdown, 1000);
    updateCountdown();
  } else {
    $("#countdown").textContent = "Persistent";
  }
}
function updateCountdown() {
  if (!state.inbox) return;
  if (state.inbox.permanent) { $("#countdown").textContent = "Persistent"; return; }
  const ms = Math.max(0, state.inbox.expiresAt - Date.now());
  const total = Math.ceil(ms / 1000);
  $("#countdown").textContent = `${String(Math.floor(total / 60)).padStart(2,"0")}:${String(total % 60).padStart(2,"0")}`;
  if (ms <= 0) expireInbox();
}
async function expireInbox() {
  clearInterval(state.pollTimer); clearInterval(state.tickTimer);
  state.inbox = null;
  $("#workspace").classList.add("hidden");
  $("#welcome-card").classList.remove("hidden");
  showNotice("This inbox has expired. Generate a new address to continue.");
}
async function refreshMessages() {
  if (!state.inbox || state.refreshing) return;
  state.refreshing = true;
  try {
    const data = await request(`/api/inboxes/${state.inbox.id}/messages`);
    state.messages = data.messages || [];
    $("#message-count").textContent = String(data.total ?? state.messages.length);
    $("#last-updated").textContent = `Updated ${new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})}`;
    renderMessages();
    if (state.selectedId && state.messages.some(m => m.id === state.selectedId)) {
      // Keep the currently opened message visible; don't refetch its body on every poll.
    } else if (!state.selectedId && state.messages.length) {
      openMessage(state.messages[0].id);
    }
  } catch (e) {
    if (/expired|not found/i.test(e.message)) expireInbox();
    else $("#last-updated").textContent = "Refresh failed";
  } finally {
    state.refreshing = false;
  }
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
// Stable color for a sender's avatar, derived from the address string.
function senderColor(address) {
  let h = 0;
  const s = String(address || "?");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue},65%,52%)`;
}
function senderInitial(from, fromName) {
  const name = (fromName || from || "?").trim();
  // Use the first letter of the local part if it's an email, else first char.
  const local = name.includes("@") ? name.split("@")[0] : name;
  return (local[0] || "?").toUpperCase();
}
function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
}
function renderMessages() {
  const root = $("#message-list");
  if (!state.messages.length) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">✉</div><strong>Waiting for your first email</strong><p>Messages sent to this address will appear here automatically.</p><span class="loading-line"></span></div>';
    return;
  }
  root.innerHTML = state.messages.map(m => {
    const initial = escapeHtml(senderInitial(m.from, m.fromName));
    const color = senderColor(m.from);
    const pills = [];
    if (!m.seen) pills.push('<span class="pill pill-new">NEW</span>');
    else if (!m.seen) pills.push('<span class="pill pill-unread">UNREAD</span>');
    if (m.hasAttachments) pills.push('<span class="pill pill-attach">ATTACH</span>');
    return `
    <div class="message-item ${m.id === state.selectedId ? "active" : ""}" data-id="${escapeHtml(m.id)}">
      <div class="sender-avatar" style="background:${color}">${initial}</div>
      <div class="message-body">
        <div class="message-top"><span class="message-sender">${escapeHtml(m.from)}</span><span class="message-date">${escapeHtml(formatDate(m.createdAt))}</span></div>
        <div class="message-subject">${escapeHtml(m.subject)}</div>
        <div class="message-intro">${escapeHtml(m.intro)}</div>
        ${pills.length ? `<div class="message-pills">${pills.join("")}</div>` : ""}
      </div>
    </div>`;
  }).join("");
  root.querySelectorAll(".message-item").forEach(el => el.addEventListener("click", () => openMessage(el.dataset.id)));
}
async function openMessage(id) {
  if (!state.inbox) return;
  state.selectedId = id; renderMessages();
  $("#message-view").innerHTML = '<div class="reader-empty"><div class="loading-line"></div><p>Loading message…</p></div>';
  try {
    const m = await request(`/api/inboxes/${state.inbox.id}/messages/${encodeURIComponent(id)}`);
    const codes = (m.codes || []).map(code => `<button class="code-chip" data-code="${escapeHtml(code)}" title="Copy verification code">${escapeHtml(code)} ⧉</button>`).join("");
    $("#message-view").innerHTML = `
      <div class="reader-head"><h2>${escapeHtml(m.subject)}</h2>
      <div class="reader-meta"><b>FROM</b>${escapeHtml(m.from)}<br><b>TO</b>${escapeHtml(m.to)}<br><b>RECEIVED</b>${escapeHtml(formatDate(m.createdAt))}</div></div>
      ${codes ? `<div class="section-kicker" style="margin-top:18px">POSSIBLE VERIFICATION CODES</div><div class="code-row">${codes}</div>` : ""}
      <div class="reader-body">${escapeHtml(m.body || "(This message has no readable text body.)")}</div>
      ${(m.attachments || []).length ? `<div class="attachment-note">Attachments: ${m.attachments.map(a => escapeHtml(a.filename)).join(", ")} (not downloaded in this local build)</div>` : ""}`;
    $("#message-view").querySelectorAll(".code-chip").forEach(btn => btn.addEventListener("click", async () => {
      const original = btn.innerHTML;
      try {
        await navigator.clipboard.writeText(btn.dataset.code);
        btn.classList.add("copied");
        btn.innerHTML = `${escapeHtml(btn.dataset.code)} ✓`;
        setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = original; }, 1300);
      } catch {
        btn.innerHTML = `${escapeHtml(btn.dataset.code)} (copy failed)`;
        setTimeout(() => { btn.innerHTML = original; }, 1500);
      }
    }));
  } catch (e) {
    $("#message-view").innerHTML = `<div class="reader-empty"><strong>Could not open message</strong><p>${escapeHtml(e.message)}</p></div>`;
  }
}
async function deleteInbox() {
  if (!state.inbox) return;
  const id = state.inbox.id;
  clearInterval(state.pollTimer); clearInterval(state.tickTimer);
  try { await request(`/api/inboxes/${id}`, { method: "DELETE" }); } catch {}
  state.inbox = null; state.messages = []; state.selectedId = null;
  $("#workspace").classList.add("hidden");
  $("#welcome-card").classList.remove("hidden");
  showNotice("Inbox ended. Its local access credentials have been discarded.");
  await refreshStatus();
}
$("#create-btn").addEventListener("click", createInbox);
$("#refresh-btn").addEventListener("click", refreshMessages);
$("#delete-btn").addEventListener("click", deleteInbox);
$("#logout-btn").addEventListener("click", async () => {
  try { await fetch("/api/logout", { method: "POST" }); } catch {}
  window.location.href = "/login";
});
$("#copy-btn").addEventListener("click", async () => {
  if (!state.inbox) return;
  try { await navigator.clipboard.writeText(state.inbox.address); $("#copy-btn").textContent = "✓"; setTimeout(() => $("#copy-btn").textContent = "▢", 1200); }
  catch { showNotice("Clipboard access was blocked by the browser.", true); }
});
refreshStatus();
refreshAuthState();
setInterval(refreshStatus, 15000);
