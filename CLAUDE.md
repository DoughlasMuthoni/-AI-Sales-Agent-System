# CLAUDE.md - AI Sales Agent System Architecture & Directory Blueprint

## Project Context & Architecture
This is a production-grade, subscription-free AI Sales Agent for a high-ticket infrastructure company operating in two high-trust verticals: Solar Solutions and Borehole Drilling Services.

### Core Stack
- **Runtime & Framework:** Node.js (CommonJS — `require`/`module.exports` throughout, no `"type": "module"`) with Express.
- **AI Integration Layer:** Anthropic Model Context Protocol (MCP) using `@modelcontextprotocol/sdk`.
- **Hosting Environment:** Hosted directly on a secure domain over HTTPS (cPanel / LiteSpeed LSAPI).
- **Upstream Trigger:** Meta Business Suite Webhook (WhatsApp Cloud API integration).
- **Database:** MySQL via `mysql2/promise` (see `schema.sql` and `src/services/db.js`) — this replaced an earlier flat-JSON-file design; any mention of `data/sessions.json` elsewhere in this file is stale.

See `README.md` for the full, up-to-date picture of what's built: admin dashboard login, document sending, reply-to-specific-message, PWA/push notifications, leads management, etc.

---

## Pending Features (to implement later)

### 1. WhatsApp 24-Hour Messaging Window — Message Templates + Auto Follow-Up
WhatsApp only allows free-form replies within 24 hours of the last customer message. After that window closes, the API rejects outbound messages (error `131047`) — a pre-approved Message Template is the *only* way to message that customer again; this is a hard platform restriction, not a preference.

**Agreed plan (2026-07, not yet built):**
- **Template content** (to submit in Meta Business Manager → WhatsApp Manager → Message Templates):
  - Name: `waterlift_followup`
  - Category: **Utility** (a status check-in on an existing inquiry, not new promotional content — utility templates approve faster and cost ~80–90% less than Marketing category)
  - Body: *"Hi! This is Waterlift Solar following up on your recent {{1}} inquiry. Are you still interested, or would you like more information? Just reply and I'll continue helping you right away."* — `{{1}}` fills with the session's detected domain ("solar" or "borehole").
- **Cadence:** one follow-up per session, sent once in the 24–48 hour idle window, never repeated. Skip sessions that are already `escalated`. Track per-session whether a follow-up was already sent (new column needed, e.g. `sessions.last_followup_sent_at`) so the cron job doesn't re-send on every run.
- **What needs to be built once the template is approved:**
  - `sendTemplateMessage(to, templateName, languageCode, params)` in `src/services/whatsapp.js`.
  - A detection query (sessions with `last_seen` 24–48h ago, not escalated, no follow-up sent yet).
  - A cron-callable script (same pattern as `scripts/sync-catalog-cron.js`) that finds eligible sessions, sends the template, logs it into the conversation history (same pattern as `appendAdminMessage`), and marks `last_followup_sent_at`.
  - Dashboard visibility so the admin can see which conversations got an automated follow-up.
- **Cost — confirmed real, not new:** business-initiated messages (which is what a template is, by definition) have **always** required payment — this is separate from and predates the Oct 1, 2026 service-message pricing change (see item below). Rate is per-message, based on the *customer's* country (Kenya), not the business's. Exact Kenya rate not yet confirmed — check Meta Business Manager → WhatsApp Manager → pricing/rates section before enabling this in production, since it directly affects whether the cadence above is worth the per-lead cost at volume.
- **Payment method:** already added to the Meta Business account (done 2026-07).

**Related — separate but relevant pricing change:** starting **October 1, 2026**, Meta ends free service-message replies entirely (currently free up to 1,000 conversations/month) — normal AI replies within the 24-hour window will start costing ~$0.0068/message (exact Kenya rate to be published by Meta before 2026-09-01). This affects the whole bot's running cost, not just follow-ups, and is worth budgeting for regardless of whether the auto-follow-up feature above gets built.

**Current status:** Agent works fine for inbound-triggered conversations. Design agreed for proactive follow-up after 24h of silence; not yet implemented. Next step once ready to build: submit the template above for Meta approval (1-3 days), then implement the code pieces listed.

### 2. ~~Dedicated Phone Number for AI Agent~~ ✅ DONE
Separate WhatsApp Business number exclusively for the AI agent is already set up and connected to the webhook. Sales team uses a different number — no conflicts.

