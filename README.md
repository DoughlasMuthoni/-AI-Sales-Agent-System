# AI Sales Agent — Waterlift Solar Limited

A production-grade WhatsApp AI Sales Agent for **Waterlift Solar Limited**, handling inbound customer conversations across two verticals: **Solar Energy Solutions** and **Borehole Drilling Services**.

Built on Node.js + Express, powered by Claude (Anthropic), connected via the WhatsApp Cloud API (Meta Business Suite).

---

## How It Works

1. A customer messages the WhatsApp Business number
2. Meta sends a webhook `POST` to the server
3. The server responds `200 OK` immediately (within Meta's 5-second window)
4. The pipeline detects the service domain (solar vs borehole) from the message
5. Claude is called with the appropriate system prompt and conversation history
6. If Claude calls a tool (qualify lead, send quote, schedule callback, etc.) the loop continues until `end_turn`
7. The final text reply is sent back to the customer via the WhatsApp Cloud API

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ (CommonJS) |
| Web framework | Express 4 |
| AI | Anthropic Claude (claude-sonnet-4-6) |
| Messaging | WhatsApp Cloud API v21.0 |
| Tool protocol | Model Context Protocol (MCP) — `@modelcontextprotocol/sdk` |
| Hosting | cPanel / LiteSpeed LSAPI over HTTPS |
| Database | MySQL (via `mysql2/promise` connection pool) |

---

## Directory Structure

```
├── CLAUDE.md                 # Architecture guide and pending features
├── README.md                 # This file
├── schema.sql                # MySQL schema — import via phpMyAdmin to create all tables
├── .env                      # Runtime secrets (never commit)
├── package.json
├── webhook.js                # Express entry point — handles Meta webhook + admin dashboard
└── src/
    ├── agent/
    │   ├── pipeline.js       # Core orchestration: webhook → Claude → tools → WhatsApp
    │   └── prompts.js        # System prompts for Solar and Borehole domains
    ├── mcp/
    │   ├── mcpServer.js      # Tool handlers and MCP server setup
    │   └── tools.js          # Tool schemas exposed to Claude
    └── services/
        ├── db.js             # MySQL connection pool — all database read/write operations
        ├── whatsapp.js       # WhatsApp Cloud API — send messages, typing indicator, product cards
        └── email.js          # Email notifications for leads, callbacks, escalations
```

---

## Environment Variables

Create a `.env` file at the project root:

```env
# WhatsApp Cloud API
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_ACCESS_TOKEN=your_permanent_access_token
WHATSAPP_VERIFY_TOKEN=your_chosen_verify_token

# Meta Commerce (optional — enables interactive product cards in WhatsApp)
WHATSAPP_CATALOG_ID=your_catalog_id

# Anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key
CLAUDE_MODEL=claude-sonnet-4-6

# MySQL Database
DB_HOST=127.0.0.1
DB_USER=your_db_username
DB_PASSWORD=your_db_password
DB_NAME=your_db_name

# Admin Dashboard
ADMIN_PASSWORD=your_admin_password

# Server
PORT=3000

# Email notifications (leads, callbacks, escalations)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
NOTIFY_EMAIL=
```

> **Note:** Use `DB_HOST=127.0.0.1` (IPv4) rather than `localhost` — on cPanel servers `localhost` resolves to IPv6 `::1` which MySQL does not listen on.

---

## Setup

### 1. Create the MySQL database

In **cPanel → MySQL Databases**:
- Create a new database (e.g. `myuser_salesai`)
- Create a database user and assign full privileges to that database
- Record the host, username, password, and database name for `.env`

### 2. Import the schema

In **phpMyAdmin**:
- Select your new database
- Click **Import** → choose `schema.sql` from the project root → **Go**

This creates five tables: `sessions`, `messages`, `leads`, `callbacks`, `escalations`.

### 3. Install dependencies

In cPanel's **Node.js** application manager, click **Run NPM Install** — or via SSH:

```bash
cd ~/salesai.waterliftsolarsavings.africa
npm install
```

### 4. Start the server

```bash
node webhook.js
```

For local development, expose with ngrok and register the HTTPS URL in **Meta Developer Console → WhatsApp → Configuration → Webhook URL**.

---

## Database Tables

| Table | Purpose |
|---|---|
| `sessions` | One row per customer phone number — domain, last seen timestamp, escalated/takeover flags |
| `messages` | Full conversation history — every user, assistant, and tool message, keyed by phone |
| `leads` | Captured lead records with name, location, service, status (new → contacted → converted/lost) |
| `callbacks` | Scheduled site visit and consultation bookings |
| `escalations` | Human escalation requests flagged by the agent |

Conversation history is **permanent** — there is no expiry. History from all previous conversations is visible in the admin dashboard and available to Claude on every message (last 20 messages per API call).

---

## Domain Detection

Every message runs through a two-tier detector in `pipeline.js`:

1. **Phrase matching** (takes priority) — compound terms like "heat pump", "hot water", "borehole", "water well" are matched first to avoid keyword ambiguity
2. **Keyword scoring** — counts solar vs borehole keywords; higher score wins
3. **Fallback** — if ambiguous, a general greeting asks the customer which service they need

Domain detection runs on **every message**, so if a customer pivots from borehole to solar topics mid-conversation the agent updates automatically.

---

## Agentic Loop

The pipeline runs up to **10 iterations** per message:

```
Claude API call
  └─ stop_reason: end_turn    → extract text → send WhatsApp message → done
  └─ stop_reason: tool_use    → execute all tool blocks in parallel → append tool_results → loop
  └─ stop_reason: max_tokens  → send whatever text was generated → done
```

When a tool sends a reply directly to the customer (e.g. `show_products` catalog fallback), it returns a `SENT_DIRECTLY:` sentinel and the loop exits immediately without a second Claude call.

---

## Tools Available to Claude

| Tool | Purpose |
|---|---|
| `qualify_lead` | Captures name, phone, location, service, property type — writes to `leads` table and sends email |
| `send_quote` | Generates indicative price ranges for solar systems or borehole drilling |
| `schedule_callback` | Books a site visit or consultation — writes to `callbacks` table and sends email |
| `escalate_to_human` | Flags the conversation for the sales team — writes to `escalations` table and sends email |
| `show_products` | Sends WhatsApp interactive product cards (requires Meta catalog to be linked) |

---

## Cost Controls

- **Prompt caching** — system prompt (~1,800 tokens) is cached via `cache_control: { type: 'ephemeral' }` on the system content block; cached tokens cost ~10% of normal input token price.
- **History trimming** — only the last 20 messages are sent to Claude per call; full history is preserved in the `messages` table. Orphaned `tool_result` blocks are automatically dropped from the trimmed slice.
- **Output cap** — `max_tokens: 1024` on every API call.

---

## Session Management

Sessions are keyed by the customer's WhatsApp phone number and stored in the `sessions` table. Each session holds:

- `domain` — `solar`, `borehole`, or `null`
- `last_seen` — Unix timestamp of the most recent message
- `escalated` — set `true` when `escalate_to_human` is called
- `human_takeover` — set `true` to pause AI and allow a human agent to reply manually

Full message history is stored in the `messages` table (no expiry) and is available in the admin dashboard for all past conversations.

Admin controls exposed by `pipeline.js`:

```js
pauseSession(phone)              // stops AI replies; human can take over
resumeSession(phone)             // re-enables AI replies
appendAdminMessage(phone, text)  // injects a human-written message into the conversation history
```

When AI is paused and a human replies via the admin dashboard, those messages are saved as `assistant` role with `source: 'human'`. When AI resumes, it has full context of what the human agent said and can continue the conversation seamlessly.

---

## Admin Dashboard

Available at: `https://salesai.waterliftsolarsavings.africa/admin`

Protected by HTTP Basic Auth — username `admin`, password from `ADMIN_PASSWORD` in `.env`.

Shows:
- All conversation sessions (phone number, domain, last seen, escalated/takeover status)
- Full message history per conversation (permanent — all history, not limited to recent messages)
- Pause / Resume AI toggle per conversation
- Human agent reply form (inject messages into conversation history)
- Leads table with status management (New → Contacted → Converted / Lost)
- Scheduled callbacks list
- Escalations list

---

## WhatsApp Product Catalog

Interactive product cards (images, prices, "View" buttons inside WhatsApp) require:

1. A product catalog set up in **Meta Commerce Manager**
2. The catalog linked to the WhatsApp Business Account:
   - Commerce Manager → catalog → **Settings → Connected Assets** → add WhatsApp Business Account
   - WhatsApp Manager → **Settings → WhatsApp Commerce Settings** → enable Shopping
3. `WHATSAPP_CATALOG_ID` set in `.env`

Until the catalog is linked, Claude falls back to describing products from its system prompt and directing customers to `waterliftsolar.africa/shop`.

---

## Pending Features

See `CLAUDE.md` for full specifications. Summary:

- **WhatsApp Message Templates** — for proactive outreach after the 24-hour messaging window closes (requires Meta payment method + template approval, 1–3 days)
- **Meta Business Verification** — unlocks higher messaging tier limits
- **WhatsApp Product Catalog integration** — interactive product cards inside WhatsApp (blocked until Meta Business Verification is complete)
- **SaaS Multi-Tenant Architecture** — run multiple independent agents for different businesses on a single platform

---

## Useful Links

- WhatsApp Business number: dedicated AI agent line (separate from the sales team number)
- Company website: [waterliftsolar.africa](https://waterliftsolar.africa)
- Shop: [waterliftsolar.africa/shop](https://waterliftsolar.africa/shop)
- Support: support@waterliftsolar.africa | +254 768 117 070
- Offices: Nairobi (Baba Dogo) and Nanyuki (Laikipia)
