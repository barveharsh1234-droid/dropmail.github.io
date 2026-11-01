# Dropmail Local — real disposable inboxes

A self-hostable dashboard that creates actual temporary inboxes using the Mail.tm API and retrieves incoming messages. Runs locally on `127.0.0.1` by default, and can be deployed to the cloud with optional password authentication.

It does **not** create Gmail, Outlook, or Hotmail accounts and does not operate its own mail servers.

## Requirements

- Node.js 20 or newer
- Internet connection
- A browser

## Run on Windows

1. Extract the ZIP.
2. Open the extracted `dropmail-real` folder.
3. In File Explorer's address bar, type `cmd` and press Enter.
4. Run:

   ```bat
   npm install
   npm start
   ```

5. Open <http://127.0.0.1:3000>.

## Run on macOS / Linux

```bash
cd dropmail-real
npm install
npm start
```

Then open <http://127.0.0.1:3000>.

## Features

- Loads currently active public domains from Mail.tm; no domain is hard-coded.
- Creates a random account through the provider and obtains a bearer token.
- Fetches incoming messages and message bodies from the provider.
- Polls every 9 seconds.
- Displays possible 4–8 digit verification codes found in message text.
- **Inboxes are permanent by default** — they stay until you click "End inbox" or the provider invalidates the token. Set `TTL_MINUTES` to bring back a time limit.
- **Local inbox cap** — at most `MAX_INBOXES` (default 5) inboxes can exist at once; creation is rejected with a clear message when the cap is hit.
- **Optional password authentication** — set `AUTH_PASSWORD` to require login before any inbox can be created or read. HMAC-signed session cookie, 7-day expiry, per-IP rate limiting on login attempts.
- **Cloud-ready** — bind to `0.0.0.0` behind any reverse proxy (Caddy/nginx/Cloudflare/Render); Dockerfile included.
- Stores account credentials and tokens in `.data/inboxes.json` with restrictive file permissions where supported.
- Binds to `127.0.0.1` by default; opt into a public bind with `HOST=0.0.0.0`.

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` for cloud / container / reverse-proxy deployments. |
| `TTL_MINUTES` | `0` | Inbox lifetime in minutes. `0` means **permanent** (no local expiry). Example: `TTL_MINUTES=60` restores a 1-hour lifetime. |
| `MAX_INBOXES` | `5` | Maximum number of inboxes stored locally at once. Creating more is rejected with HTTP 429 until you delete an existing one. |
| `AUTH_PASSWORD` | _(empty)_ | If set, all routes require a session cookie obtained by logging in at `/login`. Empty = auth disabled (local mode). |
| `SESSION_SECRET` | _(random)_ | Secret used to sign session cookies. **Set this to a long random string in production** — otherwise sessions won't survive a restart. |
| `NODE_ENV` | _(unset)_ | Set to `production` so the session cookie gets the `Secure` flag (only sent over HTTPS). |
| `FORCE_HTTPS` | _(unset)_ | Set to any truthy value to force the `Secure` flag on the cookie even if `NODE_ENV` isn't `production`. |

Examples:

```bash
# macOS / Linux — permanent inboxes, cap of 10
MAX_INBOXES=10 npm start

# macOS / Linux — 1-hour lifetime, cap of 3
TTL_MINUTES=60 MAX_INBOXES=3 npm start
```

```bat
:: Windows CMD — permanent inboxes, cap of 10
set MAX_INBOXES=10 && npm start
```

## About "permanent"

This server treats an inbox as permanent: it never expires the local access token, and the dashboard no longer shows a countdown. Two important caveats:

1. **The provider (Mail.tm) controls account retention.** Mail.tm may delete inactive accounts or invalidate tokens according to its own policy. This local client cannot override that. If the provider rejects a stored token, the dashboard surfaces "Provider inbox expired or credentials were rejected" and you can generate a new address.
2. **Tokens are stored on disk.** `.data/inboxes.json` contains bearer tokens and mailbox passwords for every persistent inbox. Keep this file private and delete it when you want to revoke all locally stored access.

## Important provider constraints

Mail.tm is a third-party provider. It controls domain availability, account creation, deliverability, retention, and rate limits. Some external websites block disposable domains. Inbox generation can fail if the provider is unavailable, rate-limits account creation, or rejects a requested account. This application does not bypass those restrictions.

The provider's documentation describes a general limit of 8 requests per second. Account creation may be subject to stricter limits. If generation is rate-limited, wait and retry.

Mail.tm requires attribution and prohibits illegal use, reselling an API wrapper, and proxying/mirroring its service under another domain. This project is intended as a local testing client. See:
- https://docs.mail.tm/
- https://docs.mail.tm/api/accounts
- https://docs.mail.tm/api/messages

## Data and privacy

- `.data/inboxes.json` contains provider bearer tokens and generated mailbox passwords. Do not share this file.
- Use this only on a trusted computer, or behind a password you control (set `AUTH_PASSWORD`).
- If you expose this server to the internet, **always** set `AUTH_PASSWORD` and run behind HTTPS — otherwise anyone who finds the URL can read your inboxes.
- Delete `.data/inboxes.json` and stop the server to clear locally stored inbox credentials.
- Message content is untrusted. The interface displays it as escaped text and does not execute remote HTML.

## Cloud deployment

The app is a single Node.js process with no external database, so it deploys anywhere that runs Node or Docker. Three common paths:

### Option A — Cloudflare Tunnel (quickest, no deploy)

Exposes your local machine via a public HTTPS URL without opening any ports. Run Dropmail locally with auth on, then tunnel it:

```bash
# 1. Run Dropmail locally with auth
AUTH_PASSWORD="your-strong-password" \
SESSION_SECRET="$(openssl rand -hex 32)" \
HOST=127.0.0.1 \
npm start