### 3. ~~WhatsApp Product Catalog Integration~~ ✅ DONE
Built and working — `src/services/whatsapp.js` has `sendCatalogMessage`/`sendProductMessage`/`sendProductListMessage`, the `show_products` tool is wired up in `src/mcp/tools.js`/`mcpServer.js`, and `WHATSAPP_CATALOG_ID` is configured.

**Known limitation:** unverified WhatsApp Business Accounts appear to have a cap on how many catalog items are actually usable via the API — observed ~30 usable products out of 78 listed in Commerce Manager, even though all 78 are visible there. When a product card fails to send for this reason, `show_products`'s error handling lets Claude fall back to describing the product in plain text (it already has full pricing/specs in its system prompt) instead of the customer hitting a dead end. Likely resolved by completing Meta Business Verification (item 4 below) — not yet confirmed.

### 4. ~~Admin Conversation Dashboard~~ ✅ DONE (and far beyond the original spec)
Live at `/admin` — real per-account email/password login (not Basic Auth), live-polling conversation view, pause/resume AI with human takeover, reply-to-specific-message (WhatsApp quoted replies), send documents and photos to customers (with click-to-reopen; photos send as real inline WhatsApp images via `sendImageMessage`, not downloadable file attachments — added 2026-07), image understanding for customer photos, leads management (add/edit/CSV export), callbacks/escalations views, ad-referral attribution, installable PWA with push notifications. Full details in `README.md`.

### 5. Meta Business Verification
Complete full business verification on Meta Business Manager to unlock higher messaging tier limits (currently limited to low volume unverified tier) — see item 3's known limitation above for why this matters beyond just messaging volume.

### 6. SaaS Multi-Tenant Architecture
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
  5. `/admin` in `webhook.js` now has real per-account login (`admin_users` table, `express-session`) instead of the old shared-password Basic Auth, but it's still a single flat account list showing every conversation — no per-tenant isolation yet.
- Migration path: add a `tenants` table, add `tenant_id` to the other tables, move WhatsApp credentials + system prompt + catalog into per-tenant DB rows, route `/webhook` by matching the incoming `phone_number_id` to a tenant, and give `/admin` per-tenant login + scoped queries.

### 7. ~~Database-Backed Product Catalog + Automated Sync~~ ✅ DONE
Built and working (2026-07). `products` table in MySQL (id, retailer_id, name, description, price, currency, category, `vertical` tag, availability — generic schema, not scoped to just solar/borehole) plus an `app_settings` key-value table storing the feed URL and last-synced timestamp. `src/services/catalogSync.js` parses the Google/Facebook-format XML feed and does a transactional full-table replace via `db.replaceProducts()`. Sync runs both ways: a "Sync Now" button in the admin Catalog tab (on-demand) and `scripts/sync-catalog-cron.js` on a nightly cPanel cron job — both re-fetch from the one saved feed URL. The Catalog tab also has a product search box and a live-synced product count in the tab label. `get_product_info` MCP tool queries the live table (FULLTEXT + LIKE search) instead of Claude reciting a frozen prompt list. `prompts.js` shrank from 258 → 152 lines once the hardcoded ~90-line price list was removed (product-specific pricing is now a live lookup; only company overview/tone/sales-approach/tool-usage-rules remain hardcoded per vertical).

**Known gap, not yet addressed:** the architecture only supports one feed URL — syncing a second catalog feed would destructively overwrite the first rather than merging. Not an issue today (one feed), but would need addressing before a second product feed/vertical is added.

### 8. ~~Water Tower Pricing + Branded PDF Quotations~~ ✅ DONE
Built 2026-07. Three parts:
- **Tower pricing is DB-backed, not hardcoded** (upgraded 2026-07 after the first real price change/expansion made hand-editing two files — `mcpServer.js` and `prompts.js` — too fragile and error-prone). Three new tables in `schema.sql`: `tower_foundation_prices` (Pad/Raft), `tower_tank_prices` (type + capacity → price), `tower_packages` (height + tank config → fabrication price, referencing the other two tables to compute the full total). CRUD in `src/services/db.js`. `src/mcp/mcpServer.js`'s `getTowerQuote()`/`getTowerQuoteBreakdown()` are now async and query these tables live (via `loadTowerPricing()`) instead of reading in-memory constants — reachable via `send_quote` with `is_tower_quote: true`. `BOREHOLE_SYSTEM_PROMPT` no longer hardcodes tower prices at all — it just tells Claude to call `send_quote` for exact numbers, same pattern already used for the regular product catalog.
- **Admin dashboard "Tower Pricing" tab**: edit foundation prices inline, add/edit/delete tank prices and full packages — no code deploy needed for a price change or a new height/tank-size combination going forward. Routes under `/admin/api/tower-pricing/*`.
- **Branded PDF quotation** (`src/services/pdfQuote.js`, using `pdfkit` — pure JS, no Chromium dependency, safe for cPanel shared hosting): `generateTowerQuotePDF()` renders a quote matching the company's `TOWERS QUOTE TEMPLATE.pdf` layout (logo header, Client/Project/Site Location/Quote Ref/Date, itemized Foundation/Fabrication/Tank/Transport line items — transport line names the actual destination and folds in a cost if the admin supplies one, Sub Total/Grand Total, Terms & Conditions, `info@waterlift.co.ke`), plus a second "Previous Projects" photo gallery page. **Admin-triggered, not Claude-triggered** — a "Quote" button on each lead row in the admin dashboard opens a modal to pick tower height/tank config/transport cost, then either downloads the PDF or sends it straight to the customer on WhatsApp (`POST /admin/api/quotes/tower/send/:phone`, reusing the same save/upload/send/log pattern as the existing document-send feature, and going through `normalizePhone()` so it always appends to the customer's real conversation instead of opening a duplicate one). For non-standard tower/tank combos outside the configured packages, the PDF honestly shows "pending fabrication cost" instead of a misleadingly low total.

