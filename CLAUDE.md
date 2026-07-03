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

### 5. SaaS Multi-Tenant Architecture
Convert this single-tenant agent into a multi-tenant SaaS platform where multiple businesses can each run their own AI sales agent on their own WhatsApp number.

**Architecture changes required:**
- **Multi-tenant data model** — the system already migrated off flat JSON files onto MySQL (see `schema.sql`: `sessions`, `messages`, `leads`, `callbacks`, `escalations`). None of these tables have a `tenant_id` column yet — everything belongs to one implicit tenant. Adding `tenant_id` to each table (and to every query in `src/services/db.js`) is the actual remaining task, not a database migration.
- **Per-tenant configuration** — store WhatsApp credentials (phone number ID, access token, verify token), system prompts, and product catalog per tenant in DB instead of `.env`.
- **Webhook routing** — single `/webhook` endpoint dispatches to the correct tenant by matching the `verify_token` or phone number ID from Meta's payload.
- **Tenant onboarding UI** — web form where a new client enters their WhatsApp credentials, describes their business/services, and pastes their product catalog. Generates their system prompt automatically.
- **Per-tenant admin dashboard** — each client logs in to see only their own conversations, leads, and callbacks. Add auth (Clerk or Auth.js).
- **Billing** — Stripe integration, charge per active WhatsApp number per month.
- **Hosting** — migrate off cPanel/LiteSpeed to Railway, Render, or VPS to eliminate the LSAPI async timeout issue that affects multi-iteration Claude calls.

**WhatsApp constraint (critical):**
Each tenant must bring their own WhatsApp Business Account and phone number — one number cannot be shared across clients. Two paths:
- **Path A (start here):** Clients connect their own WABA credentials during onboarding.
- **Path B (future):** Apply to become a Meta WhatsApp Business Solution Provider (BSP) to provision numbers directly — requires Meta approval and significant compliance overhead.

**Target market:** High-ticket service businesses in Kenya/Africa with WhatsApp presence — solar companies, borehole drillers, real estate agents, insurance brokers, car dealers.

**Recommended pricing:** KShs 5,000–20,000/month per WhatsApp number depending on message volume and features.

**Current status:** Single-tenant only. SaaS architecture is a future roadmap item — implement after Meta Business Verification is complete and the current system is stable in production.

**Current codebase assessment (SaaS-readiness):**
- What's already in good shape: the module split (`src/services/whatsapp.js`, `src/agent/pipeline.js`, `src/agent/prompts.js`, `src/services/db.js`, `src/mcp/`) is clean — most of the *logic* would carry over unchanged, it just needs to be parameterized by tenant rather than rewritten.
- Concrete blockers found when this was reviewed:
  1. WhatsApp credentials (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`) live in one shared `.env` — only one business/number can exist at a time.
  2. No `tenant_id` on `sessions` / `messages` / `leads` / `callbacks` / `escalations` — see data-model note above.
  3. `POST /webhook` in `webhook.js` doesn't dispatch by tenant — it assumes every inbound message belongs to this one client.
  4. `SOLAR_SYSTEM_PROMPT` / `BOREHOLE_SYSTEM_PROMPT` in `src/agent/prompts.js` are hardcoded strings, including the full product catalog with prices — a new tenant's business description/catalog isn't data-driven yet.
  5. `/admin` in `webhook.js` uses one global `ADMIN_PASSWORD` and shows every conversation with no per-tenant isolation.
- Migration path: add a `tenants` table, add `tenant_id` to the other tables, move WhatsApp credentials + system prompt + catalog into per-tenant DB rows, route `/webhook` by matching the incoming `phone_number_id` to a tenant, and give `/admin` per-tenant login + scoped queries.

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
    └── age
    
    
    
    
    
    
    
    nt/
        ├── pipeline.js       # Core orchestration tying Webhook -> Claude API -> MCP Tool
        └── prompts.js        # Strict system prompts for Solar vs Borehole domains