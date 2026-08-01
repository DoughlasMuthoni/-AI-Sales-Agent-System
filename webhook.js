const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session')(session);
const multer  = require('multer');
const { processMessage, processImageMessage, processVideoMessage, pauseSession, resumeSession, appendAdminMessage, appendAdminDocumentMessage, appendAdminImageMessage } = require('./src/agent/pipeline.js');
const { sendTextMessage, lookupProductNames, downloadMedia, uploadMedia, sendDocumentMessage, sendImageMessage } = require('./src/services/whatsapp.js');
const { notifyNewMessage } = require('./src/services/push.js');
const { verifyPassword } = require('./src/services/authService.js');
const catalogSync = require('./src/services/catalogSync.js');
const { generateTowerQuotePDF, generateDrillingQuotePDF, generateSolarQuotePDF } = require('./src/services/pdfQuote.js');
const { generateDrillingQuote } = require('./src/services/drillingCalc.js');
const { generateSolarQuote } = require('./src/services/solarQuote.js');
const { normalizePhone } = require('./src/utils/phone.js');

// Matches mcpServer.js's normalizeCapacityKey — keeps admin-entered capacity keys (e.g. "50m3",
// "50 M3", "50M³") consistent with what the chat tool's lookups expect.
function normalizeCapacityKeyForAdmin(capacityKey) {
  return String(capacityKey || '').toLowerCase().replace(/[\s,]/g, '');
}
const db = require('./src/services/db.js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Sessions (dashboard logins — MySQL-backed, separate from WhatsApp conversation state) ──

const sessionStore = new MySQLStoreFactory({
  host:     process.env.DB_HOST || 'localhost',
  port:     process.env.DB_PORT || 3306,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  schema: {
    tableName: 'admin_sessions',
    columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
  },
});

app.use(session({
  secret:            process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  store:             sessionStore,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    maxAge:   7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  },
}));

// Quotation/document uploads for the admin dashboard — buffered in memory, then
// (a) re-uploaded to Meta's Media API to actually send it, and (b) written to
// DOCUMENTS_DIR so the admin can re-open what was sent later (Meta's media API
// doesn't give us a durable link back).
const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!DOCUMENT_MIME_TYPES.has(file.mimetype)) return cb(new Error('Only PDF, Word, or Excel documents are allowed'));
    cb(null, true);
  },
});

// Separate from uploadDocument above — WhatsApp treats images as their own message type
// (inline photo bubble, not a downloadable file), so they get their own upload path.
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!IMAGE_MIME_TYPES.has(file.mimetype)) return cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
    cb(null, true);
  },
});

const DOCUMENTS_DIR = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

function saveDocumentToDisk(buffer, originalname) {
  const safeName = originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
  const storedAs = crypto.randomBytes(8).toString('hex') + '-' + safeName;
  fs.writeFileSync(path.join(DOCUMENTS_DIR, storedAs), buffer);
  return storedAs;
}
// Serves /manifest.webmanifest and /icons/* for the admin dashboard's "Add to Home Screen" support
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status:         'ok',
    anthropic_key:  process.env.ANTHROPIC_API_KEY        ? 'SET' : 'MISSING',
    whatsapp_token: process.env.WHATSAPP_ACCESS_TOKEN    ? 'SET' : 'MISSING',
    whatsapp_phone: process.env.WHATSAPP_PHONE_NUMBER_ID ? 'SET' : 'MISSING',
    smtp_pass:      process.env.SMTP_PASS                ? 'SET' : 'MISSING',
    model:          process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    node_version:   process.version,
  });
});

// ── Admin auth ────────────────────────────────────────────────────────────────
// Per-account email/password login (hand-rolled — no external auth vendor),
// replacing the old shared-password Basic Auth. Keeps the exact same
// `if (!requireAdminAuth(req, res)) return;` call signature every route already
// uses, so only this function's internals changed, not the ~15 call sites.

