# CLAUDE.md - AI Sales Agent System Architecture & Directory Blueprint

## Project Context & Architecture
This is a production-grade, subscription-free AI Sales Agent for a high-ticket infrastructure company operating in two high-trust verticals: Solar Solutions and Borehole Drilling Services.

### Core Stack
- **Runtime & Framework:** Node.js (ES6 Modules, `"type": "module"`) with Express.
- **AI Integration Layer:** Anthropic Model Context Protocol (MCP) using `@modelcontextprotocol/sdk`.
- **Hosting Environment:** Hosted directly on a secure domain over HTTPS.
- **Upstream Trigger:** Meta Business Suite Webhook (WhatsApp Cloud API integration).

---

## Pending Features (to implement later)

### 1. WhatsApp 24-Hour Messaging Window — Message Templates
WhatsApp only allows free-form replies within 24 hours of the last customer message. After that window closes, the API rejects outbound messages (error `131047`).

**What needs to be built:**
- Create pre-approved **HSM Message Templates** in Meta Business Manager (e.g. quote follow-ups, callback reminders, site assessment confirmations).
- Templates must be submitted to Meta for approval (1-3 days).
- Requires a **payment method** added to the Meta Business account.
- Add a `sendTemplateMessage(to, templateName, params)` function in `src/services/whatsapp.js` for proactive outreach to leads who have gone cold (>24h silence).

**Current status:** Agent works fine for inbound-triggered conversations. Templates needed only for proactive follow-up after 24h of silence.

### 2. ~~Dedicated Phone Number for AI Agent~~ ✅ DONE
Separate WhatsApp Business number exclusively for the AI agent is already set up and connected to the webhook. Sales team uses a different number — no conflicts.

### 3. WhatsApp Product Catalog Integration
The company already has a product catalog set up in Meta Commerce Manager and linked to the WhatsApp Business number. The agent needs to be able to send interactive product messages from this catalog during conversations.

**What to build:**
- Add `WHATSAPP_CATALOG_ID` to `.env` (get from Meta Commerce Manager → Catalog → Settings)
- Add these functions to `src/services/whatsapp.js`:
  - `sendCatalogMessage(to)` — sends a button that opens the full catalog inside WhatsApp
  - `sendProductMessage(to, productRetailerId)` — sends a single product card (image, name, price, description)
  - `sendProductListMessage(to, productRetailerIds, sectionTitle)` — sends a curated list of multiple products
- Add a `show_products` tool in `src/mcp/tools.js` and `src/mcp/mcpServer.js` with inputs: `type` (catalog|single|list), `product_ids` (array), `section_title`
- Update `src/agent/prompts.js` to instruct Claude to use `show_products` when customers ask to see products, packages, or pricing options

**Key benefit:** Product updates (prices, images, descriptions) are managed entirely in Meta Business Manager — no code changes needed when catalog changes.

**To start building:** Provide the Catalog ID from Meta Commerce Manager → select catalog → Settings → Catalog ID.

### 4. Admin Conversation Dashboard
Build a `/admin` page served by the Express app that reads from `data/sessions.json` and displays all ongoing conversations in a browser interface.

**URL:** `https://salesai.waterliftsolarsavings.africa/admin`

**Should show:**
- All active sessions (phone number, domain, last seen timestamp)
- Full message history per conversation
- Lead/callback/escalation status
- Password-protect the route (add `ADMIN_PASSWORD` to `.env`)

**Implementation:** Add a `GET /admin` route in `webhook.js` that renders an HTML page — no frontend framework needed, plain HTML/CSS is fine.

### 4. Meta Business Verification
Complete full business verification on Meta Business Manager to unlock higher messaging tier limits (currently limited to low volume unverified tier).

---

## Target Directory Structure
Claude Code must strictly implement and maintain the following modular folder layout:

```text
├── CLAUDE.md                 # This system development architecture guide
├── .env                      # Local runtime secrets (never commit to source)
├── package.json              # App configuration & modern ES6 modules spec
├── webhook.js                # Live entrypoint for Meta's HTTP Webhook notifications
└── src/
    ├── mcp/
    │   ├── mcpServer.js      # Host process configuring the @modelcontextprotocol/sdk
    │   └── tools.js          # Definitions/schemas for tools exposed to Claude
    ├── services/
    │   └── whatsapp.js       # Outbound HTTPS engine executing official Meta Cloud API calls
    └── agent/
        ├── pipeline.js       # Core orchestration tying Webhook -> Claude API -> MCP Tool
        └── prompts.js        # Strict system prompts for Solar vs Borehole domains