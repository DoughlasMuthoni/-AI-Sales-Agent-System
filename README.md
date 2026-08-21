# AI Sales Agent — Waterlift Solar Limited

A production WhatsApp AI Sales Agent for **Waterlift Solar Limited**, handling inbound customer conversations across two verticals: **Solar Energy Solutions** and **Borehole Drilling Services** — plus a full admin dashboard for the sales team to monitor, take over, and manage conversations, generate branded PDF quotations, and manage product/pricing data.

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

Customers can also send **photos** (analyzed via Claude vision) and **videos** (captured and flagged for human review — Claude has no native video understanding, so it never pretends to have watched one).

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
| File uploads | `multer` (in-memory, for quotation documents/photos sent to customers) |
| PDF generation | `pdfkit` (pure JS, no Chromium — safe for cPanel shared hosting) |
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
│   └── uploads/                    # Quotation documents/photos/videos sent or received (gitignored)
├── public/
│   ├── logo.png                    # Waterlift Solar logo, used on the login page, dashboard header, and PDFs
│   ├── icons/                      # Favicon + PWA install icons (maskable-safe, centered with padding)
│   ├── manifest.webmanifest        # PWA manifest ("Add to Home Screen")
│   ├── sw.js                       # Service worker — push notifications only, no offline caching
│   └── quote-assets/
│       └── projects/               # "Previous Projects" photo gallery used in tower quote PDFs
├── scripts/
│   ├── create-admin-user.js        # One-off CLI script to provision a dashboard login account
│   ├── sync-catalog-cron.js        # Nightly cPanel cron job — re-syncs the product catalog feed
│   └── cleanup-uploads-cron.js     # Periodic cPanel cron job — deletes data/uploads/ files older than UPLOADS_RETENTION_DAYS
└── src/
    ├── agent/
    │   ├── pipeline.js             # Core orchestration: webhook → Claude → tools → WhatsApp
    │   └── prompts.js              # System prompts for Solar and Borehole domains (product-specific pricing is a live DB lookup, not hardcoded)
    ├── mcp/
    │   ├── mcpServer.js            # Tool handlers (qualify_lead, send_quote, show_products, etc.)
    │   └── tools.js                # Tool schemas exposed to Claude
    ├── services/
    │   ├── db.js                   # MySQL connection pool — all database read/write operations
    │   ├── whatsapp.js             # WhatsApp Cloud API — send/upload, product cards, quoted replies
    │   ├── authService.js          # bcrypt password hashing for dashboard logins
    │   ├── push.js                 # Web push notifications to the admin dashboard
    │   ├── email.js                # Email notifications for leads, callbacks, escalations
    │   ├── catalogSync.js          # Parses the Google/Facebook product feed XML and replaces the `products` table
    │   ├── drillingCalc.js         # Borehole drilling cost/quote calculation engine (see below)
    │   ├── solarQuote.js           # Solar system quote calculation (subtotal / VAT split / total)
    │   └── pdfQuote.js             # Branded PDF generation — tower, drilling, and solar quotations
    └── utils/
        └── phone.js                # normalizePhone() — coerces any typed phone format to WhatsApp's wa_id format
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
VAPID_SUBJECT=mailto:githuiddoughlas8@gmail.com