**Not yet added:** bank/payment details on the PDF (T&Cs and support email are in; user said no bank details needed for now — add later if that changes). Only covers tower/tank quotes — solar and borehole drilling quotes don't have a branded PDF yet (no template was provided for those; `send_quote`'s chat-text quotes still cover them). Deploying this update requires re-running `schema.sql` (or just the new `tower_*` table statements) against the live DB — it's idempotent (`CREATE TABLE IF NOT EXISTS` + `INSERT IGNORE`), so re-importing the whole file is safe.

### 9. ~~Automated Drilling Quotation Calculator~~ ✅ DONE (admin-side tool)
Built 2026-07, replacing the plan in the earlier version of this item (a simple per-county rate table) with something more accurate: a full costing engine that automates what used to be a manual two-step Excel process (an internal "costing sheet" → a derived customer quote), based on a detailed walkthrough of real reference documents (`NICHOLAS DRILLING COSTING RUIRI.csv`, `wakwetu mobilization moyale.csv`, `BOREHOLE DRILLING QUOTE.pdf` — all provided by the user, not committed to the repo).

- **`src/services/drillingCalc.js`** — `computeCostingSheet()` replicates the internal cost-basis calculation (compressor/rig/test-pumping fuel from depth + penetration rate, casing cost by pipe-unit count, gravel by tonnage, ~19 standard consumables) to derive a per-metre "costing rate" — exactly the number a human used to work out by hand. `computeQuote()` then derives the customer-facing quote from it: drilling rate = costing rate − a fixed deduction (casing is re-itemized separately so it isn't double-charged), casing at a flat rate/metre (70% plain / 30% screened split), an optional 10" surface casing line (excluded from the total by default — site-dependent, shown as "rate only" until a site assessment confirms it's needed), mobilization computed per-vehicle (rig + support truck) from a distance/fuel-consumption formula plus optional associated costs (traffic, accommodation, wear & tear, security), 16% VAT, and a 3-stage payment split (70% deposit / flat KShs 60,000 before test pumping / remainder after drilling). `generateDrillingQuote()` wraps this with DB-backed defaults + per-quote overrides. **Verified against the real reference numbers**: reproduces the Ruiri costing sheet's KShs 695,583 total / 6,323.49-per-metre rate exactly, and the Moyale mobilization total (KShs 275,177) within sub-shilling rounding noise.
- **DB schema** (`schema.sql`): `drilling_settings` (20 key-value scalars — fuel rate, casing rates, gravel formula, VAT, payment split, etc.), `drilling_penetration_rates` (selectable presets like "50 min/rod"), `drilling_line_items` (the ~19 consumables + 5 mobilization cost types, category-tagged, admin-editable defaults). All admin-editable via the dashboard so rate drift over time (explicitly called out by the user for nearly every number in this system) never needs a code deploy.
- **Admin dashboard "Drilling Pricing" tab**: edit all global settings inline, add/edit/delete penetration-rate presets and line items (consumables + mobilization cost types) — mirrors the Tower Pricing tab's UX.
- **Branded PDF** (`generateDrillingQuotePDF()` in `pdfQuote.js`, matching `BOREHOLE DRILLING QUOTE.pdf`): drilling/casing/surface-casing/mobilization line items, sub total/VAT/grand total, payment breakdown, prepared/reviewed/approved signature lines. **Admin-triggered, not Claude-triggered** — a "Drilling Quote" button on each lead row (next to the existing "Tower Quote" button) opens a large modal covering every input (depth, penetration rate, fuel, casing, gravel, all consumables, mobilization for both vehicles, VAT/payment split), with a "Preview Totals" button to sanity-check the numbers before generating the PDF or sending it via WhatsApp.
- Routes: `GET/POST /admin/api/drilling-pricing/*` (settings/presets/line-items CRUD), `POST /admin/api/quotes/drilling/preview` (JSON totals, no PDF), `/download`, `/send/:phone`.
- **Chat agent no longer quotes drilling prices** — `getBoreholeQuote()`'s new-drilling branch (non-rehab) now always defers to `schedule_callback`/a site assessment instead of returning a numeric range; the old unverified `BOREHOLE_RATES.perMetre`/`.pump`/`.defaultDepth` constants (KShs 1,800–3,200/m — the original complaint that started this whole item) were deleted. Rehabilitation pricing (`BOREHOLE_RATES.rehabilitation`, KShs 40,000–120,000) was never flagged as a problem and is unchanged. The new calculator above remains admin-only/dashboard-triggered — it needs inputs (mobilization distance, penetration rate) a customer wouldn't naturally provide over WhatsApp, so it was never intended to be chat-triggered.
- **Dynamic sign-off + original footer restored**: the PDF's Prepared/Reviewed/Approved By lines are now admin-editable fields in the Drilling Quote modal (blank shows a signature line placeholder instead of nothing). The branded footer also now matches the original template's two-office contact block (Nairobi + Nanyuki addresses/phone/email) plus a decorative blue/orange accent bar, pinned to the bottom of the page.
- **Downloadable full costing sheet (CSV)**: a "Download Costing Sheet (CSV)" button in the quote modal exports every fuel/consumable/casing/gravel line with its qty/rate/amount, mirroring the original hand-built Excel costing sheet — internal-use only, never sent to a customer. Route: `POST /admin/api/quotes/drilling/costing.csv`.
- **Direct-entry modes for both drilling rate and mobilization**: two independent toggles in the quote modal — "Drilling Rate Method" (Full Costing Calculation vs Enter Rate Directly) and "Mobilization Method" (Calculate from Distance vs Enter Total Directly). Either can skip its build-up and take a known figure instead (rate already known from experience/negotiation; mobilization already agreed with a transporter), and the two mix freely — e.g. a computed drilling rate with a direct mobilization total, or vice versa. `computeQuote()` accepts `directDrillingRate` and/or `directMobilizationTotal`; casing/surface-casing/VAT/payment are unaffected either way since they don't depend on either build-up. The costing CSV and PDF both handle every combination gracefully (e.g. "no costing breakdown — rate entered directly" / "mobilization entered directly — no rig/truck breakdown computed").

