const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session')(session);
const multer  = require('multer');
const { processMessage, processImageMessage, pauseSession, resumeSession, appendAdminMessage, appendAdminDocumentMessage } = require('./src/agent/pipeline.js');
const { sendTextMessage, lookupProductNames, downloadMedia, uploadMedia, sendDocumentMessage } = require('./src/services/whatsapp.js');
const { notifyNewMessage } = require('./src/services/push.js');
const { verifyPassword } = require('./src/services/authService.js');
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

// Quotation/document uploads for the admin dashboard — kept in memory since we
// immediately re-upload to Meta's Media API rather than hosting the file ourselves.
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
    req.session.userId = user.id;
    req.session.email  = user.email;
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
      if (m.content.some(b => b.type === 'image')) {
        const cap = m.content.find(b => b.type === 'text');
        return '📷 Photo' + (cap ? ': ' + cap.text.slice(0, 35) : '');
      }
      const docBlock = m.content.find(b => b.type === 'document');
      if (docBlock) return '📄 ' + docBlock.filename;
      const t = m.content.find(b => b.type === 'text');
      if (t) return (m.source === 'human' ? '👤 ' : m.role === 'assistant' ? '🤖 ' : '') + t.text.slice(0, 42);
    }
  }
  return 'Message';
}

function renderMessages(messages) {
  return (messages || []).map(msg => {
    const t = fmtTime(msg.ts);
    if (msg.source === 'system') return '';
    if (typeof msg.content === 'string') {
      return '<div class="wa-row wa-row-in">' +
        '<div class="wa-bubble wa-in">' + esc(msg.content) +
        '<span class="wa-ts">' + t + '</span></div></div>';
    }
    if (!Array.isArray(msg.content)) return '';
    const imgBlock = msg.content.find(b => b.type === 'image');
    if (imgBlock && msg.role === 'user') {
      const capBlock = msg.content.find(b => b.type === 'text');
      const src = 'data:' + (imgBlock.source?.media_type || 'image/jpeg') + ';base64,' + (imgBlock.source?.data || '');
      return '<div class="wa-row wa-row-in"><div class="wa-bubble wa-in wa-img-bubble">' +
        '<img class="wa-img" src="' + src + '" alt="Photo from customer" loading="lazy"/>' +
        (capBlock ? '<div class="wa-img-cap">' + esc(capBlock.text) + '</div>' : '') +
        '<span class="wa-ts">' + t + '</span></div></div>';
    }
    return msg.content.map(block => {
      if (block.type === 'text' && msg.role === 'assistant') {
        const human = msg.source === 'human';
        return '<div class="wa-row wa-row-out">' +
          '<div class="wa-bubble wa-out' + (human ? ' wa-human' : '') + '">' +
          '<span class="wa-sender">' + (human ? '&#128100; Human Agent' : '&#129302; AI Agent') + '</span>' +
          esc(block.text) +
          '<span class="wa-ts">' + t + ' <span class="wa-tick">&#10003;&#10003;</span></span>' +
          '</div></div>';
      }
      if (block.type === 'tool_use') {
        return '<div class="wa-row wa-row-center">' +
          '<div class="wa-system">&#128295; ' + esc(block.name) + '</div></div>';
      }
      if (block.type === 'document') {
        const human = msg.source === 'human';
        return '<div class="wa-row wa-row-out">' +
          '<div class="wa-bubble wa-out' + (human ? ' wa-human' : '') + ' wa-doc-bubble">' +
          '<span class="wa-sender">' + (human ? '&#128100; Human Agent' : '&#129302; AI Agent') + '</span>' +
          '<div class="wa-doc"><span class="wa-doc-icon">&#128196;</span><span class="wa-doc-name">' + esc(block.filename) + '</span></div>' +
          (block.caption ? '<div class="wa-doc-cap">' + esc(block.caption) + '</div>' : '') +
          '<span class="wa-ts">' + t + ' <span class="wa-tick">&#10003;&#10003;</span></span>' +
          '</div></div>';
      }
      if (block.type === 'text' && msg.role === 'user') {
        return '<div class="wa-row wa-row-in"><div class="wa-bubble wa-in">' + esc(block.text) +
          '<span class="wa-ts">' + t + '</span></div></div>';
      }
      return '';
    }).join('');
  }).join('');
}

