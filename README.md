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
| Session storage | `data/sessions.json` (file-based, 24-hour TTL) |

---

## Directory Structure

```
├── CLAUDE.md                 # Architecture guide and pending features
├── README.md                 # This file
├── .env                      # Runtime secrets (never commit)
├── package.json
├── webhook.js                # Express entry point — handles Meta webhook
├── data/
│   ├── sessions.json         # Active conversation sessions
│   ├── leads.json            # Captured leads
│   ├── callbacks.json        # Scheduled callbacks
│   └── escalations.json      # Human escalation records
└── src/
    ├── agent/
    │   ├── pipeline.js       # Core orchestration: webhook → Claude → tools → WhatsApp
    │   └── prompts.js        # System prompts for Solar and Borehole domains
    ├── mcp/
    │   ├── mcpServer.js      # Tool handlers and MCP server setup
    │   └── tools.js          # Tool schemas exposed to Claude
    └── services/
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

# Server
PORT=3000

# Email notifications (leads, callbacks, escalations)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
NOTIFY_EMAIL=
```

---

## Setup

```bash
npm install
node webhook.js
```

The server starts on the configured `PORT`. For local testing, expose it with:

```bash
ngrok http 3000
```

Register the HTTPS ngrok URL in **Meta Developer Console → WhatsApp → Configuration → Webhook URL** using your `WHATSAPP_VERIFY_TOKEN`.

---

## Domain Detection

Every new session runs the incoming message through a two-tier detector in `pipeline.js`:

1. **Phrase matching** (takes priority) — compound terms like "heat pump", "hot water", "borehole", "water well" are matched first to avoid keyword ambiguity
2. **Keyword scoring** — counts solar vs borehole keywords; higher score wins
3. **Fallback** — if ambiguous, a general greeting asks the customer which service they need

Once a domain is set on the session it persists for the 24-hour session window.

---

## Agentic Loop

The pipeline runs up to **10 iterations** per message:

```
Claude API call
  └─ stop_reason: end_turn    → extract text → send WhatsApp message → done
  └─ stop_reason: tool_use    → execute all tool blocks in parallel → append tool_results → loop
  └─ stop_reason: max_tokens  → send whatever text was generated → done
```

---

## Tools Available to Claude

| Tool | Purpose |
|---|---|
| `qualify_lead` | Captures name, phone, location, service, property type — writes to `leads.json` and sends email |
| `send_quote` | Generates indicative price ranges for solar systems or borehole drilling |
| `schedule_callback` | Books a site visit or consultation — writes to `callbacks.json` and sends email |
| `escalate_to_human` | Flags the conversation for the sales team — writes to `escalations.json` and sends email |
| `show_products` | Sends WhatsApp interactive product cards (requires Meta catalog to be linked) |

---

## Cost Controls

- **Prompt caching** — system prompt (~1,800 tokens) is cached via `anthropic.beta.promptCaching`; cached tokens cost ~10% of normal input token price. All sessions sharing the same domain prompt hit the same cache entry.
- **History trimming** — only the last 20 messages are sent to Claude per call; full history is preserved in `sessions.json` for the admin dashboard. Orphaned `tool_result` blocks are automatically dropped from the trimmed slice.
- **Output cap** — `max_tokens: 1024` on every API call.

---

## Session Management

Sessions are keyed by the customer's WhatsApp phone number and stored in `data/sessions.json`. Each session holds:

- `domain` — `solar`, `borehole`, or `null`
- `messages` — full conversation history (including system seed messages)
- `lastSeen` — Unix timestamp; sessions expire after 24 hours of inactivity
- `escalated` — set `true` when `escalate_to_human` is called
- `humanTakeover` — set `true` to pause AI and allow a human agent to reply manually

Admin controls exposed by `pipeline.js`:

```js
pauseSession(phone)          // stops AI replies; human can take over
resumeSession(phone)         // re-enables AI replies
appendAdminMessage(phone, text)  // injects a human-written message into the session history
```

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
- **Admin Conversation Dashboard** — `/admin` route showing all active sessions, message history, lead status (password-protected)
- **Lead status tracking** — New → Contacted → Converted / Lost
- **Meta Business Verification** — unlocks higher messaging tier limits

---

## Useful Links

- WhatsApp Business number: dedicated AI agent line (separate from the sales team number)
- Company website: [waterliftsolar.africa](https://waterliftsolar.africa)
- Shop: [waterliftsolar.africa/shop](https://waterliftsolar.africa/shop)
- Support: support@waterliftsolar.africa | +254 768 117 070
- Offices: Nairobi (Baba Dogo) and Nanyuki (Laikipia)
