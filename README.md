# AI Sales Agent — Waterlift Solar Limited

A production WhatsApp AI Sales Agent for **Waterlift Solar Limited**, handling inbound customer conversations across two verticals: **Solar Energy Solutions** and **Borehole Drilling Services** — plus a full admin dashboard for the sales team to monitor, take over, and manage conversations.

Built on Node.js + Express, powered by Claude (Anthropic), connected via the WhatsApp Cloud API (Meta Business Suite).

---

## How It Works

1. A customer messages the WhatsApp Business number
2. Meta sends a webhook `POST` to the server
3. The server responds `200 OK` immediately (within Meta's 5-second window)
4. The pipeline detects the service domain (solar vs borehole) from the message
5. Claude is called with the appropriate system prompt and conversation history
6. If Claude calls a tool (qualify lead, send quote, schedule callback, show products, escalate) the loop continues until `end_turn`
7. The final text reply is sent back to the customer via the WhatsApp Cloud API

If a human agent has paused the AI for that conversation (via the admin dashboard), inbound messages are still logged but skip the AI entirely — the human replies manually instead.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ (CommonJS) |
| Web framework | Express 4 |
| AI | Anthropic Claude (`claude-sonnet-4-6` by default) |
| Messaging | WhatsApp Cloud API v21.0 |
| Tool protocol | Model Context Protocol (MCP) — `@modelcontextprotocol/sdk` |
| Hosting | cPanel / LiteSpeed LSAPI over HTTPS |
| Database | MySQL (via `mysql2/promise` connection pool) |
| Admin auth | Hand-rolled email/password login — `bcryptjs` + `express-session` with a MySQL-backed session store |
| File uploads | `multer` (in-memory, for quotation documents sent to customers) |
| Push notifications | `web-push` (VAPID) — admin dashboard is an installable PWA |
| Email notifications | `nodemailer` (SMTP) — leads, callbacks, escalations |

---

## Directory Structure

```
├── CLAUDE.md                       # Architecture guide and pending features (read by Claude Code)
├── README.md                       # This file
├── schema.sql                      # MySQL schema — import via phpMyAdmin to create all tables
├── .env                            # Runtime secrets (never commit)
├── package.json
├── webhook.js                      # Express entry point — Meta webhook, login, and the entire admin dashboard
├── data/
│   └── uploads/                    # Quotation documents sent to customers (gitignored)
├── public/                         # Static assets, served at the root
│   ├── logo.png                    # Waterlift Solar logo, used on the login page and dashboard header
│   ├── icons/                      # Favicon + PWA install icons
│   ├── manifest.webmanifest        # PWA manifest ("Add to Home Screen")
│   └── sw.js                       # Service worker — push notifications only, no offline caching
├── scripts/
│   └── create-admin-user.js        # One-off CLI script to provision a dashboard login account
└── src/
    ├── agent/
    │   ├── pipeline.js             # Core orchestration: webhook → Claude → tools → WhatsApp
    │   └── prompts.js              # System prompts + full product catalog for Solar and Borehole domains
    ├── mcp/
    │   ├── mcpServer.js            # Tool handlers (qualify_lead, send_quote, show_products, etc.)
    │   └── tools.js                # Tool schemas exposed to Claude
    └── services/
        ├── db.js                   # MySQL connection pool — all database read/write operations
        ├── whatsapp.js             # WhatsApp Cloud API — send/upload, product cards, quoted replies
        ├── authService.js          # bcrypt password hashing for dashboard logins
        ├── push.js                 # Web push notifications to the admin dashboard
        └── email.js                # Email notifications for leads, callbacks, escalations
```

---

## Environment Variables

Create a `.env` file at the project root:

```env
# WhatsApp Cloud API
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_ACCESS_TOKEN=your_permanent_access_token
WHATSAPP_VERIFY_TOKEN=your_chosen_verify_token

# Meta Commerce (enables interactive product cards in WhatsApp)
WHATSAPP_CATALOG_ID=your_catalog_id

# Anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key
CLAUDE_MODEL=claude-sonnet-4-6

# MySQL Database
DB_HOST=127.0.0.1
DB_USER=your_db_username
DB_PASSWORD=your_db_password
DB_NAME=your_db_name

# Admin dashboard login sessions — any random string (see Setup below for how to generate one)
SESSION_SECRET=

# Server
PORT=3000

# Email notifications (leads, callbacks, escalations)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
NOTIFICATION_EMAIL=

# Web push notifications (admin dashboard PWA) — generate with: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:support@waterliftsolar.africa
```

> **Note:** Use `DB_HOST=127.0.0.1` (IPv4) rather than `localhost` — on cPanel servers `localhost` resolves to IPv6 `::1`, which MySQL does not listen on.

---

## Setup

### 1. Create the MySQL database

In **cPanel → MySQL Databases**: create a database, create a user with full privileges on it, and record the host/username/password/database name for `.env`.

### 2. Import the schema

In **phpMyAdmin**: select the database → **Import** → choose `schema.sql` from the project root → **Go**. This creates all eight tables (see below).

### 3. Install dependencies

In cPanel's **Setup Node.js App**, click **Run NPM Install** — or via terminal:
```bash
cd ~/salesai.waterliftsolarsavings.africa
npm install
```

### 4. Generate a session secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Paste the output into `SESSION_SECRET` in `.env`.

### 5. Create a dashboard login account

```bash
node scripts/create-admin-user.js you@example.com YourPassword123
```
(No terminal access? Hash the password locally with bcrypt and `INSERT` it directly into the `admin_users` table via phpMyAdmin instead.)

### 6. Start the server

```bash
node webhook.js
```

Log in at `/login`. For local development, expose the server with ngrok and register the HTTPS URL in **Meta Developer Console → WhatsApp → Configuration → Webhook URL**.

---

## Database Tables

| Table | Purpose |
|---|---|
| `sessions` | One row per customer phone number — domain, last seen, escalated/human-takeover flags, ad-referral attribution |
| `messages` | Full conversation history — every customer, AI, and human-agent message, keyed by phone. Also stores each message's WhatsApp id (for quoted replies) and a reply-context snapshot |
| `leads` | Captured lead records — name, phone, location, service, property type, budget, free-text notes, status (new → contacted → converted/lost) |
| `callbacks` | Scheduled site visit / consultation bookings |
| `escalations` | Human escalation requests flagged by the agent |
| `push_subscriptions` | Registered browser push endpoints for the admin PWA |
| `admin_users` | Dashboard login accounts (email + bcrypt password hash) |
| `admin_sessions` | Login session store for `express-session` (separate from the `sessions` table above, which is WhatsApp conversation state, not logins) |

Conversation history is **permanent** — there is no expiry. Full history is visible in the admin dashboard; Claude sees the last 20 messages per API call.

---

## Domain Detection

Every message runs through a two-tier detector in `pipeline.js`:

1. **Phrase matching** (takes priority) — compound terms like "heat pump", "hot water", "borehole", "water well" are matched first to avoid keyword ambiguity
2. **Keyword scoring** — counts solar vs borehole keywords; higher score wins
3. **Fallback** — if ambiguous, a general greeting asks the customer which service they need

Domain detection runs on **every message**, so if a customer pivots from borehole to solar topics mid-conversation the agent updates automatically. If the customer arrived via a Click-to-WhatsApp ad, the ad's headline/body can also help pick the domain when the message itself is generic (e.g. "Hi").

---

## Agentic Loop

The pipeline runs up to **10 iterations** per message:

```
Claude API call
  └─ stop_reason: end_turn    → extract text → send WhatsApp message → done
  └─ stop_reason: tool_use    → execute all tool blocks in parallel → append tool_results → loop
  └─ stop_reason: max_tokens  → send whatever text was generated → done
```

When a tool sends a reply directly to the customer (e.g. `show_products` falling back to a website link), it returns a `SENT_DIRECTLY:` sentinel and the loop exits immediately without a further Claude call. Tool failures that Claude *can* usefully respond to (e.g. a specific product not being sendable) instead return a plain error string — the loop continues and Claude composes its own reply using its product knowledge, rather than the customer getting a generic dead end.

---

## Tools Available to Claude

| Tool | Purpose |
|---|---|
| `qualify_lead` | Captures name, phone, location, service, property type, and optional notes — writes to `leads` and sends an email notification |
| `send_quote` | Generates indicative price ranges for solar systems or borehole drilling |
| `schedule_callback` | Books a site visit or consultation — writes to `callbacks` and sends an email notification |
| `escalate_to_human` | Flags the conversation for the sales team — writes to `escalations` and sends an email notification |
| `show_products` | Sends WhatsApp interactive product cards from the Meta catalog (single item, curated list, or full catalog browse) |

Claude can also see and reason about **photos** customers send (electricity meters, nameplates, roofs, existing equipment) via vision input — this isn't a tool call, it's handled directly in the message pipeline.

---

## Cost Controls

- **Prompt caching** — system prompt (~1,800 tokens) is cached via `cache_control: { type: 'ephemeral' }`; cached tokens cost ~10% of normal input token price.
- **History trimming** — only the last 20 messages are sent to Claude per call; full history is preserved in the `messages` table. Orphaned `tool_result` blocks are automatically dropped from the trimmed slice.
- **Output cap** — `max_tokens: 1024` on every API call.

---

## Session Management & Human Takeover

Sessions are keyed by the customer's WhatsApp phone number. Each session holds `domain`, `last_seen`, `escalated`, and `human_takeover` flags, plus first-touch ad-referral attribution.

Admin controls exposed by `pipeline.js`:

```js
pauseSession(phone)                                          // stops AI replies; human can take over
resumeSession(phone)                                         // re-enables AI replies
appendAdminMessage(phone, text, waMessageId, replyContext)    // logs a human-written text reply
appendAdminDocumentMessage(phone, filename, caption, ...)     // logs a human-sent document
```

When AI is paused and a human replies via the dashboard, those messages are saved as `assistant` role with `source: 'human'`. When AI resumes, it has full context of what the human agent said and continues seamlessly. Messages an admin sends are never fed back to Claude verbatim if they'd collide with a reserved Claude content-block type (e.g. documents) — they're sanitized to plain text first.

---

## Admin Dashboard

Available at `/admin` (redirects to `/login` if not authenticated). Login is a real per-account email/password system with server-side sessions — no shared password, no browser Basic Auth popup.

**Conversation view:**
- All active sessions with live polling (10s interval, plus an immediate re-sync whenever the browser tab regains focus — browsers throttle background-tab timers, so this keeps the view from going stale)
- Full permanent message history per conversation, including customer photos and any documents sent
- Pause / Resume AI toggle, with a human reply box that unlocks once paused
- **Reply to a specific message** — click ↩ on any bubble to quote-reply to it, exactly like WhatsApp's native swipe-to-reply; also shows what the *customer* replied to when they use the same feature on their end
- **Send documents** (PDF/Word/Excel, up to 16MB) directly to a customer — e.g. a quotation. Sent documents are saved server-side and stay clickable/reopenable afterwards, not just fire-and-forget
- Ad-referral badge showing which Click-to-WhatsApp ad brought a customer in, if any

**Leads / Callbacks / Escalations tabs:**
- Leads: add manually, edit any field, status management (New → Contacted → Converted/Lost), CSV export (formatted to avoid Excel mangling phone numbers into scientific notation or dumping raw JS date strings)

**Other:**
- Stats bar (sessions/leads/callbacks/escalations counts) can be hidden to reclaim screen space, remembered via `localStorage`
- Installable as a PWA ("Add to Home Screen") with push notifications for new customer messages — the service worker is push-only, no offline page caching

---

## WhatsApp Product Catalog

Interactive product cards (images, prices, "View" buttons inside WhatsApp) require:

1. A product catalog set up in **Meta Commerce Manager**
2. The catalog linked to the WhatsApp Business Account (Commerce Manager → catalog → **Settings → Connected Assets**; WhatsApp Manager → **Settings → WhatsApp Commerce Settings** → enable Shopping)
3. `WHATSAPP_CATALOG_ID` set in `.env`

**Known limitation:** WhatsApp Business Accounts that haven't completed Meta Business Verification have a cap on how many catalog items are actually usable via the API (observed: ~30 usable out of 78 listed in Commerce Manager), even though every item is visible in Commerce Manager itself. When a product card fails to send for this reason, Claude describes the product in plain text instead (it already has full pricing/specs in its system prompt) rather than leaving the customer with a dead end.

---

## Known Limitations

- **No message editing/unsend** — WhatsApp's Business API has no edit capability for outbound messages. Once sent, the only fix is a follow-up correction message.
- **24-hour messaging window** — outside 24 hours of the customer's last message, WhatsApp blocks free-form replies (error `131047`). Proactive re-engagement needs pre-approved Message Templates (not yet built — see Pending Features).
- **Reply-to-specific-message only works going forward** — it depends on WhatsApp message IDs that are only captured at the moment a message is sent/received; there's no way to backfill this for conversation history from before the feature existed.
- **Unverified WhatsApp Business tier** — caps usable catalog items (see above) and overall messaging volume; resolved by completing Meta Business Verification.

---

## Pending Features

See `CLAUDE.md` for full specifications. Summary:

- **WhatsApp Message Templates** — for proactive outreach after the 24-hour messaging window closes (requires a payment method on the Meta Business account + template approval, 1–3 days)
- **Meta Business Verification** — unlocks higher messaging tier limits and the full catalog (see Known Limitations)
- **SaaS Multi-Tenant Architecture** — a separate platform (different project) generalizing this pattern to run independent agents for multiple businesses

---

## Useful Links

- WhatsApp Business number: dedicated AI agent line (separate from the sales team number)
- Company website: [waterliftsolar.africa](https://waterliftsolar.africa)
- Shop: [waterliftsolar.africa/shop](https://waterliftsolar.africa/shop)
- Support: support@waterliftsolar.africa | +254 768 117 070
- Offices: Nairobi (Baba Dogo) and Nanyuki (Laikipia)