function requireAdminAuth(req, res) {
  if (req.session?.userId) return true;
  if (req.path.startsWith('/admin/api/')) {
    res.status(401).json({ error: 'Login required' });
  } else {
    res.redirect('/login');
  }
  return false;
}

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Log in — Waterlift Admin</title>
<link rel="icon" href="/icons/favicon.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f4f8;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:36px 32px;box-shadow:0 6px 28px rgba(0,0,0,.10);max-width:360px;width:100%;text-align:center}
.card .login-logo{max-width:220px;width:100%;height:auto;margin:0 0 22px}
.card form{text-align:left}
label{display:block;margin-bottom:14px;font-size:.85rem;font-weight:600;color:#334155}
input{width:100%;padding:10px 12px;margin-top:5px;font-family:inherit;font-size:.9rem;border:1.5px solid #cbd5e1;border-radius:8px;color:#111}
input:focus{outline:none;border-color:#075E54}
button{width:100%;background:#075E54;color:#fff;border:none;border-radius:8px;padding:11px;font-size:.9rem;font-weight:600;cursor:pointer;margin-top:4px}
button:hover{background:#054a3a}
.error{color:#991b1b;font-size:.85rem;margin-bottom:14px}
</style>
</head>
<body>
  <div class="card">
    <img src="/logo.png" alt="Waterlift Solar" class="login-logo">
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <form method="POST" action="/login">
      <label>Email<input type="email" name="email" required autofocus></label>
      <label>Password<input type="password" name="password" required></label>
      <button type="submit">Log in</button>
    </form>
  </div>
</body>
</html>`;
}

app.get('/login', (req, res) => {
  res.send(loginPage(req.query.error));
});

app.post('/login', async (req, res) => {
  try {
    const email    = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await db.getAdminUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password.'));
    }
    req.session.userId    = user.id;
    req.session.email     = user.email;
    req.session.userAgent = req.get('User-Agent') || null;
    req.session.loginAt   = Date.now();
    res.redirect('/admin');
  } catch (err) {
    console.error('[login] error:', err);
    res.redirect('/login?error=' + encodeURIComponent('Something went wrong — please try again.'));
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Foundation types were originally just "pad"/"raft" (single words, first-letter capitalize
// was enough) — now admin-addable and potentially multi-word (e.g. "pile foundation"), so
// capitalize every word instead.
function titleCase(s) {
  return String(s || '').replace(/\b\w/g, c => c.toUpperCase());
}

function timeAgo(ts) {
  const d = Date.now() - Number(ts), m = Math.floor(d / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function fmtTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(Number(ts));
    const isToday = d.toDateString() === new Date().toDateString();
    return isToday
      ? d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })
      : d.toLocaleDateString('en-KE', { month: 'short', day: 'numeric', timeZone: 'Africa/Nairobi' });
  } catch(e) { return ''; }
}

function fmtFull(iso) {
  try { return new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }); }
  catch(e) { return iso || '—'; }
}

function getInitials(phone) {
  const d = String(phone).replace(/\D/g, '');
  return d.slice(-2) || '??';
}

// NOTE: the string this returns gets passed through esc() at the call site, which
// HTML-escapes '&' — so use real Unicode emoji characters here, never '&#12345;'
// entity-code strings, or they'll show up as literal visible text like "&#128247;".
function lastMsg(messages) {
  if (!messages || !messages.length) return 'No messages';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m.content === 'string') return m.content.slice(0, 45);
    if (Array.isArray(m.content)) {
      const imgB = m.content.find(b => b.type === 'image');
      if (imgB) {
        const cap = m.content.find(b => b.type === 'text');
        const capText = cap ? cap.text : imgB.caption;
        return '📷 Photo' + (capText ? ': ' + capText.slice(0, 35) : '');
      }
      const docBlock = m.content.find(b => b.type === 'document');
      if (docBlock) return '📄 ' + docBlock.filename;
      const t = m.content.find(b => b.type === 'text');
      if (t) return (m.source === 'human' ? '👤 ' : m.role === 'assistant' ? '🤖 ' : '') + t.text.slice(0, 42);
    }
  }
  return 'Message';
}

function quoteBoxHtml(replyContext) {
  if (!replyContext) return '';
  const label = replyContext.sender === 'customer' ? 'Customer' : replyContext.sender === 'human' ? 'You' : 'AI Agent';
  return '<div class="wa-quote"><span class="wa-quote-sender">' + esc(label) + '</span>' + esc(replyContext.preview || '') + '</div>';
}

function replyBtnHtml(waMessageId, preview, sender, paused) {
  if (!waMessageId) return '';
  return '<button type="button" class="wa-reply-btn" title="Reply" ' + (paused ? '' : 'disabled ') +
    'data-wa-id="' + esc(waMessageId) + '" data-preview="' + esc(preview || '') + '" data-sender="' + esc(sender) + '" ' +
    'onclick="startReply(this)">&#8617;</button>';
}

function renderMessages(messages, paused) {
  return (messages || []).map(msg => {
    const t = fmtTime(msg.ts);
    const idAttr = ' data-msg-id="' + (msg.id || 0) + '"';
    const quote = quoteBoxHtml(msg.replyContext);
    if (msg.source === 'system') return '';
    if (typeof msg.content === 'string') {
      return '<div class="wa-row wa-row-in"' + idAttr + '>' +
        '<div class="wa-bubble wa-in">' + quote + esc(msg.content) +
        '<span class="wa-ts">' + t + '</span></div>' + replyBtnHtml(msg.waMessageId, msg.content, 'customer', paused) + '</div>';
    }
    if (!Array.isArray(msg.content)) return '';
    const imgBlock = msg.content.find(b => b.type === 'image');
    if (imgBlock && msg.role === 'user') {
      const capBlock = msg.content.find(b => b.type === 'text');
      const src = 'data:' + (imgBlock.source?.media_type || 'image/jpeg') + ';base64,' + (imgBlock.source?.data || '');
      return '<div class="wa-row wa-row-in"' + idAttr + '><div class="wa-bubble wa-in wa-img-bubble">' +
        quote +
        '<img class="wa-img" src="' + src + '" alt="Photo from customer" loading="lazy"/>' +
        (capBlock ? '<div class="wa-img-cap">' + esc(capBlock.text) + '</div>' : '') +
        '<span class="wa-ts">' + t + '</span></div>' + replyBtnHtml(msg.waMessageId, '📷 Photo', 'customer', paused) + '</div>';
    }
    const vidBlock = msg.content.find(b => b.type === 'video');
    if (vidBlock && msg.role === 'user') {
      const capBlock = msg.content.find(b => b.type === 'text');
      const src = '/admin/api/documents/' + encodeURIComponent(vidBlock.storedAs);
      return '<div class="wa-row wa-row-in"' + idAttr + '><div class="wa-bubble wa-in wa-img-bubble">' +
        quote +
        '<video class="wa-img" src="' + src + '" controls preload="metadata"></video>' +
        (capBlock ? '<div class="wa-img-cap">' + esc(capBlock.text) + '</div>' : '') +
        '<span class="wa-ts">' + t + '</span></div>' + replyBtnHtml(msg.waMessageId, '🎥 Video', 'customer', paused) + '</div>';
    }
    return msg.content.map(block => {
      if (block.type === 'text' && msg.role === 'assistant') {
        const human = msg.source === 'human';
        return '<div class="wa-row wa-row-out"' + idAttr + '>' +
          '<div class="wa-bubble wa-out' + (human ? ' wa-human' : '') + '">' +
          '<span class="wa-sender">' + (human ? '&#128100; Human Agent' : '&#129302; AI Agent') + '</span>' +
          quote + esc(block.text) +
          '<span class="wa-ts">' + t + ' <span class="wa-tick">&#10003;&#10003;</span></span>' +
          '</div>' + replyBtnHtml(msg.waMessageId, block.text, human ? 'human' : 'ai', paused) + '</div>';
      }
      if (block.type === 'tool_use') {
        return '<div class="wa-row wa-row-center"' + idAttr + '>' +
          '<div class="wa-system">&#128295; ' + esc(block.name) + '</div></div>';
      }
      if (block.type === 'document') {
        const human = msg.source === 'human';
        const docInner = '<span class="wa-doc-icon">&#128196;</span><span class="wa-doc-name">' + esc(block.filename) + '</span>';
        const docHtml = block.storedAs
          ? '<a class="wa-doc" href="/admin/api/documents/' + encodeURIComponent(block.storedAs) + '" target="_blank" rel="noopener">' + docInner + '</a>'
          : '<div class="wa-doc">' + docInner + '</div>';
        return '<div class="wa-row wa-row-out"' + idAttr + '>' +
          '<div class="wa-bubble wa-out' + (human ? ' wa-human' : '') + ' wa-doc-bubble">' +
          '<span class="wa-sender">' + (human ? '&#128100; Human Agent' : '&#129302; AI Agent') + '</span>' +
          quote + docHtml +
          (block.caption ? '<div class="wa-doc-cap">' + esc(block.caption) + '</div>' : '') +
          '<span class="wa-ts">' + t + ' <span class="wa-tick">&#10003;&#10003;</span></span>' +
          '</div>' + replyBtnHtml(msg.waMessageId, '📄 ' + block.filename, human ? 'human' : 'ai', paused) + '</div>';
      }
      if (block.type === 'image' && msg.role === 'assistant') {
        const human = msg.source === 'human';
        const src = '/admin/api/documents/' + encodeURIComponent(block.storedAs);
        return '<div class="wa-row wa-row-out"' + idAttr + '>' +
          '<div class="wa-bubble wa-out' + (human ? ' wa-human' : '') + ' wa-img-bubble">' +
          '<span class="wa-sender">' + (human ? '&#128100; Human Agent' : '&#129302; AI Agent') + '</span>' +
          quote +
          '<a href="' + src + '" target="_blank" rel="noopener"><img class="wa-img" src="' + src + '" alt="Photo sent to customer" loading="lazy"/></a>' +
          (block.caption ? '<div class="wa-img-cap">' + esc(block.caption) + '</div>' : '') +
          '<span class="wa-ts">' + t + ' <span class="wa-tick">&#10003;&#10003;</span></span>' +
          '</div>' + replyBtnHtml(msg.waMessageId, '📷 Photo', human ? 'human' : 'ai', paused) + '</div>';
      }
      if (block.type === 'text' && msg.role === 'user') {
        return '<div class="wa-row wa-row-in"' + idAttr + '><div class="wa-bubble wa-in">' + quote + esc(block.text) +
          '<span class="wa-ts">' + t + '</span></div>' + replyBtnHtml(msg.waMessageId, block.text, 'customer', paused) + '</div>';
      }
      return '';
    }).join('');
  }).join('');
}

// ── Admin page ────────────────────────────────────────────────────────────────

const DRILLING_SETTING_LABELS = {
  fuel_rate_per_litre: 'Fuel Rate (KShs/Litre)',
  flushing_fuel_litres_default: 'Flushing Fuel Default (Litres)',
  rig_fuel_litres_default: 'Rig Truck Fuel Default (Litres)',
  test_pumping_fuel_litres_default: 'Test Pumping Fuel Default (Litres)',
  casing_rate_per_metre: 'Casing Rate — customer quote (KShs/Metre)',
  drilling_rate_deduction: 'Drilling Rate Deduction (KShs/Metre)',
  surface_casing_rate: 'Surface Casing Rate (KShs)',
  casing_plain_split_pct: 'Plain Casing Split (%)',
  casing_screened_split_pct: 'Screened Casing Split (%)',
  casing_pipe_length_m: 'Casing Pipe Length (Metres)',
  plain_casing_unit_rate: 'Plain Casing Unit Cost — internal costing (KShs)',
  screened_casing_unit_rate: 'Screened Casing Unit Cost — internal costing (KShs)',
  gravel_tonnes_per_metre: 'Gravel (Tonnes/Metre)',
  gravel_bag_size_kg: 'Gravel Bag Size (Kg)',
  gravel_rate_per_bag: 'Gravel Rate (KShs/Bag)',
  vat_rate_pct: 'VAT Rate (%)',
  payment_deposit_pct: 'Payment Deposit (%)',
  payment_before_test_pumping_flat: 'Before Test Pumping (KShs, flat)',
  fuel_consumption_tarmac_km_per_l: 'Fuel Consumption — Tarmac (Km/Litre)',
  fuel_consumption_rough_km_per_l: 'Fuel Consumption — Rough Road (Km/Litre)',
};

const SOLAR_SETTING_LABELS = {
  vat_rate_pct: 'VAT Rate on Non-Solar Items (%)',
};

function buildAdminPage(sessions, leads, callbacks, escalations, adminEmail, productCount, towerPricing, drillingPricing, solarPricing, blockedNumbers, analytics) {
  const entries   = Object.entries(sessions).sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  const now       = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  const converted = leads.filter(l => l.status === 'converted').length;
  const convRate  = leads.length > 0 ? Math.round(converted / leads.length * 100) : 0;
  const leadMap   = {};
  for (const l of leads) { if (l.phone && !leadMap[l.phone]) leadMap[l.phone] = l; }
  const blockedSet = new Set((blockedNumbers || []).map(b => b.phone));

  // Left panel: contact list
  const contactsHTML = entries.length === 0
    ? '<div class="wa-empty-contacts"><p>No conversations yet</p></div>'
    : entries.map(([phone, s]) => {
        const pid     = phone.replace(/\D/g,'');
        const domain  = s.domain || 'general';
        const paused  = !!s.humanTakeover;
        const blocked = blockedSet.has(phone);
        return (
          '<div class="wa-contact" id="contact-' + pid + '" data-phone="' + esc(phone) + '" data-domain="' + domain + '" onclick="openChat(\'' + pid + '\')">' +
            '<div class="wa-av wa-av-' + domain + '">' + getInitials(phone) + '</div>' +
            '<div class="wa-ct-info">' +
              '<div class="wa-ct-row1">' +
                '<span class="wa-ct-name">' + esc(phone) + '</span>' +
                '<span class="wa-ct-time">' + timeAgo(s.lastSeen) + '</span>' +
              '</div>' +
              '<div class="wa-ct-row2">' +
                '<span class="wa-ct-prev">' + esc(lastMsg(s.messages)) + '</span>' +
                (blocked ? '<span class="wa-ct-badge" title="Blocked — AI does not reply">&#128683;</span>' : '') +
                (paused ? '<span class="wa-ct-badge">&#128100;</span>' : '') +
                (s.adReferral ? '<span class="wa-ct-badge" title="Came from a WhatsApp ad">&#128226;</span>' : '') +
                '<span class="wa-domain-chip wa-chip-' + domain + '">' + domain + '</span>' +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }).join('');

  // Right panel: individual chat windows
  const chatsHTML = entries.map(([phone, s]) => {
    const pid     = phone.replace(/\D/g,'');
    const domain  = s.domain || 'general';
    const paused  = !!s.humanTakeover;
    const blocked = blockedSet.has(phone);
    const lastId = s.messages.length > 0 ? (s.messages[s.messages.length - 1].id || 0) : 0;
    const lead   = leadMap[phone] || null;
    const quickReplies = [
      ['&#128222; Call within hour', 'Thank you for reaching out! I will have one of our specialists call you within the hour.'],
      ['&#128203; Prepare quote',    'Let me prepare a detailed quote for you. Could you confirm your location and the scope of work needed?'],
      ['&#128197; Book assessment',  'I can arrange a free site assessment for you. What dates and times work best?'],
      ['&#9989; Follow up soon',     'Our team will follow up with you shortly. Thank you for your patience.'],
    ].map(([label, text]) =>
      '<button class="wa-qr-btn" onclick="fillReply(\'' + pid + '\',\'' + text.replace(/'/g,"\\'") + '\')">' + label + '</button>'
    ).join('');
    return (
      '<div class="wa-chat" id="chat-' + pid + '" data-phone="' + esc(phone) + '" data-last-id="' + lastId + '">' +
        '<div class="wa-chat-hdr">' +
          '<button class="wa-back" onclick="backToContacts()">&#8592;</button>' +
          '<div class="wa-av wa-av-' + domain + ' wa-av-sm">' + getInitials(phone) + '</div>' +
          '<div class="wa-hdr-info">' +
            '<div class="wa-hdr-name">' + esc(phone) + '</div>' +
            '<div class="wa-hdr-sub ' + (paused ? 'sub-paused' : 'sub-active') + '" id="hsub-' + pid + '">' +
              (paused ? '&#128100; Human Mode' : '&#129302; AI Active') +
            '</div>' +
            (blocked ? '<div class="wa-blocked-pill" id="bpill-' + pid + '">&#128683; Blocked' + '</div>' : '') +
            (lead ? '<div class="wa-lead-pill">&#128100; ' + esc(lead.name) + ' &bull; ' + esc(lead.service||'') + (lead.location ? ' &bull; ' + esc(lead.location) : '') + (lead.estimated_budget ? ' &bull; ' + esc(lead.estimated_budget) : '') + '</div>' : '') +
            (s.adReferral ? '<div class="wa-ad-pill" title="' + esc(s.adReferral.headline || '') + ' — ' + esc(s.adReferral.body || '') + '">&#128226; From ad' + (s.adReferral.headline ? ': "' + esc(s.adReferral.headline) + '"' : '') + (s.adReferral.productId ? ' &bull; Product ' + esc(s.adReferral.productId) : '') + '</div>' : '') +
          '</div>' +
          '<a class="wa-action-btn" href="/admin/api/session/' + encodeURIComponent(phone) + '/transcript.txt" title="Download this conversation as a readable transcript" style="text-decoration:none;background:#f1f5f9;color:#334155">&#11015;&#65039;</a>' +
          '<button class="wa-action-btn ' + (blocked ? 'wa-btn-resume' : 'wa-btn-pause') + '" id="bbtn-' + pid + '" data-phone="' + esc(phone) + '" data-pid="' + pid + '" data-blocked="' + blocked + '" onclick="handleBlock(this)" title="' + (blocked ? 'Unblock this number so the AI can reply again' : 'Stop the AI replying to this number — messages are still logged') + '">' +
            (blocked ? '&#128683; Unblock' : '&#128683; Block') +
          '</button>' +
          '<button class="wa-action-btn ' + (paused ? 'wa-btn-resume' : 'wa-btn-pause') + '" id="pbtn-' + pid + '" data-phone="' + esc(phone) + '" data-pid="' + pid + '" data-paused="' + paused + '" onclick="handlePause(this)">' +
            (paused ? '&#9654; Resume AI' : '&#9646;&#9646; Pause AI') +
          '</button>' +
        '</div>' +
        '<div class="wa-msgs" id="chatmsgs-' + pid + '">' +
          renderMessages(s.messages, paused) +
        '</div>' +
        '<div class="wa-input-area' + (paused ? '' : ' wa-input-locked') + '" id="wa-input-' + pid + '">' +
          (!paused ? '<div class="wa-lock-notice">&#9888;&#65039; Pause AI to reply directly</div>' : '') +
          '<div class="wa-reply-banner" id="rbanner-' + pid + '" style="display:none">' +
            '<div class="wa-reply-banner-body"><span class="wa-reply-banner-sender" id="rbanner-sender-' + pid + '"></span>' +
            '<span class="wa-reply-banner-preview" id="rbanner-preview-' + pid + '"></span></div>' +
            '<button type="button" class="wa-reply-cancel" onclick="cancelReply(\'' + pid + '\')">&#10005;</button>' +
          '</div>' +
          '<div class="wa-quick-replies" id="qr-' + pid + '"' + (paused ? '' : ' style="display:none"') + '>' + quickReplies + '</div>' +
          '<div class="wa-input-row">' +
            '<input type="file" id="finput-' + pid + '" accept=".pdf,.doc,.docx,.xls,.xlsx" style="display:none" onchange="handleSendDocument(\'' + esc(phone) + '\',\'' + pid + '\')">' +
            '<button type="button" class="wa-attach" id="abtn-' + pid + '" title="Attach a document" onclick="document.getElementById(\'finput-' + pid + '\').click()" ' + (paused ? '' : 'disabled') + '>&#128206;</button>' +
            '<input type="file" id="pinput-' + pid + '" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none" onchange="handleSendImage(\'' + esc(phone) + '\',\'' + pid + '\')">' +
            '<button type="button" class="wa-attach" id="pbtn-img-' + pid + '" title="Attach a photo" onclick="document.getElementById(\'pinput-' + pid + '\').click()" ' + (paused ? '' : 'disabled') + '>&#128247;</button>' +
            '<textarea id="rinput-' + pid + '" class="wa-ta" rows="1" placeholder="' + (paused ? 'Type a message...' : 'Pause AI to reply') + '" ' + (paused ? '' : 'disabled') + ' oninput="autoResize(this)" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();handleSend(\'' + esc(phone) + '\',\'' + pid + '\')}"></textarea>' +
            '<button class="wa-send' + (paused ? '' : ' wa-send-disabled') + '" id="sbtn-' + pid + '" onclick="handleSend(\'' + esc(phone) + '\',\'' + pid + '\')" ' + (paused ? '' : 'disabled') + '>&#10148;</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');

  // Tables for leads / callbacks / escalations
  const tbl = (cols, rows, emptyIcon, emptyText) => rows.length === 0
    ? '<div class="tbl-empty"><div>' + emptyIcon + '</div><p>' + emptyText + '</p></div>'
    : '<div class="tbl-wrap"><table><thead><tr>' + cols.map(c=>'<th>'+c+'</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  function statusDropdown(index, current) {
    const opts = ['new','contacted','converted','lost'];
    return '<select class="status-sel status-' + current + '" data-index="' + index + '" onchange="updateLeadStatus(this)">' +
      opts.map(s => '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>').join('') +
      '</select>';
  }

  const leadsHTML = tbl(
    ['Status','Name','Phone','Service','Location','Property','Budget','Notes','Captured',''],
    leads.map(l => {
      const status = l.status || 'new';
      return '<tr>' +
        '<td class="nowrap">' + statusDropdown(l.id, status) + '</td>' +
        '<td class="nowrap"><strong>' + esc(l.name) + '</strong></td>' +
        '<td class="mono nowrap"><span class="cell-flex">' + esc(l.phone) +
          '<button type="button" class="copy-btn" data-copy="' + esc(l.phone) + '" onclick="copyToClipboard(this)" title="Copy phone number">&#128203;</button></span></td>' +
        '<td class="nowrap"><span class="chip chip-' + esc(l.service) + '">' + esc(l.service) + '</span></td>' +
        '<td class="wrap-cell">' + esc(l.location) + '</td><td class="nowrap">' + esc(l.property_type) + '</td>' +
        '<td class="nowrap">' + esc(l.estimated_budget||'—') + '</td>' +
        '<td class="wrap-cell"><div class="cell-flex"><span class="notes-cell" onclick="toggleNotes(this)" title="Click to expand/collapse">' + esc(l.notes||'—') + '</span>' +
          (l.notes ? '<button type="button" class="copy-btn" data-copy="' + esc(l.notes) + '" onclick="copyToClipboard(this)" title="Copy notes">&#128203;</button>' : '') +
          '</div></td>' +
        '<td class="muted nowrap">' + fmtFull(l.captured_at) + '</td>' +
        '<td class="nowrap">' +
          '<button type="button" class="resolve-btn" ' +
            'data-id="' + l.id + '" data-name="' + esc(l.name) + '" data-phone="' + esc(l.phone) + '" ' +
            'data-service="' + esc(l.service) + '" data-location="' + esc(l.location) + '" ' +
            'data-property="' + esc(l.property_type) + '" data-budget="' + esc(l.estimated_budget) + '" ' +
            'data-notes="' + esc(l.notes) + '" onclick="openEditLeadModal(this)">Edit</button> ' +
          '<button type="button" class="resolve-btn" ' +
            'data-name="' + esc(l.name) + '" data-phone="' + esc(l.phone) + '" data-location="' + esc(l.location) + '" ' +
            'onclick="openTowerQuoteModal(this)">Tower Quote</button> ' +
          '<button type="button" class="resolve-btn" ' +
            'data-name="' + esc(l.name) + '" data-phone="' + esc(l.phone) + '" data-location="' + esc(l.location) + '" ' +
            'onclick="openDrillingQuoteModal(this)">Drilling Quote</button> ' +
          '<button type="button" class="resolve-btn" ' +
            'data-name="' + esc(l.name) + '" data-phone="' + esc(l.phone) + '" ' +
            'onclick="openSolarQuoteModal(this)">Solar Quote</button>' +
        '</td></tr>';
    }).join(''), '&#127919;', 'No leads captured yet.');

  const cbHTML = tbl(
    ['Name','Phone','Date','Time','Notes','Booked At'],
    callbacks.map(c =>
      '<tr><td class="nowrap"><strong>' + esc(c.name) + '</strong></td>' +
      '<td class="mono nowrap">' + esc(c.phone) + '</td>' +
      '<td class="nowrap">' + esc(c.preferred_date) + '</td><td class="nowrap">' + esc(c.preferred_time) + '</td>' +
      '<td class="wrap-cell">' + esc(c.notes||'—') + '</td>' +
      '<td class="muted nowrap">' + fmtFull(c.booked_at) + '</td></tr>'
    ).join(''), '&#128197;', 'No callbacks booked yet.');

  const urgCls = u => u==='high'?'danger':u==='medium'?'warning':'general';
  const escTbl = tbl(
    ['Customer','Urgency','Reason','Time','Action'],
    escalations.map(e =>
      '<tr' + (e.resolved ? ' class="esc-resolved"' : '') + '>' +
      '<td class="nowrap"><strong>' + esc(e.customer_name||'Unknown') + '</strong></td>' +
      '<td class="nowrap"><span class="chip chip-' + urgCls(e.urgency) + '">' + esc(e.urgency) + '</span></td>' +
      '<td class="wrap-cell">' + esc(e.reason) + '</td>' +
      '<td class="muted nowrap">' + fmtFull(e.escalated_at) + '</td>' +
      '<td>' + (e.resolved
        ? '<span class="resolved-badge">&#10003; Resolved</span>'
        : '<button class="resolve-btn" data-id="' + e.id + '" onclick="handleResolveEscalation(this)">Resolve</button>') + '</td>' +
      '</tr>'
    ).join(''), '&#128680;', 'No escalations yet.');

  // ── Tower pricing tables ──────────────────────────────────────────────────
  const towerFoundationHTML = tbl(
    ['Foundation Type', 'Price (KShs)', ''],
    towerPricing.foundation.map(f =>
      '<tr><td class="nowrap"><strong>' + esc(titleCase(f.foundation_type)) + '</strong></td>' +
      '<td class="nowrap"><input type="number" class="tf-price-input" id="tf-price-' + esc(f.foundation_type) + '" value="' + esc(f.price) + '" min="0"></td>' +
      '<td class="nowrap">' +
        '<button type="button" class="resolve-btn" onclick="saveTowerFoundation(\'' + esc(f.foundation_type) + '\')">Save</button> ' +
        '<button type="button" class="resolve-btn" onclick="deleteTowerFoundation(\'' + esc(f.foundation_type) + '\')">Delete</button>' +
      '</td></tr>'
    ).join(''), '&#127959;&#65039;', 'No foundation prices set.');
  // Powers the Tower Package modal's Foundation Type dropdown — server-rendered from whatever
  // foundation types currently exist, so a newly-added one is immediately selectable there too,
  // rather than the dropdown being hardcoded to just "Pad"/"Raft".
  const towerFoundationOptionsHTML = towerPricing.foundation.map(f =>
    '<option value="' + esc(f.foundation_type) + '">' + esc(titleCase(f.foundation_type)) + '</option>'
  ).join('');

  const towerTanksHTML = tbl(
    ['Tank Type', 'Capacity', 'Price (KShs)', ''],
    towerPricing.tanks.map(t =>
      '<tr><td class="nowrap">' + esc(t.tank_type === 'plastic' ? 'Jojo' : 'Steel') + '</td>' +
      '<td class="nowrap">' + esc(t.capacity_label) + '</td>' +
      '<td class="nowrap">KShs ' + Number(t.price).toLocaleString() + '</td>' +
      '<td class="nowrap">' +
        '<button type="button" class="resolve-btn" data-id="' + t.id + '" data-type="' + esc(t.tank_type) + '" data-key="' + esc(t.capacity_key) + '" ' +
          'data-label="' + esc(t.capacity_label) + '" data-price="' + esc(t.price) + '" onclick="openTankPriceModal(this)">Edit</button> ' +
        '<button type="button" class="resolve-btn" onclick="deleteTowerTank(' + t.id + ')">Delete</button>' +
      '</td></tr>'
    ).join(''), '&#128167;', 'No tank prices set.');

  const foundationLookup = {};
  towerPricing.foundation.forEach(f => { foundationLookup[f.foundation_type] = Number(f.price); });
  const tankLookup = {};
  towerPricing.tanks.forEach(t => { tankLookup[t.tank_type + ':' + t.capacity_key] = Number(t.price); });

  const towerPackagesHTML = tbl(
    ['Height', 'Tanks', 'Type', 'Capacity', 'Foundation', 'Fabrication (KShs)', 'Total (KShs)', ''],
    towerPricing.packages.map(p => {
      const foundationPrice = foundationLookup[p.foundation_type] || 0;
      const tankPrice = tankLookup[p.tank_type + ':' + p.capacity_key] || 0;
      const total = Number(p.fabrication_price) + foundationPrice + tankPrice * p.tank_count;
      return '<tr><td class="nowrap">' + p.height_m + 'm</td>' +
        '<td class="nowrap">' + p.tank_count + '</td>' +
        '<td class="nowrap">' + esc(p.tank_type === 'plastic' ? 'Jojo' : 'Steel') + '</td>' +
        '<td class="nowrap">' + esc(p.capacity_label) + '</td>' +
        '<td class="nowrap">' + esc(p.foundation_type.charAt(0).toUpperCase() + p.foundation_type.slice(1)) + '</td>' +
        '<td class="nowrap">KShs ' + Number(p.fabrication_price).toLocaleString() + '</td>' +
        '<td class="nowrap"><strong>KShs ' + total.toLocaleString() + '</strong></td>' +
        '<td class="nowrap">' +
          '<button type="button" class="resolve-btn" data-id="' + p.id + '" data-height="' + p.height_m + '" data-count="' + p.tank_count + '" ' +
            'data-type="' + esc(p.tank_type) + '" data-key="' + esc(p.capacity_key) + '" data-label="' + esc(p.capacity_label) + '" ' +
            'data-foundation="' + esc(p.foundation_type) + '" data-fab="' + esc(p.fabrication_price) + '" onclick="openTowerPackageModal(this)">Edit</button> ' +
          '<button type="button" class="resolve-btn" onclick="deleteTowerPackage(' + p.id + ')">Delete</button>' +
        '</td></tr>';
    }).join(''), '&#127959;&#65039;', 'No tower packages configured.');

  // ── Drilling pricing tables ───────────────────────────────────────────────
  const drillingSettingsHTML = tbl(
    ['Setting', 'Value', ''],
    Object.keys(drillingPricing.settings).sort().map(key =>
      '<tr><td class="wrap-cell">' + esc(DRILLING_SETTING_LABELS[key] || key) + '</td>' +
      '<td class="nowrap"><input type="text" class="tf-price-input" id="ds-value-' + esc(key) + '" value="' + esc(drillingPricing.settings[key]) + '"></td>' +
      '<td class="nowrap"><button type="button" class="resolve-btn" onclick="saveDrillingSetting(\'' + esc(key) + '\')">Save</button></td></tr>'
    ).join(''), '&#9935;&#65039;', 'No drilling settings configured.');

  const drillingPenetrationHTML = tbl(
    ['Label', 'Minutes/Rod', 'Rod Length (m)', ''],
    drillingPricing.penetrationRates.map(p =>
      '<tr><td class="nowrap">' + esc(p.label) + '</td>' +
      '<td class="nowrap">' + p.minutes_per_rod + '</td>' +
      '<td class="nowrap">' + p.rod_length_m + '</td>' +
      '<td class="nowrap">' +
        '<button type="button" class="resolve-btn" data-id="' + p.id + '" data-label="' + esc(p.label) + '" ' +
          'data-minutes="' + esc(p.minutes_per_rod) + '" data-rodlength="' + esc(p.rod_length_m) + '" onclick="openPenetrationRateModal(this)">Edit</button> ' +
        '<button type="button" class="resolve-btn" onclick="deletePenetrationRate(' + p.id + ')">Delete</button>' +
      '</td></tr>'
    ).join(''), '&#9935;&#65039;', 'No penetration rate presets configured.');

  function lineItemsTable(items, category) {
    return tbl(
      ['Name', 'Default Qty', 'Default Rate (KShs)', ''],
      items.map(li =>
        '<tr><td class="wrap-cell">' + esc(li.name) + '</td>' +
        '<td class="nowrap">' + li.default_qty + '</td>' +
        '<td class="nowrap">KShs ' + Number(li.default_rate).toLocaleString() + '</td>' +
        '<td class="nowrap">' +
          '<button type="button" class="resolve-btn" data-id="' + li.id + '" data-category="' + category + '" data-name="' + esc(li.name) + '" ' +
            'data-qty="' + esc(li.default_qty) + '" data-rate="' + esc(li.default_rate) + '" data-sort="' + esc(li.sort_order) + '" onclick="openLineItemModal(this)">Edit</button> ' +
          '<button type="button" class="resolve-btn" onclick="deleteLineItem(' + li.id + ')">Delete</button>' +
        '</td></tr>'
      ).join(''), '&#9935;&#65039;', 'No line items configured.');
  }
  const drillingConsumablesHTML = lineItemsTable(drillingPricing.consumables, 'consumable');
  const drillingMobilizationHTML = lineItemsTable(drillingPricing.mobilization, 'mobilization');

  // ── Solar pricing tables ──────────────────────────────────────────────────
  const solarSettingsHTML = tbl(
    ['Setting', 'Value', ''],
    Object.keys(solarPricing.settings).sort().map(key =>
      '<tr><td class="wrap-cell">' + esc(SOLAR_SETTING_LABELS[key] || key) + '</td>' +
      '<td class="nowrap"><input type="text" class="tf-price-input" id="ss-value-' + esc(key) + '" value="' + esc(solarPricing.settings[key]) + '"></td>' +
      '<td class="nowrap"><button type="button" class="resolve-btn" onclick="saveSolarSetting(\'' + esc(key) + '\')">Save</button></td></tr>'
    ).join(''), '&#9728;&#65039;', 'No solar settings configured.');

  const solarItemsByTier = {};
  solarPricing.lineItems.forEach(li => { (solarItemsByTier[li.tier_key] = solarItemsByTier[li.tier_key] || []).push(li); });

  const solarTiersHTML = solarPricing.tiers.map(tier => {
    const items = solarItemsByTier[tier.tier_key] || [];
    const itemsTable = tbl(
      ['Name', 'Category', 'Default Qty', 'Default Rate (KShs)', ''],
      items.map(li =>
        '<tr><td class="wrap-cell">' + esc(li.name) + '</td>' +
        '<td class="nowrap">' + (li.category === 'exempt' ? '<span class="chip chip-general">VAT-exempt</span>' : '<span class="chip chip-warning">Taxable</span>') + '</td>' +
        '<td class="nowrap">' + li.default_qty + '</td>' +
        '<td class="nowrap">KShs ' + Number(li.default_rate).toLocaleString() + '</td>' +
        '<td class="nowrap">' +
          '<button type="button" class="resolve-btn" data-id="' + li.id + '" data-tier="' + esc(tier.tier_key) + '" data-category="' + li.category + '" data-name="' + esc(li.name) + '" ' +
            'data-qty="' + esc(li.default_qty) + '" data-rate="' + esc(li.default_rate) + '" data-sort="' + esc(li.sort_order) + '" onclick="openSolarLineItemModal(this)">Edit</button> ' +
          '<button type="button" class="resolve-btn" onclick="deleteSolarLineItem(' + li.id + ')">Delete</button>' +
        '</td></tr>'
      ).join(''), '&#9728;&#65039;', 'No line items in this tier yet.');
    const domId = 'solar-tier-items-' + esc(tier.tier_key);
    return (
      '<div class="solar-tier-block">' +
        '<h4 style="margin:16px 0 4px;display:flex;align-items:center;gap:8px;cursor:pointer" onclick="toggleSolarTier(\'' + esc(tier.tier_key) + '\',this)">' +
          '<span class="solar-tier-arrow">&#9654;</span> ' + esc(tier.label) + ' <span style="font-weight:400;color:#888;font-size:.85rem">(' + items.length + ' items)</span>' +
        '</h4>' +
        '<div id="' + domId + '" style="display:none">' +
          '<div class="pane-toolbar">' +
            '<button type="button" class="resolve-btn" data-key="' + esc(tier.tier_key) + '" data-label="' + esc(tier.label) + '" data-sort="' + esc(tier.sort_order) + '" onclick="event.stopPropagation();openSolarTierModal(this)">Edit Tier</button>' +
            '<button type="button" class="resolve-btn" onclick="event.stopPropagation();deleteSolarTier(\'' + esc(tier.tier_key) + '\')">Delete Tier</button>' +
            '<button type="button" class="export-btn" onclick="event.stopPropagation();openSolarLineItemModal(null,\'' + esc(tier.tier_key) + '\')">&#10133; Add Item</button>' +
          '</div>' +
          itemsTable +
        '</div>' +
      '</div>'
    );
  }).join('');

  // ── Analytics tab ─────────────────────────────────────────────────────────
  // Simple CSS bar visualizations rather than a charting dependency — matches this dashboard's
  // existing no-heavy-libraries pattern (pdfkit over Chromium, plain JS over a frontend framework).
  const STAT_COLORS = ['#075E54', '#1E88C7', '#F5A623', '#B02A2A', '#8E44AD', '#16A085'];
  function barList(rows, total) {
    if (!rows.length) return '<p class="muted">No data yet.</p>';
    return '<div class="analytics-bars">' + rows.map((r, i) => {
      const pct = total > 0 ? Math.round(r.count / total * 100) : 0;
      const color = STAT_COLORS[i % STAT_COLORS.length];
      return '<div class="analytics-bar-row">' +
        '<div class="analytics-bar-label">' + esc(r.label) + '</div>' +
        '<div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
        '<div class="analytics-bar-value">' + r.count + ' <span class="muted">(' + pct + '%)</span></div>' +
      '</div>';
    }).join('') + '</div>';
  }
  const statusTotal = analytics.leadsByStatus.reduce((s, r) => s + r.count, 0);
  const domainTotal  = analytics.domainSplit.reduce((s, r) => s + r.count, 0);
  const leadsByStatusHTML = barList(analytics.leadsByStatus.map(r => ({ label: r.status.charAt(0).toUpperCase() + r.status.slice(1), count: r.count })), statusTotal);
  const domainSplitHTML   = barList(analytics.domainSplit.map(r => ({ label: r.domain === 'undetected' ? 'Undetected' : r.domain.charAt(0).toUpperCase() + r.domain.slice(1), count: r.count })), domainTotal);

  const analyticsHTML =
    '<div class="stats" style="margin:0 0 20px">' +
      '<div class="stat s-conv"><div class="stat-n">' + analytics.totalConversations + '</div><div class="stat-l">&#128172; Total Conversations</div></div>' +
      '<div class="stat s-leads"><div class="stat-n">' + analytics.totalLeads + '</div><div class="stat-sub">' + analytics.conversionRatePct + '% conversion</div><div class="stat-l">&#127919; Leads Captured</div></div>' +
      '<div class="stat s-esc"><div class="stat-n">' + analytics.escalation.pct + '%</div><div class="stat-sub">' + analytics.escalation.count + ' of ' + analytics.escalation.total + '</div><div class="stat-l">&#128680; Escalation Rate</div></div>' +
      '<div class="stat s-cb"><div class="stat-n">' + analytics.messagesPerConversation.withLead.avgMessages + '</div><div class="stat-sub">vs ' + analytics.messagesPerConversation.withoutLead.avgMessages + ' without a lead</div><div class="stat-l">&#128172; Avg Messages (Converted)</div></div>' +
    '</div>' +
    '<div class="pane-scroll">' +
      '<h3 style="margin:16px 0 8px">Leads by Status</h3>' +
      leadsByStatusHTML +
      '<h3 style="margin:24px 0 8px">Domain Split</h3>' +
      domainSplitHTML +
      '<h3 style="margin:24px 0 8px">Messages per Conversation</h3>' +
      '<div class="tbl-wrap"><table><thead><tr><th></th><th>Conversations</th><th>Avg. Messages</th></tr></thead><tbody>' +
        '<tr><td>With a captured lead</td><td>' + analytics.messagesPerConversation.withLead.conversations + '</td><td>' + analytics.messagesPerConversation.withLead.avgMessages + '</td></tr>' +
        '<tr><td>No lead captured</td><td>' + analytics.messagesPerConversation.withoutLead.conversations + '</td><td>' + analytics.messagesPerConversation.withoutLead.avgMessages + '</td></tr>' +
      '</tbody></table></div>' +
      '<p class="muted" style="margin-top:8px;font-size:.8rem">Message counts exclude internal system-injected context (date seeding, ad-referral notes) — real customer/AI/human exchanges only. For raw data, use the conversation export in the Chats tab.</p>' +
    '</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waterlift Admin</title>
<link rel="icon" href="/icons/favicon.png">

<!-- PWA: lets staff "Add to Home Screen" on Android/iOS for an app-like icon -->
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#075E54">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Waterlift Admin">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f4f8;color:#111;height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden}

/* ── Top bar ── */
.topbar{background:linear-gradient(135deg,#054a3a,#075E54);color:#fff;padding:8px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;row-gap:8px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.topbar-brand{display:flex;align-items:center;gap:10px}
.topbar-logo-chip{background:#fff;border-radius:8px;padding:4px 8px;display:flex;align-items:center;flex-shrink:0}
.topbar-logo{height:26px;width:auto;display:block}
.topbar h1{font-size:.92rem;font-weight:700;letter-spacing:-.2px}
.topbar p{font-size:.68rem;opacity:.75;margin-top:1px}
.top-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.live{display:flex;align-items:center;gap:5px;font-size:.75rem;opacity:.9}
.logged-in-as{font-size:.72rem;opacity:.8;white-space:nowrap}
@media(max-width:640px){.logged-in-as{display:none}}
.live-dot{width:7px;height:7px;background:#25D366;border-radius:50%;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(37,211,102,.4)}70%{box-shadow:0 0 0 5px rgba(37,211,102,0)}}
.refresh-btn{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.25);color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:.8rem;transition:background .15s;white-space:nowrap}
.refresh-btn:hover{background:rgba(255,255,255,.25)}
@media(max-width:640px){
  .topbar{padding:8px 12px}
  .topbar h1{font-size:.8rem}
  .live{display:none}
  .top-right{gap:6px}
  .refresh-btn{padding:5px 9px;font-size:.7rem}
}

/* ── Stats ── */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:7px 16px;background:#fff;border-bottom:1px solid #e2e8f0;flex-shrink:0}
.stats.stats-hidden{display:none}
@media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr);padding:6px 12px}}
.stat{text-align:center;padding:4px}
.stat-n{font-size:1.2rem;font-weight:700;line-height:1}
.stat-l{font-size:.65rem;color:#64748b;margin-top:2px;font-weight:500}
.s-conv .stat-n{color:#075E54} .s-leads .stat-n{color:#d97706}
.s-cb .stat-n{color:#dc2626} .s-esc .stat-n{color:#8b5cf6}

/* ── Tabs ── */
.tabs{display:flex;background:#075E54;flex-shrink:0;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{padding:8px 20px;border:none;background:transparent;color:rgba(255,255,255,.65);cursor:pointer;font-size:.85rem;font-weight:500;white-space:nowrap;border-bottom:3px solid transparent;transition:all .15s}
.tab:hover{color:#fff;background:rgba(255,255,255,.08)}
.tab.active{color:#fff;border-bottom-color:#25D366;background:rgba(255,255,255,.1)}

/* ── Panes ── */
.pane{display:none;flex:1;overflow:hidden;min-height:0}
.pane.active{display:flex;flex-direction:column}
.pane-scroll{flex:1;overflow-y:auto;padding:16px}

/* ── WhatsApp layout ── */
.wa-layout{display:flex;flex:1;overflow:hidden;min-height:0;background:#fff}
.wa-left{width:360px;min-width:280px;border-right:1px solid #e2e8f0;display:flex;flex-direction:column;background:#fff;flex-shrink:0}
@media(max-width:768px){
  .wa-left{width:100%;min-width:0}
  .wa-left.wa-hidden{display:none}
  .wa-right{width:100%}
  .wa-chat:not(.wa-active){display:none}
}
.wa-right{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;position:relative}

/* Left panel header */
.wa-lhdr{background:#075E54;color:#fff;padding:14px 16px;font-size:.9rem;font-weight:600;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.wa-lcount{background:rgba(255,255,255,.2);border-radius:12px;padding:2px 8px;font-size:.75rem}

/* Search */
.wa-search{padding:8px 12px;background:#f0f2f5;border-bottom:1px solid #e2e8f0;flex-shrink:0}
.wa-search input{width:100%;border:none;background:#fff;padding:8px 14px;border-radius:20px;font-size:.85rem;outline:none;color:#111;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.wa-search input:focus{box-shadow:0 0 0 2px rgba(7,94,84,.2)}

/* Contacts */
.wa-contacts{flex:1;overflow-y:auto}
.wa-contact{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;border-bottom:1px solid #f0f2f5;transition:background .1s}
.wa-contact:hover,.wa-contact.active{background:#f0f2f5}
.wa-empty-contacts{padding:40px 20px;text-align:center;color:#94a3b8;font-size:.875rem}

/* Avatars */
.wa-av{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:700;color:#fff;flex-shrink:0;text-transform:uppercase}
.wa-av-sm{width:38px;height:38px;font-size:.75rem}
.wa-av-solar{background:linear-gradient(135deg,#d97706,#f59e0b)}
.wa-av-borehole{background:linear-gradient(135deg,#1d4ed8,#3b82f6)}
.wa-av-general{background:linear-gradient(135deg,#075E54,#128C7E)}

/* Contact info */
.wa-ct-info{flex:1;min-width:0}
.wa-ct-row1{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.wa-ct-name{font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;margin-right:8px}
.wa-ct-time{font-size:.72rem;color:#128C7E;flex-shrink:0;font-weight:500}
.wa-ct-row2{display:flex;align-items:center;gap:6px}
.wa-ct-prev{font-size:.8rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.wa-ct-badge{font-size:.85rem;flex-shrink:0}
.wa-unread-dot{width:10px;height:10px;background:#25D366;border-radius:50%;flex-shrink:0;box-shadow:0 0 0 2px #e8f5e9}
.wa-domain-chip,.wa-chip-solar,.wa-chip-borehole,.wa-chip-general{font-size:.65rem;padding:1px 6px;border-radius:8px;font-weight:600;flex-shrink:0}
.wa-chip-solar{background:#fef3c7;color:#92400e}
.wa-chip-borehole{background:#dbeafe;color:#1e40af}
.wa-chip-general{background:#e2e8f0;color:#475569}

/* Right: no-chat */
.wa-no-chat{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f0f2f5;color:#94a3b8;text-align:center;padding:40px}
.wa-no-chat-icon{font-size:3rem;margin-bottom:12px;opacity:.4}
.wa-no-chat p{font-size:.9rem}

/* Chat window */
.wa-chat{display:none;flex-direction:column;flex:1;overflow:hidden;min-height:0}
.wa-chat.wa-active{display:flex}

/* Chat header */
.wa-chat-hdr{background:#075E54;color:#fff;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0;box-shadow:0 2px 4px rgba(0,0,0,.2)}
.wa-back{background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer;padding:4px 8px;border-radius:4px;display:none;flex-shrink:0}
@media(max-width:768px){.wa-back{display:block}}
.wa-hdr-info{flex:1;min-width:0}
.wa-hdr-name{font-size:.9rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-hdr-sub{font-size:.72rem;margin-top:1px;opacity:.85}
.sub-active{color:#25D366}
.sub-paused{color:#fb923c}
.wa-action-btn{padding:6px 12px;border:none;border-radius:6px;cursor:pointer;font-size:.75rem;font-weight:600;white-space:nowrap;transition:all .15s;flex-shrink:0}
.wa-btn-pause{background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.3)}
.wa-btn-pause:hover{background:rgba(255,255,255,.25)}
.wa-btn-resume{background:#25D366;color:#fff;border:1px solid #1ebe5a}
.wa-btn-resume:hover{background:#1ebe5a}
.wa-action-btn:disabled{opacity:.5;cursor:not-allowed}

/* Messages area */
.wa-msgs{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:4px;
  background-color:#ECE5DD;
  background-image:url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
}

/* Message rows */
.wa-row{display:flex;margin-bottom:2px}
.wa-row-in{justify-content:flex-start}
.wa-row-out{justify-content:flex-end}
.wa-row-center{justify-content:center;margin:6px 0}

/* Bubbles */
.wa-bubble{max-width:72%;padding:8px 12px 22px;border-radius:8px;font-size:.875rem;line-height:1.5;white-space:pre-wrap;word-break:break-word;position:relative;box-shadow:0 1px 2px rgba(0,0,0,.12)}
@media(max-width:480px){.wa-bubble{max-width:88%}}
.wa-in{background:#fff;border-radius:0 8px 8px 8px}
.wa-in::before{content:'';position:absolute;left:-7px;top:0;border:7px solid transparent;border-right-color:#fff;border-top-color:#fff}
.wa-out{background:#DCF8C6;border-radius:8px 0 8px 8px}
.wa-out::after{content:'';position:absolute;right:-7px;top:0;border:7px solid transparent;border-left-color:#DCF8C6;border-top-color:#DCF8C6}
.wa-human{background:#C8F7DC}
.wa-human::after{border-left-color:#C8F7DC;border-top-color:#C8F7DC}
.wa-sender{display:block;font-size:.68rem;font-weight:700;color:#075E54;margin-bottom:3px;opacity:.8}
.wa-human .wa-sender{color:#16a34a}
.wa-ts{position:absolute;bottom:4px;right:8px;font-size:.65rem;color:rgba(0,0,0,.38);white-space:nowrap;display:flex;align-items:center;gap:3px}
.wa-tick{color:#53bdeb}
.wa-system{background:rgba(0,0,0,.06);border-radius:12px;padding:4px 12px;font-size:.72rem;color:#475569;text-align:center;max-width:80%}
.wa-img-bubble{padding:6px 6px 20px}
.wa-img{display:block;max-width:100%;width:240px;height:auto;border-radius:6px;cursor:pointer}
.wa-img-cap{padding:6px 6px 0;font-size:.85rem;line-height:1.4}
@media(max-width:480px){.wa-img{width:180px}}

.wa-doc-bubble{min-width:200px}
.wa-doc{display:flex;align-items:center;gap:8px;background:rgba(0,0,0,.06);border-radius:8px;padding:8px 10px;margin-top:2px;color:inherit;text-decoration:none}
a.wa-doc{cursor:pointer;transition:background .15s}
a.wa-doc:hover{background:rgba(0,0,0,.12)}
a.wa-doc .wa-doc-name{text-decoration:underline}
.wa-doc-icon{font-size:1.3rem}
.wa-doc-name{font-size:.85rem;font-weight:600;word-break:break-all}
.wa-doc-cap{padding:6px 2px 0;font-size:.85rem;line-height:1.4}

.wa-quote{background:rgba(0,0,0,.06);border-left:3px solid #25D366;border-radius:6px;padding:5px 8px;margin-bottom:5px;font-size:.8rem;line-height:1.35;max-height:2.7em;overflow:hidden}
.wa-quote-sender{display:block;font-weight:700;color:#075E54;font-size:.75rem}
.wa-in .wa-quote{border-left-color:#94a3b8}
.wa-in .wa-quote-sender{color:#475569}

.wa-row{position:relative}
.wa-reply-btn{position:absolute;top:2px;background:#fff;border:1px solid #e2e8f0;border-radius:50%;width:26px;height:26px;font-size:.9rem;color:#64748b;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.85;transition:opacity .15s,background .15s}
.wa-row-in .wa-reply-btn{right:-4px}
.wa-row-out .wa-reply-btn{left:-4px}
.wa-reply-btn:hover:not(:disabled){opacity:1;background:#f0fdf4}
.wa-reply-btn:disabled{opacity:0;pointer-events:none}
@media(max-width:768px){.wa-reply-btn{opacity:.7}}

.wa-reply-banner{display:flex;align-items:center;gap:8px;background:#f0f2f5;border-left:3px solid #25D366;border-radius:6px;padding:6px 8px;margin-bottom:6px;font-size:.8rem}
.wa-reply-banner-body{flex:1;min-width:0}
.wa-reply-banner-sender{display:block;font-weight:700;color:#075E54;font-size:.75rem}
.wa-reply-banner-preview{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-reply-cancel{background:none;border:none;color:#64748b;font-size:1.1rem;cursor:pointer;padding:2px 6px;flex-shrink:0}

.wa-attach{width:40px;height:40px;border-radius:50%;background:#fff;border:1px solid #d1d5db;color:#075E54;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s}
.wa-attach:hover:not(:disabled){background:#f0fdf4}
.wa-attach:disabled{color:#94a3b8;cursor:not-allowed}

/* Input area */
.wa-input-area{background:#f0f2f5;padding:8px 12px;padding-bottom:calc(8px + env(safe-area-inset-bottom, 0px));border-top:1px solid #e2e8f0;flex-shrink:0}
.wa-input-locked{background:#f8f9fa}
.wa-lock-notice{font-size:.78rem;color:#d97706;background:#fef9c3;border:1px solid #fde68a;padding:6px 12px;border-radius:6px;margin-bottom:8px;text-align:center;font-weight:500}
.wa-input-row{display:flex;align-items:flex-end;gap:8px}
@media(max-width:480px){
  .wa-input-row{gap:6px}
  .wa-attach{width:36px;height:36px;font-size:1rem}
  .wa-send{width:38px;height:38px;font-size:1rem}
  .wa-ta{padding:9px 12px}
}
.wa-ta{flex:1;min-width:0;border:none;background:#fff;padding:10px 14px;border-radius:22px;font-size:16px;font-family:inherit;resize:none;outline:none;line-height:1.4;max-height:120px;overflow-y:auto;box-shadow:0 1px 2px rgba(0,0,0,.08);color:#111}
.wa-ta:disabled{background:#f1f5f9;color:#94a3b8;cursor:not-allowed}
.wa-send{width:44px;height:44px;border-radius:50%;background:#25D366;border:none;color:#fff;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s;box-shadow:0 2px 4px rgba(37,211,102,.4)}
.wa-send:hover:not(:disabled){background:#1ebe5a}
.wa-send-disabled{background:#94a3b8;box-shadow:none;cursor:not-allowed}

/* Tables */
.tbl-wrap{overflow-x:auto;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid #e2e8f0}
table{width:100%;border-collapse:collapse;background:#fff}
th{background:#f8fafc;padding:11px 14px;text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.5px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0;white-space:nowrap}
td{padding:12px 14px;border-top:1px solid #f1f5f9;font-size:.875rem;vertical-align:top}
tr:hover td{background:#fafbfd}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:.8rem}
.muted{color:#64748b;font-size:.8rem}
.chip{display:inline-block;padding:3px 9px;border-radius:20px;font-size:.72rem;font-weight:700;text-transform:capitalize}
.chip-solar{background:#fef3c7;color:#92400e}
.chip-borehole{background:#dbeafe;color:#1e40af}
.chip-general{background:#f1f5f9;color:#475569}
.chip-danger{background:#fee2e2;color:#991b1b}
.chip-warning{background:#fef3c7;color:#92400e}
.status-sel{border:none;border-radius:12px;padding:3px 10px;font-size:.72rem;font-weight:700;cursor:pointer;outline:none;-webkit-appearance:none;appearance:none}
.status-new{background:#dbeafe;color:#1e40af}
.status-contacted{background:#fef3c7;color:#92400e}
.status-converted{background:#dcfce7;color:#166534}
.status-lost{background:#fee2e2;color:#991b1b}
.tbl-empty{text-align:center;padding:48px 24px;color:#94a3b8;background:#fff;border-radius:10px}
.tbl-empty div{font-size:2.5rem;margin-bottom:10px}
.tbl-empty p{font-size:.9rem}
.nowrap{white-space:nowrap}
.wrap-cell{white-space:normal;word-break:break-word;min-width:160px;max-width:280px}
.notes-cell{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;cursor:pointer}
.notes-cell.expanded{display:block;-webkit-line-clamp:unset;overflow:visible}
.cell-flex{display:flex;align-items:center;gap:4px}
.copy-btn{background:none;border:none;cursor:pointer;font-size:.8rem;padding:2px 5px;color:#94a3b8;border-radius:4px;line-height:1;flex-shrink:0}
.copy-btn:hover{background:#f1f5f9;color:#334155}
@media(max-width:768px){
  .pane-scroll{padding:12px 8px}
  table{min-width:640px}
  th,td{padding:9px 10px;font-size:.8rem}
  .wrap-cell{min-width:140px;max-width:220px}
}

/* ── Filter bar ── */
.wa-filter-bar{display:flex;gap:6px;padding:8px 12px;background:#f0f2f5;border-bottom:1px solid #e2e8f0;flex-shrink:0}
.wa-filt{background:#fff;border:1px solid #d1d5db;border-radius:14px;padding:4px 12px;font-size:.75rem;cursor:pointer;color:#475569;font-weight:500;transition:all .15s;white-space:nowrap}
.wa-filt:hover{border-color:#25D366;color:#075E54}
.wa-filt-active{background:#075E54;border-color:#075E54;color:#fff}

/* ── Quick reply templates ── */
.wa-quick-replies{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px 4px;background:#f0f2f5;border-top:1px solid #e2e8f0}
.wa-qr-btn{background:#fff;border:1px solid #d1d5db;border-radius:14px;padding:5px 11px;font-size:.74rem;cursor:pointer;color:#075E54;font-weight:500;transition:all .15s;white-space:nowrap;text-align:left}
.wa-qr-btn:hover{background:#dcfce7;border-color:#25D366}

/* ── Lead pill in chat header ── */
.wa-lead-pill{font-size:.7rem;color:rgba(255,255,255,.8);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
.wa-ad-pill{font-size:.7rem;color:#fde68a;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
.wa-blocked-pill{font-size:.7rem;font-weight:600;color:#fecaca;margin-top:2px}

/* ── Stat subtitle ── */
.stat-sub{font-size:.68rem;color:#94a3b8;margin-top:1px}

/* ── Pane toolbar (export button row) ── */
.pane-toolbar{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;background:#fff;border-bottom:1px solid #e2e8f0;flex-shrink:0}
.export-btn{background:#075E54;color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:.8rem;font-weight:600;cursor:pointer;transition:background .15s;text-decoration:none;display:inline-flex;align-items:center}
.export-btn:hover{background:#054a3a}
.catalog-toolbar{justify-content:flex-start}
.catalog-url-input{flex:1;min-width:0;max-width:520px;padding:7px 12px;border:1.5px solid #cbd5e1;border-radius:6px;font-size:.8rem;font-family:inherit;color:#111}
.catalog-url-input:focus{outline:none;border-color:#075E54}
.catalog-status{padding:6px 16px;font-size:.78rem;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0}

/* ── Modal (Add Lead) ── */
.modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
.modal-card{background:#fff;border-radius:12px;padding:24px;max-width:420px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,.2)}
.modal-card h3{margin:0 0 16px;font-size:1.05rem;color:#075E54}
.modal-card label{display:block;font-size:.8rem;font-weight:600;color:#334155;margin-bottom:12px}
.modal-card input,.modal-card select,.modal-card textarea{width:100%;padding:9px 10px;margin-top:5px;font-family:inherit;font-size:.88rem;border:1.5px solid #cbd5e1;border-radius:6px;color:#111}
.modal-card input:focus,.modal-card select:focus,.modal-card textarea:focus{outline:none;border-color:#075E54}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;flex-wrap:wrap}
.modal-card-wide{max-width:820px}
.modal-card-wide h4{margin:16px 0 4px;font-size:.85rem;color:#075E54;border-top:1px solid #e2e8f0;padding-top:12px}
.dq-row4{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0 12px}
.dq-item-row{display:grid;grid-template-columns:1fr 90px 110px;gap:6px;align-items:center;font-size:.78rem;padding:4px 0}
.dq-item-row input[type="text"]{margin:0;padding:4px 6px;font-size:.78rem}
.dq-item-row input[type="number"]{margin:0;padding:4px 6px;font-size:.78rem}
.dq-mob-row{display:grid;grid-template-columns:20px 1fr 90px 110px;gap:6px;align-items:center;font-size:.78rem;padding:4px 0}
.dq-add-row{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
.dq-add-row input[type="text"]{flex:1;min-width:140px;margin:0;padding:4px 6px;font-size:.78rem}
.dq-add-row input[type="number"]{width:90px;margin:0;padding:4px 6px;font-size:.78rem}
.dq-preview{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-top:12px;font-size:.85rem;line-height:1.7}
.sq-item-row{display:grid;grid-template-columns:1fr 130px 70px 100px 22px;gap:6px;align-items:center;font-size:.78rem;padding:4px 0;border-bottom:1px solid #f1f5f9}
.sq-item-row input[type="text"],.sq-item-row input[type="number"],.sq-item-row select{margin:0;padding:4px 6px;font-size:.78rem}
.sq-item-row .sq-remove{cursor:pointer;color:#b91c1c;font-weight:700;text-align:center;user-select:none}
.solar-tier-arrow{display:inline-block;transition:transform .15s;font-size:.7rem}
.solar-tier-arrow.open{transform:rotate(90deg)}
.analytics-bars{display:flex;flex-direction:column;gap:10px;max-width:600px}
.analytics-bar-row{display:grid;grid-template-columns:140px 1fr 100px;gap:10px;align-items:center;font-size:.85rem}
.analytics-bar-track{background:#f1f5f9;border-radius:4px;height:14px;overflow:hidden}
.analytics-bar-fill{height:100%;border-radius:4px}
.analytics-bar-value{text-align:right}

/* ── Escalation resolve ── */
.resolve-btn{background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;padding:4px 10px;font-size:.75rem;cursor:pointer;color:#475569;font-weight:500;transition:all .15s}
.resolve-btn:hover{background:#dcfce7;border-color:#25D366;color:#16a34a}
.resolved-badge{font-size:.75rem;color:#16a34a;font-weight:600}
tr.esc-resolved td{opacity:.45}

/* Toast */
#toasts{position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.toast{background:#1e293b;color:#fff;padding:11px 16px;border-radius:8px;font-size:.83rem;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:toastIn .25s ease;max-width:260px;pointer-events:auto}
.toast.ok{background:#16a34a}
.toast.err{background:#dc2626}
@keyframes toastIn{from{transform:translateX(110%);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes toastOut{to{transform:translateX(110%);opacity:0}}
</style>
</head>
<body>

<div id="toasts"></div>

<div class="topbar">
  <div class="topbar-brand">
    <div class="topbar-logo-chip"><img src="/logo.png" alt="Waterlift Solar" class="topbar-logo"></div>
    <div>
      <h1>Admin Dashboard</h1>
      <p>Last refreshed: ${now}</p>
    </div>
  </div>
  <div class="top-right">
    <div class="live"><span class="live-dot"></span>Live</div>
    <span class="logged-in-as">${esc(adminEmail || '')}</span>
    <button class="refresh-btn" id="statsToggleBtn" onclick="toggleStats()">&#128202; Hide Stats</button>
    <button class="refresh-btn" onclick="openDevicesModal()">&#128241; Devices</button>
    <button class="refresh-btn" id="notifBtn" onclick="subscribeToPush()">&#128276; Enable Notifications</button>
    <button class="refresh-btn" onclick="location.reload()">&#8635; Refresh</button>
    <form method="POST" action="/logout" style="display:inline"><button type="submit" class="refresh-btn">&#128682; Log out</button></form>
  </div>
</div>

<!-- Active Devices modal -->
<div id="devicesOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card modal-card-wide">
    <h3>Active Devices</h3>
    <p style="font-size:.85rem;color:#64748b;margin:-8px 0 12px">Dashboard logins currently active (a session lasts up to 7 days, or until logged out / revoked).</p>
    <div id="devicesList">Loading&hellip;</div>
    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeDevicesModal()">Close</button>
    </div>
  </div>
</div>

<div class="stats" id="statsBar">
  <div class="stat s-conv"><div class="stat-n">${entries.length}</div><div class="stat-l">&#128172; Sessions</div></div>
  <div class="stat s-leads"><div class="stat-n">${leads.length}</div><div class="stat-sub">${converted} converted &bull; ${convRate}%</div><div class="stat-l">&#127919; Leads</div></div>
  <div class="stat s-cb"><div class="stat-n">${callbacks.length}</div><div class="stat-l">&#128222; Callbacks</div></div>
  <div class="stat s-esc"><div class="stat-n">${escalations.filter(e=>!e.resolved).length}</div><div class="stat-sub">${escalations.filter(e=>e.resolved).length} resolved</div><div class="stat-l">&#128680; Escalations</div></div>
</div>

<div class="tabs">
  <button class="tab active" onclick="showTab('conv',this)">&#128172; Chats (${entries.length})</button>
  <button class="tab" onclick="showTab('leads',this)">&#127919; Leads (${leads.length})</button>
  <button class="tab" onclick="showTab('cb',this)">&#128222; Callbacks (${callbacks.length})</button>
  <button class="tab" onclick="showTab('esc',this)">&#128680; Escalations (${escalations.length})</button>
  <button class="tab" onclick="showTab('catalog',this)">&#128230; Catalog (<span id="catalogTabCount">${productCount}</span>)</button>
  <button class="tab" onclick="showTab('towers',this)">&#127959;&#65039; Tower Pricing (${towerPricing.packages.length})</button>
  <button class="tab" onclick="showTab('drilling',this)">&#9935;&#65039; Drilling Pricing</button>
  <button class="tab" onclick="showTab('solar',this)">&#9728;&#65039; Solar Pricing</button>
  <button class="tab" onclick="showTab('analytics',this)">&#128202; Analytics</button>
</div>

<!-- Conversations pane -->
<div id="pane-conv" class="pane active">
  <div class="wa-layout">
    <div class="wa-left" id="wa-left">
      <div class="wa-lhdr">
        Conversations
        <span style="display:flex;align-items:center;gap:8px">
          <a href="/admin/api/export/conversations.csv" title="Export all conversations to CSV" style="color:#fff;text-decoration:none;font-size:.85rem">&#11015;&#65039;</a>
          <span class="wa-lcount">${entries.length}</span>
        </span>
      </div>
      <div class="wa-search">
        <input type="text" placeholder="&#128269; Search by number or message..." oninput="filterContacts(this.value)">
      </div>
      <div class="wa-filter-bar">
        <button class="wa-filt wa-filt-active" id="filt-all" onclick="filterDomain('all')">All</button>
        <button class="wa-filt" id="filt-solar" onclick="filterDomain('solar')">&#9728;&#65039; Solar</button>
        <button class="wa-filt" id="filt-borehole" onclick="filterDomain('borehole')">&#128167; Borehole</button>
      </div>
      <div class="wa-contacts">${contactsHTML}</div>
    </div>
    <div class="wa-right" id="wa-right">
      <div class="wa-no-chat" id="wa-no-chat">
        <div class="wa-no-chat-icon">&#128172;</div>
        <p>Select a conversation to view</p>
      </div>
      ${chatsHTML}
    </div>
  </div>
</div>

<!-- Leads pane -->
<div id="pane-leads" class="pane">
  <div class="pane-toolbar">
    <button class="export-btn" type="button" onclick="openAddLeadModal()">&#10133; Add Lead</button>
    <a class="export-btn" href="/admin/api/leads/export.csv">&#11015;&#65039; Export CSV</a>
  </div>
  <div class="pane-scroll">${leadsHTML}</div>
</div>

<!-- Add Lead modal -->
<div id="addLeadOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <h3 id="al-title">Add Lead</h3>
    <form id="addLeadForm" onsubmit="submitAddLead(event)">
      <input type="hidden" id="al-id" value="">
      <label>Name<input type="text" id="al-name" required></label>
      <label>Phone<input type="text" id="al-phone" required placeholder="e.g. 254712345678"></label>
      <label>Service
        <select id="al-service">
          <option value="solar">Solar</option>
          <option value="borehole">Borehole</option>
        </select>
      </label>
      <label>Location<input type="text" id="al-location"></label>
      <label>Property Type
        <select id="al-property">
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
          <option value="agricultural">Agricultural</option>
        </select>
      </label>
      <label>Estimated Budget (optional)<input type="text" id="al-budget"></label>
      <label>Notes (optional)<textarea id="al-notes" rows="3" style="width:100%;font-family:inherit"></textarea></label>
      <div class="modal-actions">
        <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeAddLeadModal()">Cancel</button>
        <button type="submit" class="export-btn" id="al-submit">Save Lead</button>
      </div>
    </form>
  </div>
</div>

<!-- Tower Quote modal -->
<div id="towerQuoteOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <h3>Generate Water Tower Quote</h3>
    <label>Client<input type="text" id="tq-client" required></label>
    <label>Phone (for WhatsApp send)<input type="text" id="tq-phone" placeholder="e.g. 254712345678"></label>
    <label>Project<input type="text" id="tq-project"></label>
    <label>Site Location (fills the transport line item)<input type="text" id="tq-location" placeholder="e.g. Nakuru"></label>
    <label>Quote Ref<input type="text" id="tq-ref"></label>
    <label>Date<input type="date" id="tq-date"></label>
    <label>Tower Height
      <select id="tq-height">
        <option value="6">6m</option>
        <option value="9">9m</option>
        <option value="12">12m</option>
      </select>
    </label>
    <label>Number of Tanks<input type="number" id="tq-count" value="2" min="1"></label>
    <label>Tank Type
      <select id="tq-tanktype" onchange="updateTankCapacityOptions()">
        <option value="plastic">Jojo</option>
        <option value="steel">Steel</option>
      </select>
    </label>
    <label>Tank Capacity
      <select id="tq-capacity"></select>
    </label>
    <label>Transport Cost, KShs (optional — leave blank to quote separately)<input type="number" id="tq-transport" min="0" placeholder="e.g. 25000"></label>
    <label><input type="checkbox" id="tq-vat-included" checked> Include VAT (16% — structure/foundation/tank rates are VAT-exclusive either way)</label>
    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeTowerQuoteModal()">Cancel</button>
      <button type="button" class="export-btn" onclick="downloadTowerQuote()">&#11015;&#65039; Download PDF</button>
      <button type="button" class="export-btn" id="tq-send-btn" onclick="sendTowerQuote()">Send via WhatsApp</button>
    </div>
  </div>
</div>

<!-- Callbacks pane -->
<div id="pane-cb" class="pane">
  <div class="pane-scroll">${cbHTML}</div>
</div>

<!-- Escalations pane -->
<div id="pane-esc" class="pane">
  <div class="pane-scroll">${escTbl}</div>
</div>

<!-- Catalog pane -->
<div id="pane-catalog" class="pane">
  <div class="pane-toolbar catalog-toolbar">
    <input type="text" id="catalogFeedUrl" class="catalog-url-input" placeholder="Product feed URL (Facebook/Google product feed XML)">
    <button class="export-btn" type="button" onclick="saveCatalogFeedUrl()">Save URL</button>
    <button class="export-btn" type="button" id="syncCatalogBtn" onclick="syncCatalogNow()">&#128260; Sync Now</button>
  </div>
  <div class="catalog-status" id="catalogStatus"></div>
  <div class="pane-toolbar catalog-toolbar">
    <input type="text" id="catalogSearch" class="catalog-url-input" placeholder="&#128269; Search products by name or category..." oninput="filterCatalogProducts(this.value)">
  </div>
  <div class="pane-scroll" id="catalogProductsTable">Loading&hellip;</div>
</div>

<!-- Tower Pricing pane -->
<div id="pane-towers" class="pane">
  <div class="pane-scroll">
    <div class="pane-toolbar">
      <a class="export-btn" href="/admin/api/tower-pricing/export.csv">&#11015;&#65039; Export CSV</a>
    </div>
    <h3 style="margin:16px 0 8px">Foundation Prices</h3>
    <div class="pane-toolbar">
      <button class="export-btn" type="button" onclick="openFoundationModal()">&#10133; Add Foundation</button>
    </div>
    ${towerFoundationHTML}

    <h3 style="margin:24px 0 8px">Tank Prices</h3>
    <div class="pane-toolbar">
      <button class="export-btn" type="button" onclick="openTankPriceModal()">&#10133; Add Tank Price</button>
    </div>
    ${towerTanksHTML}

    <h3 style="margin:24px 0 8px">Tower Packages</h3>
    <div class="pane-toolbar">
      <button class="export-btn" type="button" onclick="openTowerPackageModal()">&#10133; Add Package</button>
    </div>
    ${towerPackagesHTML}
  </div>
</div>

<!-- Drilling Pricing pane -->
<div id="pane-drilling" class="pane">
  <div class="pane-scroll">
    <h3 style="margin:16px 0 8px">Global Settings</h3>
    ${drillingSettingsHTML}

    <h3 style="margin:24px 0 8px">Penetration Rate Presets</h3>
    <div class="pane-toolbar">
      <button class="export-btn" type="button" onclick="openPenetrationRateModal()">&#10133; Add Preset</button>
    </div>
    ${drillingPenetrationHTML}

    <h3 style="margin:24px 0 8px">Consumable Line Items</h3>
    <div class="pane-toolbar">
      <button class="export-btn" type="button" onclick="openLineItemModal(null,'consumable')">&#10133; Add Consumable</button>
    </div>
    ${drillingConsumablesHTML}

    <h3 style="margin:24px 0 8px">Mobilization Cost Types</h3>
    <div class="pane-toolbar">
      <button class="export-btn" type="button" onclick="openLineItemModal(null,'mobilization')">&#10133; Add Mobilization Cost</button>
    </div>
    ${drillingMobilizationHTML}
  </div>
</div>

<!-- Solar Pricing pane -->
<div id="pane-solar" class="pane">
  <div class="pane-scroll">
    <div class="pane-toolbar">
      <a class="export-btn" href="/admin/api/solar-pricing/export.csv">&#11015;&#65039; Export CSV</a>
    </div>
    <h3 style="margin:16px 0 8px">Global Settings</h3>
    ${solarSettingsHTML}

    <h3 style="margin:24px 0 8px">kVA Tier Templates</h3>
    <div class="pane-toolbar">
      <button class="export-btn" type="button" onclick="openSolarTierModal()">&#10133; Add Tier</button>
    </div>
    ${solarTiersHTML}
  </div>
</div>

<!-- Analytics pane -->
<div id="pane-analytics" class="pane">
  ${analyticsHTML}
</div>

<!-- Foundation Price modal -->
<div id="foundationOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <h3>Add Foundation Type</h3>
    <label>Foundation Type (e.g. "pile", "strip" — used internally, shown to you capitalized)<input type="text" id="fo-type" required></label>
    <label>Price, KShs<input type="number" id="fo-price" min="0" required></label>
    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeFoundationModal()">Cancel</button>
      <button type="button" class="export-btn" id="fo-submit" onclick="submitFoundation()">Add</button>
    </div>
  </div>
</div>

<!-- Tank Price modal -->
<div id="tankPriceOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <h3 id="tp-title">Add Tank Price</h3>
    <input type="hidden" id="tp-id" value="">
    <label>Tank Type
      <select id="tp-type">
        <option value="plastic">Jojo (Plastic)</option>
        <option value="steel">Steel</option>
      </select>
    </label>
    <label>Capacity Key (used for matching, e.g. "50m3" or "10000l")<input type="text" id="tp-key" required></label>
    <label>Capacity Label (shown to customers, e.g. "50m³" or "10,000L")<input type="text" id="tp-label" required></label>
    <label>Price, KShs<input type="number" id="tp-price" min="0" required></label>
    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeTankPriceModal()">Cancel</button>
      <button type="button" class="export-btn" id="tp-submit" onclick="submitTankPrice()">Save</button>
    </div>
  </div>
</div>

<!-- Tower Package modal -->
<div id="towerPackageOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <h3 id="tw-title">Add Tower Package</h3>
    <input type="hidden" id="tw-id" value="">
    <label>Height, metres<input type="number" id="tw-height" min="1" required></label>
    <label>Number of Tanks<input type="number" id="tw-count" min="1" value="1" required></label>
    <label>Tank Type
      <select id="tw-type">
        <option value="plastic">Jojo (Plastic)</option>
        <option value="steel">Steel</option>
      </select>
    </label>
    <label>Capacity Key (must match an existing Tank Price entry, e.g. "50m3")<input type="text" id="tw-key" required></label>
    <label>Capacity Label (e.g. "50m³")<input type="text" id="tw-label" required></label>
    <label>Foundation Type
      <select id="tw-foundation">
        ${towerFoundationOptionsHTML}
      </select>
    </label>
    <label>Fabrication Price, KShs (item 1.00 on the quote — structure only, not foundation or tank)<input type="number" id="tw-fab" min="0" required></label>
    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeTowerPackageModal()">Cancel</button>
      <button type="button" class="export-btn" id="tw-submit" onclick="submitTowerPackage()">Save</button>
    </div>
  </div>
</div>

<!-- Penetration Rate modal -->
<div id="penetrationRateOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <h3 id="pr-title">Add Penetration Rate Preset</h3>
    <input type="hidden" id="pr-id" value="">
    <label>Label (e.g. "50 min/rod")<input type="text" id="pr-label" required></label>
    <label>Minutes per Rod<input type="number" id="pr-minutes" min="0" step="0.1" required></label>
    <label>Rod Length, metres<input type="number" id="pr-rodlength" min="0" step="0.1" value="5" required></label>
    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closePenetrationRateModal()">Cancel</button>
      <button type="button" class="export-btn" id="pr-submit" onclick="submitPenetrationRate()">Save</button>
    </div>
  </div>
</div>

<!-- Drilling Line Item modal (consumables + mobilization cost types share this modal) -->
<div id="lineItemOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <h3 id="li-title">Add Line Item</h3>
    <input type="hidden" id="li-id" value="">
    <input type="hidden" id="li-category" value="">
    <label>Name<input type="text" id="li-name" required></label>
    <label>Default Quantity<input type="number" id="li-qty" min="0" step="0.001" required></label>
    <label>Default Rate, KShs<input type="number" id="li-rate" min="0" step="0.01" required></label>
    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeLineItemModal()">Cancel</button>
      <button type="button" class="export-btn" id="li-submit" onclick="submitLineItem()">Save</button>
    </div>
  </div>
</div>

<!-- Drilling Quote modal -->
<div id="drillingQuoteOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card modal-card-wide">
    <h3>Generate Drilling Quote</h3>
    <label>Client<input type="text" id="dq-client" required></label>
    <label>Phone (for WhatsApp send)<input type="text" id="dq-phone" placeholder="e.g. 254712345678"></label>
    <label>Location<input type="text" id="dq-location"></label>
    <label>Quote Ref<input type="text" id="dq-ref"></label>
    <label>Date<input type="date" id="dq-date"></label>
    <label>Borehole Depth, metres<input type="number" id="dq-depth" min="1" required></label>

    <h4 style="margin:16px 0 4px">Drilling Rate Method</h4>
    <div class="dq-row4">
      <label><input type="radio" name="dq-ratemethod" id="dq-method-costing" value="costing" checked onchange="toggleDrillingRateMethod()"> Full Costing Calculation</label>
      <label><input type="radio" name="dq-ratemethod" id="dq-method-direct" value="direct" onchange="toggleDrillingRateMethod()"> Enter Rate Directly</label>
    </div>
    <div class="dq-row4" id="dq-direct-section" style="display:none">
      <label>Drilling Rate (KShs/metre)<input type="number" id="dq-directrate" step="0.01"></label>
    </div>

    <div class="dq-costing-only">
      <label>Penetration Rate<select id="dq-penetration"></select></label>
      <div class="dq-add-row">
        <input type="text" id="dq-new-pr-label" placeholder="New preset label, e.g. 45 min/rod">
        <input type="number" id="dq-new-pr-minutes" step="0.1" placeholder="Minutes/rod">
        <input type="number" id="dq-new-pr-rodlength" step="0.1" placeholder="Rod length, m" value="5">
        <button type="button" class="export-btn" onclick="addNewPenetrationRate()">&#10133; Add Preset</button>
      </div>

      <h4 style="margin:16px 0 4px">Fuel</h4>
      <div class="dq-row4">
        <label>Flushing Fuel (L)<input type="number" id="dq-flushing" step="0.01"></label>
        <label>Rig Truck Fuel (L)<input type="number" id="dq-rigfuel" step="0.01"></label>
        <label>Test Pumping Fuel (L)<input type="number" id="dq-testfuel" step="0.01"></label>
        <label>Fuel Rate (KShs/L)<input type="number" id="dq-fuelrate" step="0.01"></label>
      </div>
    </div>

    <h4 style="margin:16px 0 4px">Casing &amp; Surface Casing</h4>
    <div class="dq-row4">
      <label>Casing Rate (KShs/m)<input type="number" id="dq-casingrate" step="0.01"></label>
      <label class="dq-costing-only">Drilling Rate Deduction (costing mode only)<input type="number" id="dq-deduction" step="0.01"></label>
      <label>Surface Casing Rate<input type="number" id="dq-surfacerate" step="0.01"></label>
      <label><input type="checkbox" id="dq-surfaceincluded"> Include Surface Casing in Total</label>
    </div>

    <div class="dq-costing-only">
      <h4 style="margin:16px 0 4px">Gravel</h4>
      <div class="dq-row4">
        <label>Tonnes/Metre<input type="number" id="dq-graveltonnes" step="0.001"></label>
        <label>Bag Size (Kg)<input type="number" id="dq-bagsize" step="1"></label>
        <label>Rate/Bag (KShs)<input type="number" id="dq-bagrate" step="0.01"></label>
      </div>
    </div>

    <div class="dq-costing-only">
      <h4 style="margin:16px 0 4px">Consumables (internal costing — affects drilling rate only)</h4>
      <div id="dq-consumables"></div>
      <div class="dq-add-row">
        <input type="text" id="dq-new-consumable-name" placeholder="New consumable name">
        <input type="number" id="dq-new-consumable-qty" step="0.001" placeholder="Qty" value="1">
        <input type="number" id="dq-new-consumable-rate" step="0.01" placeholder="Rate, KShs">
        <button type="button" class="export-btn" onclick="addNewConsumable()">&#10133; Add Consumable</button>
      </div>
    </div>

    <h4 style="margin:16px 0 4px">Mobilization Method</h4>
    <div class="dq-row4">
      <label><input type="radio" name="dq-mobmethod" id="dq-mobmethod-calc" value="calc" checked onchange="toggleMobilizationMethod()"> Calculate from Distance</label>
      <label><input type="radio" name="dq-mobmethod" id="dq-mobmethod-direct" value="direct" onchange="toggleMobilizationMethod()"> Enter Total Directly</label>
    </div>
    <div class="dq-row4" id="dq-mob-direct-section" style="display:none">
      <label>Mobilization Total (KShs)<input type="number" id="dq-mob-directtotal" step="0.01"></label>
    </div>

    <div class="dq-mob-calc-only">
      <h4 style="margin:16px 0 4px">Mobilization — Rig</h4>
      <div class="dq-row4">
        <label>Tarmac (km)<input type="number" id="dq-rig-tarmac" step="0.1" value="0"></label>
        <label>Rough Road (km)<input type="number" id="dq-rig-rough" step="0.1" value="0"></label>
        <label>Tarmac Consumption (km/L)<input type="number" id="dq-rig-ctarmac" step="0.1"></label>
        <label>Rough Consumption (km/L)<input type="number" id="dq-rig-crough" step="0.1"></label>
      </div>
      <div id="dq-mob-rig"></div>

      <h4 style="margin:16px 0 4px">Mobilization — Support Truck</h4>
      <div class="dq-row4">
        <label>Tarmac (km)<input type="number" id="dq-truck-tarmac" step="0.1" value="0"></label>
        <label>Rough Road (km)<input type="number" id="dq-truck-rough" step="0.1" value="0"></label>
        <label>Tarmac Consumption (km/L)<input type="number" id="dq-truck-ctarmac" step="0.1"></label>
        <label>Rough Consumption (km/L)<input type="number" id="dq-truck-crough" step="0.1"></label>
      </div>
      <div id="dq-mob-truck"></div>

      <h4 style="margin:16px 0 4px">Mobilization — Test Pumping Unit Truck</h4>
      <div class="dq-row4">
        <label>Tarmac (km)<input type="number" id="dq-testpump-tarmac" step="0.1" value="0"></label>
        <label>Rough Road (km)<input type="number" id="dq-testpump-rough" step="0.1" value="0"></label>
        <label>Tarmac Consumption (km/L)<input type="number" id="dq-testpump-ctarmac" step="0.1"></label>
        <label>Rough Consumption (km/L)<input type="number" id="dq-testpump-crough" step="0.1"></label>
      </div>
      <div id="dq-mob-testpump"></div>
      <div class="dq-add-row">
        <input type="text" id="dq-new-mob-name" placeholder="New mobilization cost type (added to Rig, Truck and Test Pumping Unit lists above)">
        <input type="number" id="dq-new-mob-qty" step="0.001" placeholder="Qty" value="1">
        <input type="number" id="dq-new-mob-rate" step="0.01" placeholder="Rate, KShs">
        <button type="button" class="export-btn" onclick="addNewMobilizationCost()">&#10133; Add Mobilization Cost</button>
      </div>
    </div>

    <h4 style="margin:16px 0 4px">VAT &amp; Payment</h4>
    <div class="dq-row4">
      <label>VAT Rate (%)<input type="number" id="dq-vat" step="0.1"></label>
      <label>Deposit (%)<input type="number" id="dq-depositpct" step="0.1"></label>
      <label>Before Test Pumping (KShs, flat)<input type="number" id="dq-testpumpflat" step="0.01"></label>
    </div>

    <h4 style="margin:16px 0 4px">Sign-off</h4>
    <div class="dq-row4">
      <label>Prepared By<input type="text" id="dq-preparedby"></label>
      <label>Reviewed By<input type="text" id="dq-reviewedby"></label>
      <label>Approved By<input type="text" id="dq-approvedby"></label>
    </div>

    <div id="dq-preview" class="dq-preview" style="display:none"></div>

    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeDrillingQuoteModal()">Cancel</button>
      <button type="button" class="export-btn" onclick="previewDrillingQuote()">&#128202; Preview Totals</button>
      <button type="button" class="export-btn" onclick="downloadDrillingCostingCSV()">&#128202; Download Costing Sheet (CSV)</button>
      <button type="button" class="export-btn" onclick="downloadDrillingQuote()">&#11015;&#65039; Download PDF</button>
      <button type="button" class="export-btn" id="dq-send-btn" onclick="sendDrillingQuote()">Send via WhatsApp</button>
    </div>
  </div>
</div>

<!-- Solar Quote modal -->
<div id="solarQuoteOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card modal-card-wide">
    <h3>Generate Solar System Quote</h3>
    <label>Client<input type="text" id="sq-client" required></label>
    <label>Phone (for WhatsApp send)<input type="text" id="sq-phone" placeholder="e.g. 254712345678"></label>
    <label>Project<input type="text" id="sq-project" value="Solar Power Installation"></label>
    <label>Quote Ref<input type="text" id="sq-ref"></label>
    <label>Date<input type="date" id="sq-date"></label>
    <label>kVA Tier (loads a starting bill of quantities — edit freely below)
      <select id="sq-tier" onchange="loadSolarTierItems()"></select>
    </label>
    <label>System Label (shown on the quote banner, e.g. "20 KVA SYSTEM WITH 40KWH STORAGE")<input type="text" id="sq-label"></label>
    <label><input type="checkbox" id="sq-vat-included" checked> Include VAT (16% on non-solar accessories/labour — line item rates below are VAT-exclusive either way)</label>

    <h4 style="margin:16px 0 4px">Line Items</h4>
    <div class="dq-row4" style="font-weight:600;font-size:.85rem;color:#555">
      <span>Name</span><span>Category</span><span>Qty</span><span>Rate (KShs)</span>
    </div>
    <div id="sq-items"></div>
    <button type="button" class="export-btn" style="margin-top:8px" onclick="addSolarItemRow()">&#10133; Add Row</button>

    <h4 style="margin:16px 0 4px">Sign-off</h4>
    <div class="dq-row4">
      <label>Prepared By<input type="text" id="sq-preparedby"></label>
      <label>Reviewed By<input type="text" id="sq-reviewedby"></label>
      <label>Approved By<input type="text" id="sq-approvedby"></label>
    </div>

    <div id="sq-preview" class="dq-preview" style="display:none"></div>

    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeSolarQuoteModal()">Cancel</button>
      <button type="button" class="export-btn" onclick="previewSolarQuote()">&#128202; Preview Totals</button>
      <button type="button" class="export-btn" onclick="downloadSolarQuote()">&#11015;&#65039; Download PDF</button>
      <button type="button" class="export-btn" id="sq-send-btn" onclick="sendSolarQuote()">Send via WhatsApp</button>
    </div>
  </div>
</div>

<!-- Solar kVA Tier modal -->
<div id="solarTierOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <h3 id="st-title">Add kVA Tier</h3>
    <input type="hidden" id="st-key" value="">
    <label>Tier Key (used internally, e.g. "15kva" — cannot be changed once created)<input type="text" id="st-keyinput" required></label>
    <label>Label (shown to admin, e.g. "15 kVA")<input type="text" id="st-label" required></label>
    <label>Sort Order<input type="number" id="st-sort" value="0"></label>
    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeSolarTierModal()">Cancel</button>
      <button type="button" class="export-btn" id="st-submit" onclick="submitSolarTier()">Save</button>
    </div>
  </div>
</div>

<!-- Solar Line Item modal (tier template management, not the per-quote editor above) -->
<div id="solarLineItemOverlay" class="modal-overlay" style="display:none">
  <div class="modal-card">
    <h3 id="sli-title">Add Line Item</h3>
    <input type="hidden" id="sli-id" value="">
    <input type="hidden" id="sli-tier" value="">
    <label>Name<input type="text" id="sli-name" required></label>
    <label>Category
      <select id="sli-category">
        <option value="exempt">VAT-exempt (solar equipment)</option>
        <option value="taxable">Taxable (16% VAT)</option>
      </select>
    </label>
    <label>Default Quantity<input type="number" id="sli-qty" min="0" step="0.001" required></label>
    <label>Default Rate, KShs<input type="number" id="sli-rate" min="0" step="0.01" required></label>
    <div class="modal-actions">
      <button type="button" class="export-btn" style="background:#94a3b8" onclick="closeSolarLineItemModal()">Cancel</button>
      <button type="button" class="export-btn" id="sli-submit" onclick="submitSolarLineItem()">Save</button>
    </div>
  </div>
</div>

<script>
var activeChat = null;
var VAPID_PUBLIC_KEY = ${JSON.stringify(process.env.VAPID_PUBLIC_KEY || '')};

function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var rawData = atob(base64);
  var arr = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; i++) arr[i] = rawData.charCodeAt(i);
  return arr;
}

function updateBellUI() {
  var btn = document.getElementById('notifBtn');
  if (!btn) return;
  if (!('Notification' in window) || !VAPID_PUBLIC_KEY) { btn.style.display = 'none'; return; }
  if (Notification.permission === 'granted') {
    btn.innerHTML = '&#128276; Notifications On';
    btn.disabled = true;
  } else if (Notification.permission === 'denied') {
    btn.innerHTML = '&#128277; Notifications Blocked';
    btn.disabled = true;
  } else {
    btn.innerHTML = '&#128276; Enable Notifications';
    btn.disabled = false;
  }
}

async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('Push notifications are not supported on this browser', 'err'); return;
  }
  if (!VAPID_PUBLIC_KEY) {
    toast('Push notifications are not configured on the server', 'err'); return;
  }
  try {
    var permission = await Notification.requestPermission();
    if (permission !== 'granted') { toast('Notification permission denied', 'err'); updateBellUI(); return; }
    await navigator.serviceWorker.register('/sw.js');
    var reg = await navigator.serviceWorker.ready; // wait until the worker is actually active
    var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
    await fetch('/admin/api/push/subscribe', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(sub) });
    toast('Notifications enabled', 'ok');
    updateBellUI();
  } catch (err) {
    console.error('[push] subscribe failed', err);
    toast('Could not enable notifications', 'err');
  }
}

// Re-subscribes silently on load if the browser already granted permission earlier
// (subscribe() is idempotent — it returns the existing subscription if one is active)
function autoResubscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !VAPID_PUBLIC_KEY) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker.register('/sw.js').then(function() {
    return navigator.serviceWorker.ready; // wait until the worker is actually active
  }).then(function(reg) {
    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
  }).then(function(sub) {
    return fetch('/admin/api/push/subscribe', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(sub) });
  }).catch(function(err) { console.error('[push] auto-resubscribe failed', err); });
}

var catalogLoaded = false;
function showTab(name, btn) {
  document.querySelectorAll('.pane').forEach(function(p){p.classList.remove('active')});
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
  document.getElementById('pane-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'catalog' && !catalogLoaded) {
    catalogLoaded = true;
    loadCatalogSettings();
    loadCatalogProducts();
  }
}

function fmtCatalogTime(ts) {
  if (!ts) return 'never';
  return new Date(Number(ts)).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' });
}

async function loadCatalogSettings() {
  try {
    var r = await fetch('/admin/api/catalog/settings');
    var data = await r.json();
    document.getElementById('catalogFeedUrl').value = data.feedUrl || '';
    document.getElementById('catalogStatus').textContent = 'Last synced: ' + fmtCatalogTime(data.lastSynced);
  } catch (e) { toast('Failed to load catalog settings', 'err'); }
}

async function saveCatalogFeedUrl() {
  var url = document.getElementById('catalogFeedUrl').value.trim();
  if (!url) { toast('Enter a feed URL first', 'err'); return; }
  try {
    var r = await fetch('/admin/api/catalog/settings', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ feedUrl: url })
    });
    if (!r.ok) { var e = await r.json(); throw new Error(e.error || 'Failed'); }
    toast('Feed URL saved', 'ok');
  } catch (e) { toast('Save failed: ' + e.message, 'err'); }
}

async function syncCatalogNow() {
  var btn = document.getElementById('syncCatalogBtn');
  btn.disabled = true; btn.innerHTML = '&#128260; Syncing...';
  try {
    var r = await fetch('/admin/api/catalog/sync', { method: 'POST' });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Sync failed');
    toast('Synced ' + data.count + ' products', 'ok');
    document.getElementById('catalogStatus').textContent = 'Last synced: ' + fmtCatalogTime(data.syncedAt) + ' — ' + data.count + ' products';
    loadCatalogProducts();
  } catch (e) { toast('Sync failed: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '&#128260; Sync Now'; }
}

var catalogProductsCache = [];

function renderCatalogTable(products) {
  var el = document.getElementById('catalogProductsTable');
  if (!products.length) {
    el.innerHTML = '<div class="tbl-empty"><div>&#128230;</div><p>No products found.</p></div>';
    return;
  }
  var rows = products.map(function(p) {
    return '<tr><td class="nowrap">' + clientEsc(p.category || '') + '</td>' +
      '<td><strong>' + clientEsc(p.name) + '</strong></td>' +
      '<td class="nowrap">KShs ' + Number(p.price).toLocaleString('en-KE') + '</td>' +
      '<td class="mono nowrap">' + clientEsc(p.retailer_id) + '</td>' +
      '<td class="nowrap">' + clientEsc(p.availability || '') + '</td></tr>';
  }).join('');
  el.innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Category</th><th>Name</th><th>Price</th><th>Retailer ID</th><th>Availability</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function filterCatalogProducts(query) {
  query = query.trim().toLowerCase();
  if (!query) { renderCatalogTable(catalogProductsCache); return; }
  var filtered = catalogProductsCache.filter(function(p) {
    return (p.name || '').toLowerCase().indexOf(query) !== -1 || (p.category || '').toLowerCase().indexOf(query) !== -1;
  });
  renderCatalogTable(filtered);
}

async function loadCatalogProducts() {
  var el = document.getElementById('catalogProductsTable');
  try {
    var r = await fetch('/admin/api/catalog/products');
    catalogProductsCache = await r.json();
    var countEl = document.getElementById('catalogTabCount');
    if (countEl) countEl.textContent = catalogProductsCache.length;
    if (!catalogProductsCache.length) {
      el.innerHTML = '<div class="tbl-empty"><div>&#128230;</div><p>No products synced yet — enter a feed URL above and click Sync Now.</p></div>';
      return;
    }
    var searchBox = document.getElementById('catalogSearch');
    if (searchBox && searchBox.value.trim()) filterCatalogProducts(searchBox.value);
    else renderCatalogTable(catalogProductsCache);
  } catch (e) {
    el.innerHTML = '<div class="tbl-empty"><div>&#9888;&#65039;</div><p>Failed to load products.</p></div>';
  }
}

function openChat(pid) {
  document.querySelectorAll('.wa-contact').forEach(function(c){c.classList.remove('active')});
  var contact = document.getElementById('contact-' + pid);
  if (contact) {
    contact.classList.add('active');
    var dot = contact.querySelector('.wa-unread-dot');
    if (dot) { dot.remove(); updateTabTitle(); }
  }

  document.querySelectorAll('.wa-chat').forEach(function(c){c.classList.remove('wa-active')});
  document.getElementById('wa-no-chat').style.display = 'none';
  var chat = document.getElementById('chat-' + pid);
  if (chat) {
    chat.classList.add('wa-active');
    if (chat.dataset.phone) fetchNewMessages(pid, chat.dataset.phone, false);
  }
  activeChat = pid;

  var msgs = document.getElementById('chatmsgs-' + pid);
  if (msgs) setTimeout(function(){ msgs.scrollTop = msgs.scrollHeight; }, 120);

  if (window.innerWidth <= 768) {
    document.getElementById('wa-left').classList.add('wa-hidden');
  }
}

function backToContacts() {
  document.querySelectorAll('.wa-chat').forEach(function(c){c.classList.remove('wa-active')});
  document.getElementById('wa-no-chat').style.display = 'flex';
  document.getElementById('wa-left').classList.remove('wa-hidden');
  activeChat = null;
}

function filterContacts(q) {
  var query       = q.toLowerCase();
  var activeDomain = (document.querySelector('.wa-filt.wa-filt-active') || {id:'filt-all'}).id.replace('filt-','');
  document.querySelectorAll('.wa-contact').forEach(function(c) {
    var phone   = (c.dataset.phone || '').toLowerCase();
    var preview = (c.querySelector('.wa-ct-prev') ? c.querySelector('.wa-ct-prev').textContent : '').toLowerCase();
    var domain  = c.dataset.domain || 'general';
    var matchSearch = query === '' || phone.includes(query) || preview.includes(query);
    var matchDomain = activeDomain === 'all' || domain === activeDomain;
    c.style.display = (matchSearch && matchDomain) ? '' : 'none';
  });
}

function filterDomain(domain) {
  document.querySelectorAll('.wa-filt').forEach(function(b){b.classList.remove('wa-filt-active')});
  var btn = document.getElementById('filt-'+domain);
  if (btn) btn.classList.add('wa-filt-active');
  var search = document.querySelector('.wa-search input');
  filterContacts(search ? search.value : '');
}

function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function toast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast' + (type === 'ok' ? ' ok' : type === 'err' ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(function(){
    el.style.animation = 'toastOut .3s ease forwards';
    setTimeout(function(){ el.remove(); }, 300);
  }, 3000);
}

function toggleNotes(el) {
  el.classList.toggle('expanded');
}
function copyToClipboard(btn) {
  var text = btn.dataset.copy || '';
  if (!text) return;
  navigator.clipboard.writeText(text).then(function () {
    toast('Copied to clipboard', 'ok');
  }).catch(function () {
    toast('Could not copy — select and copy manually', 'err');
  });
}

function openAddLeadModal() {
  document.getElementById('al-title').textContent = 'Add Lead';
  document.getElementById('al-submit').textContent = 'Save Lead';
  document.getElementById('addLeadOverlay').style.display = 'flex';
}
function openEditLeadModal(btn) {
  document.getElementById('al-title').textContent = 'Edit Lead';
  document.getElementById('al-submit').textContent = 'Save Changes';
  document.getElementById('al-id').value = btn.dataset.id;
  document.getElementById('al-name').value = btn.dataset.name || '';
  document.getElementById('al-phone').value = btn.dataset.phone || '';
  document.getElementById('al-service').value = btn.dataset.service || 'solar';
  document.getElementById('al-location').value = btn.dataset.location || '';
  document.getElementById('al-property').value = btn.dataset.property || 'residential';
  document.getElementById('al-budget').value = btn.dataset.budget || '';
  document.getElementById('al-notes').value = btn.dataset.notes || '';
  document.getElementById('addLeadOverlay').style.display = 'flex';
}
function closeAddLeadModal() {
  document.getElementById('addLeadOverlay').style.display = 'none';
  document.getElementById('addLeadForm').reset();
  document.getElementById('al-id').value = '';
}
async function submitAddLead(event) {
  event.preventDefault();
  var btn = document.getElementById('al-submit');
  var leadId = document.getElementById('al-id').value;
  var payload = {
    name: document.getElementById('al-name').value.trim(),
    phone: document.getElementById('al-phone').value.trim(),
    service: document.getElementById('al-service').value,
    location: document.getElementById('al-location').value.trim(),
    property_type: document.getElementById('al-property').value,
    estimated_budget: document.getElementById('al-budget').value.trim(),
    notes: document.getElementById('al-notes').value.trim(),
  };
  if (!payload.name || !payload.phone) { toast('Name and phone are required', 'err'); return; }
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    var url = leadId ? '/admin/api/leads/' + leadId + '/update' : '/admin/api/leads';
    var r = await fetch(url, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast(leadId ? 'Lead updated' : 'Lead added', 'ok');
    location.reload();
  } catch (err) {
    toast('Could not add lead: ' + err.message, 'err');
    btn.disabled = false; btn.textContent = leadId ? 'Save Changes' : 'Save Lead';
  }
}

function updateTankCapacityOptions() {
  var type = document.getElementById('tq-tanktype').value;
  var sel = document.getElementById('tq-capacity');
  var countInput = document.getElementById('tq-count');
  var opts = type === 'plastic'
    ? [['10000L', '10,000L']]
    : [['24m3', '24m³'], ['48m3', '48m³'], ['50m3', '50m³'], ['100m3', '100m³']];
  sel.innerHTML = opts.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('');
  // Standard steel tower packages are all built with a single large tank — locking this to 1
  // avoids silently falling into the "custom configuration" fallback (blank fabrication cost)
  // just because the count field was left at its plastic-tank default.
  if (type === 'steel') {
    countInput.value = '1';
    countInput.readOnly = true;
    countInput.title = 'Steel towers are built with a single large tank';
    countInput.style.background = '#f1f5f9';
  } else {
    countInput.readOnly = false;
    countInput.title = '';
    countInput.style.background = '';
  }
}
function openTowerQuoteModal(btn) {
  document.getElementById('tq-client').value = btn.dataset.name || '';
  document.getElementById('tq-phone').value = btn.dataset.phone || '';
  document.getElementById('tq-project').value = (btn.dataset.location ? btn.dataset.location + ' - ' : '') + 'Water Tower';
  document.getElementById('tq-location').value = btn.dataset.location || '';
  document.getElementById('tq-ref').value = 'QT-' + String(Date.now()).slice(-6);
  document.getElementById('tq-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('tq-height').value = '6';
  document.getElementById('tq-count').value = '2';
  document.getElementById('tq-tanktype').value = 'plastic';
  document.getElementById('tq-transport').value = '';
  document.getElementById('tq-vat-included').checked = true;
  updateTankCapacityOptions();
  document.getElementById('towerQuoteOverlay').style.display = 'flex';
}
function closeTowerQuoteModal() {
  document.getElementById('towerQuoteOverlay').style.display = 'none';
}
function tqParams() {
  return {
    client: document.getElementById('tq-client').value.trim(),
    project: document.getElementById('tq-project').value.trim(),
    siteLocation: document.getElementById('tq-location').value.trim(),
    quoteRef: document.getElementById('tq-ref').value.trim(),
    date: document.getElementById('tq-date').value,
    towerHeightM: document.getElementById('tq-height').value,
    tankCount: document.getElementById('tq-count').value,
    tankType: document.getElementById('tq-tanktype').value,
    tankCapacity: document.getElementById('tq-capacity').value,
    transportCost: document.getElementById('tq-transport').value.trim(),
    vatIncluded: document.getElementById('tq-vat-included').checked,
  };
}
function downloadTowerQuote() {
  var p = tqParams();
  if (!p.client) { toast('Client name is required', 'err'); return; }
  var qs = new URLSearchParams(p).toString();
  window.open('/admin/api/quotes/tower/download?' + qs, '_blank');
}
async function sendTowerQuote() {
  var p = tqParams();
  var phone = document.getElementById('tq-phone').value.trim();
  if (!p.client || !phone) { toast('Client name and phone are required to send', 'err'); return; }
  var btn = document.getElementById('tq-send-btn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    var r = await fetch('/admin/api/quotes/tower/send/' + encodeURIComponent(phone), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, p, { caption: 'Your water tower quotation from Waterlift Solar' })),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Quote sent to customer', 'ok');
    closeTowerQuoteModal();
  } catch (err) {
    toast('Could not send quote: ' + err.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Send via WhatsApp';
  }
}

// ── Drilling pricing settings/presets/line-items (Drilling Pricing tab) ─────────

async function saveDrillingSetting(key) {
  var value = document.getElementById('ds-value-' + key).value;
  if (value === '') { toast('Value is required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/drilling-pricing/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, value: value }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Setting updated', 'ok');
  } catch (err) { toast('Could not save: ' + err.message, 'err'); }
}

function openPenetrationRateModal(btn) {
  document.getElementById('pr-title').textContent = btn ? 'Edit Penetration Rate Preset' : 'Add Penetration Rate Preset';
  document.getElementById('pr-submit').textContent = 'Save';
  document.getElementById('pr-id').value = btn ? btn.dataset.id : '';
  document.getElementById('pr-label').value = btn ? btn.dataset.label : '';
  document.getElementById('pr-minutes').value = btn ? btn.dataset.minutes : '';
  document.getElementById('pr-rodlength').value = btn ? btn.dataset.rodlength : '5';
  document.getElementById('penetrationRateOverlay').style.display = 'flex';
}
function closePenetrationRateModal() {
  document.getElementById('penetrationRateOverlay').style.display = 'none';
}
async function submitPenetrationRate() {
  var id = document.getElementById('pr-id').value;
  var payload = {
    label: document.getElementById('pr-label').value.trim(),
    minutes_per_rod: document.getElementById('pr-minutes').value,
    rod_length_m: document.getElementById('pr-rodlength').value,
  };
  if (!payload.label || !payload.minutes_per_rod || !payload.rod_length_m) { toast('All fields are required', 'err'); return; }
  var btn = document.getElementById('pr-submit');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    var r = await fetch('/admin/api/drilling-pricing/penetration-rates' + (id ? '/' + id : ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast(id ? 'Preset updated' : 'Preset added', 'ok');
    location.reload();
  } catch (err) {
    toast('Could not save: ' + err.message, 'err');
    btn.disabled = false; btn.textContent = 'Save';
  }
}
async function deletePenetrationRate(id) {
  if (!confirm('Delete this penetration rate preset?')) return;
  try {
    var r = await fetch('/admin/api/drilling-pricing/penetration-rates/' + id + '/delete', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Preset deleted', 'ok');
    location.reload();
  } catch (err) { toast('Could not delete: ' + err.message, 'err'); }
}

function openLineItemModal(btn, category) {
  document.getElementById('li-title').textContent = btn ? 'Edit Line Item' : 'Add Line Item';
  document.getElementById('li-submit').textContent = 'Save';
  document.getElementById('li-id').value = btn ? btn.dataset.id : '';
  document.getElementById('li-category').value = btn ? btn.dataset.category : (category || 'consumable');
  document.getElementById('li-name').value = btn ? btn.dataset.name : '';
  document.getElementById('li-qty').value = btn ? btn.dataset.qty : '1';
  document.getElementById('li-rate').value = btn ? btn.dataset.rate : '';
  document.getElementById('lineItemOverlay').style.display = 'flex';
}
function closeLineItemModal() {
  document.getElementById('lineItemOverlay').style.display = 'none';
}
async function submitLineItem() {
  var id = document.getElementById('li-id').value;
  var payload = {
    category: document.getElementById('li-category').value,
    name: document.getElementById('li-name').value.trim(),
    default_qty: document.getElementById('li-qty').value,
    default_rate: document.getElementById('li-rate').value,
  };
  if (!payload.name || payload.default_qty === '' || payload.default_rate === '') { toast('All fields are required', 'err'); return; }
  var btn = document.getElementById('li-submit');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    var r = await fetch('/admin/api/drilling-pricing/line-items' + (id ? '/' + id : ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast(id ? 'Line item updated' : 'Line item added', 'ok');
    location.reload();
  } catch (err) {
    toast('Could not save: ' + err.message, 'err');
    btn.disabled = false; btn.textContent = 'Save';
  }
}
async function deleteLineItem(id) {
  if (!confirm('Delete this line item?')) return;
  try {
    var r = await fetch('/admin/api/drilling-pricing/line-items/' + id + '/delete', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Line item deleted', 'ok');
    location.reload();
  } catch (err) { toast('Could not delete: ' + err.message, 'err'); }
}

// ── Drilling Quote modal ─────────────────────────────────────────────────────

var drillingPricingCache = null;

function consumableRowHTML(item) {
  var safeName = item.name.replace(/"/g, '&quot;');
  return '<div class="dq-item-row" data-name="' + safeName + '">' +
    '<span>' + item.name.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>' +
    '<input type="number" step="0.001" class="dq-c-qty" value="' + item.default_qty + '">' +
    '<input type="number" step="0.01" class="dq-c-rate" value="' + item.default_rate + '">' +
    '</div>';
}
function renderConsumableRows(items) {
  document.getElementById('dq-consumables').innerHTML = items.map(consumableRowHTML).join('');
}
function appendConsumableRow(item) {
  document.getElementById('dq-consumables').insertAdjacentHTML('beforeend', consumableRowHTML(item));
}

function mobilizationRowHTML(item) {
  var checked = Number(item.default_qty) > 0 ? 'checked' : '';
  return '<div class="dq-mob-row" data-name="' + item.name.replace(/"/g, '&quot;') + '">' +
    '<input type="checkbox" class="dq-m-included" ' + checked + '>' +
    '<span>' + item.name.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>' +
    '<input type="number" step="0.001" class="dq-m-qty" value="' + item.default_qty + '">' +
    '<input type="number" step="0.01" class="dq-m-rate" value="' + item.default_rate + '">' +
    '</div>';
}
function renderMobilizationRows(containerId, items) {
  document.getElementById(containerId).innerHTML = items.map(mobilizationRowHTML).join('');
}
function appendMobilizationRow(containerId, item) {
  document.getElementById(containerId).insertAdjacentHTML('beforeend', mobilizationRowHTML(item));
}

function collectRowItems(containerId, isMobilization) {
  var rows = document.querySelectorAll('#' + containerId + ' .' + (isMobilization ? 'dq-mob-row' : 'dq-item-row'));
  var out = [];
  rows.forEach(function (row) {
    var item = {
      name: row.dataset.name,
      qty: Number(row.querySelector(isMobilization ? '.dq-m-qty' : '.dq-c-qty').value),
      rate: Number(row.querySelector(isMobilization ? '.dq-m-rate' : '.dq-c-rate').value),
    };
    if (isMobilization) item.included = row.querySelector('.dq-m-included').checked;
    out.push(item);
  });
  return out;
}

function toggleDrillingRateMethod() {
  var direct = document.getElementById('dq-method-direct').checked;
  document.getElementById('dq-direct-section').style.display = direct ? '' : 'none';
  document.querySelectorAll('.dq-costing-only').forEach(function (el) {
    el.style.display = direct ? 'none' : '';
  });
}

function toggleMobilizationMethod() {
  var direct = document.getElementById('dq-mobmethod-direct').checked;
  document.getElementById('dq-mob-direct-section').style.display = direct ? '' : 'none';
  document.querySelectorAll('.dq-mob-calc-only').forEach(function (el) {
    el.style.display = direct ? 'none' : '';
  });
}

async function openDrillingQuoteModal(btn) {
  document.getElementById('dq-client').value = btn ? (btn.dataset.name || '') : '';
  document.getElementById('dq-phone').value = btn ? (btn.dataset.phone || '') : '';
  document.getElementById('dq-location').value = btn ? (btn.dataset.location || '') : '';
  document.getElementById('dq-ref').value = 'DQ-' + String(Date.now()).slice(-6);
  document.getElementById('dq-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('dq-preparedby').value = '';
  document.getElementById('dq-reviewedby').value = '';
  document.getElementById('dq-approvedby').value = '';
  document.getElementById('dq-method-costing').checked = true;
  document.getElementById('dq-directrate').value = '';
  toggleDrillingRateMethod();
  document.getElementById('dq-mobmethod-calc').checked = true;
  document.getElementById('dq-mob-directtotal').value = '';
  toggleMobilizationMethod();
  document.getElementById('dq-preview').style.display = 'none';
  document.getElementById('drillingQuoteOverlay').style.display = 'flex';

  try {
    var r = await fetch('/admin/api/drilling-pricing');
    if (!r.ok) throw new Error('Failed to load drilling pricing');
    var data = await r.json();
    drillingPricingCache = data;
    var s = data.settings;

    var sel = document.getElementById('dq-penetration');
    sel.innerHTML = data.penetrationRates.map(function (p) {
      return '<option value="' + p.id + '">' + p.label + '</option>';
    }).join('');

    document.getElementById('dq-flushing').value = s.flushing_fuel_litres_default;
    document.getElementById('dq-rigfuel').value = s.rig_fuel_litres_default;
    document.getElementById('dq-testfuel').value = s.test_pumping_fuel_litres_default;
    document.getElementById('dq-fuelrate').value = s.fuel_rate_per_litre;
    document.getElementById('dq-casingrate').value = s.casing_rate_per_metre;
    document.getElementById('dq-deduction').value = s.drilling_rate_deduction;
    document.getElementById('dq-surfacerate').value = s.surface_casing_rate;
    document.getElementById('dq-surfaceincluded').checked = false;
    document.getElementById('dq-graveltonnes').value = s.gravel_tonnes_per_metre;
    document.getElementById('dq-bagsize').value = s.gravel_bag_size_kg;
    document.getElementById('dq-bagrate').value = s.gravel_rate_per_bag;
    document.getElementById('dq-rig-ctarmac').value = s.fuel_consumption_tarmac_km_per_l;
    document.getElementById('dq-rig-crough').value = s.fuel_consumption_rough_km_per_l;
    document.getElementById('dq-truck-ctarmac').value = s.fuel_consumption_tarmac_km_per_l;
    document.getElementById('dq-truck-crough').value = s.fuel_consumption_rough_km_per_l;
    document.getElementById('dq-testpump-ctarmac').value = s.fuel_consumption_tarmac_km_per_l;
    document.getElementById('dq-testpump-crough').value = s.fuel_consumption_rough_km_per_l;
    document.getElementById('dq-vat').value = s.vat_rate_pct;
    document.getElementById('dq-depositpct').value = s.payment_deposit_pct;
    document.getElementById('dq-testpumpflat').value = s.payment_before_test_pumping_flat;

    renderConsumableRows(data.consumables);
    renderMobilizationRows('dq-mob-rig', data.mobilization);
    renderMobilizationRows('dq-mob-truck', data.mobilization);
    renderMobilizationRows('dq-mob-testpump', data.mobilization);
  } catch (err) {
    toast('Could not load drilling pricing defaults: ' + err.message, 'err');
  }
}

function closeDrillingQuoteModal() {
  document.getElementById('drillingQuoteOverlay').style.display = 'none';
}

// Quick-add controls inside the Drilling Quote modal itself — persist to Drilling Pricing
// (so future quotes see them too) and drop straight into this quote's form, no reload/reopen needed.
async function addNewConsumable() {
  var name = document.getElementById('dq-new-consumable-name').value.trim();
  var qty = document.getElementById('dq-new-consumable-qty').value;
  var rate = document.getElementById('dq-new-consumable-rate').value;
  if (!name || qty === '' || rate === '') { toast('Name, qty and rate are required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/drilling-pricing/line-items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'consumable', name: name, default_qty: qty, default_rate: rate }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    appendConsumableRow({ name: name, default_qty: qty, default_rate: rate });
    document.getElementById('dq-new-consumable-name').value = '';
    document.getElementById('dq-new-consumable-qty').value = '1';
    document.getElementById('dq-new-consumable-rate').value = '';
    toast('Consumable added to this quote and saved to Drilling Pricing', 'ok');
  } catch (err) { toast('Could not add consumable: ' + err.message, 'err'); }
}

async function addNewMobilizationCost() {
  var name = document.getElementById('dq-new-mob-name').value.trim();
  var qty = document.getElementById('dq-new-mob-qty').value;
  var rate = document.getElementById('dq-new-mob-rate').value;
  if (!name || qty === '' || rate === '') { toast('Name, qty and rate are required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/drilling-pricing/line-items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'mobilization', name: name, default_qty: qty, default_rate: rate }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    appendMobilizationRow('dq-mob-rig', { name: name, default_qty: qty, default_rate: rate });
    appendMobilizationRow('dq-mob-truck', { name: name, default_qty: qty, default_rate: rate });
    appendMobilizationRow('dq-mob-testpump', { name: name, default_qty: qty, default_rate: rate });
    document.getElementById('dq-new-mob-name').value = '';
    document.getElementById('dq-new-mob-qty').value = '1';
    document.getElementById('dq-new-mob-rate').value = '';
    toast('Mobilization cost added to this quote and saved to Drilling Pricing', 'ok');
  } catch (err) { toast('Could not add mobilization cost: ' + err.message, 'err'); }
}

async function addNewPenetrationRate() {
  var label = document.getElementById('dq-new-pr-label').value.trim();
  var minutes = document.getElementById('dq-new-pr-minutes').value;
  var rodlength = document.getElementById('dq-new-pr-rodlength').value;
  if (!label || minutes === '' || rodlength === '') { toast('Label, minutes/rod and rod length are required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/drilling-pricing/penetration-rates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label, minutes_per_rod: minutes, rod_length_m: rodlength }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    var created = await r.json();
    var sel = document.getElementById('dq-penetration');
    var opt = document.createElement('option');
    opt.value = created.id;
    opt.textContent = label;
    sel.appendChild(opt);
    sel.value = created.id;
    document.getElementById('dq-new-pr-label').value = '';
    document.getElementById('dq-new-pr-minutes').value = '';
    document.getElementById('dq-new-pr-rodlength').value = '5';
    toast('Penetration rate preset added and selected for this quote', 'ok');
  } catch (err) { toast('Could not add preset: ' + err.message, 'err'); }
}

function buildDrillingPayload() {
  var penSelect = document.getElementById('dq-penetration');
  var isDirect = document.getElementById('dq-method-direct').checked;
  var isMobDirect = document.getElementById('dq-mobmethod-direct').checked;
  return {
    client: document.getElementById('dq-client').value.trim(),
    location: document.getElementById('dq-location').value.trim(),
    quoteRef: document.getElementById('dq-ref').value.trim(),
    date: document.getElementById('dq-date').value,
    depthM: Number(document.getElementById('dq-depth').value),
    directDrillingRate: isDirect ? Number(document.getElementById('dq-directrate').value) : undefined,
    penetrationRateId: penSelect.value ? Number(penSelect.value) : undefined,
    flushingFuelLitres: Number(document.getElementById('dq-flushing').value),
    rigFuelLitres: Number(document.getElementById('dq-rigfuel').value),
    testPumpingFuelLitres: Number(document.getElementById('dq-testfuel').value),
    fuelRatePerLitre: Number(document.getElementById('dq-fuelrate').value),
    casingRatePerMetre: Number(document.getElementById('dq-casingrate').value),
    drillingRateDeduction: Number(document.getElementById('dq-deduction').value),
    surfaceCasingIncluded: document.getElementById('dq-surfaceincluded').checked,
    surfaceCasingRate: Number(document.getElementById('dq-surfacerate').value),
    gravelTonnesPerMetre: Number(document.getElementById('dq-graveltonnes').value),
    gravelBagSizeKg: Number(document.getElementById('dq-bagsize').value),
    gravelRatePerBag: Number(document.getElementById('dq-bagrate').value),
    consumables: collectRowItems('dq-consumables', false),
    directMobilizationTotal: isMobDirect ? Number(document.getElementById('dq-mob-directtotal').value) : undefined,
    mobilizationRig: {
      tarmacKm: Number(document.getElementById('dq-rig-tarmac').value || 0),
      roughKm: Number(document.getElementById('dq-rig-rough').value || 0),
      consumptionTarmacKmPerL: Number(document.getElementById('dq-rig-ctarmac').value),
      consumptionRoughKmPerL: Number(document.getElementById('dq-rig-crough').value),
      fuelRatePerLitre: Number(document.getElementById('dq-fuelrate').value),
      associatedCosts: collectRowItems('dq-mob-rig', true),
    },
    mobilizationTruck: {
      tarmacKm: Number(document.getElementById('dq-truck-tarmac').value || 0),
      roughKm: Number(document.getElementById('dq-truck-rough').value || 0),
      consumptionTarmacKmPerL: Number(document.getElementById('dq-truck-ctarmac').value),
      consumptionRoughKmPerL: Number(document.getElementById('dq-truck-crough').value),
      fuelRatePerLitre: Number(document.getElementById('dq-fuelrate').value),
      associatedCosts: collectRowItems('dq-mob-truck', true),
    },
    mobilizationTestPumpingUnit: {
      tarmacKm: Number(document.getElementById('dq-testpump-tarmac').value || 0),
      roughKm: Number(document.getElementById('dq-testpump-rough').value || 0),
      consumptionTarmacKmPerL: Number(document.getElementById('dq-testpump-ctarmac').value),
      consumptionRoughKmPerL: Number(document.getElementById('dq-testpump-crough').value),
      fuelRatePerLitre: Number(document.getElementById('dq-fuelrate').value),
      associatedCosts: collectRowItems('dq-mob-testpump', true),
    },
    vatRatePct: Number(document.getElementById('dq-vat').value),
    paymentDepositPct: Number(document.getElementById('dq-depositpct').value),
    paymentBeforeTestPumpingFlat: Number(document.getElementById('dq-testpumpflat').value),
    preparedBy: document.getElementById('dq-preparedby').value.trim(),
    reviewedBy: document.getElementById('dq-reviewedby').value.trim(),
    approvedBy: document.getElementById('dq-approvedby').value.trim(),
  };
}

async function previewDrillingQuote() {
  var payload = buildDrillingPayload();
  if (!payload.depthM) { toast('Borehole depth is required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/quotes/drilling/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    var q = await r.json();
    var el = document.getElementById('dq-preview');
    el.style.display = 'block';
    el.innerHTML =
      (q.isDirectRate ? '<em>Drilling rate entered directly — no costing breakdown computed.</em><br>' : '') +
      '<strong>Drilling rate:</strong> KShs ' + q.drillingRate.toLocaleString() + '/m &mdash; <strong>Amount:</strong> KShs ' + q.drillingAmount.toLocaleString() + '<br>' +
      '<strong>Casing:</strong> ' + q.casingMetres + 'm = KShs ' + q.casingAmount.toLocaleString() + ' (plain ' + q.plainCasingMetres + 'm + screened ' + q.screenedCasingMetres + 'm, same rate)<br>' +
      '<strong>Mobilization total:</strong> KShs ' + q.mobilization.total.toLocaleString() +
        (q.mobilization.isDirect ? ' (entered directly)' : ' (rig ' + q.mobilization.rig.total.toLocaleString() + ' + truck ' + q.mobilization.truck.total.toLocaleString() + ' + test pumping unit ' + q.mobilization.testPumpingUnit.total.toLocaleString() + ')') + '<br>' +
      '<strong>Sub Total:</strong> KShs ' + q.subTotal.toLocaleString() + ' &bull; <strong>VAT:</strong> KShs ' + q.vatAmount.toLocaleString() + '<br>' +
      '<strong style="color:#075E54">Grand Total: KShs ' + q.grandTotal.toLocaleString() + '</strong><br>' +
      '<em>Deposit KShs ' + q.payment.deposit.toLocaleString() + ' &bull; After drilling KShs ' + q.payment.afterDrilling.toLocaleString() + ' &bull; Before test pumping KShs ' + q.payment.beforeTestPumping.toLocaleString() + '</em>';
  } catch (err) { toast('Could not compute preview: ' + err.message, 'err'); }
}

async function downloadDrillingQuote() {
  var payload = buildDrillingPayload();
  if (!payload.client || !payload.depthM) { toast('Client name and depth are required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/quotes/drilling/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    var blob = await r.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = (payload.quoteRef || 'quote') + '.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) { toast('Could not download quote: ' + err.message, 'err'); }
}

async function downloadDrillingCostingCSV() {
  var payload = buildDrillingPayload();
  if (!payload.depthM) { toast('Borehole depth is required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/quotes/drilling/costing.csv', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    var blob = await r.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = (payload.quoteRef || 'costing') + '-costing.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) { toast('Could not download costing sheet: ' + err.message, 'err'); }
}

async function sendDrillingQuote() {
  var payload = buildDrillingPayload();
  var phone = document.getElementById('dq-phone').value.trim();
  if (!payload.client || !phone || !payload.depthM) { toast('Client name, phone, and depth are required to send', 'err'); return; }
  var btn = document.getElementById('dq-send-btn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    var r = await fetch('/admin/api/quotes/drilling/send/' + encodeURIComponent(phone), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, payload, { caption: 'Your borehole drilling quotation from Waterlift Solar' })),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Quote sent to customer', 'ok');
    closeDrillingQuoteModal();
  } catch (err) {
    toast('Could not send quote: ' + err.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Send via WhatsApp';
  }
}

// ── Solar Quote modal ────────────────────────────────────────────────────────

var solarPricingCache = null;

function renderSolarItemRow(item) {
  var name = (item && item.name) || '';
  var category = (item && item.category) || 'taxable';
  var qty = item && item.qty !== undefined ? item.qty : (item && item.default_qty !== undefined ? item.default_qty : 1);
  var rate = item && item.rate !== undefined ? item.rate : (item && item.default_rate !== undefined ? item.default_rate : 0);
  var safeName = String(name).replace(/"/g, '&quot;');
  return '<div class="sq-item-row">' +
    '<input type="text" class="sq-name" value="' + safeName + '">' +
    '<select class="sq-category">' +
      '<option value="exempt"' + (category === 'exempt' ? ' selected' : '') + '>VAT-exempt</option>' +
      '<option value="taxable"' + (category === 'taxable' ? ' selected' : '') + '>Taxable</option>' +
    '</select>' +
    '<input type="number" step="0.001" class="sq-qty" value="' + qty + '">' +
    '<input type="number" step="0.01" class="sq-rate" value="' + rate + '">' +
    '<span class="sq-remove" onclick="this.parentElement.remove()" title="Remove row">&times;</span>' +
    '</div>';
}

function renderSolarItemRows(items) {
  document.getElementById('sq-items').innerHTML = items.map(renderSolarItemRow).join('');
}

function addSolarItemRow() {
  document.getElementById('sq-items').insertAdjacentHTML('beforeend', renderSolarItemRow(null));
}

function collectSolarItems() {
  var rows = document.querySelectorAll('#sq-items .sq-item-row');
  var out = [];
  rows.forEach(function (row) {
    var name = row.querySelector('.sq-name').value.trim();
    if (!name) return;
    out.push({
      name: name,
      category: row.querySelector('.sq-category').value,
      qty: Number(row.querySelector('.sq-qty').value),
      rate: Number(row.querySelector('.sq-rate').value),
    });
  });
  return out;
}

function loadSolarTierItems() {
  if (!solarPricingCache) return;
  var tierKey = document.getElementById('sq-tier').value;
  var tier = solarPricingCache.tiers.find(function (t) { return t.tier_key === tierKey; });
  var items = solarPricingCache.lineItems.filter(function (li) { return li.tier_key === tierKey; });
  renderSolarItemRows(items);
  if (tier) document.getElementById('sq-label').value = tier.label.toUpperCase() + ' SYSTEM';
}

async function openSolarQuoteModal(btn) {
  document.getElementById('sq-client').value = btn ? (btn.dataset.name || '') : '';
  document.getElementById('sq-phone').value = btn ? (btn.dataset.phone || '') : '';
  document.getElementById('sq-project').value = 'Solar Power Installation';
  document.getElementById('sq-ref').value = 'SS-' + String(Date.now()).slice(-6);
  document.getElementById('sq-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('sq-preparedby').value = '';
  document.getElementById('sq-reviewedby').value = '';
  document.getElementById('sq-approvedby').value = '';
  document.getElementById('sq-vat-included').checked = true;
  document.getElementById('sq-preview').style.display = 'none';
  document.getElementById('solarQuoteOverlay').style.display = 'flex';

  try {
    var r = await fetch('/admin/api/solar-pricing');
    if (!r.ok) throw new Error('Failed to load solar pricing');
    solarPricingCache = await r.json();
    var sel = document.getElementById('sq-tier');
    sel.innerHTML = solarPricingCache.tiers.map(function (t) {
      return '<option value="' + t.tier_key + '">' + t.label + '</option>';
    }).join('');
    loadSolarTierItems();
  } catch (err) {
    toast('Could not load solar pricing defaults: ' + err.message, 'err');
  }
}

function closeSolarQuoteModal() {
  document.getElementById('solarQuoteOverlay').style.display = 'none';
}

function buildSolarPayload() {
  var vatIncluded = document.getElementById('sq-vat-included').checked;
  return {
    client: document.getElementById('sq-client').value.trim(),
    project: document.getElementById('sq-project').value.trim(),
    quoteRef: document.getElementById('sq-ref').value.trim(),
    date: document.getElementById('sq-date').value,
    tierKey: document.getElementById('sq-tier').value,
    systemLabel: document.getElementById('sq-label').value.trim(),
    items: collectSolarItems(),
    // Omitting vatRatePct entirely (undefined) lets the backend fall back to the admin-configured
    // default rate — only force it to 0 when VAT is explicitly excluded for this quote.
    vatRatePct: vatIncluded ? undefined : 0,
    preparedBy: document.getElementById('sq-preparedby').value.trim(),
    reviewedBy: document.getElementById('sq-reviewedby').value.trim(),
    approvedBy: document.getElementById('sq-approvedby').value.trim(),
  };
}

async function previewSolarQuote() {
  var payload = buildSolarPayload();
  if (!payload.items.length) { toast('Add at least one line item', 'err'); return; }
  try {
    var r = await fetch('/admin/api/quotes/solar/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    var q = await r.json();
    var el = document.getElementById('sq-preview');
    el.style.display = 'block';
    el.innerHTML =
      '<strong>Sub Total:</strong> KShs ' + q.subTotal.toLocaleString() + ' &bull; ' +
      (q.vatRatePct > 0
        ? '<strong>VAT on Non-Solar (' + q.vatRatePct + '%):</strong> KShs ' + q.vatAmount.toLocaleString()
        : '<em>VAT excluded</em>') + '<br>' +
      '<strong style="color:#075E54">Total: KShs ' + q.grandTotal.toLocaleString() + '</strong>';
  } catch (err) { toast('Could not compute preview: ' + err.message, 'err'); }
}

async function downloadSolarQuote() {
  var payload = buildSolarPayload();
  if (!payload.client || !payload.items.length) { toast('Client name and at least one line item are required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/quotes/solar/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    var blob = await r.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = (payload.quoteRef || 'quote') + '.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) { toast('Could not download quote: ' + err.message, 'err'); }
}

async function sendSolarQuote() {
  var payload = buildSolarPayload();
  var phone = document.getElementById('sq-phone').value.trim();
  if (!payload.client || !phone || !payload.items.length) { toast('Client name, phone, and at least one line item are required to send', 'err'); return; }
  var btn = document.getElementById('sq-send-btn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    var r = await fetch('/admin/api/quotes/solar/send/' + encodeURIComponent(phone), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, payload, { caption: 'Your solar system quotation from Waterlift Solar' })),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Quote sent to customer', 'ok');
    closeSolarQuoteModal();
  } catch (err) {
    toast('Could not send quote: ' + err.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Send via WhatsApp';
  }
}

// ── Solar Pricing tab (tier templates) ───────────────────────────────────────

async function saveSolarSetting(key) {
  var value = document.getElementById('ss-value-' + key).value;
  try {
    var r = await fetch('/admin/api/solar-pricing/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, value: value }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Setting saved', 'ok');
  } catch (err) { toast('Could not save setting: ' + err.message, 'err'); }
}

function openSolarTierModal(btn) {
  document.getElementById('st-title').textContent = btn ? 'Edit kVA Tier' : 'Add kVA Tier';
  document.getElementById('st-key').value = btn ? btn.dataset.key : '';
  document.getElementById('st-keyinput').value = btn ? btn.dataset.key : '';
  document.getElementById('st-keyinput').disabled = !!btn;
  document.getElementById('st-label').value = btn ? btn.dataset.label : '';
  document.getElementById('st-sort').value = btn ? btn.dataset.sort : '0';
  document.getElementById('solarTierOverlay').style.display = 'flex';
}
function closeSolarTierModal() { document.getElementById('solarTierOverlay').style.display = 'none'; }

async function submitSolarTier() {
  var tierKey = document.getElementById('st-key').value || document.getElementById('st-keyinput').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  var label = document.getElementById('st-label').value.trim();
  if (!tierKey || !label) { toast('Tier key and label are required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/solar-pricing/tiers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier_key: tierKey, label: label, sort_order: Number(document.getElementById('st-sort').value || 0) }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    location.reload();
  } catch (err) { toast('Could not save tier: ' + err.message, 'err'); }
}

async function deleteSolarTier(tierKey) {
  if (!confirm('Delete this tier and all its line items?')) return;
  try {
    var r = await fetch('/admin/api/solar-pricing/tiers/' + encodeURIComponent(tierKey) + '/delete', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    location.reload();
  } catch (err) { toast('Could not delete tier: ' + err.message, 'err'); }
}

function openSolarLineItemModal(btn, tierKey) {
  document.getElementById('sli-title').textContent = btn ? 'Edit Line Item' : 'Add Line Item';
  document.getElementById('sli-id').value = btn ? btn.dataset.id : '';
  document.getElementById('sli-tier').value = btn ? btn.dataset.tier : tierKey;
  document.getElementById('sli-name').value = btn ? btn.dataset.name : '';
  document.getElementById('sli-category').value = btn ? btn.dataset.category : 'taxable';
  document.getElementById('sli-qty').value = btn ? btn.dataset.qty : '1';
  document.getElementById('sli-rate').value = btn ? btn.dataset.rate : '';
  document.getElementById('solarLineItemOverlay').style.display = 'flex';
}
function closeSolarLineItemModal() { document.getElementById('solarLineItemOverlay').style.display = 'none'; }

async function submitSolarLineItem() {
  var id = document.getElementById('sli-id').value;
  var payload = {
    tier_key: document.getElementById('sli-tier').value,
    category: document.getElementById('sli-category').value,
    name: document.getElementById('sli-name').value.trim(),
    default_qty: Number(document.getElementById('sli-qty').value),
    default_rate: Number(document.getElementById('sli-rate').value),
  };
  if (!payload.name) { toast('Name is required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/solar-pricing/line-items' + (id ? '/' + id : ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    location.reload();
  } catch (err) { toast('Could not save line item: ' + err.message, 'err'); }
}

async function deleteSolarLineItem(id) {
  if (!confirm('Delete this line item?')) return;
  try {
    var r = await fetch('/admin/api/solar-pricing/line-items/' + id + '/delete', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    location.reload();
  } catch (err) { toast('Could not delete line item: ' + err.message, 'err'); }
}

function toggleSolarTier(tierKey, headingEl) {
  var box = document.getElementById('solar-tier-items-' + tierKey);
  var arrow = headingEl.querySelector('.solar-tier-arrow');
  var open = box.style.display !== 'none';
  box.style.display = open ? 'none' : '';
  arrow.classList.toggle('open', !open);
}

async function saveTowerFoundation(foundationType) {
  var price = document.getElementById('tf-price-' + foundationType).value;
  if (!price) { toast('Price is required', 'err'); return; }
  try {
    var r = await fetch('/admin/api/tower-pricing/foundation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foundation_type: foundationType, price: price }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Foundation price updated', 'ok');
    location.reload();
  } catch (err) { toast('Could not save: ' + err.message, 'err'); }
}

function openFoundationModal() {
  document.getElementById('fo-type').value = '';
  document.getElementById('fo-price').value = '';
  document.getElementById('foundationOverlay').style.display = 'flex';
}
function closeFoundationModal() {
  document.getElementById('foundationOverlay').style.display = 'none';
}
async function submitFoundation() {
  // Slugify the same way Solar tier keys already do — this becomes both the DB primary key and
  // part of an HTML element id elsewhere on the page, so keep it to plain lowercase/digits.
  var foundationType = document.getElementById('fo-type').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  var price = document.getElementById('fo-price').value;
  if (!foundationType || !price) { toast('Foundation type and price are required', 'err'); return; }
  var btn = document.getElementById('fo-submit');
  btn.disabled = true; btn.textContent = 'Adding...';
  try {
    var r = await fetch('/admin/api/tower-pricing/foundation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foundation_type: foundationType, price: price }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Foundation type added', 'ok');
    location.reload();
  } catch (err) {
    toast('Could not add: ' + err.message, 'err');
    btn.disabled = false; btn.textContent = 'Add';
  }
}
async function deleteTowerFoundation(foundationType) {
  if (!confirm('Delete this foundation type? Any tower package still using it will show an incomplete price until reassigned.')) return;
  try {
    var r = await fetch('/admin/api/tower-pricing/foundation/' + encodeURIComponent(foundationType) + '/delete', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Foundation type deleted', 'ok');
    location.reload();
  } catch (err) { toast('Could not delete: ' + err.message, 'err'); }
}

function openTankPriceModal(btn) {
  document.getElementById('tp-title').textContent = btn ? 'Edit Tank Price' : 'Add Tank Price';
  document.getElementById('tp-submit').textContent = 'Save';
  document.getElementById('tp-id').value = btn ? btn.dataset.id : '';
  document.getElementById('tp-type').value = btn ? btn.dataset.type : 'plastic';
  document.getElementById('tp-key').value = btn ? btn.dataset.key : '';
  document.getElementById('tp-label').value = btn ? btn.dataset.label : '';
  document.getElementById('tp-price').value = btn ? btn.dataset.price : '';
  document.getElementById('tankPriceOverlay').style.display = 'flex';
}
function closeTankPriceModal() {
  document.getElementById('tankPriceOverlay').style.display = 'none';
}
async function submitTankPrice() {
  var id = document.getElementById('tp-id').value;
  var payload = {
    tank_type: document.getElementById('tp-type').value,
    capacity_key: document.getElementById('tp-key').value.trim(),
    capacity_label: document.getElementById('tp-label').value.trim(),
    price: document.getElementById('tp-price').value,
  };
  if (!payload.capacity_key || !payload.capacity_label || !payload.price) { toast('All fields are required', 'err'); return; }
  var btn = document.getElementById('tp-submit');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    var r = await fetch('/admin/api/tower-pricing/tanks' + (id ? '/' + id : ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast(id ? 'Tank price updated' : 'Tank price added', 'ok');
    location.reload();
  } catch (err) {
    toast('Could not save: ' + err.message, 'err');
    btn.disabled = false; btn.textContent = 'Save';
  }
}
async function deleteTowerTank(id) {
  if (!confirm('Delete this tank price? Any tower package still referencing it will show KShs 0 for the tank until fixed.')) return;
  try {
    var r = await fetch('/admin/api/tower-pricing/tanks/' + id + '/delete', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Tank price deleted', 'ok');
    location.reload();
  } catch (err) { toast('Could not delete: ' + err.message, 'err'); }
}

function openTowerPackageModal(btn) {
  document.getElementById('tw-title').textContent = btn ? 'Edit Tower Package' : 'Add Tower Package';
  document.getElementById('tw-submit').textContent = 'Save';
  document.getElementById('tw-id').value = btn ? btn.dataset.id : '';
  document.getElementById('tw-height').value = btn ? btn.dataset.height : '';
  document.getElementById('tw-count').value = btn ? btn.dataset.count : '1';
  document.getElementById('tw-type').value = btn ? btn.dataset.type : 'plastic';
  document.getElementById('tw-key').value = btn ? btn.dataset.key : '';
  document.getElementById('tw-label').value = btn ? btn.dataset.label : '';
  document.getElementById('tw-foundation').value = btn ? btn.dataset.foundation : 'pad';
  document.getElementById('tw-fab').value = btn ? btn.dataset.fab : '';
  document.getElementById('towerPackageOverlay').style.display = 'flex';
}
function closeTowerPackageModal() {
  document.getElementById('towerPackageOverlay').style.display = 'none';
}
async function submitTowerPackage() {
  var id = document.getElementById('tw-id').value;
  var payload = {
    height_m: document.getElementById('tw-height').value,
    tank_count: document.getElementById('tw-count').value,
    tank_type: document.getElementById('tw-type').value,
    capacity_key: document.getElementById('tw-key').value.trim(),
    capacity_label: document.getElementById('tw-label').value.trim(),
    foundation_type: document.getElementById('tw-foundation').value,
    fabrication_price: document.getElementById('tw-fab').value,
  };
  if (!payload.height_m || !payload.tank_count || !payload.capacity_key || !payload.capacity_label || !payload.fabrication_price) {
    toast('All fields are required', 'err'); return;
  }
  var btn = document.getElementById('tw-submit');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    var r = await fetch('/admin/api/tower-pricing/packages' + (id ? '/' + id : ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast(id ? 'Package updated' : 'Package added', 'ok');
    location.reload();
  } catch (err) {
    toast('Could not save: ' + err.message, 'err');
    btn.disabled = false; btn.textContent = 'Save';
  }
}
async function deleteTowerPackage(id) {
  if (!confirm('Delete this tower package? It will no longer be offered as a standard quote.')) return;
  try {
    var r = await fetch('/admin/api/tower-pricing/packages/' + id + '/delete', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    toast('Package deleted', 'ok');
    location.reload();
  } catch (err) { toast('Could not delete: ' + err.message, 'err'); }
}

async function handlePause(btn) {
  var phone  = btn.dataset.phone;
  var pid    = btn.dataset.pid;
  var paused = btn.dataset.paused === 'true';
  var action = paused ? 'resume' : 'pause';
  btn.disabled = true; btn.textContent = '...';
  try {
    var r = await fetch('/admin/api/session/' + encodeURIComponent(phone) + '/' + action, { method: 'POST' });
    if (!r.ok) throw new Error('Failed');
    var nowPaused = !paused;
    btn.dataset.paused = String(nowPaused);
    btn.innerHTML = nowPaused ? '&#9654; Resume AI' : '&#9646;&#9646; Pause AI';
    btn.className = 'wa-action-btn ' + (nowPaused ? 'wa-btn-resume' : 'wa-btn-pause');

    var sub = document.getElementById('hsub-' + pid);
    sub.innerHTML = nowPaused ? '&#128100; Human Mode' : '&#129302; AI Active';
    sub.className = 'wa-hdr-sub ' + (nowPaused ? 'sub-paused' : 'sub-active');

    var wrap  = document.getElementById('wa-input-' + pid);
    var ta    = document.getElementById('rinput-' + pid);
    var sbtn  = document.getElementById('sbtn-' + pid);
    var abtn2 = document.getElementById('abtn-' + pid);
    var pbtnImg = document.getElementById('pbtn-img-' + pid);
    var note  = wrap.querySelector('.wa-lock-notice');
    var qr = document.getElementById('qr-'+pid);
    if (nowPaused) {
      wrap.classList.remove('wa-input-locked');
      ta.disabled = false; ta.placeholder = 'Type a message...';
      sbtn.disabled = false; sbtn.className = 'wa-send';
      if (abtn2) abtn2.disabled = false;
      if (pbtnImg) pbtnImg.disabled = false;
      if (note) note.remove();
      if (qr) qr.style.display = '';
      setTimeout(function(){ wrap.scrollIntoView({ behavior: 'smooth', block: 'end' }); ta.focus(); }, 100);
    } else {
      wrap.classList.add('wa-input-locked');
      ta.disabled = true; ta.placeholder = 'Pause AI to reply';
      sbtn.disabled = true; sbtn.className = 'wa-send wa-send-disabled';
      if (abtn2) abtn2.disabled = true;
      if (pbtnImg) pbtnImg.disabled = true;
      if (qr) qr.style.display = 'none';
      cancelReply(pid);
      if (!note) {
        var n = document.createElement('div');
        n.className = 'wa-lock-notice';
        n.innerHTML = '&#9888;&#65039; Pause AI to reply directly';
        wrap.insertBefore(n, wrap.querySelector('.wa-input-row'));
      }
    }
    // Update contact badge
    var badge = document.querySelector('#contact-' + pid + ' .wa-ct-badge');
    if (nowPaused && !badge) {
      var row2 = document.querySelector('#contact-' + pid + ' .wa-ct-row2');
      if (row2) { var b = document.createElement('span'); b.className='wa-ct-badge'; b.innerHTML='&#128100;'; row2.appendChild(b); }
    } else if (!nowPaused && badge) { badge.remove(); }
    toast(nowPaused ? 'AI paused — you can now reply' : 'AI resumed', 'ok');
  } catch(e) { toast('Error: ' + e.message, 'err'); }
  finally { btn.disabled = false; }
}

async function handleBlock(btn) {
  var phone   = btn.dataset.phone;
  var pid     = btn.dataset.pid;
  var blocked = btn.dataset.blocked === 'true';
  var action  = blocked ? 'unblock' : 'block';
  if (!blocked && !confirm('Block ' + phone + '? The AI will stop replying to them, but their messages will still be logged here until you unblock them.')) return;
  btn.disabled = true; btn.textContent = '...';
  try {
    var r = await fetch('/admin/api/session/' + encodeURIComponent(phone) + '/' + action, { method: 'POST' });
    if (!r.ok) throw new Error('Failed');
    var nowBlocked = !blocked;
    btn.dataset.blocked = String(nowBlocked);
    btn.innerHTML = nowBlocked ? '&#128683; Unblock' : '&#128683; Block';
    btn.className = 'wa-action-btn ' + (nowBlocked ? 'wa-btn-resume' : 'wa-btn-pause');
    btn.title = nowBlocked ? 'Unblock this number so the AI can reply again' : 'Stop the AI replying to this number — messages are still logged';

    var pill = document.getElementById('bpill-' + pid);
    var info = btn.closest('.wa-chat-hdr').querySelector('.wa-hdr-info');
    if (nowBlocked && !pill) {
      var p = document.createElement('div');
      p.className = 'wa-blocked-pill'; p.id = 'bpill-' + pid; p.innerHTML = '&#128683; Blocked';
      info.insertBefore(p, info.children[2] || null);
    } else if (!nowBlocked && pill) { pill.remove(); }

    var ctBadge = document.querySelector('#contact-' + pid + ' .wa-ct-row2');
    if (ctBadge) {
      var existing = ctBadge.querySelector('.wa-ct-badge[title^="Blocked"]');
      if (nowBlocked && !existing) {
        var b = document.createElement('span'); b.className = 'wa-ct-badge'; b.title = 'Blocked — AI does not reply'; b.innerHTML = '&#128683;';
        ctBadge.insertBefore(b, ctBadge.firstChild.nextSibling);
      } else if (!nowBlocked && existing) { existing.remove(); }
    }
    toast(nowBlocked ? 'Number blocked — AI will no longer reply' : 'Number unblocked', 'ok');
  } catch (e) { toast('Error: ' + e.message, 'err'); }
  finally { btn.disabled = false; }
}

async function handleSend(phone, pid) {
  var ta   = document.getElementById('rinput-' + pid);
  var btn  = document.getElementById('sbtn-' + pid);
  var text = ta.value.trim();
  if (!text) return;
  var reply = replyTarget[pid] || null;
  btn.disabled = true; btn.innerHTML = '...';
  try {
    var r = await fetch('/admin/api/session/' + encodeURIComponent(phone) + '/send', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ message: text, replyToWaId: reply ? reply.waId : undefined, replyPreview: reply ? reply.preview : undefined, replySender: reply ? reply.sender : undefined })
    });
    if (!r.ok) { var e = await r.json(); throw new Error(e.error || 'Failed'); }
    var result = await r.json();
    var msgs = document.getElementById('chatmsgs-' + pid);
    var d    = document.createElement('div');
    d.className = 'wa-row wa-row-out';
    if (result.id) d.setAttribute('data-msg-id', result.id);
    var escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var now  = new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Nairobi'});
    var quoteHtml = reply ? clientQuoteBoxHtml({ sender: reply.sender, preview: reply.preview }) : '';
    d.innerHTML = '<div class="wa-bubble wa-out wa-human"><span class="wa-sender">&#128100; Human Agent</span>' + quoteHtml + escaped + '<span class="wa-ts">' + now + ' <span class="wa-tick">&#10003;&#10003;</span></span></div>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    ta.value = ''; ta.style.height = 'auto';
    cancelReply(pid);
    if (result.id && result.id > (chatLastId[pid]||0)) chatLastId[pid] = result.id;
    var prev = document.querySelector('#contact-' + pid + ' .wa-ct-prev');
    if (prev) prev.textContent = '\\u{1F464} ' + text.slice(0, 42);
    toast('Message sent', 'ok');
  } catch(e) { toast('Send failed: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '&#10148;'; }
}

async function handleSendDocument(phone, pid) {
  var finput = document.getElementById('finput-' + pid);
  var file   = finput.files[0];
  if (!file) return;
  var ta      = document.getElementById('rinput-' + pid);
  var caption = ta.value.trim();
  var abtn    = document.getElementById('abtn-' + pid);
  var reply   = replyTarget[pid] || null;
  abtn.disabled = true;
  toast('Sending ' + file.name + '...', 'ok');
  try {
    var formData = new FormData();
    formData.append('file', file);
    if (caption) formData.append('caption', caption);
    if (reply) {
      formData.append('replyToWaId', reply.waId);
      formData.append('replyPreview', reply.preview);
      formData.append('replySender', reply.sender);
    }
    var r = await fetch('/admin/api/session/' + encodeURIComponent(phone) + '/send-document', {
      method: 'POST',
      body: formData
    });
    if (!r.ok) { var e = await r.json(); throw new Error(e.error || 'Failed'); }
    var result = await r.json();
    var msgs = document.getElementById('chatmsgs-' + pid);
    var d    = document.createElement('div');
    d.className = 'wa-row wa-row-out';
    if (result.id) d.setAttribute('data-msg-id', result.id);
    var escapedName = file.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var escapedCap  = caption.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var now  = new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Nairobi'});
    var docInner = '<span class="wa-doc-icon">&#128196;</span><span class="wa-doc-name">' + escapedName + '</span>';
    var docHtml = result.storedAs
      ? '<a class="wa-doc" href="/admin/api/documents/' + encodeURIComponent(result.storedAs) + '" target="_blank" rel="noopener">' + docInner + '</a>'
      : '<div class="wa-doc">' + docInner + '</div>';
    var quoteHtml = reply ? clientQuoteBoxHtml({ sender: reply.sender, preview: reply.preview }) : '';
    d.innerHTML = '<div class="wa-bubble wa-out wa-human wa-doc-bubble"><span class="wa-sender">&#128100; Human Agent</span>' +
      quoteHtml + docHtml +
      (caption ? '<div class="wa-doc-cap">' + escapedCap + '</div>' : '') +
      '<span class="wa-ts">' + now + ' <span class="wa-tick">&#10003;&#10003;</span></span></div>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    ta.value = ''; ta.style.height = 'auto';
    finput.value = '';
    cancelReply(pid);
    if (result.id && result.id > (chatLastId[pid]||0)) chatLastId[pid] = result.id;
    var prev = document.querySelector('#contact-' + pid + ' .wa-ct-prev');
    if (prev) prev.textContent = '\\u{1F464} \\u{1F4C4} ' + file.name;
    toast('Document sent', 'ok');
  } catch(e) { toast('Send failed: ' + e.message, 'err'); }
  finally { abtn.disabled = false; }
}

async function handleSendImage(phone, pid) {
  var pinput = document.getElementById('pinput-' + pid);
  var file   = pinput.files[0];
  if (!file) return;
  var ta      = document.getElementById('rinput-' + pid);
  var caption = ta.value.trim();
  var pbtnImg = document.getElementById('pbtn-img-' + pid);
  var reply   = replyTarget[pid] || null;
  pbtnImg.disabled = true;
  toast('Sending ' + file.name + '...', 'ok');
  try {
    var formData = new FormData();
    formData.append('file', file);
    if (caption) formData.append('caption', caption);
    if (reply) {
      formData.append('replyToWaId', reply.waId);
      formData.append('replyPreview', reply.preview);
      formData.append('replySender', reply.sender);
    }
    var r = await fetch('/admin/api/session/' + encodeURIComponent(phone) + '/send-image', {
      method: 'POST',
      body: formData
    });
    if (!r.ok) { var e = await r.json(); throw new Error(e.error || 'Failed'); }
    var result = await r.json();
    var msgs = document.getElementById('chatmsgs-' + pid);
    var d    = document.createElement('div');
    d.className = 'wa-row wa-row-out';
    if (result.id) d.setAttribute('data-msg-id', result.id);
    var escapedCap = caption.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var now  = new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Nairobi'});
    var isrc = '/admin/api/documents/' + encodeURIComponent(result.storedAs);
    var quoteHtml = reply ? clientQuoteBoxHtml({ sender: reply.sender, preview: reply.preview }) : '';
    d.innerHTML = '<div class="wa-bubble wa-out wa-human wa-img-bubble"><span class="wa-sender">&#128100; Human Agent</span>' +
      quoteHtml +
      '<a href="' + isrc + '" target="_blank" rel="noopener"><img class="wa-img" src="' + isrc + '" alt="Photo sent to customer" loading="lazy"/></a>' +
      (caption ? '<div class="wa-img-cap">' + escapedCap + '</div>' : '') +
      '<span class="wa-ts">' + now + ' <span class="wa-tick">&#10003;&#10003;</span></span></div>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    ta.value = ''; ta.style.height = 'auto';
    pinput.value = '';
    cancelReply(pid);
    if (result.id && result.id > (chatLastId[pid]||0)) chatLastId[pid] = result.id;
    var prev = document.querySelector('#contact-' + pid + ' .wa-ct-prev');
    if (prev) prev.textContent = '\\u{1F464} \\u{1F4F7} Photo';
    toast('Photo sent', 'ok');
  } catch(e) { toast('Send failed: ' + e.message, 'err'); }
  finally { pbtnImg.disabled = false; }
}

async function updateLeadStatus(sel) {
  var index  = sel.dataset.index;
  var status = sel.value;
  try {
    var r = await fetch('/admin/api/leads/' + index + '/status', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ status: status })
    });
    if (!r.ok) throw new Error('Failed');
    sel.className = 'status-sel status-' + status;
    toast('Status updated to ' + status, 'ok');
  } catch(e) { toast('Update failed: ' + e.message, 'err'); }
}

function fillReply(pid, text) {
  var ta = document.getElementById('rinput-'+pid);
  if (ta && !ta.disabled) { ta.value = text; autoResize(ta); ta.focus(); }
}

function updateTabTitle() {
  var count = document.querySelectorAll('.wa-unread-dot').length;
  document.title = count > 0 ? '('+count+') Waterlift Admin' : 'Waterlift Admin';
}

function playNotificationSound() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.18);
    o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.18);
  } catch(e) {}
}

async function handleResolveEscalation(btn) {
  var id = btn.dataset.id;
  btn.disabled = true; btn.textContent = '...';
  try {
    var r = await fetch('/admin/api/escalations/'+id+'/resolve', { method: 'POST' });
    if (!r.ok) throw new Error('Failed');
    var tr = btn.closest('tr');
    tr.classList.add('esc-resolved');
    btn.outerHTML = '<span class="resolved-badge">&#10003; Resolved</span>';
    var escStat = document.querySelector('.s-esc .stat-sub');
    if (escStat) {
      var resolved = document.querySelectorAll('tr.esc-resolved').length;
      var total    = document.querySelectorAll('#pane-esc tbody tr').length;
      escStat.textContent = resolved + ' resolved';
      var nEl = document.querySelector('.s-esc .stat-n');
      if (nEl) nEl.textContent = total - resolved;
    }
    toast('Escalation resolved', 'ok');
  } catch(e) { toast('Failed: '+e.message, 'err'); btn.disabled = false; btn.textContent = 'Resolve'; }
}

// ── Smart polling (replaces full page reload) ─────────────────────────────────

var chatLastId       = {};   // pid → highest message id rendered for that chat
var sessionLastSeen = {};   // pid → lastSeen from sessions API (for unread detection)
var firstPoll       = true;
var replyTarget      = {};   // pid → {waId, preview, sender} currently selected to reply to, if any

function startReply(btn) {
  var chat = btn.closest('.wa-chat');
  if (!chat) return;
  var pid = chat.id.replace('chat-', '');
  var waId = btn.dataset.waId, preview = btn.dataset.preview, sender = btn.dataset.sender;
  replyTarget[pid] = { waId: waId, preview: preview, sender: sender };
  var banner = document.getElementById('rbanner-' + pid);
  var senderLabel = sender === 'customer' ? 'Customer' : sender === 'human' ? 'You' : 'AI Agent';
  document.getElementById('rbanner-sender-' + pid).textContent = senderLabel;
  document.getElementById('rbanner-preview-' + pid).textContent = preview;
  if (banner) banner.style.display = 'flex';
  var ta = document.getElementById('rinput-' + pid);
  if (ta && !ta.disabled) ta.focus();
}

function cancelReply(pid) {
  delete replyTarget[pid];
  var banner = document.getElementById('rbanner-' + pid);
  if (banner) banner.style.display = 'none';
}

function clientEsc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function clientFmtTime(ts) {
  if (!ts) return '';
  try {
    var d = new Date(Number(ts)), isToday = d.toDateString() === new Date().toDateString();
    return isToday
      ? d.toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Nairobi'})
      : d.toLocaleDateString('en-KE',{month:'short',day:'numeric',timeZone:'Africa/Nairobi'});
  } catch(e){ return ''; }
}
function clientTimeAgo(ts) {
  var d = Date.now()-Number(ts), m = Math.floor(d/60000);
  if (m<1) return 'just now';
  if (m<60) return m+'m ago';
  var h = Math.floor(m/60);
  if (h<24) return h+'h ago';
  return Math.floor(h/24)+'d ago';
}
function clientLastMsgText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content.slice(0,45);
  if (Array.isArray(msg.content)) {
    var imgB = msg.content.find(function(b){ return b.type==='image'; });
    if (imgB) {
      var cap = msg.content.find(function(b){ return b.type==='text'; });
      var capText = cap ? cap.text : imgB.caption;
      return '\\u{1F4F7} Photo' + (capText ? ': ' + capText.slice(0,35) : '');
    }
    var docBlock = msg.content.find(function(b){ return b.type==='document'; });
    if (docBlock) return '\\u{1F4C4} ' + docBlock.filename;
    var vidB = msg.content.find(function(b){ return b.type==='video'; });
    if (vidB) {
      var vcap = msg.content.find(function(b){ return b.type==='text'; });
      return '\\u{1F3A5} Video' + (vcap ? ': ' + vcap.text.slice(0,35) : '');
    }
    var t = msg.content.find(function(b){ return b.type==='text'; });
    if (t) return (msg.source==='human' ? '\\u{1F464} ' : msg.role==='assistant' ? '\\u{1F916} ' : '') + t.text.slice(0,42);
  }
  return '';
}
function clientQuoteBoxHtml(replyContext) {
  if (!replyContext) return '';
  var label = replyContext.sender==='customer' ? 'Customer' : replyContext.sender==='human' ? 'You' : 'AI Agent';
  return '<div class="wa-quote"><span class="wa-quote-sender">'+clientEsc(label)+'</span>'+clientEsc(replyContext.preview||'')+'</div>';
}

function clientReplyBtnHtml(waMessageId, preview, sender, paused) {
  if (!waMessageId) return '';
  return '<button type="button" class="wa-reply-btn" title="Reply" '+(paused?'':'disabled ')+
    'data-wa-id="'+clientEsc(waMessageId)+'" data-preview="'+clientEsc(preview||'')+'" data-sender="'+clientEsc(sender)+'" ' +
    'onclick="startReply(this)">&#8617;</button>';
}

function renderSingleMsg(msg, pid) {
  if (msg.source === 'system') return '';
  var t = clientFmtTime(msg.ts);
  var idAttr = ' data-msg-id="'+(msg.id||0)+'"';
  var quote = clientQuoteBoxHtml(msg.replyContext);
  var pbtn = pid ? document.getElementById('pbtn-'+pid) : null;
  var paused = pbtn ? pbtn.dataset.paused === 'true' : false;
  if (typeof msg.content === 'string') {
    return '<div class="wa-row wa-row-in"'+idAttr+'><div class="wa-bubble wa-in">'+quote+clientEsc(msg.content)+'<span class="wa-ts">'+t+'</span></div>'+clientReplyBtnHtml(msg.waMessageId, msg.content, 'customer', paused)+'</div>';
  }
  if (!Array.isArray(msg.content)) return '';
  var imgBlock = msg.content.find(function(b){ return b.type==='image'; });
  if (imgBlock && msg.role==='user') {
    var capBlock = msg.content.find(function(b){ return b.type==='text'; });
    var src = 'data:'+((imgBlock.source&&imgBlock.source.media_type)||'image/jpeg')+';base64,'+((imgBlock.source&&imgBlock.source.data)||'');
    return '<div class="wa-row wa-row-in"'+idAttr+'><div class="wa-bubble wa-in wa-img-bubble">' +
      quote +
      '<img class="wa-img" src="'+src+'" alt="Photo from customer" loading="lazy"/>' +
      (capBlock ? '<div class="wa-img-cap">'+clientEsc(capBlock.text)+'</div>' : '') +
      '<span class="wa-ts">'+t+'</span></div>'+clientReplyBtnHtml(msg.waMessageId, '📷 Photo', 'customer', paused)+'</div>';
  }
  var vidBlock = msg.content.find(function(b){ return b.type==='video'; });
  if (vidBlock && msg.role==='user') {
    var vcapBlock = msg.content.find(function(b){ return b.type==='text'; });
    var vsrc = '/admin/api/documents/'+encodeURIComponent(vidBlock.storedAs);
    return '<div class="wa-row wa-row-in"'+idAttr+'><div class="wa-bubble wa-in wa-img-bubble">' +
      quote +
      '<video class="wa-img" src="'+vsrc+'" controls preload="metadata"></video>' +
      (vcapBlock ? '<div class="wa-img-cap">'+clientEsc(vcapBlock.text)+'</div>' : '') +
      '<span class="wa-ts">'+t+'</span></div>'+clientReplyBtnHtml(msg.waMessageId, '🎥 Video', 'customer', paused)+'</div>';
  }
  return msg.content.map(function(block) {
    if (block.type==='text' && msg.role==='assistant') {
      var h = msg.source==='human';
      return '<div class="wa-row wa-row-out"'+idAttr+'><div class="wa-bubble wa-out'+(h?' wa-human':'')+'"><span class="wa-sender">'+(h?'&#128100; Human Agent':'&#129302; AI Agent')+'</span>'+quote+clientEsc(block.text)+'<span class="wa-ts">'+t+' <span class="wa-tick">&#10003;&#10003;</span></span></div>'+clientReplyBtnHtml(msg.waMessageId, block.text, h?'human':'ai', paused)+'</div>';
    }
    if (block.type==='tool_use') {
      return '<div class="wa-row wa-row-center"'+idAttr+'><div class="wa-system">&#128295; '+clientEsc(block.name)+'</div></div>';
    }
    if (block.type==='document') {
      var hd = msg.source==='human';
      var docInner = '<span class="wa-doc-icon">&#128196;</span><span class="wa-doc-name">'+clientEsc(block.filename)+'</span>';
      var docHtml = block.storedAs
        ? '<a class="wa-doc" href="/admin/api/documents/'+encodeURIComponent(block.storedAs)+'" target="_blank" rel="noopener">'+docInner+'</a>'
        : '<div class="wa-doc">'+docInner+'</div>';
      return '<div class="wa-row wa-row-out"'+idAttr+'><div class="wa-bubble wa-out'+(hd?' wa-human':'')+' wa-doc-bubble">' +
        '<span class="wa-sender">'+(hd?'&#128100; Human Agent':'&#129302; AI Agent')+'</span>' +
        quote + docHtml +
        (block.caption ? '<div class="wa-doc-cap">'+clientEsc(block.caption)+'</div>' : '') +
        '<span class="wa-ts">'+t+' <span class="wa-tick">&#10003;&#10003;</span></span></div>'+clientReplyBtnHtml(msg.waMessageId, '📄 '+block.filename, hd?'human':'ai', paused)+'</div>';
    }
    if (block.type==='image' && msg.role==='assistant') {
      var hi = msg.source==='human';
      var isrc = '/admin/api/documents/'+encodeURIComponent(block.storedAs);
      return '<div class="wa-row wa-row-out"'+idAttr+'><div class="wa-bubble wa-out'+(hi?' wa-human':'')+' wa-img-bubble">' +
        '<span class="wa-sender">'+(hi?'&#128100; Human Agent':'&#129302; AI Agent')+'</span>' +
        quote +
        '<a href="'+isrc+'" target="_blank" rel="noopener"><img class="wa-img" src="'+isrc+'" alt="Photo sent to customer" loading="lazy"/></a>' +
        (block.caption ? '<div class="wa-img-cap">'+clientEsc(block.caption)+'</div>' : '') +
        '<span class="wa-ts">'+t+' <span class="wa-tick">&#10003;&#10003;</span></span></div>'+clientReplyBtnHtml(msg.waMessageId, '📷 Photo', hi?'human':'ai', paused)+'</div>';
    }
    if (block.type==='text' && msg.role==='user') {
      return '<div class="wa-row wa-row-in"'+idAttr+'><div class="wa-bubble wa-in">'+quote+clientEsc(block.text)+'<span class="wa-ts">'+t+'</span></div>'+clientReplyBtnHtml(msg.waMessageId, block.text, 'customer', paused)+'</div>';
    }
    return '';
  }).join('');
}

async function fetchNewMessages(pid, phone, autoScroll) {
  var lastId = chatLastId[pid] || 0;
  try {
    var r = await fetch('/admin/api/messages/'+encodeURIComponent(phone)+'/since-id/'+lastId);
    if (!r.ok) return;
    var newMsgs = await r.json();
    if (!newMsgs.length) return;
    var msgs = document.getElementById('chatmsgs-'+pid);
    if (!msgs) return;
    var atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    var rendered = false;
    newMsgs.forEach(function(msg) {
      // Defensive dedup: the optimistic send-bubble may have already rendered this
      // exact message (data-msg-id) before this poll's response arrived.
      if (msg.id && msgs.querySelector('[data-msg-id="'+msg.id+'"]')) {
        if (msg.id > (chatLastId[pid]||0)) chatLastId[pid] = msg.id;
        return;
      }
      var html = renderSingleMsg(msg, pid);
      if (html) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        while (tmp.firstChild) msgs.appendChild(tmp.firstChild);
        rendered = true;
      }
      if (msg.id > (chatLastId[pid]||0)) chatLastId[pid] = msg.id;
    });
    if (rendered && (autoScroll ? atBottom : true)) msgs.scrollTop = msgs.scrollHeight;
    var lastM = newMsgs[newMsgs.length-1];
    var prev = document.querySelector('#contact-'+pid+' .wa-ct-prev');
    if (prev && lastM) { var p = clientLastMsgText(lastM); if (p) prev.textContent = p; }
  } catch(e) { console.error('[poll] fetchNewMessages:', e); }
}

async function pollUpdates() {
  try {
    var sr = await fetch('/admin/api/sessions');
    if (sr.ok) {
      var sessions = await sr.json();
      sessions.forEach(function(s) {
        var pid = s.phone.replace(/\\D/g,'');
        var contact = document.getElementById('contact-'+pid);
        if (!contact) return;
        var timeEl = contact.querySelector('.wa-ct-time');
        if (timeEl) timeEl.textContent = clientTimeAgo(s.lastSeen);
        if (!firstPoll && pid !== activeChat && sessionLastSeen[pid] && s.lastSeen > sessionLastSeen[pid]) {
          if (!contact.querySelector('.wa-unread-dot')) {
            var dot = document.createElement('span');
            dot.className = 'wa-unread-dot';
            var row2 = contact.querySelector('.wa-ct-row2');
            if (row2) row2.insertBefore(dot, row2.firstChild);
            playNotificationSound();
            updateTabTitle();
          }
        }
        sessionLastSeen[pid] = s.lastSeen;
      });
    }
    if (activeChat) {
      var chat = document.getElementById('chat-'+activeChat);
      if (chat && chat.dataset.phone) await fetchNewMessages(activeChat, chat.dataset.phone, true);
    }
    var p = document.querySelector('.topbar p');
    if (p) p.textContent = 'Updated: '+new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Nairobi'});
    firstPoll = false;
  } catch(e) { console.error('[poll]', e); }
}

function toggleStats() {
  var bar = document.getElementById('statsBar');
  var btn = document.getElementById('statsToggleBtn');
  var hidden = bar.classList.toggle('stats-hidden');
  btn.innerHTML = hidden ? '&#128202; Show Stats' : '&#128202; Hide Stats';
  try { localStorage.setItem('waAdminStatsHidden', hidden ? '1' : '0'); } catch(e) {}
}

// ── Active Devices modal ─────────────────────────────────────────────────────

// Small heuristic label, not a full UA-parsing library — good enough to tell devices apart
// at a glance (e.g. "Chrome on Windows", "Safari on iPhone") without a dependency.
function friendlyDeviceLabel(ua) {
  if (!ua) return 'Unknown device';
  var browser = ua.indexOf('Edg/') !== -1 ? 'Edge' : ua.indexOf('OPR/') !== -1 ? 'Opera' : ua.indexOf('Chrome/') !== -1 ? 'Chrome' :
                ua.indexOf('Firefox/') !== -1 ? 'Firefox' : ua.indexOf('Safari/') !== -1 ? 'Safari' : 'Browser';
  var os = ua.indexOf('iPhone') !== -1 ? 'iPhone' : ua.indexOf('iPad') !== -1 ? 'iPad' : ua.indexOf('Android') !== -1 ? 'Android' :
           ua.indexOf('Windows') !== -1 ? 'Windows' : ua.indexOf('Mac OS X') !== -1 ? 'Mac' : ua.indexOf('Linux') !== -1 ? 'Linux' : '';
  return browser + (os ? ' on ' + os : '');
}

async function openDevicesModal() {
  document.getElementById('devicesOverlay').style.display = 'flex';
  var list = document.getElementById('devicesList');
  list.innerHTML = 'Loading&hellip;';
  try {
    var r = await fetch('/admin/api/devices');
    if (!r.ok) throw new Error('Failed to load');
    var devices = await r.json();
    if (!devices.length) { list.innerHTML = '<p style="color:#64748b">No active sessions found.</p>'; return; }
    list.innerHTML = '<div class="tbl-wrap"><table><thead><tr><th>Email</th><th>Device</th><th>Logged in</th><th>Expires</th><th></th></tr></thead><tbody>' +
      devices.map(function (d) {
        var loginStr = d.loginAt ? new Date(d.loginAt).toLocaleString() : 'Unknown';
        var expStr = new Date(d.expiresAt).toLocaleString();
        return '<tr><td>' + clientEsc(d.email || '') + '</td>' +
          '<td>' + clientEsc(friendlyDeviceLabel(d.userAgent)) + (d.isCurrent ? ' <em>(this device)</em>' : '') + '</td>' +
          '<td class="muted">' + loginStr + '</td>' +
          '<td class="muted">' + expStr + '</td>' +
          '<td>' + (d.isCurrent ? '' : '<button type="button" class="resolve-btn" onclick="revokeDevice(\\'' + d.sessionId + '\\', this)">Log out</button>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  } catch (e) {
    list.innerHTML = '<p style="color:#b91c1c">Could not load active devices: ' + clientEsc(e.message) + '</p>';
  }
}

function closeDevicesModal() {
  document.getElementById('devicesOverlay').style.display = 'none';
}

async function revokeDevice(sessionId, btn) {
  if (!confirm('Log out this device? It will need to sign in again.')) return;
  btn.disabled = true; btn.textContent = '...';
  try {
    var r = await fetch('/admin/api/devices/' + encodeURIComponent(sessionId) + '/revoke', { method: 'POST' });
    if (!r.ok) throw new Error('Failed');
    btn.closest('tr').remove();
    toast('Device logged out', 'ok');
  } catch (e) { toast('Error: ' + e.message, 'err'); btn.disabled = false; btn.textContent = 'Log out'; }
}

window.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.wa-chat').forEach(function(chat) {
    var pid = chat.id.replace('chat-','');
    chatLastId[pid] = Number(chat.dataset.lastId || 0);
  });
  if (window.innerWidth > 768) {
    var first = document.querySelector('.wa-contact');
    if (first) { var pid = first.id.replace('contact-',''); openChat(pid); }
  }
  try {
    if (localStorage.getItem('waAdminStatsHidden') === '1') {
      document.getElementById('statsBar').classList.add('stats-hidden');
      document.getElementById('statsToggleBtn').innerHTML = '&#128202; Show Stats';
    }
  } catch(e) {}
  updateBellUI();
  autoResubscribePush();
  pollUpdates();
  setInterval(pollUpdates, 10000);

  // Browsers throttle setInterval in background tabs (sometimes to once a minute or
  // less), so the 10s poll can stall while this tab isn't focused. Force an immediate
  // re-sync the moment the admin switches back, instead of waiting for the next tick.
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') pollUpdates();
  });
  window.addEventListener('focus', pollUpdates);
});
</script>
</body>
</html>`;
}

// ── Admin routes ──────────────────────────────────────────────────────────────

app.get('/admin', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const sessions     = await db.getAllSessionsWithMessages();
    const leads        = await db.getAllLeads();
    const callbacks    = await db.getAllCallbacks();
    const escalations  = await db.getAllEscalations();
    const productCount = await db.getProductCount();
    const [towerFoundation, towerTanks, towerPackages] = await Promise.all([
      db.getTowerFoundationPrices(),
      db.getTowerTankPrices(),
      db.getTowerPackages(),
    ]);
    const towerPricing = { foundation: towerFoundation, tanks: towerTanks, packages: towerPackages };
    const [drillingSettings, drillingPenetrationRates, drillingConsumables, drillingMobilization] = await Promise.all([
      db.getDrillingSettings(),
      db.getDrillingPenetrationRates(),
      db.getDrillingLineItems('consumable'),
      db.getDrillingLineItems('mobilization'),
    ]);
    const drillingPricing = { settings: drillingSettings, penetrationRates: drillingPenetrationRates, consumables: drillingConsumables, mobilization: drillingMobilization };
    const [solarSettings, solarTiers, solarLineItems] = await Promise.all([
      db.getSolarSettings(),
      db.getSolarKvaTiers(),
      db.getSolarLineItems(),
    ]);
    const solarPricing = { settings: solarSettings, tiers: solarTiers, lineItems: solarLineItems };
    const blockedNumbers = await db.getBlockedNumbers();
    const analytics = await db.getAnalyticsSummary();
    res.send(buildAdminPage(sessions, leads, callbacks, escalations, req.session.email, productCount, towerPricing, drillingPricing, solarPricing, blockedNumbers, analytics));
  } catch (err) {
    console.error('[admin] DB error:', err.message);
    res.status(500).send('Database error: ' + esc(err.message));
  }
});

app.post('/admin/api/session/:phone/pause', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try { await pauseSession(normalizePhone(req.params.phone)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/session/:phone/resume', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try { await resumeSession(normalizePhone(req.params.phone)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/session/:phone/block', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    await db.blockNumber(normalizePhone(req.params.phone), (req.body && req.body.reason) || null);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/session/:phone/unblock', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    await db.unblockNumber(normalizePhone(req.params.phone));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/api/devices', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const sessions = await db.getActiveAdminSessions();
    const currentId = req.sessionID;
    res.json(sessions.map(s => ({ ...s, isCurrent: s.sessionId === currentId })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/devices/:sessionId/revoke', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    if (req.params.sessionId === req.sessionID) return res.status(400).json({ error: "Can't revoke your own current session — use Log out instead" });
    await db.revokeAdminSession(req.params.sessionId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/session/:phone/send', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  const phone = normalizePhone(req.params.phone);
  const { message, replyToWaId, replyPreview, replySender } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });
  try {
    const sendResult  = await sendTextMessage(phone, message.trim(), replyToWaId || undefined);
    const waMessageId = sendResult?.messages?.[0]?.id || null;
    const replyContext = replyToWaId
      ? { waMessageId: replyToWaId, preview: String(replyPreview || '').slice(0, 120), sender: replySender || 'customer' }
      : null;
    const id = await appendAdminMessage(phone, message.trim(), waMessageId, replyContext);
    res.json({ ok: true, id, waMessageId });
  } catch (err) {
    console.error('[admin] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload a document (e.g. a quotation PDF) and send it straight to the customer on WhatsApp
app.post('/admin/api/session/:phone/send-document', (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  uploadDocument.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const phone       = normalizePhone(req.params.phone);
      const caption     = (req.body?.caption || '').trim();
      const replyToWaId = req.body?.replyToWaId || null;
      const storedAs    = saveDocumentToDisk(req.file.buffer, req.file.originalname);
      const mediaId     = await uploadMedia(req.file.buffer, req.file.mimetype, req.file.originalname);
      const sendResult  = await sendDocumentMessage(phone, mediaId, req.file.originalname, caption, replyToWaId || undefined);
      const waMessageId = sendResult?.messages?.[0]?.id || null;
      const replyContext = replyToWaId
        ? { waMessageId: replyToWaId, preview: String(req.body?.replyPreview || '').slice(0, 120), sender: req.body?.replySender || 'customer' }
        : null;
      const id = await appendAdminDocumentMessage(phone, req.file.originalname, caption, storedAs, waMessageId, replyContext);
      res.json({ ok: true, filename: req.file.originalname, storedAs, id, waMessageId });
    } catch (err2) {
      console.error('[admin] Document send error:', err2.message);
      res.status(500).json({ error: err2.message });
    }
  });
});

// Upload a photo and send it straight to the customer on WhatsApp as an inline image
// (not a downloadable file — see sendImageMessage vs sendDocumentMessage).
app.post('/admin/api/session/:phone/send-image', (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  uploadImage.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const phone       = normalizePhone(req.params.phone);
      const caption     = (req.body?.caption || '').trim();
      const replyToWaId = req.body?.replyToWaId || null;
      const storedAs    = saveDocumentToDisk(req.file.buffer, req.file.originalname);
      const mediaId     = await uploadMedia(req.file.buffer, req.file.mimetype, req.file.originalname);
      const sendResult  = await sendImageMessage(phone, mediaId, caption, replyToWaId || undefined);
      const waMessageId = sendResult?.messages?.[0]?.id || null;
      const replyContext = replyToWaId
        ? { waMessageId: replyToWaId, preview: String(req.body?.replyPreview || '').slice(0, 120), sender: req.body?.replySender || 'customer' }
        : null;
      const id = await appendAdminImageMessage(phone, req.file.originalname, caption, storedAs, waMessageId, replyContext);
      res.json({ ok: true, filename: req.file.originalname, storedAs, id, waMessageId });
    } catch (err2) {
      console.error('[admin] Image send error:', err2.message);
      res.status(500).json({ error: err2.message });
    }
  });
});

// Re-opens a previously sent quotation document. storedAs is a server-generated
// random-prefixed filename (see saveDocumentToDisk) — path.basename() strips any
// directory components as defense in depth against path traversal.
app.get('/admin/api/documents/:storedAs', (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  const storedAs = path.basename(req.params.storedAs);
  const filePath = path.join(DOCUMENTS_DIR, storedAs);
  res.sendFile(filePath, err => {
    // sendFile's error callback also fires when the client disconnects mid-transfer (e.g. a
    // <video> tag's range request getting cancelled by scrubbing/tab-switch/preload="metadata")
    // — by then Express has already sent headers (or the socket is already gone), so calling
    // res.status().send() again throws ERR_HTTP_HEADERS_SENT and crashes the whole process
    // since this runs outside any request's try/catch. Only respond if nothing went out yet.
    if (err && !res.headersSent) res.status(err.status === 404 ? 404 : 500).send('Document not found');
  });
});

// Generates a branded elevated-steel-water-tower quotation PDF and streams it back for download.
app.get('/admin/api/quotes/tower/download', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { client, project, siteLocation, quoteRef, date, towerHeightM, tankCount, tankType, tankCapacity, transportCost, vatIncluded } = req.query;
    const buffer = await generateTowerQuotePDF({
      client, project, siteLocation, quoteRef, date,
      towerHeightM: Number(towerHeightM), tankCount: Number(tankCount), tankType, tankCapacity, transportCost,
      vatIncluded: vatIncluded !== 'false',
    });
    const safeName = String(quoteRef || 'quote').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('[admin] Quote PDF generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generates the same PDF and sends it straight to the customer on WhatsApp — mirrors the
// save-to-disk + upload + send + log pattern used by /send-document above.
app.post('/admin/api/quotes/tower/send/:phone', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const phone = normalizePhone(req.params.phone);
    const { client, project, siteLocation, quoteRef, date, towerHeightM, tankCount, tankType, tankCapacity, transportCost, caption, vatIncluded } = req.body || {};
    const buffer = await generateTowerQuotePDF({
      client, project, siteLocation, quoteRef, date,
      towerHeightM: Number(towerHeightM), tankCount: Number(tankCount), tankType, tankCapacity, transportCost,
      vatIncluded: vatIncluded !== false,
    });
    const filename = `${String(quoteRef || 'Quote').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
    const storedAs = saveDocumentToDisk(buffer, filename);
    const mediaId = await uploadMedia(buffer, 'application/pdf', filename);
    const sendResult = await sendDocumentMessage(phone, mediaId, filename, (caption || '').trim());
    const waMessageId = sendResult?.messages?.[0]?.id || null;
    const id = await appendAdminDocumentMessage(phone, filename, (caption || '').trim(), storedAs, waMessageId, null);
    res.json({ ok: true, filename, storedAs, id, waMessageId });
  } catch (err) {
    console.error('[admin] Quote PDF send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/leads/:index/status', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  const { status } = req.body || {};
  const valid = ['new', 'contacted', 'converted', 'lost'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await db.updateLeadStatus(Number(req.params.index), status);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] updateLeadStatus error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Formats a DB date value as "YYYY-MM-DD HH:mm" (Nairobi time) instead of a raw
// JS Date's verbose toString(), which is what was showing up as an unreadably long
// value in the exported spreadsheet.
function fmtExportDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// Excel/Sheets auto-detect long all-digit CSV cells as numbers and switch to
// scientific notation (e.g. "2.54712E+11") once a phone number is ~12+ digits —
// which is where the stray "letters" the user saw were coming from. Wrapping the
// value as ="..." forces it to be treated as literal text instead.
function csvTextCell(v) {
  return '"=""' + String(v || '').replace(/"/g, '""') + '"""';
}

function csvCell(v) {
  return '"' + String(v || '').replace(/"/g, '""') + '"';
}

// Flattens a message's content (a plain string, or an array of Claude-style content blocks)
// into one readable line — shared by the bulk conversation CSV and the per-chat transcript
// download. tool_result blocks are internal plumbing (Claude's own tool-call bookkeeping) and
// carry nothing useful for a human reading the conversation, so they're skipped.
function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') {
      return block.source
        ? '[Photo from customer]' + (block.caption ? ': ' + block.caption : '')
        : '[Photo sent: ' + (block.filename || '') + ']' + (block.caption ? ' — ' + block.caption : '');
    }
    if (block.type === 'document') return '[Document sent: ' + (block.filename || '') + ']' + (block.caption ? ' — ' + block.caption : '');
    if (block.type === 'video') return '[Video from customer]';
    if (block.type === 'tool_use') return '[Tool used: ' + block.name + ']';
    return '';
  }).filter(Boolean).join(' ');
}

function senderLabel(role, source) {
  if (role === 'user') return 'Customer';
  return source === 'human' ? 'Human Agent' : 'AI Agent';
}

// Bulk export of every message across every conversation, joined with lead outcome — for
// spotting conversion patterns in a spreadsheet (filter/pivot by domain, lead status, message
// count, etc.), as opposed to the per-conversation transcript below which is for reading one
// conversation end-to-end.
app.get('/admin/api/export/conversations.csv', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const messages = await db.getAllMessagesForExport();
    const header = ['Phone', 'Domain', 'Escalated', 'Human Takeover', 'Lead Status', 'Lead Service', 'Lead Property Type', 'Timestamp', 'Sender', 'Message'];
    const rows = messages.map(m => [
      csvTextCell(m.phone),
      csvCell(m.domain || ''),
      csvCell(m.escalated ? 'Yes' : 'No'),
      csvCell(m.humanTakeover ? 'Yes' : 'No'),
      csvCell(m.leadStatus || ''),
      csvCell(m.leadService || ''),
      csvCell(m.leadPropertyType || ''),
      csvCell(fmtExportDate(m.ts)),
      csvCell(senderLabel(m.role, m.source)),
      csvCell(extractMessageText(m.content)),
    ].join(','));
    const csv = [header.map(csvCell).join(','), ...rows].join('\r\n');
    const filename = 'waterlift-conversations-' + new Date().toISOString().slice(0, 10) + '.csv';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(csv);
  } catch (err) { res.status(500).send('Export error: ' + err.message); }
});

// CSV export of all leads
app.get('/admin/api/leads/export.csv', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const leads = await db.getAllLeads();
    const header = ['Status','Name','Phone','Service','Location','Property Type','Budget','Notes','Captured'];
    const rows = leads.map(l => [
      csvCell(l.status),
      csvCell(l.name),
      csvTextCell(l.phone),
      csvCell(l.service),
      csvCell(l.location),
      csvCell(l.property_type),
      csvCell(l.estimated_budget || ''),
      csvCell(l.notes || ''),
      csvCell(fmtExportDate(l.captured_at)),
    ].join(','));
    const csv = [header.map(csvCell).join(','), ...rows].join('\r\n');
    const filename = 'waterlift-leads-' + new Date().toISOString().slice(0, 10) + '.csv';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(csv);
  } catch (err) { res.status(500).send('Export error: ' + err.message); }
});

// ── Product catalog ──────────────────────────────────────────────────────────

app.get('/admin/api/catalog/settings', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const feedUrl = await catalogSync.getFeedUrl();
    const lastSynced = await catalogSync.getLastSynced();
    res.json({ feedUrl, lastSynced });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/catalog/settings', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { feedUrl } = req.body || {};
    if (!feedUrl || !/^https?:\/\//i.test(feedUrl)) {
      return res.status(400).json({ error: 'A valid feed URL (starting with http:// or https://) is required' });
    }
    await catalogSync.setFeedUrl(feedUrl.trim());
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/catalog/sync', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const result = await catalogSync.syncCatalog();
    res.json({ ok: true, count: result.count, syncedAt: result.syncedAt });
  } catch (err) {
    console.error('[admin] Catalog sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/catalog/products', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const products = await db.getAllProducts();
    res.json(products);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tower pricing (admin-editable, not part of the synced product feed) ────────

app.get('/admin/api/tower-pricing', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const [foundation, tanks, packages] = await Promise.all([
      db.getTowerFoundationPrices(),
      db.getTowerTankPrices(),
      db.getTowerPackages(),
    ]);
    res.json({ foundation, tanks, packages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Exports the current live tower pricing (foundation/tank/package tables) as one CSV with a
// section per table — reads straight from the DB so it always reflects whatever the admin has
// edited via this tab, not a stale snapshot.
app.get('/admin/api/tower-pricing/export.csv', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const cell = (v) => csvCell(v === undefined || v === null ? '' : String(v));
    const [foundation, tanks, packages] = await Promise.all([
      db.getTowerFoundationPrices(),
      db.getTowerTankPrices(),
      db.getTowerPackages(),
    ]);
    const foundationLookup = {};
    foundation.forEach(f => { foundationLookup[f.foundation_type] = Number(f.price); });
    const tankLookup = {};
    tanks.forEach(t => { tankLookup[t.tank_type + ':' + t.capacity_key] = Number(t.price); });

    const rows = [];
    rows.push(['FOUNDATION PRICES']);
    rows.push(['Foundation Type', 'Price (KShs)']);
    foundation.forEach(f => rows.push([f.foundation_type.charAt(0).toUpperCase() + f.foundation_type.slice(1), f.price]));
    rows.push([]);

    rows.push(['TANK PRICES']);
    rows.push(['Tank Type', 'Capacity Key', 'Capacity Label', 'Price (KShs)']);
    tanks.forEach(t => rows.push([t.tank_type === 'plastic' ? 'Jojo' : 'Steel', t.capacity_key, t.capacity_label, t.price]));
    rows.push([]);

    rows.push(['TOWER PACKAGES']);
    rows.push(['Height (m)', 'Tank Count', 'Tank Type', 'Capacity', 'Foundation', 'Fabrication Price (KShs)', 'Complete Package Total (KShs)']);
    packages.forEach(p => {
      const foundationPrice = foundationLookup[p.foundation_type] || 0;
      const tankPrice = tankLookup[p.tank_type + ':' + p.capacity_key] || 0;
      const total = Number(p.fabrication_price) + foundationPrice + tankPrice * p.tank_count;
      rows.push([p.height_m, p.tank_count, p.tank_type === 'plastic' ? 'Jojo' : 'Steel', p.capacity_label, p.foundation_type.charAt(0).toUpperCase() + p.foundation_type.slice(1), p.fabrication_price, total]);
    });

    const csv = rows.map(row => row.map(cell).join(',')).join('\r\n');
    const filename = 'waterlift-tower-pricing-' + new Date().toISOString().slice(0, 10) + '.csv';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(csv);
  } catch (err) { res.status(500).send('Export error: ' + err.message); }
});

app.post('/admin/api/tower-pricing/foundation', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { foundation_type, price } = req.body || {};
    if (!foundation_type || price === undefined || price === '') return res.status(400).json({ error: 'foundation_type and price are required' });
    await db.upsertTowerFoundationPrice(foundation_type, Number(price));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/tower-pricing/foundation/:type/delete', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    await db.deleteTowerFoundationPrice(req.params.type);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/tower-pricing/tanks/:id?', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { tank_type, capacity_key, capacity_label, price } = req.body || {};
    if (!tank_type || !capacity_key || !capacity_label || price === undefined || price === '') {
      return res.status(400).json({ error: 'tank_type, capacity_key, capacity_label, and price are required' });
    }
    const id = await db.upsertTowerTankPrice({
      id: req.params.id ? Number(req.params.id) : undefined,
      tank_type, capacity_key: normalizeCapacityKeyForAdmin(capacity_key), capacity_label, price: Number(price),
    });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/tower-pricing/tanks/:id/delete', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    await db.deleteTowerTankPrice(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/tower-pricing/packages/:id?', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { height_m, tank_count, tank_type, capacity_key, capacity_label, foundation_type, fabrication_price } = req.body || {};
    if (!height_m || !tank_count || !tank_type || !capacity_key || !capacity_label || !foundation_type || fabrication_price === undefined || fabrication_price === '') {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const id = await db.upsertTowerPackage({
      id: req.params.id ? Number(req.params.id) : undefined,
      height_m: Number(height_m), tank_count: Number(tank_count), tank_type,
      capacity_key: normalizeCapacityKeyForAdmin(capacity_key), capacity_label, foundation_type,
      fabrication_price: Number(fabrication_price),
    });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/tower-pricing/packages/:id/delete', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    await db.deleteTowerPackage(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Drilling pricing (admin-editable inputs for the drilling quote calculator) ──

app.get('/admin/api/drilling-pricing', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const [settings, penetrationRates, consumables, mobilization] = await Promise.all([
      db.getDrillingSettings(),
      db.getDrillingPenetrationRates(),
      db.getDrillingLineItems('consumable'),
      db.getDrillingLineItems('mobilization'),
    ]);
    res.json({ settings, penetrationRates, consumables, mobilization });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/drilling-pricing/settings', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { key, value } = req.body || {};
    if (!key || value === undefined || value === '') return res.status(400).json({ error: 'key and value are required' });
    await db.setDrillingSetting(key, String(value));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/drilling-pricing/penetration-rates/:id?', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { label, minutes_per_rod, rod_length_m } = req.body || {};
    if (!label || !minutes_per_rod || !rod_length_m) return res.status(400).json({ error: 'label, minutes_per_rod, and rod_length_m are required' });
    const id = await db.upsertDrillingPenetrationRate({
      id: req.params.id ? Number(req.params.id) : undefined,
      label, minutes_per_rod: Number(minutes_per_rod), rod_length_m: Number(rod_length_m),
    });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/drilling-pricing/penetration-rates/:id/delete', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    await db.deleteDrillingPenetrationRate(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/drilling-pricing/line-items/:id?', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { category, name, default_qty, default_rate, sort_order } = req.body || {};
    if (!category || !name || default_qty === undefined || default_rate === undefined) {
      return res.status(400).json({ error: 'category, name, default_qty, and default_rate are required' });
    }
    const id = await db.upsertDrillingLineItem({
      id: req.params.id ? Number(req.params.id) : undefined,
      category, name, default_qty: Number(default_qty), default_rate: Number(default_rate), sort_order: Number(sort_order || 0),
    });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/drilling-pricing/line-items/:id/delete', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    await db.deleteDrillingLineItem(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Generates a branded drilling quotation PDF and streams it back for download. Uses POST
// Computes the drilling quote and returns the JSON breakdown (no PDF) — powers the "Preview
// Totals" button so the admin can sanity-check numbers before generating/sending the PDF.
app.post('/admin/api/quotes/drilling/preview', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const quote = await generateDrillingQuote(req.body || {});
    res.json(quote);
  } catch (err) {
    console.error('[admin] Drilling quote preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full internal costing breakdown as CSV — every fuel/consumable/casing/gravel line with its
// qty, rate, and amount (mirrors the original hand-built "NICHOLAS DRILLING COSTING" sheet),
// plus the derived customer quote totals. Internal-use only — never sent to a customer.
app.post('/admin/api/quotes/drilling/costing.csv', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { client, location, quoteRef, date, depthM } = req.body || {};
    const quote = await generateDrillingQuote(req.body || {});
    const c = quote.costing;
    // csvCell does `String(v || '')`, which blanks out legitimate 0 values (falsy) — a costing
    // sheet has plenty of real zeros (unused consumables, excluded surface casing), so stringify
    // numbers first to keep them as "0" rather than silently dropping them.
    const cell = (v) => csvCell(v === undefined || v === null ? '' : String(v));
    const rows = [];
    rows.push(['DRILLING COSTING SHEET']);
    rows.push(['Client', client || '']);
    rows.push(['Location', location || '']);
    rows.push(['Quote Ref', quoteRef || '']);
    rows.push(['Date', date || '']);
    rows.push(['Depth (m)', depthM]);
    rows.push([]);
    if (quote.isDirectRate) {
      rows.push(['DRILLING RATE ENTERED DIRECTLY — no costing breakdown was computed for this quote']);
    } else {
      rows.push(['FUEL']);
      rows.push(['Flushing Fuel (L)', c.flushingFuelLitres]);
      rows.push(['Rig Truck Fuel (L)', c.rigFuelLitres]);
      rows.push(['Test Pumping Fuel (L)', c.testPumpingFuelLitres]);
      rows.push(['Compressor Fuel (L)', c.compressorFuelLitres, '= Flushing + Depth x (' + c.minutesPerRod + '/' + c.rodLengthM + ')']);
      rows.push(['Total Fuel (L)', c.totalFuelLitres]);
      rows.push(['Fuel Rate (KShs/L)', c.fuelRatePerLitre]);
      rows.push([]);
      rows.push(['ITEM', 'QTY', 'RATE', 'AMOUNT']);
      c.consumablesBreakdown.forEach(item => rows.push([item.name, item.qty, item.rate, item.amount]));
      rows.push(['PLAIN CASINGS (units)', c.plainCasingUnits, c.plainCasingUnitRate, c.plainCasingCost]);
      rows.push(['SCREENED CASINGS (units)', c.screenedCasingUnits, c.screenedCasingUnitRate, c.screenedCasingCost]);
      rows.push(['GRAVEL (bags)', c.gravelBags, c.gravelRatePerBag, c.gravelCost]);
      rows.push(['DIESEL (RIG)', c.totalFuelLitres, c.fuelRatePerLitre, c.dieselAmount]);
      rows.push([]);
      rows.push(['TOTAL COST', '', '', c.totalCost]);
      rows.push(['RATE PER METRE', '', '', c.ratePerMetre]);
    }
    rows.push([]);
    rows.push(['CUSTOMER QUOTE (DERIVED)']);
    rows.push(['Drilling Rate' + (quote.isDirectRate ? ' (entered directly)' : ' (costing rate - deduction)'), '', '', quote.drillingRate]);
    rows.push(['Drilling Amount', '', '', quote.drillingAmount]);
    rows.push(['Casing Amount (flat rate x depth)', '', '', quote.casingAmount]);
    rows.push(['Surface Casing', quote.surfaceCasingIncluded ? 'Included' : 'Not included', '', quote.surfaceCasingIncluded ? quote.surfaceCasingAmount : 0]);
    if (quote.mobilization.isDirect) {
      rows.push(['Mobilization', 'Entered directly — no rig/truck/test pumping unit breakdown computed', '', quote.mobilization.total]);
    } else {
      rows.push(['Mobilization — Rig', '', '', quote.mobilization.rig.total]);
      rows.push(['Mobilization — Support Truck', '', '', quote.mobilization.truck.total]);
      rows.push(['Mobilization — Test Pumping Unit Truck', '', '', quote.mobilization.testPumpingUnit.total]);
    }
    rows.push(['Mobilization Total', '', '', quote.mobilization.total]);
    rows.push(['SUB TOTAL', '', '', quote.subTotal]);
    rows.push(['V.A.T (' + quote.vatRatePct + '%)', '', '', quote.vatAmount]);
    rows.push(['GRAND TOTAL', '', '', quote.grandTotal]);
    rows.push([]);
    rows.push(['PAYMENT BREAKDOWN']);
    rows.push(['Deposit of Works', '', '', quote.payment.deposit]);
    rows.push(['After Drilling, Before Casing', '', '', quote.payment.afterDrilling]);
    rows.push(['Before Test Pumping', '', '', quote.payment.beforeTestPumping]);

    const csv = rows.map(row => row.map(cell).join(',')).join('\r\n');
    const safeName = String(quoteRef || 'costing').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-costing.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[admin] Drilling costing CSV error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// (not GET like the tower download route) because the input — job-specific overrides for
// dozens of consumable/mobilization line items — is too large/nested for a query string.
app.post('/admin/api/quotes/drilling/download', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { client, location, quoteRef, date, depthM, preparedBy, reviewedBy, approvedBy } = req.body || {};
    const quote = await generateDrillingQuote(req.body || {});
    const buffer = await generateDrillingQuotePDF({ client, location, quoteRef, date, depthM: Number(depthM), quote, preparedBy, reviewedBy, approvedBy });
    const safeName = String(quoteRef || 'quote').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('[admin] Drilling quote PDF generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generates the same PDF and sends it straight to the customer on WhatsApp — mirrors the
// tower quote's send route.
app.post('/admin/api/quotes/drilling/send/:phone', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const phone = normalizePhone(req.params.phone);
    const { client, location, quoteRef, date, depthM, caption, preparedBy, reviewedBy, approvedBy } = req.body || {};
    const quote = await generateDrillingQuote(req.body || {});
    const buffer = await generateDrillingQuotePDF({ client, location, quoteRef, date, depthM: Number(depthM), quote, preparedBy, reviewedBy, approvedBy });
    const filename = `${String(quoteRef || 'Quote').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
    const storedAs = saveDocumentToDisk(buffer, filename);
    const mediaId = await uploadMedia(buffer, 'application/pdf', filename);
    const sendResult = await sendDocumentMessage(phone, mediaId, filename, (caption || '').trim());
    const waMessageId = sendResult?.messages?.[0]?.id || null;
    const id = await appendAdminDocumentMessage(phone, filename, (caption || '').trim(), storedAs, waMessageId, null);
    res.json({ ok: true, filename, storedAs, id, waMessageId });
  } catch (err) {
    console.error('[admin] Drilling quote PDF send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/solar-pricing', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const [settings, tiers, lineItems] = await Promise.all([
      db.getSolarSettings(),
      db.getSolarKvaTiers(),
      db.getSolarLineItems(),
    ]);
    res.json({ settings, tiers, lineItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Exports the current live solar pricing (VAT setting + every tier's line items) as one CSV,
// grouped by tier with a subtotal/VAT/total per tier — reads straight from the DB so it always
// reflects whatever the admin has edited via this tab, not a stale snapshot.
app.get('/admin/api/solar-pricing/export.csv', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const cell = (v) => csvCell(v === undefined || v === null ? '' : String(v));
    const round2 = (n) => Math.round(n * 100) / 100;
    const [settings, tiers, lineItems] = await Promise.all([
      db.getSolarSettings(),
      db.getSolarKvaTiers(),
      db.getSolarLineItems(),
    ]);
    const vatRatePct = Number(settings.vat_rate_pct || 16);
    const itemsByTier = {};
    lineItems.forEach(li => { (itemsByTier[li.tier_key] = itemsByTier[li.tier_key] || []).push(li); });

    const rows = [];
    rows.push(['SETTINGS']);
    rows.push(['VAT Rate on Non-Solar Items (%)', vatRatePct]);
    rows.push([]);

    tiers.forEach(tier => {
      const items = itemsByTier[tier.tier_key] || [];
      rows.push([tier.label.toUpperCase() + ' TIER']);
      rows.push(['Category', 'Name', 'Default Qty', 'Default Rate (KShs)', 'Amount (KShs)']);
      let subTotal = 0, taxableTotal = 0;
      items.forEach(li => {
        const amount = round2(Number(li.default_qty) * Number(li.default_rate));
        subTotal += amount;
        if (li.category === 'taxable') taxableTotal += amount;
        rows.push([li.category === 'exempt' ? 'VAT-exempt' : 'Taxable', li.name, li.default_qty, li.default_rate, amount]);
      });
      const vatAmount = round2(taxableTotal * (vatRatePct / 100));
      rows.push(['Sub Total', '', '', '', round2(subTotal)]);
      rows.push(['VAT on Non-Solar (' + vatRatePct + '%)', '', '', '', vatAmount]);
      rows.push(['Total', '', '', '', round2(subTotal + vatAmount)]);
      rows.push([]);
    });

    const csv = rows.map(row => row.map(cell).join(',')).join('\r\n');
    const filename = 'waterlift-solar-pricing-' + new Date().toISOString().slice(0, 10) + '.csv';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(csv);
  } catch (err) { res.status(500).send('Export error: ' + err.message); }
});

app.post('/admin/api/solar-pricing/settings', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { key, value } = req.body || {};
    if (!key || value === undefined || value === '') return res.status(400).json({ error: 'key and value are required' });
    await db.setSolarSetting(key, String(value));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/solar-pricing/tiers', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { tier_key, label, sort_order } = req.body || {};
    if (!tier_key || !label) return res.status(400).json({ error: 'tier_key and label are required' });
    await db.upsertSolarKvaTier({ tier_key, label, sort_order: Number(sort_order || 0) });
    res.json({ ok: true, tier_key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/solar-pricing/tiers/:key/delete', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    await db.deleteSolarKvaTier(req.params.key);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/solar-pricing/line-items/:id?', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { tier_key, category, name, default_qty, default_rate, sort_order } = req.body || {};
    if (!tier_key || !category || !name || default_qty === undefined || default_rate === undefined) {
      return res.status(400).json({ error: 'tier_key, category, name, default_qty, and default_rate are required' });
    }
    const id = await db.upsertSolarLineItem({
      id: req.params.id ? Number(req.params.id) : undefined,
      tier_key, category, name, default_qty: Number(default_qty), default_rate: Number(default_rate), sort_order: Number(sort_order || 0),
    });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/solar-pricing/line-items/:id/delete', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    await db.deleteSolarLineItem(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Computes the solar quote and returns the JSON breakdown (no PDF) — powers "Preview Totals".
app.post('/admin/api/quotes/solar/preview', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const quote = await generateSolarQuote(req.body || {});
    res.json(quote);
  } catch (err) {
    console.error('[admin] Solar quote preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/quotes/solar/download', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { client, project, quoteRef, date, systemLabel, preparedBy, reviewedBy, approvedBy } = req.body || {};
    const quote = await generateSolarQuote(req.body || {});
    const buffer = await generateSolarQuotePDF({ client, project, quoteRef, date, systemLabel, quote, preparedBy, reviewedBy, approvedBy });
    const safeName = String(quoteRef || 'quote').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('[admin] Solar quote PDF generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generates the same PDF and sends it straight to the customer on WhatsApp — mirrors the
// tower/drilling quote send routes.
app.post('/admin/api/quotes/solar/send/:phone', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const phone = normalizePhone(req.params.phone);
    const { client, project, quoteRef, date, systemLabel, caption, preparedBy, reviewedBy, approvedBy } = req.body || {};
    const quote = await generateSolarQuote(req.body || {});
    const buffer = await generateSolarQuotePDF({ client, project, quoteRef, date, systemLabel, quote, preparedBy, reviewedBy, approvedBy });
    const filename = `${String(quoteRef || 'Quote').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
    const storedAs = saveDocumentToDisk(buffer, filename);
    const mediaId = await uploadMedia(buffer, 'application/pdf', filename);
    const sendResult = await sendDocumentMessage(phone, mediaId, filename, (caption || '').trim());
    const waMessageId = sendResult?.messages?.[0]?.id || null;
    const id = await appendAdminDocumentMessage(phone, filename, (caption || '').trim(), storedAs, waMessageId, null);
    res.json({ ok: true, filename, storedAs, id, waMessageId });
  } catch (err) {
    console.error('[admin] Solar quote PDF send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manually add a lead from the admin dashboard
app.post('/admin/api/leads', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { name, phone, service, location, property_type, estimated_budget, notes } = req.body || {};
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
    await db.insertLead({
      name: String(name).trim(),
      phone: normalizePhone(phone),
      service: service || null,
      location: location || null,
      property_type: property_type || null,
      estimated_budget: estimated_budget || null,
      notes: notes || null,
      capturedAt: Date.now(),
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit an existing lead's details from the admin dashboard
app.post('/admin/api/leads/:id/update', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { name, phone, service, location, property_type, estimated_budget, notes } = req.body || {};
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
    await db.updateLead(Number(req.params.id), {
      name: String(name).trim(),
      phone: normalizePhone(phone),
      service: service || null,
      location: location || null,
      property_type: property_type || null,
      estimated_budget: estimated_budget || null,
      notes: notes || null,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resolve an escalation
app.post('/admin/api/escalations/:id/resolve', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try { await db.resolveEscalation(Number(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Lightweight sessions summary for polling (no full message history)
app.get('/admin/api/sessions', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try { res.json(await db.getSessionsSummary()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// New messages for a phone newer than a given message id (cursor, not a timestamp —
// see getMessagesSinceId for why: avoids client/server clock-skew bugs)
app.get('/admin/api/messages/:phone/since-id/:id', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try { res.json(await db.getMessagesSinceId(req.params.phone, Number(req.params.id))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Readable, WhatsApp-export-style transcript of one conversation — for reading a single
// interaction end-to-end (as opposed to the bulk CSV above, which is for spotting patterns
// across many conversations at once).
app.get('/admin/api/session/:phone/transcript.txt', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const phone = normalizePhone(req.params.phone);
    const [session, messages, leads] = await Promise.all([
      db.getSession(phone),
      db.getAllMessages(phone),
      db.getAllLeads(),
    ]);
    const lead = leads.find(l => l.phone === phone);
    const lines = [];
    lines.push('Conversation with ' + phone);
    lines.push('Domain: ' + (session?.domain || 'unknown') + ' | Escalated: ' + (session?.escalated ? 'Yes' : 'No') + ' | Lead status: ' + (lead?.status || 'no lead captured'));
    lines.push('Exported: ' + fmtExportDate(Date.now()));
    lines.push('='.repeat(60));
    lines.push('');
    messages.forEach(m => {
      const text = extractMessageText(m.content);
      if (!text) return;
      lines.push('[' + fmtExportDate(m.ts) + '] ' + senderLabel(m.role, m.source) + ': ' + text);
    });
    const transcript = lines.join('\n');
    const filename = 'waterlift-transcript-' + phone + '-' + new Date().toISOString().slice(0, 10) + '.txt';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(transcript);
  } catch (err) {
    console.error('[admin] Transcript export error:', err.message);
    res.status(500).send('Export error: ' + err.message);
  }
});

// Register this device for push notifications on new messages
app.post('/admin/api/push/subscribe', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const sub = req.body;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    await db.savePushSubscription(sub);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/push/unsubscribe', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    if (req.body?.endpoint) await db.deletePushSubscriptionByEndpoint(req.body.endpoint);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── WhatsApp webhook ──────────────────────────────────────────────────────────


const recentMessageIds = new Map();
const DEDUP_TTL_MS     = 60_000;

function isDuplicate(messageId) {
  const now = Date.now();
  if (recentMessageIds.has(messageId)) return true;
  recentMessageIds.set(messageId, now);
  for (const [id, ts] of recentMessageIds) {
    if (now - ts > DEDUP_TTL_MS) recentMessageIds.delete(id);
  }
  return false;
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[webhook] Verified'); return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    const body  = req.body;
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return;
    const message     = value.messages[0];
    const from        = message.from;
    const messageId   = message.id;
    const replyToWaId = message.context?.id || null; // set when the customer swiped-to-reply to a specific earlier message
    // ── Catalog order ──────────────────────────────────────────────────────────
    if (message.type === 'order' && message.order) {
      if (isDuplicate(messageId)) return;
      (async () => {
        try {
          notifyNewMessage(from, 'placed a catalog order').catch(e => console.error('[push] notify error:', e));
          const ord         = message.order;
          const retailerIds = (ord.product_items || []).map(i => String(i.product_retailer_id));
          const names       = await lookupProductNames(retailerIds);
          const items       = (ord.product_items || []).map(item => {
            const id       = String(item.product_retailer_id);
            const name     = names[id] || 'Product ID ' + id;
            const qty      = item.quantity;
            const price    = Number(item.item_price).toLocaleString('en-KE');
            const subtotal = (Number(item.item_price) * qty).toLocaleString('en-KE');
            return `${qty}x ${name} @ KShs ${price} each = KShs ${subtotal}`;
          });
          const total    = (ord.product_items || []).reduce((s, i) => s + Number(i.item_price) * i.quantity, 0);
          const noteText = ord.text ? `\nCustomer note: "${ord.text}"` : '';
          const orderMsg = `I have placed an order from your WhatsApp catalog:\n${items.join('\n')}\nTotal: KShs ${total.toLocaleString('en-KE')}${noteText}`;
          console.log('[webhook] Catalog order from', from, '-', items.length, 'item(s), KShs', total);
          await processMessage(from, orderMsg, messageId, null, replyToWaId);
        } catch (err) {
          console.error('[webhook] Order processing error:', err);
        }
      })();
      return;
    }

    // ── Interactive reply (button / list selection) ────────────────────────────
    if (message.type === 'interactive' && message.interactive) {
      if (isDuplicate(messageId)) return;
      const ia    = message.interactive;
      const reply = ia.button_reply?.title || ia.list_reply?.title || ia.nfm_reply?.submitted_form_values || 'I selected an option.';
      console.log('[webhook] Interactive reply from', from + ':', reply);
      notifyNewMessage(from, String(reply)).catch(e => console.error('[push] notify error:', e));
      processMessage(from, String(reply), messageId, null, replyToWaId).catch(err => console.error('[webhook] processMessage error:', err));
      return;
    }

    // ── Image message ──────────────────────────────────────────────────────────
    if (message.type === 'image' && message.image?.id) {
      if (isDuplicate(messageId)) return;
      const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      const MAX_IMAGE_BYTES       = 5 * 1024 * 1024;
      (async () => {
        try {
          const caption = (message.image.caption || '').trim();
          console.log('[webhook] Image from', from, caption ? '- caption: ' + caption.slice(0, 60) : '(no caption)');
          notifyNewMessage(from, caption || '📷 Sent a photo').catch(e => console.error('[push] notify error:', e));
          const media = await downloadMedia(message.image.id);
          if (!SUPPORTED_IMAGE_TYPES.includes(media.mimeType)) {
            await sendTextMessage(from, "I couldn't read that image format — could you resend it as a JPEG or PNG?");
            return;
          }
          if (media.sizeBytes > MAX_IMAGE_BYTES) {
            await sendTextMessage(from, "That image is a bit too large for me to process — could you resend a smaller photo?");
            return;
          }
          await processImageMessage(from, media, caption, messageId, replyToWaId);
        } catch (err) {
          console.error('[webhook] Image processing error:', err);
          await sendTextMessage(from, "I couldn't load that image — could you try sending it again?").catch(() => {});
        }
      })();
      return;
    }

    // ── Video message ───────────────────────────────────────────────────────────
    // Claude has no native video-understanding input, so this doesn't go through vision like
    // images do — it's downloaded, saved to disk (viewable in the admin dashboard, same as
    // documents), and the conversation is flagged escalated so a human actually watches it.
    // See pipeline.js's _processVideoMessage for how the placeholder text Claude does see is
    // built, and prompts.js for the honesty rule around it.
    if (message.type === 'video' && message.video?.id) {
      if (isDuplicate(messageId)) return;
      const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/3gpp'];
      const MAX_VIDEO_BYTES       = 16 * 1024 * 1024; // WhatsApp's own video cap
      (async () => {
        try {
          const caption = (message.video.caption || '').trim();
          console.log('[webhook] Video from', from, caption ? '- caption: ' + caption.slice(0, 60) : '(no caption)');
          notifyNewMessage(from, caption || '🎥 Sent a video').catch(e => console.error('[push] notify error:', e));
          const media = await downloadMedia(message.video.id);
          if (!SUPPORTED_VIDEO_TYPES.includes(media.mimeType)) {
            await sendTextMessage(from, "I couldn't read that video format — could you resend it, or send a few photos instead?");
            return;
          }
          if (media.sizeBytes > MAX_VIDEO_BYTES) {
            await sendTextMessage(from, "That video is a bit too large for me to receive — could you resend a shorter clip or send a few photos instead?");
            return;
          }
          const ext = media.mimeType === 'video/3gpp' ? '3gp' : 'mp4';
          const storedAs = saveDocumentToDisk(Buffer.from(media.base64, 'base64'), `video.${ext}`);
          await processVideoMessage(from, { storedAs, mimeType: media.mimeType, filename: `video.${ext}` }, caption, messageId, replyToWaId);
        } catch (err) {
          console.error('[webhook] Video processing error:', err);
          await sendTextMessage(from, "I couldn't load that video — could you try sending it again?").catch(() => {});
        }
      })();
      return;
    }

    // ── Non-text fallback (audio, document, sticker, etc.) ─────────────────────
    if (message.type !== 'text' || !message.text?.body) {
      if (isDuplicate(messageId)) return;
      notifyNewMessage(from, `sent a ${message.type} message`).catch(e => console.error('[push] notify error:', e));
      processMessage(from, 'I sent a non-text message. Please let me know how I can help you via text.', messageId, null, replyToWaId)
        .catch(err => console.error('[webhook] processMessage error:', err));
      return;
    }

    // ── Plain text ─────────────────────────────────────────────────────────────
    const body2    = message.text.body.trim();
    const referral = message.referral || null; // present when customer tapped from a Click-to-WhatsApp ad
    if (!body2 || isDuplicate(messageId)) return;
    console.log('[webhook] From', from + ':', body2.slice(0, 80));
    if (referral) console.log('[webhook] Ad referral:', JSON.stringify(referral));
    notifyNewMessage(from, body2).catch(e => console.error('[push] notify error:', e));
    processMessage(from, body2, messageId, referral, replyToWaId).catch(err => console.error('[webhook] processMessage error:', err));
  } catch (err) { console.error('[webhook] Parse error:', err); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

// This is a webhook server that must stay up to keep receiving Meta's inbound POSTs — a single
// isolated error in one request handler (e.g. a callback firing after a client disconnected)
// should never take the whole process down and drop every other customer's in-flight
// conversation with it. Log and keep running rather than crash-and-restart.
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception (process kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection (process kept alive):', reason);
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('[server] Running on port', PORT));
}