# Optional — how many days to keep files in data/uploads/ before scripts/cleanup-uploads-cron.js
# deletes them. Defaults to 180 (~6 months) if not set.
UPLOADS_RETENTION_DAYS=180
```

> **Note:** Use `DB_HOST=127.0.0.1` (IPv4) rather than `localhost` — on cPanel servers `localhost` resolves to IPv6 `::1`, which MySQL does not listen on.

---

## Setup

### 1. Create the MySQL database

In **cPanel → MySQL Databases**: create a database, create a user with full privileges on it, and record the host/username/password/database name for `.env`.

### 2. Import the schema

In **phpMyAdmin**: select the database → **Import** → choose `schema.sql` from the project root → **Go**. This creates all tables (see below). The file is idempotent (`CREATE TABLE IF NOT EXISTS` + `INSERT IGNORE`), so it's always safe to re-import after a code update that adds new tables/seed data.

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
| `admin_sessions` | Login session store for `express-session` (separate from the `sessions` table above, which is WhatsApp conversation state, not logins) — also read directly by `getActiveAdminSessions()` for the dashboard's Active Devices view |
| `blocked_numbers` | Permanently-blocked customer phone numbers — presence of a row = blocked; checked by `pipeline.js` before every agentic loop run |
| `app_settings` | Key-value store for the product catalog feed URL and last-synced timestamp |
| `products` | Product catalog, synced nightly from the Google/Facebook feed — `get_product_info` queries this live instead of Claude reciting a frozen price list |
| `tower_foundation_prices`, `tower_tank_prices`, `tower_packages` | Elevated steel water tower pricing — admin-editable, drives both the chat-facing `send_quote` tower range/price and the branded Tower Quote PDF |
| `drilling_settings`, `drilling_penetration_rates`, `drilling_line_items` | Borehole drilling cost-calculation inputs (fuel rates, casing costs, gravel formula, consumables, mobilization cost types) — feeds `drillingCalc.js` |
| `solar_kva_tiers`, `solar_line_items`, `solar_settings` | Solar system quote bill-of-quantities per kVA tier (admin-editable template, not a formula — see below) and the VAT rate |

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
| `send_quote` | Generates indicative price ranges/prices for solar systems, borehole rehabilitation, and elevated steel water towers (partial tower details still return a real min–max range rather than stalling on more questions). **New borehole drilling never gets a numeric price in chat** — it always defers to `schedule_callback` since real drilling cost depends on a site assessment; the detailed engineered quote is generated admin-side (see PDF Quotations below) |
| `schedule_callback` | Books a site visit or consultation — writes to `callbacks` and sends an email notification |
| `escalate_to_human` | Flags the conversation for the sales team — writes to `escalations` and sends an email notification |
| `show_products` | Sends WhatsApp interactive product cards from the live-synced product catalog (single item, curated list, or full catalog browse) |
| `get_product_info` | Looks up current price/spec/description for a specific product from the live `products` table (FULLTEXT + LIKE search) — Claude never quotes a catalog price from memory |

Claude can also see and reason about **photos** customers send (electricity meters, nameplates, roofs, existing equipment) via vision input — this isn't a tool call, it's handled directly in the message pipeline. **Videos** are captured and stored but Claude cannot watch them — the prompt explicitly instructs it to acknowledge receipt honestly and flag the conversation for human review rather than comment on content it can't see.

---

## PDF Quotations (Admin-Triggered)

Three quote types get a branded PDF, generated and sent from the admin dashboard (not by Claude in chat — these need admin judgment/site data a customer wouldn't naturally provide over WhatsApp):

| Quote type | Pricing model | Dashboard tab | Trigger |
|---|---|---|---|
| **Tower** (elevated steel water tower) | Fixed catalog packages (height + tank type/capacity → price), admin-editable | Tower Pricing | "Tower Quote" button on a lead row |
| **Drilling** | Full costing-sheet formula (fuel, casing, gravel, consumables → derived customer rate) *or* a directly-entered rate/mobilization total as a shortcut | Drilling Pricing | "Drilling Quote" button on a lead row |
| **Solar system** | Editable bill-of-quantities template per kVA tier (3/5/12/20/30/50 kVA seeded from real reference quotations) — panel count and cable runs are engineered per site, not a formula, so the admin starts from a tier's typical BOQ and edits it for the actual job | Solar Pricing | "Solar Quote" button on a lead row |

All three share the same flow: pick/enter the job details, **Preview Totals** to sanity-check the numbers, then **Download PDF** or **Send via WhatsApp** (which uploads the PDF to Meta's Media API, sends it as a document message, and saves it server-side so it stays clickable/reopenable in the conversation afterwards — going through `normalizePhone()` so it always appends to the customer's real conversation rather than opening a duplicate).

The solar quote separates line items into VAT-exempt "solar equipment" (panels, battery, inverter, battery disconnect unit) and 16%-taxable "accessories" (cables, breakers, mounting, labour, transport) — shown on the PDF as "VAT on Non-Solar", matching Kenya's solar equipment VAT exemption.

Both the Solar and Tower Quote modals have an **"Include VAT" checkbox** (checked by default — stored rates in both tiers/packages are VAT-exclusive, so 16% is added on top unless a quote specifically needs it excluded, e.g. a VAT-exempt customer or a negotiated VAT-inclusive deal). Unchecking it omits the VAT row entirely from the PDF rather than showing a "(0%): KShs 0" line, and the grand total equals the subtotal.

The Solar/Drilling Pricing tabs' tier/line-item lists are collapsible — each tier collapses behind its heading by default (showing just the label and item count) to keep the tab scannable.

---

## Borehole Drilling Cost Calculator

`src/services/drillingCalc.js` automates what used to be a manual two-step Excel process:

1. **Costing sheet** (`computeCostingSheet`) — replicates the internal cost-basis calculation (compressor/rig/test-pumping fuel from depth + penetration rate, casing cost by pipe-unit count, gravel by tonnage, ~19 standard consumables) to derive a per-metre "costing rate" — verified against real reference numbers.
2. **Customer quote** (`computeQuote`) — derived FROM the costing rate, not equal to it: drilling rate = costing rate minus a fixed deduction (casing is re-itemized separately so it isn't double-charged), casing at a flat rate/metre, an optional 10" surface casing line (rate-only by default), mobilization computed per-vehicle (rig + support truck) from a distance/fuel-consumption formula, 16% VAT, and a 3-stage payment split.

Both the drilling rate and the mobilization total have a "direct entry" shortcut that bypasses their respective build-up when the admin already knows the figure (from experience or a prior negotiation) — the two toggles are independent and can be mixed.

---

## Product Catalog Sync

`src/services/catalogSync.js` parses a Google/Facebook-format product feed (XML) and does a transactional full-table replace of the `products` table via `db.replaceProducts()`. Runs both on-demand ("Sync Now" button in the admin Catalog tab) and nightly via `scripts/sync-catalog-cron.js` (cPanel cron job) — both re-fetch from the one feed URL saved in `app_settings`.

---

## Analytics

The admin dashboard's Analytics tab (`db.getAnalyticsSummary()`) gives an always-current, all-time view of conversion patterns without needing to export CSV and analyze it externally: total conversations, leads captured, conversion rate, escalation rate, leads by status, domain split, and average messages per conversation (with a captured lead vs without). All-time totals computed via SQL aggregation (not pulled into JS and reduced), since the underlying tables only grow. Leads are deduped to each phone's most recent status (same pattern as the CSV export), and internal system-injected bootstrap messages (date-seeding, ad-referral context) are excluded from message counts so they don't inflate the averages.

---

## Uploaded File Retention

`data/uploads/` (customer photos/videos, sent quotation PDFs) has no automatic cleanup by default and grows unbounded — `scripts/cleanup-uploads-cron.js` deletes anything older than `UPLOADS_RETENTION_DAYS` (default 180 / ~6 months), based on each file's own filesystem modified-time. Intended to run periodically via cPanel Cron Jobs, same pattern as the catalog sync cron:

```bash
cd /home/<user>/<app-path> && /path/to/node scripts/cleanup-uploads-cron.js
```

**Tradeoff to know about:** a deleted file's `storedAs` reference can still exist in old chat history — the "re-open" link on that old document/photo bubble will 404 once its file is gone. That's the intended effect of a retention policy, not a bug.

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
appendAdminImageMessage(phone, filename, caption, ...)        // logs a human-sent photo
processImageMessage(phone, media, caption, ...)               // customer-sent photo → Claude vision → agentic loop
processVideoMessage(phone, video, caption, ...)               // customer-sent video → stored + flagged, no vision (Claude cannot watch it)
```