**Fully done as of 2026-07** — no open items remain on this feature.

**Deploying this feature** requires running the new `drilling_settings`/`drilling_penetration_rates`/`drilling_line_items` SQL from `schema.sql` against the live DB (idempotent, safe to re-run) before uploading the code.

### 10. ~~Conversation Export for Conversion Analysis~~ ✅ DONE
Built 2026-07 — user wanted to download customer/agent conversations to analyze why leads aren't converting. Two complementary exports, since this is both a bulk-pattern question and a read-individual-transcripts question:

- **Bulk CSV** (`GET /admin/api/export/conversations.csv`, download link in the Chats tab header) — every message across every conversation, one row each, joined with session (domain/escalated/human-takeover) and the customer's most recent lead status/service/property type. Built for filtering/pivoting in Excel — e.g. group by lead status to compare converted vs non-converted conversations, or by domain/escalation to spot patterns.
- **Per-conversation transcript** (`GET /admin/api/session/:phone/transcript.txt`, download icon in each chat's header) — a single conversation as readable plain text (WhatsApp-export style: `[timestamp] Sender: message`), for reading one non-converting conversation end-to-end to see exactly where it went wrong.
- Both share `extractMessageText()` in `webhook.js`, which flattens Claude-style content blocks (text/image/document/tool_use) into one readable line per message; `tool_result` blocks are skipped since they're internal bookkeeping with nothing useful for a human reader.
- `db.js` gained `getAllMessagesForExport()` (joins `messages`+`sessions`+`leads`, deduped to the latest lead per phone via a subquery so multi-lead phones don't duplicate message rows).

---

## Directory Structure

See `README.md` for the current, complete directory structure and an explanation of every file — it is kept in sync with the codebase and should not be duplicated here.


