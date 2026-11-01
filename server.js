// JavaScript, server.js, Node.js 20+, local Dropmail dashboard
"use strict";

const express = require("express");
const helmet = require("helmet");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const app = express();
// HOST: 127.0.0.1 (local only, default) or 0.0.0.0 (all interfaces, for cloud).
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const API = "https://api.mail.tm";
// Inbox lifetime in minutes. 0 = permanent local access (default).
// Note: the provider (Mail.tm) may still apply its own account-retention policy;
// this server treats the inbox as permanent until you delete it or the provider
// invalidates the bearer token (in which case the UI surfaces that error).
const TTL_MINUTES = Math.max(0, Number(process.env.TTL_MINUTES ?? 0));
const TTL_MS = TTL_MINUTES > 0 ? TTL_MINUTES * 60 * 1000 : 0;
const POLL_MIN_MS = 7000;
// Maximum number of inboxes stored locally at once.
// Override with the MAX_INBOXES environment variable.
const MAX_INBOXES = Math.max(1, Number(process.env.MAX_INBOXES ?? 5));
// Auth: if AUTH_PASSWORD is set, all routes require a session cookie.
// SESSION_SECRET signs the cookie — set to a long random string in production.
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const AUTH_RATE_LIMIT = 10;       // max failed attempts per window per IP
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const DATA_DIR = path.join(__dirname, ".data");
const STORE_FILE = path.join(DATA_DIR, "inboxes.json");

// Warn loudly if exposing to the network without auth.
if (HOST !== "127.0.0.1" && !AUTH_PASSWORD) {
  console.warn("[dropmail] WARNING: HOST is set to a public interface but AUTH_PASSWORD is empty.");
  console.warn("[dropmail]          Anyone who can reach this host can read your inboxes.");
  console.warn("[dropmail]          Set AUTH_PASSWORD before exposing to the internet.");
}

// Trust the first proxy (needed when running behind Caddy/nginx/Cloudflare/Render).
app.set("trust proxy", 1);
fs.mkdirSync(DATA_DIR, { recursive: true });
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    upgradeInsecureRequests: null
  }
}}));
app.use(express.json({ limit: "32kb" }));

// === Session / auth helpers (HMAC-signed cookie, no external deps) ===
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return cookies;
}
function signSession(expiresAt) {
  const payload = String(expiresAt);
  const hmac = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}