When AI is paused and a human replies via the dashboard, those messages are saved as `assistant` role with `source: 'human'`. When AI resumes, it has full context of what the human agent said and continues seamlessly. Messages an admin sends (and customer-sent videos) are never fed back to Claude verbatim if they'd collide with a reserved Claude content-block type, or if Claude has no way to actually interpret them (video) — they're sanitized to plain text first.

---

## Admin Dashboard

Available at `/admin` (redirects to `/login` if not authenticated). Login is a real per-account email/password system with server-side sessions — no shared password, no browser Basic Auth popup.

**Conversation view:**
- All active sessions with live polling (10s interval, plus an immediate re-sync whenever the browser tab regains focus — browsers throttle background-tab timers, so this keeps the view from going stale)
- Full permanent message history per conversation, including customer photos, customer videos (playable inline, `<video controls>`), and any documents sent
- Pause / Resume AI toggle, with a human reply box that unlocks once paused
- **Reply to a specific message** — click ↩ on any bubble to quote-reply to it, exactly like WhatsApp's native swipe-to-reply; also shows what the *customer* replied to when they use the same feature on their end
- **Send documents** (PDF/Word/Excel, up to 16MB) and **photos** directly to a customer — sent items are saved server-side and stay clickable/reopenable afterwards, not just fire-and-forget
- Ad-referral badge showing which Click-to-WhatsApp ad brought a customer in, if any
- **Conversation export** — bulk CSV of every message across every conversation (for spotting conversion patterns), and a per-conversation plain-text transcript download (for reading one conversation end-to-end)
- **Block / Unblock a number** — permanently stops the AI replying to a specific customer (their messages are still logged, so you can see if they keep messaging) — independent of Pause/Resume AI, which is for temporarily taking over a conversation yourself. Backed by the `blocked_numbers` table; checked in `pipeline.js` before the agentic loop runs