# 2. In another terminal, install cloudflared and run a quick tunnel
cloudflared tunnel --url http://127.0.0.1:3000
```

Cloudflared prints a public `https://*.trycloudflare.com` URL. Open it, enter your password, and you're in. The tunnel dies when you stop `cloudflared`. For a persistent named tunnel, follow [the Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

### Option B — Render.com (free hosting, persistent)

1. Push this folder to a GitHub repo.
2. On Render, create a new **Web Service** from that repo.
3. Build command: `npm install --omit=dev` · Start command: `node server.js`
4. Set environment variables:
   - `HOST` = `0.0.0.0`
   - `AUTH_PASSWORD` = a strong password
   - `SESSION_SECRET` = a long random string (e.g. `openssl rand -hex 32`)
   - `NODE_ENV` = `production`
   - optionally `MAX_INBOXES`, `TTL_MINUTES`
5. Render gives you a persistent `https://your-app.onrender.com` URL with HTTPS automatically. The `.data` folder is ephemeral on the free tier — to keep inboxes across redeploys, attach a persistent disk at `/opt/render/project/src/.data`.

### Option C — Docker on a VPS (most control)

```bash
# Build
docker build -t dropmail .

# Run with a named volume for persistence and auth on
docker run -d \
  --name dropmail \
  -p 127.0.0.1:3000:3000 \
  -v dropmail-data:/app/.data \
  -e AUTH_PASSWORD="your-strong-password" \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e NODE_ENV=production \
  --restart unless-stopped \
  dropmail
```

Then put Caddy in front for automatic HTTPS (recommended). A minimal `Caddyfile`:

```caddy
mail.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Caddy issues and renews a Let's Encrypt cert automatically. Visit `https://mail.example.com`, enter your password, done.

### Security checklist before you expose

- [ ] `AUTH_PASSWORD` is set to a strong, unique password.
- [ ] `SESSION_SECRET` is set to a long random string (otherwise sessions invalidate on every restart).
- [ ] HTTPS is terminating in front (Cloudflare / Render / Caddy / nginx). The session cookie only gets the `Secure` flag when `NODE_ENV=production` or `FORCE_HTTPS=1`.
- [ ] `.data/inboxes.json` is on a persistent volume if you want inboxes to survive restarts.
- [ ] You've reviewed Mail.tm's terms — personal use is fine; reselling the API or running a public mirror under another domain is prohibited.

## Troubleshooting

- **Could not load provider domains:** Check internet connectivity and whether `https://api.mail.tm/domains` is reachable.
- **429 / rate limited:** Wait before creating another inbox. If the message says "Local inbox limit reached", delete an existing inbox first or raise `MAX_INBOXES`.
- **No email appears:** Confirm the address was copied correctly. Some senders block disposable email domains; delivery is controlled by the provider and sender.
- **"Provider inbox expired or credentials were rejected":** The provider invalidated the stored token (commonly because the account was deleted server-side after inactivity). Generate a new address.
- **Port 3000 is in use:** Start with `set PORT=3001 && npm start` on Windows CMD, or `PORT=3001 npm start` on macOS/Linux; then open `http://127.0.0.1:3001`.
- **Node version error:** Install Node.js 20 or newer from https://nodejs.org/.
- **Want to clear everything:** Stop the server and delete `.data/inboxes.json`.

## Architecture

Browser → local Express server → Mail.tm API → temporary mailbox. The browser never receives the provider bearer token.