function verifySession(cookie) {
  if (!cookie || typeof cookie !== "string") return false;
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = cookie.slice(0, dot);
  const hmac = cookie.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  let a, b;
  try { a = Buffer.from(hmac, "hex"); b = Buffer.from(expected, "hex"); } catch { return false; }
  if (a.length !== b.length || a.length === 0) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  const expiresAt = Number(payload);
  if (!expiresAt || Date.now() > expiresAt) return false;
  return true;
}
function setSessionCookie(res, value) {
  const secure = process.env.NODE_ENV === "production" || Boolean(process.env.FORCE_HTTPS);
  const parts = [
    `dropmail_session=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "dropmail_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

// Per-IP auth rate limiting (in-memory; fine for a single-instance deployment).
const authAttempts = new Map();
function checkAuthRateLimit(ip) {
  const now = Date.now();
  const key = ip || "unknown";
  const entry = authAttempts.get(key);
  if (!entry || now - entry.firstAt > AUTH_RATE_WINDOW_MS) {
    authAttempts.set(key, { count: 1, firstAt: now });
    return true;
  }
  entry.count++;
  return entry.count <= AUTH_RATE_LIMIT;
}

// Paths that bypass auth: the login page itself, shared CSS, and auth endpoints.
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/styles.css", "/login.js"]);
function isPublicPath(reqPath, method) {
  if (PUBLIC_PATHS.has(reqPath)) return true;
  if (reqPath === "/api/login" && method === "POST") return true;
  if (reqPath === "/api/logout" && method === "POST") return true;
  if (reqPath === "/api/auth-status" && method === "GET") return true;
  return false;
}
function authMiddleware(req, res, next) {
  // If no password is configured, auth is disabled (local mode).
  if (!AUTH_PASSWORD) return next();
  if (isPublicPath(req.path, req.method)) return next();
  const cookies = parseCookies(req);
  if (verifySession(cookies.dropmail_session)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Authentication required.", needsLogin: true });
  }
  return res.redirect("/login");
}
app.use(authMiddleware);

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Auth routes
app.post("/api/login", (req, res) => {
  if (!AUTH_PASSWORD) return res.json({ ok: true, authDisabled: true });
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkAuthRateLimit(ip)) {
    return res.status(429).json({ error: "Too many login attempts. Try again in 15 minutes." });
  }
  const { password } = req.body || {};
  if (typeof password !== "string" || password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  const expiresAt = Date.now() + SESSION_TTL_MS;
  setSessionCookie(res, signSession(expiresAt));
  res.json({ ok: true });
});
app.post("/api/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
app.get("/api/auth-status", (req, res) => {
  if (!AUTH_PASSWORD) return res.json({ authRequired: false, authed: true });
  const cookies = parseCookies(req);
  res.json({ authRequired: true, authed: verifySession(cookies.dropmail_session) });
});

let inboxes = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  for (const item of saved) {
    // expiresAt === 0 means permanent; otherwise only keep if still valid.
    if (item.expiresAt === 0 || item.expiresAt > Date.now()) inboxes.set(item.id, item);
  }
} catch (e) {
  console.warn(`[dropmail] Could not load ${STORE_FILE}: ${e.message}`);
}

function persist() {
  const safe = [...inboxes.values()].map(x => ({
    id: x.id, address: x.address, password: x.password,
    token: x.token, expiresAt: x.expiresAt, createdAt: x.createdAt
  }));
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}
function cleanExpired() {
  let changed = false;
  for (const [id, box] of inboxes) {
    // Permanent boxes (expiresAt === 0) are never expired by the local timer.
    if (box.expiresAt !== 0 && box.expiresAt <= Date.now()) {
      inboxes.delete(id);
      changed = true;
    }
  }
  if (changed) persist();
}
function randomPart(n = 12) {
  return crypto.randomBytes(n).toString("hex");
}
async function apiRequest(route, options = {}) {
  const headers = { "Accept": "application/ld+json, application/json", ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}${route}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const err = new Error(data["hydra:description"] || data.message || `Mail provider returned HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}
function publicBox(box) {
  const permanent = box.expiresAt === 0;
  return {
    id: box.id, address: box.address, expiresAt: box.expiresAt,
    createdAt: box.createdAt,
    remainingMs: permanent ? -1 : Math.max(0, box.expiresAt - Date.now()),
    permanent
  };
}
function requireBox(req, res, next) {
  cleanExpired();
  const box = inboxes.get(req.params.id);
  if (!box) return res.status(404).json({ error: "Inbox not found or expired." });
  req.box = box;
  next();
}

app.get("/api/status", (_req, res) => {
  cleanExpired();
  res.json({
    provider: "Mail.tm",
    activeInboxes: inboxes.size,
    maxInboxes: MAX_INBOXES,
    ttlMinutes: TTL_MINUTES,   // 0 means permanent
    permanent: TTL_MINUTES === 0
  });
});

app.get("/api/domains", async (_req, res) => {
  try {
    const data = await apiRequest("/domains");
    const domains = (data["hydra:member"] || []).filter(d => d.isActive && !d.isPrivate).map(d => d.domain);
    res.json({ domains });
  } catch (e) {
    res.status(502).json({ error: `Could not load provider domains: ${e.message}` });
  }
});

app.post("/api/inboxes", async (_req, res) => {
  cleanExpired();
  if (inboxes.size >= MAX_INBOXES) {
    return res.status(429).json({
      error: `Local inbox limit reached (${inboxes.size}/${MAX_INBOXES}). ` +
             `Delete an existing inbox before creating a new one. ` +
             `Set the MAX_INBOXES environment variable to change this limit.`
    });
  }
  try {
    const data = await apiRequest("/domains");
    const domains = (data["hydra:member"] || []).filter(d => d.isActive && !d.isPrivate);
    if (!domains.length) return res.status(503).json({ error: "The provider has no public domains available right now." });

    // Try currently advertised domains in order; the provider remains authoritative.
    const username = `drop${randomPart(5)}`;
    const password = `${randomPart(24)}Aa9!`;
    let created = null;
    let lastError = null;
    for (const domain of domains.slice(0, 3)) {
      const address = `${username}@${domain.domain}`;
      try {
        await apiRequest("/accounts", { method: "POST", body: { address, password } });
        created = { address, password };
        break;
      } catch (e) {
        lastError = e;
        if (e.status === 429) throw e;
      }
    }
    if (!created) throw (lastError || new Error("No available domain accepted account creation."));
    const auth = await apiRequest("/token", { method: "POST", body: created });
    if (!auth.token) throw new Error("Provider did not return an authentication token.");

    const now = Date.now();
    const expiresAt = TTL_MS > 0 ? now + TTL_MS : 0;
    const box = {
      id: randomPart(18), address: created.address, password: created.password,
      token: auth.token, createdAt: now, expiresAt
    };
    inboxes.set(box.id, box);
    persist();
    res.status(201).json({ inbox: publicBox(box) });
  } catch (e) {
    const status = e.status === 429 ? 429 : 502;
    let message = e.message;
    if (status === 429) message = "The provider is rate-limiting new inbox creation. Wait before trying again.";
    res.status(status).json({ error: message });
  }
});

app.get("/api/inboxes", (_req, res) => {
  cleanExpired();
  res.json({ inboxes: [...inboxes.values()].map(publicBox) });
});

app.get("/api/inboxes/:id/messages", requireBox, async (req, res) => {
  try {
    const data = await apiRequest("/messages?page=1", { token: req.box.token });
    const messages = (data["hydra:member"] || []).map(m => ({
      id: m.id, from: m.from?.address || m.from?.name || "Unknown sender",
      fromName: m.from?.name || "", subject: m.subject || "(no subject)",
      intro: m.intro || "", createdAt: m.createdAt,
      hasAttachments: Boolean(m.hasAttachments), seen: Boolean(m.seen)
    }));
    res.json({ messages, total: data["hydra:totalItems"] || messages.length, expiresAt: req.box.expiresAt });
  } catch (e) {
    res.status(e.status === 401 ? 410 : 502).json({ error: e.status === 401 ? "Provider inbox expired or credentials were rejected." : e.message });
  }
});

app.get("/api/inboxes/:id/messages/:messageId", requireBox, async (req, res) => {
  try {
    const data = await apiRequest(`/messages/${encodeURIComponent(req.params.messageId)}`, { token: req.box.token });
    const text = data.text || "";
    const html = Array.isArray(data.html) ? data.html.join("\n") : (data.html || "");
    const body = text || html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"');
    const codes = [...new Set((body.match(/(?<!\d)\d{4,8}(?!\d)/g) || []))].slice(0, 10);
    res.json({
      id: data.id, from: data.from?.address || "Unknown sender",
      to: (data.to || []).map(x => x.address).join(", "),
      subject: data.subject || "(no subject)", createdAt: data.createdAt,
      body: body.slice(0, 30000), codes,
      attachments: (data.attachments || []).map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size }))
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete("/api/inboxes/:id", requireBox, async (req, res) => {
  const box = req.box;
  try {
    // Best-effort provider-side deletion; local access is removed regardless.
    const me = await apiRequest(`/me`, { token: box.token }).catch(() => null);
    if (me && me.id) await apiRequest(`/accounts/${encodeURIComponent(me.id)}`, { method: "DELETE", token: box.token }).catch(() => null);
    inboxes.delete(box.id);
    persist();
    res.status(204).end();
  } catch (e) {
    inboxes.delete(box.id);
    persist();
    res.status(204).end();
  }
});

app.use((err, _req, res, _next) => {
  console.error("[dropmail] Unexpected error:", err);
  res.status(500).json({ error: "Unexpected local server error." });
});

setInterval(() => { cleanExpired(); }, 15000).unref();
app.listen(PORT, HOST, () => {
  const hostDisplay = HOST === "0.0.0.0" ? "0.0.0.0 (all interfaces)" : HOST;
  console.log(`Dropmail running at http://${hostDisplay}:${PORT}`);
  console.log(`Inbox lifetime: ${TTL_MS > 0 ? TTL_MINUTES + " minute(s)" : "permanent (until deleted or provider invalidates)"}`);
  console.log(`Local inbox limit: ${MAX_INBOXES} (override with MAX_INBOXES env var)`);
  console.log(`Auth: ${AUTH_PASSWORD ? "ENABLED (password set)" : "DISABLED (local mode — set AUTH_PASSWORD to enable)"}`);
  if (HOST === "0.0.0.0" && !AUTH_PASSWORD) {
    console.log("WARNING: public interface with no auth. Anyone who can reach this host can use your inboxes.");
  } else if (HOST === "0.0.0.0") {
    console.log("Behind a reverse proxy: use HTTPS and set NODE_ENV=production so the session cookie gets the Secure flag.");
  } else {
    console.log("Local-only bind. Set HOST=0.0.0.0 and AUTH_PASSWORD to expose to the cloud.");
  }
});