// ── Admin page ────────────────────────────────────────────────────────────────

function buildAdminPage(sessions, leads, callbacks, escalations, adminEmail) {
  const entries   = Object.entries(sessions).sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  const now       = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  const converted = leads.filter(l => l.status === 'converted').length;
  const convRate  = leads.length > 0 ? Math.round(converted / leads.length * 100) : 0;
  const leadMap   = {};
  for (const l of leads) { if (l.phone && !leadMap[l.phone]) leadMap[l.phone] = l; }

  // Left panel: contact list
  const contactsHTML = entries.length === 0
    ? '<div class="wa-empty-contacts"><p>No conversations yet</p></div>'
    : entries.map(([phone, s]) => {
        const pid    = phone.replace(/\D/g,'');
        const domain = s.domain || 'general';
        const paused = !!s.humanTakeover;
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
    const pid    = phone.replace(/\D/g,'');
    const domain = s.domain || 'general';
    const paused = !!s.humanTakeover;
    const lastTs = s.messages.length > 0 ? s.messages[s.messages.length - 1].ts : 0;
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
      '<div class="wa-chat" id="chat-' + pid + '" data-phone="' + esc(phone) + '" data-last-ts="' + lastTs + '">' +
        '<div class="wa-chat-hdr">' +
          '<button class="wa-back" onclick="backToContacts()">&#8592;</button>' +
          '<div class="wa-av wa-av-' + domain + ' wa-av-sm">' + getInitials(phone) + '</div>' +
          '<div class="wa-hdr-info">' +
            '<div class="wa-hdr-name">' + esc(phone) + '</div>' +
            '<div class="wa-hdr-sub ' + (paused ? 'sub-paused' : 'sub-active') + '" id="hsub-' + pid + '">' +
              (paused ? '&#128100; Human Mode' : '&#129302; AI Active') +
            '</div>' +
            (lead ? '<div class="wa-lead-pill">&#128100; ' + esc(lead.name) + ' &bull; ' + esc(lead.service||'') + (lead.location ? ' &bull; ' + esc(lead.location) : '') + (lead.estimated_budget ? ' &bull; ' + esc(lead.estimated_budget) : '') + '</div>' : '') +
            (s.adReferral ? '<div class="wa-ad-pill" title="' + esc(s.adReferral.headline || '') + ' — ' + esc(s.adReferral.body || '') + '">&#128226; From ad' + (s.adReferral.headline ? ': "' + esc(s.adReferral.headline) + '"' : '') + (s.adReferral.productId ? ' &bull; Product ' + esc(s.adReferral.productId) : '') + '</div>' : '') +
          '</div>' +
          '<button class="wa-action-btn ' + (paused ? 'wa-btn-resume' : 'wa-btn-pause') + '" id="pbtn-' + pid + '" data-phone="' + esc(phone) + '" data-pid="' + pid + '" data-paused="' + paused + '" onclick="handlePause(this)">' +
            (paused ? '&#9654; Resume AI' : '&#9646;&#9646; Pause AI') +
          '</button>' +
        '</div>' +
        '<div class="wa-msgs" id="chatmsgs-' + pid + '">' +
          renderMessages(s.messages) +
        '</div>' +
        '<div class="wa-input-area' + (paused ? '' : ' wa-input-locked') + '" id="wa-input-' + pid + '">' +
          (!paused ? '<div class="wa-lock-notice">&#9888;&#65039; Pause AI to reply directly</div>' : '') +
          '<div class="wa-quick-replies" id="qr-' + pid + '"' + (paused ? '' : ' style="display:none"') + '>' + quickReplies + '</div>' +
          '<div class="wa-input-row">' +
            '<input type="file" id="finput-' + pid + '" accept=".pdf,.doc,.docx,.xls,.xlsx" style="display:none" onchange="handleSendDocument(\'' + esc(phone) + '\',\'' + pid + '\')">' +
            '<button type="button" class="wa-attach" id="abtn-' + pid + '" title="Attach a document" onclick="document.getElementById(\'finput-' + pid + '\').click()" ' + (paused ? '' : 'disabled') + '>&#128206;</button>' +
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
        '<td class="mono nowrap">' + esc(l.phone) + '</td>' +
        '<td class="nowrap"><span class="chip chip-' + esc(l.service) + '">' + esc(l.service) + '</span></td>' +
        '<td class="wrap-cell">' + esc(l.location) + '</td><td class="nowrap">' + esc(l.property_type) + '</td>' +
        '<td class="nowrap">' + esc(l.estimated_budget||'—') + '</td>' +
        '<td class="wrap-cell">' + esc(l.notes||'—') + '</td>' +
        '<td class="muted nowrap">' + fmtFull(l.captured_at) + '</td>' +
        '<td class="nowrap">' +
          '<button type="button" class="resolve-btn" ' +
            'data-id="' + l.id + '" data-name="' + esc(l.name) + '" data-phone="' + esc(l.phone) + '" ' +
            'data-service="' + esc(l.service) + '" data-location="' + esc(l.location) + '" ' +
            'data-property="' + esc(l.property_type) + '" data-budget="' + esc(l.estimated_budget) + '" ' +
            'data-notes="' + esc(l.notes) + '" onclick="openEditLeadModal(this)">Edit</button>' +
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
.wa-doc{display:flex;align-items:center;gap:8px;background:rgba(0,0,0,.06);border-radius:8px;padding:8px 10px;margin-top:2px}
.wa-doc-icon{font-size:1.3rem}
.wa-doc-name{font-size:.85rem;font-weight:600;word-break:break-all}
.wa-doc-cap{padding:6px 2px 0;font-size:.85rem;line-height:1.4}
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

/* ── Stat subtitle ── */
.stat-sub{font-size:.68rem;color:#94a3b8;margin-top:1px}

/* ── Pane toolbar (export button row) ── */
.pane-toolbar{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;background:#fff;border-bottom:1px solid #e2e8f0;flex-shrink:0}
.export-btn{background:#075E54;color:#fff;border:none;border-radius:6px;padding:7px 14px;font-size:.8rem;font-weight:600;cursor:pointer;transition:background .15s;text-decoration:none;display:inline-flex;align-items:center}
.export-btn:hover{background:#054a3a}

/* ── Modal (Add Lead) ── */
.modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
.modal-card{background:#fff;border-radius:12px;padding:24px;max-width:420px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,.2)}
.modal-card h3{margin:0 0 16px;font-size:1.05rem;color:#075E54}
.modal-card label{display:block;font-size:.8rem;font-weight:600;color:#334155;margin-bottom:12px}
.modal-card input,.modal-card select,.modal-card textarea{width:100%;padding:9px 10px;margin-top:5px;font-family:inherit;font-size:.88rem;border:1.5px solid #cbd5e1;border-radius:6px;color:#111}
.modal-card input:focus,.modal-card select:focus,.modal-card textarea:focus{outline:none;border-color:#075E54}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}

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
    <button class="refresh-btn" id="notifBtn" onclick="subscribeToPush()">&#128276; Enable Notifications</button>
    <button class="refresh-btn" onclick="location.reload()">&#8635; Refresh</button>
    <form method="POST" action="/logout" style="display:inline"><button type="submit" class="refresh-btn">&#128682; Log out</button></form>
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
</div>

<!-- Conversations pane -->
<div id="pane-conv" class="pane active">
  <div class="wa-layout">
    <div class="wa-left" id="wa-left">
      <div class="wa-lhdr">
        Conversations
        <span class="wa-lcount">${entries.length}</span>
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

<!-- Callbacks pane -->
<div id="pane-cb" class="pane">
  <div class="pane-scroll">${cbHTML}</div>
</div>

<!-- Escalations pane -->
<div id="pane-esc" class="pane">
  <div class="pane-scroll">${escTbl}</div>
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

function showTab(name, btn) {
  document.querySelectorAll('.pane').forEach(function(p){p.classList.remove('active')});
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
  document.getElementById('pane-' + name).classList.add('active');
  btn.classList.add('active');
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
    var note  = wrap.querySelector('.wa-lock-notice');
    var qr = document.getElementById('qr-'+pid);
    if (nowPaused) {
      wrap.classList.remove('wa-input-locked');
      ta.disabled = false; ta.placeholder = 'Type a message...';
      sbtn.disabled = false; sbtn.className = 'wa-send';
      if (abtn2) abtn2.disabled = false;
      if (note) note.remove();
      if (qr) qr.style.display = '';
      setTimeout(function(){ wrap.scrollIntoView({ behavior: 'smooth', block: 'end' }); ta.focus(); }, 100);
    } else {
      wrap.classList.add('wa-input-locked');
      ta.disabled = true; ta.placeholder = 'Pause AI to reply';
      sbtn.disabled = true; sbtn.className = 'wa-send wa-send-disabled';
      if (abtn2) abtn2.disabled = true;
      if (qr) qr.style.display = 'none';
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

async function handleSend(phone, pid) {
  var ta   = document.getElementById('rinput-' + pid);
  var btn  = document.getElementById('sbtn-' + pid);
  var text = ta.value.trim();
  if (!text) return;
  btn.disabled = true; btn.innerHTML = '...';
  try {
    var r = await fetch('/admin/api/session/' + encodeURIComponent(phone) + '/send', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ message: text })
    });
    if (!r.ok) { var e = await r.json(); throw new Error(e.error || 'Failed'); }
    var msgs = document.getElementById('chatmsgs-' + pid);
    var d    = document.createElement('div');
    d.className = 'wa-row wa-row-out';
    var escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var now  = new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Nairobi'});
    d.innerHTML = '<div class="wa-bubble wa-out wa-human"><span class="wa-sender">&#128100; Human Agent</span>' + escaped + '<span class="wa-ts">' + now + ' <span class="wa-tick">&#10003;&#10003;</span></span></div>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    ta.value = ''; ta.style.height = 'auto';
    chatLastTs[pid] = Date.now();
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
  abtn.disabled = true;
  toast('Sending ' + file.name + '...', 'ok');
  try {
    var formData = new FormData();
    formData.append('file', file);
    if (caption) formData.append('caption', caption);
    var r = await fetch('/admin/api/session/' + encodeURIComponent(phone) + '/send-document', {
      method: 'POST',
      body: formData
    });
    if (!r.ok) { var e = await r.json(); throw new Error(e.error || 'Failed'); }
    var msgs = document.getElementById('chatmsgs-' + pid);
    var d    = document.createElement('div');
    d.className = 'wa-row wa-row-out';
    var escapedName = file.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var escapedCap  = caption.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var now  = new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Nairobi'});
    d.innerHTML = '<div class="wa-bubble wa-out wa-human wa-doc-bubble"><span class="wa-sender">&#128100; Human Agent</span>' +
      '<div class="wa-doc"><span class="wa-doc-icon">&#128196;</span><span class="wa-doc-name">' + escapedName + '</span></div>' +
      (caption ? '<div class="wa-doc-cap">' + escapedCap + '</div>' : '') +
      '<span class="wa-ts">' + now + ' <span class="wa-tick">&#10003;&#10003;</span></span></div>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    ta.value = ''; ta.style.height = 'auto';
    finput.value = '';
    chatLastTs[pid] = Date.now();
    var prev = document.querySelector('#contact-' + pid + ' .wa-ct-prev');
    if (prev) prev.textContent = '\\u{1F464} \\u{1F4C4} ' + file.name;
    toast('Document sent', 'ok');
  } catch(e) { toast('Send failed: ' + e.message, 'err'); }
  finally { abtn.disabled = false; }
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

var chatLastTs      = {};   // pid → last message ts rendered for that chat
var sessionLastSeen = {};   // pid → lastSeen from sessions API (for unread detection)
var firstPoll       = true;

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
    if (msg.content.some(function(b){ return b.type==='image'; })) {
      var cap = msg.content.find(function(b){ return b.type==='text'; });
      return '\\u{1F4F7} Photo' + (cap ? ': ' + cap.text.slice(0,35) : '');
    }
    var docBlock = msg.content.find(function(b){ return b.type==='document'; });
    if (docBlock) return '\\u{1F4C4} ' + docBlock.filename;
    var t = msg.content.find(function(b){ return b.type==='text'; });
    if (t) return (msg.source==='human' ? '\\u{1F464} ' : msg.role==='assistant' ? '\\u{1F916} ' : '') + t.text.slice(0,42);
  }
  return '';
}
function renderSingleMsg(msg) {
  if (msg.source === 'system') return '';
  var t = clientFmtTime(msg.ts);
  if (typeof msg.content === 'string') {
    return '<div class="wa-row wa-row-in"><div class="wa-bubble wa-in">'+clientEsc(msg.content)+'<span class="wa-ts">'+t+'</span></div></div>';
  }
  if (!Array.isArray(msg.content)) return '';
  var imgBlock = msg.content.find(function(b){ return b.type==='image'; });
  if (imgBlock && msg.role==='user') {
    var capBlock = msg.content.find(function(b){ return b.type==='text'; });
    var src = 'data:'+((imgBlock.source&&imgBlock.source.media_type)||'image/jpeg')+';base64,'+((imgBlock.source&&imgBlock.source.data)||'');
    return '<div class="wa-row wa-row-in"><div class="wa-bubble wa-in wa-img-bubble">' +
      '<img class="wa-img" src="'+src+'" alt="Photo from customer" loading="lazy"/>' +
      (capBlock ? '<div class="wa-img-cap">'+clientEsc(capBlock.text)+'</div>' : '') +
      '<span class="wa-ts">'+t+'</span></div></div>';
  }
  return msg.content.map(function(block) {
    if (block.type==='text' && msg.role==='assistant') {
      var h = msg.source==='human';
      return '<div class="wa-row wa-row-out"><div class="wa-bubble wa-out'+(h?' wa-human':'')+'"><span class="wa-sender">'+(h?'&#128100; Human Agent':'&#129302; AI Agent')+'</span>'+clientEsc(block.text)+'<span class="wa-ts">'+t+' <span class="wa-tick">&#10003;&#10003;</span></span></div></div>';
    }
    if (block.type==='tool_use') {
      return '<div class="wa-row wa-row-center"><div class="wa-system">&#128295; '+clientEsc(block.name)+'</div></div>';
    }
    if (block.type==='document') {
      var hd = msg.source==='human';
      return '<div class="wa-row wa-row-out"><div class="wa-bubble wa-out'+(hd?' wa-human':'')+' wa-doc-bubble">' +
        '<span class="wa-sender">'+(hd?'&#128100; Human Agent':'&#129302; AI Agent')+'</span>' +
        '<div class="wa-doc"><span class="wa-doc-icon">&#128196;</span><span class="wa-doc-name">'+clientEsc(block.filename)+'</span></div>' +
        (block.caption ? '<div class="wa-doc-cap">'+clientEsc(block.caption)+'</div>' : '') +
        '<span class="wa-ts">'+t+' <span class="wa-tick">&#10003;&#10003;</span></span></div></div>';
    }
    if (block.type==='text' && msg.role==='user') {
      return '<div class="wa-row wa-row-in"><div class="wa-bubble wa-in">'+clientEsc(block.text)+'<span class="wa-ts">'+t+'</span></div></div>';
    }
    return '';
  }).join('');
}

async function fetchNewMessages(pid, phone, autoScroll) {
  var lastTs = chatLastTs[pid] || 0;
  try {
    var r = await fetch('/admin/api/messages/'+encodeURIComponent(phone)+'/since/'+lastTs);
    if (!r.ok) return;
    var newMsgs = await r.json();
    if (!newMsgs.length) return;
    var msgs = document.getElementById('chatmsgs-'+pid);
    if (!msgs) return;
    var atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    var rendered = false;
    newMsgs.forEach(function(msg) {
      var html = renderSingleMsg(msg);
      if (html) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        while (tmp.firstChild) msgs.appendChild(tmp.firstChild);
        rendered = true;
      }
      if (msg.ts > (chatLastTs[pid]||0)) chatLastTs[pid] = msg.ts;
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

window.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.wa-chat').forEach(function(chat) {
    var pid = chat.id.replace('chat-','');
    chatLastTs[pid] = Number(chat.dataset.lastTs || 0);
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
});
</script>
</body>
</html>`;
}

// ── Admin routes ──────────────────────────────────────────────────────────────

app.get('/admin', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const sessions    = await db.getAllSessionsWithMessages();
    const leads       = await db.getAllLeads();
    const callbacks   = await db.getAllCallbacks();
    const escalations = await db.getAllEscalations();
    res.send(buildAdminPage(sessions, leads, callbacks, escalations, req.session.email));
  } catch (err) {
    console.error('[admin] DB error:', err.message);
    res.status(500).send('Database error: ' + esc(err.message));
  }
});

app.post('/admin/api/session/:phone/pause', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try { await pauseSession(req.params.phone); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/session/:phone/resume', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try { await resumeSession(req.params.phone); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/session/:phone/send', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });
  try {
    await sendTextMessage(req.params.phone, message.trim());
    await appendAdminMessage(req.params.phone, message.trim());
    res.json({ ok: true });
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
      const caption  = (req.body?.caption || '').trim();
      const mediaId  = await uploadMedia(req.file.buffer, req.file.mimetype, req.file.originalname);
      await sendDocumentMessage(req.params.phone, mediaId, req.file.originalname, caption);
      await appendAdminDocumentMessage(req.params.phone, req.file.originalname, caption);
      res.json({ ok: true, filename: req.file.originalname });
    } catch (err2) {
      console.error('[admin] Document send error:', err2.message);
      res.status(500).json({ error: err2.message });
    }
  });
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

// Manually add a lead from the admin dashboard
app.post('/admin/api/leads', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try {
    const { name, phone, service, location, property_type, estimated_budget, notes } = req.body || {};
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
    await db.insertLead({
      name: String(name).trim(),
      phone: String(phone).trim(),
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
      phone: String(phone).trim(),
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

// New messages for a phone since a timestamp
app.get('/admin/api/messages/:phone/since/:ts', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  try { res.json(await db.getMessagesSince(req.params.phone, Number(req.params.ts))); }
  catch (err) { res.status(500).json({ error: err.message }); }
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
    const message   = value.messages[0];
    const from      = message.from;
    const messageId = message.id;
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
          await processMessage(from, orderMsg, messageId);
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
      processMessage(from, String(reply), messageId).catch(err => console.error('[webhook] processMessage error:', err));
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
          await processImageMessage(from, media, caption, messageId);
        } catch (err) {
          console.error('[webhook] Image processing error:', err);
          await sendTextMessage(from, "I couldn't load that image — could you try sending it again?").catch(() => {});
        }
      })();
      return;
    }

    // ── Non-text fallback (audio, video, document, sticker, etc.) ─────────────
    if (message.type !== 'text' || !message.text?.body) {
      if (isDuplicate(messageId)) return;
      notifyNewMessage(from, `sent a ${message.type} message`).catch(e => console.error('[push] notify error:', e));
      processMessage(from, 'I sent a non-text message. Please let me know how I can help you via text.', messageId)
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
    processMessage(from, body2, messageId, referral).catch(err => console.error('[webhook] processMessage error:', err));
  } catch (err) { console.error('[webhook] Parse error:', err); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('[server] Running on port', PORT));
}