**Leads / Callbacks / Escalations tabs:**
- Leads: add manually, edit any field, status management (New → Contacted → Converted/Lost), CSV export (formatted to avoid Excel mangling phone numbers into scientific notation or dumping raw JS date strings), and Tower/Drilling/Solar Quote buttons per lead

**Catalog tab:** save the product feed URL, trigger an on-demand sync, live product count, product search box

**Tower Pricing / Drilling Pricing / Solar Pricing tabs:** manage the DB-backed pricing behind each quote type — no code deploy needed for a price change, plus CSV export of the current live pricing

**Analytics tab:** see [Analytics](#analytics) above

**Other:**
- Stats bar (sessions/leads/callbacks/escalations counts) can be hidden to reclaim screen space, remembered via `localStorage`
- **Active Devices** — a "📱 Devices" button lists currently logged-in dashboard sessions (email, device/browser, login time, expiry) with a "Log out" action to remotely revoke any session except your own current one. Note: this tracks logins/devices, not separate user accounts — one admin logged in on their phone and laptop shows as two device entries under the same email, which is expected
- Installable as a PWA ("Add to Home Screen") with push notifications for new customer messages — the service worker is push-only, no offline page caching. Icons are maskable-safe (logo scaled with padding so Android's circular/squircle home-screen crop never clips it)

---

## WhatsApp Product Catalog

Interactive product cards (images, prices, "View" buttons inside WhatsApp) require:

1. A product catalog set up in **Meta Commerce Manager**
2. The catalog linked to the WhatsApp Business Account (Commerce Manager → catalog → **Settings → Connected Assets**; WhatsApp Manager → **Settings → WhatsApp Commerce Settings** → enable Shopping)
3. `WHATSAPP_CATALOG_ID` set in `.env`

**Known limitation:** WhatsApp Business Accounts that haven't completed Meta Business Verification have a cap on how many catalog items are actually usable via the API (observed: ~30 usable out of 78 listed in Commerce Manager), even though every item is visible in Commerce Manager itself. When a product card fails to send for this reason, Claude describes the product in plain text instead (it already has full pricing/specs available via `get_product_info`) rather than leaving the customer with a dead end.

---

## Known Limitations

- **No message editing/unsend** — WhatsApp's Business API has no edit capability for outbound messages. Once sent, the only fix is a follow-up correction message.
- **24-hour messaging window** — outside 24 hours of the customer's last message, WhatsApp blocks free-form replies (error `131047`). Proactive re-engagement needs pre-approved Message Templates (not yet built — see Pending Features).
- **Reply-to-specific-message only works going forward** — it depends on WhatsApp message IDs that are only captured at the moment a message is sent/received; there's no way to backfill this for conversation history from before the feature existed.
- **Unverified WhatsApp Business tier** — caps usable catalog items (see above) and overall messaging volume; resolved by completing Meta Business Verification.
- **No AI video understanding** — Claude's API has no native video content type (unlike images). Customer videos are captured, stored, and flagged for a human to watch; the AI never analyzes what's in them.
- **Single product feed URL** — syncing a second catalog feed would overwrite the first rather than merging; not an issue today with one feed.

---

## Pending Features

See `CLAUDE.md` for full specifications. Summary:

- **WhatsApp Message Templates** — for proactive outreach after the 24-hour messaging window closes (requires a payment method on the Meta Business account + template approval, 1–3 days)
- **Meta Business Verification** — unlocks higher messaging tier limits and the full catalog (see Known Limitations)
- **SaaS Multi-Tenant Architecture** — a separate platform (different project) generalizing this pattern to run independent agents for multiple businesses

---

## Useful Links

- Website: [doughlasgithuiportfolio.kesug.com](https://doughlasgithuiportfolio.kesug.com)
- Contact: githuiddoughlas8@gmail.com | 0707264913
